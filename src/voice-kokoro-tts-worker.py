#!/opt/homebrew/bin/python3.12
import base64
import io
import json
import os
import sys
import wave
from pathlib import Path

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")


def find_local_kokoro_snapshot():
    explicit = os.environ.get("VOICE_KOKORO_MODEL_DIR", "").strip()
    if explicit and Path(explicit).is_dir():
        return explicit
    hub_dir = Path.home() / ".cache" / "huggingface" / "hub" / "models--mlx-community--Kokoro-82M-bf16" / "snapshots"
    if not hub_dir.is_dir():
        return ""
    for snap in sorted(hub_dir.iterdir(), reverse=True):
        if snap.is_dir() and (snap / "kokoro-v1_0.safetensors").exists():
            return str(snap)
    return ""


def float_audio_to_wav_bytes(samples, sample_rate=24000) -> bytes:
    import numpy as np

    arr = np.asarray(samples, dtype=np.float32).reshape(-1)
    if arr.size == 0:
        return b""
    arr = np.clip(arr, -1.0, 1.0)
    pcm16 = (arr * 32767.0).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(int(sample_rate))
        wf.writeframes(pcm16.tobytes())
    return buf.getvalue()


def main():
    model_dir = find_local_kokoro_snapshot()
    if not model_dir:
        sys.stdout.write(json.dumps({"ready": False, "error": "no local Kokoro-82M snapshot found"}, ensure_ascii=False) + "\n")
        sys.stdout.flush()
        return

    try:
        import numpy as np
        from mlx_audio.tts.utils import load_model

        model = load_model(model_dir)
        # Warm jieba dictionary once so subsequent turns are fast.
        for _ in model.generate(text="就绪", voice="zf_xiaoxiao", speed=1.05, lang_code="z"):
            break
    except Exception as exc:
        sys.stdout.write(json.dumps({"ready": False, "error": f"Kokoro init failed: {exc}"}, ensure_ascii=False) + "\n")
        sys.stdout.flush()
        return

    sys.stdout.write(json.dumps({"ready": True, "modelDir": model_dir}, ensure_ascii=False) + "\n")
    sys.stdout.flush()

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        req_id = str(req.get("id") or "")
        text = str(req.get("text") or "").strip()
        voice = str(req.get("voice") or "zf_xiaoxiao").strip()
        speed = float(req.get("speed") or 1.06)
        if not text:
            sys.stdout.write(json.dumps({"id": req_id, "ok": False, "error": "empty text"}, ensure_ascii=False) + "\n")
            sys.stdout.flush()
            continue
        try:
            chunks = []
            sample_rate = 24000
            for res in model.generate(text=text, voice=voice, speed=speed, lang_code="z"):
                if getattr(res, "audio", None) is not None:
                    chunks.append(np.asarray(res.audio, dtype=np.float32).reshape(-1))
                if getattr(res, "sample_rate", None):
                    sample_rate = int(res.sample_rate)
            if not chunks:
                raise RuntimeError("empty Kokoro audio")
            merged = np.concatenate(chunks)
            wav_bytes = float_audio_to_wav_bytes(merged, sample_rate=sample_rate)
            if not wav_bytes:
                raise RuntimeError("empty WAV bytes")
            b64 = base64.b64encode(wav_bytes).decode("ascii")
            sys.stdout.write(json.dumps({
                "id": req_id,
                "ok": True,
                "audioBase64": b64,
                "mimeType": "audio/wav",
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
