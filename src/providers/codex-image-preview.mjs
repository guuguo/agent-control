import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { extractCodexUserAttachmentsAndText } from "../codex-input-clean.mjs";
import { ALLOWED_PREVIEW_IMAGE_MIMES, hasValidImageMagic } from "../file-preview.mjs";

// 只从当前会话的 user response 中，读取与 <image path=...> 一一对应的内嵌图。
// 不把 base64 塞回历史接口，也不恢复／改写 Codex 的临时文件。
export async function recoverCodexImagePreview({ rolloutPath, targetPath, cwd, cacheDir, maxBytes }) {
  if (!rolloutPath) return null;
  const ext = extname(targetPath).toLowerCase();
  const mimeType = ALLOWED_PREVIEW_IMAGE_MIMES[ext];
  if (!mimeType) return null;
  const key = createHash("sha256").update(`${rolloutPath}\0${targetPath}`).digest("hex");
  const filePath = resolve(cacheDir, `${key}${ext}`);
  const metadata = (info) => ({ filePath, name: basename(targetPath), displayPath: targetPath, mimeType, size: info.size, mtimeMs: info.mtimeMs });
  const cached = await stat(filePath).catch(() => null);
  if (cached?.isFile()) return metadata(cached);

  const stream = createReadStream(rolloutPath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.includes('"input_image"')) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const payload = record.payload;
      if (record.type !== "response_item" || payload?.type !== "message" || payload.role !== "user") continue;
      let imagePath = "";
      for (const part of payload.content || []) {
        if (part.type === "input_text") {
          for (const tag of String(part.text || "").matchAll(/<\/?image\b[^>]*>/gi)) {
            imagePath = tag[0].startsWith("</") ? "" : (extractCodexUserAttachmentsAndText(tag[0]).images[0]?.path || "");
          }
        } else if (part.type === "input_image") {
          const matches = imagePath && resolve(cwd || ".", imagePath) === targetPath;
          imagePath = "";
          if (!matches) continue;
          const match = String(part.image_url || "").match(/^data:image\/(png|jpe?g|webp|gif);base64,([a-z0-9+/=\s]+)$/i);
          if (!match || match[2].length > Math.ceil(maxBytes / 3) * 4 + 1024) continue;
          const bytes = Buffer.from(match[2], "base64");
          if (!bytes.length || bytes.length > maxBytes || !hasValidImageMagic(bytes.subarray(0, 12), ext)) continue;
          await mkdir(cacheDir, { recursive: true, mode: 0o700 });
          await writeFile(filePath, bytes, { mode: 0o600 });
          return metadata(await stat(filePath));
        }
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return null;
}
