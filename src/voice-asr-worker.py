#!/opt/homebrew/bin/python3.12
import json
import os
import subprocess
import sys
import time
import wave
from pathlib import Path

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")


def find_local_whisper_model():
    explicit = os.environ.get("VOICE_WHISPER_MODEL_DIR", "").strip()
    if explicit and Path(explicit).is_dir():
        return explicit

    hub_dir = Path.home() / ".cache" / "huggingface" / "hub"
    candidates = [
        "models--mlx-community--whisper-small-mlx",
        "models--mlx-community--whisper-large-v3-turbo",
        "models--mlx-community--whisper-medium-mlx",
        "models--mlx-community--whisper-tiny",
    ]
    for repo_dir_name in candidates:
        snapshots = hub_dir / repo_dir_name / "snapshots"
        if not snapshots.is_dir():
            continue
        for snap in sorted(snapshots.iterdir(), reverse=True):
            if snap.is_dir() and any(snap.iterdir()):
                return str(snap)
    return ""


def load_pcm16_float32(audio_path):
    import numpy as np

    path = Path(audio_path)
    if path.suffix.lower() == ".wav":
        try:
            with wave.open(str(path), "rb") as wf:
                channels = wf.getnchannels()
                sampwidth = wf.getsampwidth()
                rate = wf.getframerate()
                frames = wf.getnframes()
                if sampwidth == 2 and rate == 16000 and frames > 0:
                    raw = wf.readframes(frames)
                    pcm = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
                    if channels > 1:
                        pcm = pcm.reshape(-1, channels).mean(axis=1)
                    return pcm
        except Exception:
            pass

    ffmpeg_bin = os.environ.get("FFMPEG_BIN", "/opt/homebrew/bin/ffmpeg")
    if not Path(ffmpeg_bin).exists():
        ffmpeg_bin = "ffmpeg"
    proc = subprocess.run(
        [ffmpeg_bin, "-v", "error", "-i", str(path), "-ar", "16000", "-ac", "1", "-f", "s16le", "pipe:1"],
        capture_output=True,
        check=False,
        timeout=15,
    )
    if proc.returncode != 0 or not proc.stdout:
        err = proc.stderr.decode("utf-8", errors="ignore").strip() or "ffmpeg decode failed"
        raise RuntimeError(err)
    return np.frombuffer(proc.stdout, dtype=np.int16).astype(np.float32) / 32768.0


def assess_audio_activity(audio_arr):
    import numpy as np

    if audio_arr.size < 1920:
        return False, 0.0, 0.0, 0.0

    peak = float(np.max(np.abs(audio_arr)))
    rms = float(np.sqrt(np.mean(audio_arr * audio_arr)))
    frame_len = 320  # 20ms at 16kHz
    usable = (audio_arr.size // frame_len) * frame_len
    if usable >= frame_len:
        frames = audio_arr[:usable].reshape(-1, frame_len)
        frame_rms = np.sqrt(np.mean(frames * frames, axis=1))
        max_frame_rms = float(np.max(frame_rms))
    else:
        max_frame_rms = rms

    if peak < 0.007 or rms < 0.0020 or max_frame_rms < 0.006:
        return False, peak, rms, max_frame_rms
    return True, peak, rms, max_frame_rms


def extract_valid_whisper_text(res):
    if not isinstance(res, dict):
        return ""
    segments = res.get("segments")
    if isinstance(segments, list) and segments:
        kept = []
        for seg in segments:
            if not isinstance(seg, dict):
                continue
            seg_text = str(seg.get("text") or "").strip()
            if not seg_text:
                continue
            no_speech_prob = seg.get("no_speech_prob")
            avg_logprob = seg.get("avg_logprob")
            compression_ratio = seg.get("compression_ratio")
            if no_speech_prob is not None and float(no_speech_prob) >= 0.72 and (avg_logprob is None or float(avg_logprob) < -0.7):
                continue
            if avg_logprob is not None and float(avg_logprob) < -1.35 and len(seg_text) <= 10:
                continue
            if compression_ratio is not None and float(compression_ratio) >= 2.6 and len(seg_text) <= 24:
                continue
            kept.append(seg_text)
        return "".join(kept).strip()
    return str(res.get("text") or "").strip()


def main():
    model_dir = find_local_whisper_model()
    if not model_dir:
        sys.stdout.write(json.dumps({"ready": False, "error": "no offline whisper snapshot found"}, ensure_ascii=False) + "\n")
        sys.stdout.flush()
        return

    try:
        import mlx.core as mx
        import mlx_whisper
        from mlx_whisper.tokenizer import get_tokenizer
        from mlx_whisper.transcribe import ModelHolder

        model_obj = ModelHolder.get_model(model_dir, mx.float16)
        get_tokenizer(
            model_obj.is_multilingual,
            num_languages=model_obj.num_languages,
            language="zh",
            task="transcribe",
        )
    except Exception as exc:
        sys.stdout.write(json.dumps({"ready": False, "error": f"mlx_whisper preload failed: {exc}"}, ensure_ascii=False) + "\n")
        sys.stdout.flush()
        return

    sys.stdout.write(json.dumps({"ready": True, "modelDir": model_dir}, ensure_ascii=False) + "\n")
    sys.stdout.flush()

    default_prompt = "请忠实转写用户说出的普通话和英文，保留疑问、否定和原意。"
    while True:
        raw_line = sys.stdin.readline()
        if not raw_line:
            break
        line = raw_line.strip()
        if not line:
            continue
        req_id = ""
        try:
            req = json.loads(line)
            req_id = str(req.get("id") or "")
            audio_path = str(req.get("audioPath") or "")
            language = str(req.get("language") or "zh").strip() or None
            prompt = str(req.get("prompt") or "").strip() or default_prompt
            if not audio_path or not Path(audio_path).is_file():
                raise ValueError("audio file missing")

            t0 = time.monotonic()
            audio_arr = load_pcm16_float32(audio_path)
            has_speech, peak, rms, max_frame_rms = assess_audio_activity(audio_arr)
            if not has_speech:
                text = ""
                no_speech = True
            else:
                res = mlx_whisper.transcribe(
                    audio_arr,
                    path_or_hf_repo=model_dir,
                    language=language,
                    temperature=(0.0, 0.2),
                    condition_on_previous_text=False,
                    initial_prompt=prompt,
                )
                text = extract_valid_whisper_text(res)
                no_speech = not bool(text)
            elapsed_ms = int((time.monotonic() - t0) * 1000)
            sys.stdout.write(json.dumps({
                "id": req_id,
                "ok": True,
                "text": text,
                "noSpeech": no_speech,
                "peak": round(peak, 5),
                "rms": round(rms, 5),
                "maxFrameRms": round(max_frame_rms, 5),
                "engine": "mlx-whisper",
                "durationMs": elapsed_ms,
            }, ensure_ascii=False) + "\n")
            sys.stdout.flush()
        except Exception as exc:
            sys.stdout.write(json.dumps({
                "id": req_id,
                "ok": False,
                "error": str(exc),
            }, ensure_ascii=False) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
