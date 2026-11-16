import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import { basename, extname, resolve } from "node:path";
import { promisify } from "node:util";
import { decodeFileUri, isSubpathOrEqual } from "./platform.mjs";

const execFileAsync = promisify(execFile);

const SIPS_BIN = "/usr/bin/sips";
const IMAGE_CACHE_DIR = resolve(os.tmpdir(), "agent-control-img-cache");
const IMAGE_CACHE_MAX_FILES = 300;
const COMPRESS_MIN_BYTES = 160 * 1024;
const DEFAULT_MAX_TEXT_BYTES = 256 * 1024;

export const ALLOWED_PREVIEW_IMAGE_MIMES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const EXTRA_FILE_MIME_TYPES = {
  ".md": "text/markdown; charset=utf-8",
  ".mdx": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
  ".toml": "application/toml; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".scss": "text/plain; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".cjs": "application/javascript; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".tsx": "text/plain; charset=utf-8",
  ".jsx": "text/plain; charset=utf-8",
  ".py": "text/plain; charset=utf-8",
  ".sh": "text/plain; charset=utf-8",
  ".zsh": "text/plain; charset=utf-8",
  ".sql": "text/plain; charset=utf-8",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
};

const CODE_EXT_LANGS = {
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".jsx": "jsx",
  ".json": "json",
  ".jsonl": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".py": "python",
  ".sh": "bash",
  ".zsh": "zsh",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
  ".htm": "html",
  ".xml": "xml",
  ".svg": "xml",
  ".sql": "sql",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".vue": "vue",
  ".svelte": "svelte",
  ".csv": "csv",
  ".tsv": "tsv",
};

const MARKDOWN_EXTS = new Set([".md", ".mdx"]);
const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov"]);
const AUDIO_EXTS = new Set([".mp3", ".wav", ".m4a", ".ogg"]);
const TEXT_LIKE_EXTS = new Set([
  ".txt", ".log", ".csv", ".tsv", ".json", ".jsonl", ".yaml", ".yml", ".toml",
  ".xml", ".svg", ".html", ".htm", ".css", ".scss", ".js", ".mjs", ".cjs",
  ".ts", ".tsx", ".jsx", ".py", ".sh", ".zsh", ".sql", ".go", ".rs", ".java",
  ".kt", ".swift", ".vue", ".svelte", ".ini", ".conf",
]);

const SKIP_BASENAME_DIRS = new Set(["node_modules", ".git", ".venv", "dist", "build"]);

const BLOCKED_DIR_SEGMENT_RE = /(?:^|\/)(?:\.(?:ssh|gnupg|aws|kube|codex|claude|git)|Library\/Keychains)(?:\/|$)/i;
const CORE_BLOCKED_DIR_RE = /(?:^|\/)(?:\.(?:ssh|gnupg|aws|kube|git)|Library\/Keychains)(?:\/|$)/i;
const BLOCKED_FILE_NAME_RE = /^(?:\.env(?:\.[^/]*)?|auth\.json|.*\.pem|.*\.key|\.npmrc|\.netrc|relay-auth\.json|tunnel-auth\.json|id_rsa(?:\..*)?|id_ed25519(?:\..*)?|.*(?:credential|secret).*)$/i;

const inFlightCompressions = new Map();

/**
 * Strip optional #L12 / #L12-L34 / :12 / :12:5 line anchors and decode file:// URIs.
 */
