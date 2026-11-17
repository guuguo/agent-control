#!/usr/bin/env python3
import asyncio
import base64
import json
import sys


async def synthesize_bytes(text: str, voice: str, rate: str) -> bytes:
    import edge_tts

    communicate = edge_tts.Communicate(text, voice=voice, rate=rate)
    chunks = []
    async for chunk in communicate.stream():
        if chunk.get("type") == "audio":
            data = chunk.get("data")
            if data:
                chunks.append(data)
    return b"".join(chunks)


def main():
    try:
        import edge_tts  # noqa: F401
    except Exception as exc:
        sys.stdout.write(json.dumps({"ready": False, "error": f"edge_tts import failed: {exc}"}, ensure_ascii=False) + "\n")
        sys.stdout.flush()
        return

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    sys.stdout.write(json.dumps({"ready": True}, ensure_ascii=False) + "\n")
    sys.stdout.flush()

    try:
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
            voice = str(req.get("voice") or "zh-CN-XiaoxiaoNeural").strip()
            rate = str(req.get("rate") or "+8%").strip()
            if not text:
                sys.stdout.write(json.dumps({"id": req_id, "ok": False, "error": "empty text"}, ensure_ascii=False) + "\n")
                sys.stdout.flush()
                continue
            try:
                mp3_bytes = loop.run_until_complete(synthesize_bytes(text, voice, rate))
                if not mp3_bytes:
                    raise RuntimeError("empty audio stream")
                b64 = base64.b64encode(mp3_bytes).decode("ascii")
                sys.stdout.write(json.dumps({
                    "id": req_id,
                    "ok": True,
                    "audioBase64": b64,
                    "mimeType": "audio/mpeg",
                }, ensure_ascii=False) + "\n")
                sys.stdout.flush()
            except Exception as exc:
                sys.stdout.write(json.dumps({
                    "id": req_id,
                    "ok": False,
                    "error": str(exc),
                }, ensure_ascii=False) + "\n")
                sys.stdout.flush()
    finally:
        try:
            loop.close()
        except Exception:
            pass


if __name__ == "__main__":
    main()