export function splitFilePathAndAnchor(rawRef = "") {
  let working = String(rawRef || "").trim();
  let startLine = null;
  let endLine = null;

  const hashMatch = working.match(/#L(\d+)(?:-L?(\d+))?$/i);
  if (hashMatch) {
    startLine = Number(hashMatch[1]) || null;
    endLine = Number(hashMatch[2] || hashMatch[1]) || startLine;
    working = working.slice(0, hashMatch.index);
  } else {
    const colonMatch = working.match(/:(\d+)(?::(\d+))?$/);
    if (colonMatch) {
      startLine = Number(colonMatch[1]) || null;
      endLine = startLine;
      working = working.slice(0, colonMatch.index);
    }
  }

  const cleanPath = decodeFileUri(working);
  return {
    cleanPath,
    startLine,
    endLine,
  };
}

/**
 * Block credential, private key, dot-config, and repository internal files.
 */
export function isBlockedPreviewFile(filePath = "", { allowCodexGenerated = false } = {}) {
  const forward = String(filePath || "").replace(/\\/g, "/");
  if (!forward) return true;
  const isCodexAttachment = /(?:^|\/)\.codex[^/]*\/attachments\//i.test(forward);
  const isCodexGeneratedImg = allowCodexGenerated && /(?:^|\/)\.codex[^/]*\/generated_images\//i.test(forward);
  if (isCodexAttachment || isCodexGeneratedImg) {
    if (CORE_BLOCKED_DIR_RE.test(forward)) return true;
  } else if (BLOCKED_DIR_SEGMENT_RE.test(forward)) {
    return true;
  }
  const base = basename(forward);
  if (BLOCKED_FILE_NAME_RE.test(base)) {
    return true;
  }
  return false;
}

/**
 * Validate binary header signatures for supported raster image formats.
 */
export function hasValidImageMagic(header, ext) {
  if (!Buffer.isBuffer(header) || header.length < 4) return false;
  if (ext === ".png") {
    return header.length >= 8
      && header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47
      && header[4] === 0x0d && header[5] === 0x0a && header[6] === 0x1a && header[7] === 0x0a;
  }
  if (ext === ".jpg" || ext === ".jpeg") {
    return header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  }
  if (ext === ".gif") {
    const sig = header.subarray(0, 6).toString("ascii");
    return sig === "GIF87a" || sig === "GIF89a";
  }
  if (ext === ".webp") {
    return header.length >= 12
      && header.subarray(0, 4).toString("ascii") === "RIFF"
      && header.subarray(8, 12).toString("ascii") === "WEBP";
  }
  return false;
}

/**
 * Bounded breadth-first lookup inside workspace when agent cited only a bare filename.
 */
export async function findWorkspaceFileByBasename(cwd, fileName, {
  maxDepth = 4,
  maxEntries = 1500,
} = {}) {
  const cleanCwd = String(cwd || "").trim();
  const cleanName = String(fileName || "").trim();
  if (!cleanCwd || !cleanName || cleanName.includes("/") || cleanName.includes("\\")) {
    return "";
  }
  const queue = [{ dir: cleanCwd, depth: 0 }];
  let visited = 0;
  let bestPath = "";
  let bestMtimeMs = -1;

  while (queue.length > 0 && visited < maxEntries) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > maxEntries) break;
      const name = entry.name;
      if (!name || name.startsWith(".") || SKIP_BASENAME_DIRS.has(name)) continue;
      const fullPath = resolve(dir, name);
      if (entry.isFile() && name === cleanName) {
        const info = await stat(fullPath).catch(() => null);
        if (info?.isFile() && isSubpathOrEqual(cleanCwd, fullPath)) {
          if (info.mtimeMs > bestMtimeMs) {
            bestMtimeMs = info.mtimeMs;
            bestPath = fullPath;
          }
        }
      } else if (entry.isDirectory() && depth < maxDepth) {
        queue.push({ dir: fullPath, depth: depth + 1 });
      }
    }
  }
  return bestPath;
}

async function pruneImageCacheDir(cacheDir = IMAGE_CACHE_DIR, maxFiles = IMAGE_CACHE_MAX_FILES) {
  const names = await readdir(cacheDir).catch(() => []);
  const jpgNames = names.filter((n) => n.endsWith(".jpg") && !n.includes(".tmp-"));
  if (jpgNames.length <= maxFiles) return;
  const stats = await Promise.all(
    jpgNames.map(async (name) => {
      const p = resolve(cacheDir, name);
      const st = await stat(p).catch(() => null);
      return st?.isFile() ? { path: p, mtimeMs: st.mtimeMs } : null;
    }),
  );
  const valid = stats.filter(Boolean).sort((a, b) => a.mtimeMs - b.mtimeMs);
  const excess = valid.length - Math.max(16, maxFiles - 24);
  if (excess <= 0) return;
  await Promise.all(valid.slice(0, excess).map((item) => rm(item.path, { force: true }).catch(() => {})));
}

/**
 * Downscale and JPEG-compress large raster images via macOS `sips` with disk caching.
 */
export async function getCompressedImagePreview(filePath, {
  size = 0,
  mtimeMs = 0,
  mimeType = "image/png",
  maxDim = 1280,
  quality = 74,
  raw = false,
  cacheDir = IMAGE_CACHE_DIR,
} = {}) {
  const original = {
    filePath,
    mimeType,
    size,
    mtimeMs,
    compressed: false,
    originalSize: size,
  };
  if (raw || size <= COMPRESS_MIN_BYTES || mimeType === "image/gif" || process.platform !== "darwin") {
    return original;
  }
  if (!existsSync(SIPS_BIN)) {
    return original;
  }

  const clampedDim = Math.max(240, Math.min(2400, Math.round(Number(maxDim) || 1280)));
  const clampedQuality = Math.max(40, Math.min(90, Math.round(Number(quality) || 74)));
  const key = createHash("sha1")
    .update(`${filePath}|${size}|${Math.trunc(mtimeMs)}|${clampedDim}|${clampedQuality}`)
    .digest("hex");
  const cacheFile = resolve(cacheDir, `${key}.jpg`);

  const cachedStat = await stat(cacheFile).catch(() => null);
  if (cachedStat?.isFile() && cachedStat.size > 0 && cachedStat.size < size) {
    return {
      filePath: cacheFile,
      mimeType: "image/jpeg",
      size: cachedStat.size,
      mtimeMs: cachedStat.mtimeMs,
      compressed: true,
      originalSize: size,
    };
  }

  let pending = inFlightCompressions.get(key);
  if (!pending) {
    pending = (async () => {
      await mkdir(cacheDir, { recursive: true, mode: 0o700 });
      const tempFile = resolve(cacheDir, `${key}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 6)}.jpg`);
      try {
        await execFileAsync(
          SIPS_BIN,
          [
            "-Z", String(clampedDim),
            "-s", "format", "jpeg",
            "-s", "formatOptions", String(clampedQuality),
            filePath,
            "--out", tempFile,
          ],
          { timeout: 8_000, maxBuffer: 512 * 1024 },
        );
        const tmpStat = await stat(tempFile).catch(() => null);
        if (!tmpStat?.isFile() || tmpStat.size <= 0 || tmpStat.size >= size) {
          await rm(tempFile, { force: true }).catch(() => {});
          return original;
        }
        await rename(tempFile, cacheFile);
        void pruneImageCacheDir(cacheDir).catch(() => {});
        return {
          filePath: cacheFile,
          mimeType: "image/jpeg",
          size: tmpStat.size,
          mtimeMs: tmpStat.mtimeMs,
          compressed: true,
          originalSize: size,
        };
      } catch {
        await rm(tempFile, { force: true }).catch(() => {});
        return original;
      }
    })().finally(() => {
      inFlightCompressions.delete(key);
    });
    inFlightCompressions.set(key, pending);
  }
  return pending;
}

export function lookupFileMimeType(filePath = "") {
  const ext = extname(String(filePath || "")).toLowerCase();
  return ALLOWED_PREVIEW_IMAGE_MIMES[ext] || EXTRA_FILE_MIME_TYPES[ext] || "application/octet-stream";
}

/**
 * Inspect file type and read bounded UTF-8 text preview (or media descriptor).
 */
export async function readPreviewableFileMeta(filePath, {
  size = 0,
  maxTextBytes = DEFAULT_MAX_TEXT_BYTES,
} = {}) {
  const ext = extname(filePath).toLowerCase();
  const mimeType = lookupFileMimeType(filePath);
  const name = basename(filePath);

  if (ALLOWED_PREVIEW_IMAGE_MIMES[ext]) {
    return { kind: "image", name, mimeType, size, truncated: false, lineCount: 0, content: "" };
  }
  if (VIDEO_EXTS.has(ext)) {
    return { kind: "video", name, mimeType, size, truncated: false, lineCount: 0, content: "" };
  }
  if (AUDIO_EXTS.has(ext)) {
    return { kind: "audio", name, mimeType, size, truncated: false, lineCount: 0, content: "" };
  }
  if (ext === ".pdf") {
    return { kind: "pdf", name, mimeType, size, truncated: false, lineCount: 0, content: "" };
  }

  const knownText = MARKDOWN_EXTS.has(ext) || TEXT_LIKE_EXTS.has(ext);
  const fh = await open(filePath, "r");
  try {
    const readLen = Math.min(Math.max(0, Number(size) || maxTextBytes), maxTextBytes);
    const buf = Buffer.allocUnsafe(readLen);
    const { bytesRead } = readLen > 0 ? await fh.read(buf, 0, readLen, 0) : { bytesRead: 0 };
    const sample = buf.subarray(0, bytesRead);
    const probeSlice = sample.subarray(0, Math.min(bytesRead, 4096));
    const hasNull = probeSlice.includes(0x00);
    if (!knownText && hasNull) {
      return { kind: "binary", name, mimeType, size, truncated: false, lineCount: 0, content: "" };
    }
    if (hasNull) {
      return { kind: "binary", name, mimeType: "application/octet-stream", size, truncated: false, lineCount: 0, content: "" };
    }
    const content = sample.toString("utf8");
    const lineCount = content ? content.split("\n").length : 0;
    const truncated = Boolean(size > maxTextBytes);
    let kind = "text";
    let language = "text";
    if (MARKDOWN_EXTS.has(ext)) {
      kind = "markdown";
      language = "markdown";
    } else if (ext === ".json" || ext === ".jsonl") {
      kind = "json";
      language = "json";
    } else if (CODE_EXT_LANGS[ext]) {
      kind = "code";
      language = CODE_EXT_LANGS[ext];
    }
    return {
      kind,
      language,
      name,
      mimeType,
      size,
      truncated,
      lineCount,
      content,
    };
  } finally {
    await fh.close().catch(() => {});
  }
}
