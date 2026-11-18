export const MAX_ATTACHED_IMAGES = 6;
export const DEFAULT_MAX_IMAGE_DIMENSION = 1600;
export const SMALL_PASSTHROUGH_BYTES = 220 * 1024;
export const TARGET_IMAGE_BYTES = 420 * 1024;
export const HARD_MAX_IMAGE_BYTES = 1536 * 1024;
export const HARD_TOTAL_IMAGE_BYTES = 2600 * 1024;
export const MAX_SOURCE_FILE_BYTES = 25 * 1024 * 1024;

const STANDARD_RASTER_MIME_RE = /^image\/(?:png|jpe?g|webp|gif)$/i;
const FALLBACK_PASSTHROUGH_MIME_RE = /^image\/(?:png|jpe?g|gif|webp|svg\+xml)$/i;

const COMPRESSION_STEPS = [
  { scale: 1, quality: 0.84 },
  { scale: 1, quality: 0.72 },
  { scale: 0.85, quality: 0.66 },
  { scale: 0.72, quality: 0.58 },
];

// 仅移除已经成功附加的同名本地图片路径；正文、网址和其他文件引用保持原样。
export function stripAttachedImagePaths(text, files = []) {
  let cleaned = String(text || "");
  for (const file of files) {
    const name = String(file?.name || "");
    if (!name) continue;
    const names = [...new Set([name, encodeURIComponent(name)])].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const root = "(?:file:\\/\\/\\/|\\/|[A-Za-z]:[\\\\/])";
    const path = new RegExp(`(^|[\\s(])(?:"${root}[^"\\r\\n]*?(?:${names})"|'${root}[^'\\r\\n]*?(?:${names})'|${root}[^\\s"'<>]*?(?:${names})(?=$|[\\s<>\\u4e00-\\u9fff]))[ \\t]*`, "gm");
    cleaned = cleaned.replace(path, (_match, prefix) => prefix);
  }
  return cleaned;
}

export function estimateDataUrlBytes(dataUrl) {
  const str = String(dataUrl || "");
  if (!str) return 0;
  const commaIdx = str.indexOf(",");
  if (commaIdx < 0) return str.length;
  const header = str.slice(0, commaIdx);
  const payload = str.slice(commaIdx + 1).trim();
  if (!payload) return 0;
  if (/;base64$/i.test(header)) {
    const cleanLen = payload.replace(/\s+/g, "").length;
    if (!cleanLen) return 0;
    const padding = payload.endsWith("==") ? 2 : (payload.endsWith("=") ? 1 : 0);
    return Math.max(0, Math.floor((cleanLen * 3) / 4) - padding);
  }
  try {
    return new TextEncoder().encode(decodeURIComponent(payload)).length;
  } catch {
    return payload.length;
  }
}

export function formatByteSize(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} B`;
  const kb = value / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export function computeScaledDimensions(width, height, maxDimension = DEFAULT_MAX_IMAGE_DIMENSION) {
  const w = Math.max(1, Math.round(Number(width) || 0));
  const h = Math.max(1, Math.round(Number(height) || 0));
  const cap = Math.max(64, Math.round(Number(maxDimension) || DEFAULT_MAX_IMAGE_DIMENSION));
  const longest = Math.max(w, h);
  if (longest <= cap) {
    return { width: w, height: h, scaled: false };
  }
  const ratio = cap / longest;
  return {
    width: Math.max(1, Math.round(w * ratio)),
    height: Math.max(1, Math.round(h * ratio)),
    scaled: true,
  };
}

export function shouldKeepOriginalImageDataUrl({ mimeType = "", byteLength = 0, scaled = false } = {}) {
  const cleanMime = String(mimeType || "").trim().toLowerCase();
  const size = Number(byteLength) || 0;
  if (size <= 0) return false;
  if (cleanMime === "image/svg+xml" && size <= TARGET_IMAGE_BYTES) {
    return true;
  }
  if (!scaled && size <= SMALL_PASSTHROUGH_BYTES && STANDARD_RASTER_MIME_RE.test(cleanMime)) {
    return true;
  }
  return false;
}

export function validateImageBatchBudget(existingImages = [], candidateByteLength = 0, limits = {}) {
  const list = Array.isArray(existingImages) ? existingImages : [];
  const maxCount = Number(limits.maxCount) || MAX_ATTACHED_IMAGES;
  const maxSingleBytes = Number(limits.maxSingleBytes) || HARD_MAX_IMAGE_BYTES;
  const maxTotalBytes = Number(limits.maxTotalBytes) || HARD_TOTAL_IMAGE_BYTES;
  const nextBytes = Math.max(0, Number(candidateByteLength) || 0);

  if (list.length >= maxCount) {
    return {
      ok: false,
      message: `单次最多附加 ${maxCount} 张图片，请先移除部分图片后再试`,
    };
  }
  if (nextBytes > maxSingleBytes) {
    return {
      ok: false,
      message: `单张图片压缩后仍达 ${formatByteSize(nextBytes)}（上限 ${formatByteSize(maxSingleBytes)}），请裁剪后发送`,
    };
  }
  const usedBytes = list.reduce(
    (sum, img) => sum + (Number(img?.byteLength) || estimateDataUrlBytes(img?.dataUrl || "")),
    0,
  );
  if (usedBytes + nextBytes > maxTotalBytes) {
    return {
      ok: false,
      message: `已附加图片总大小超出 ${formatByteSize(maxTotalBytes)}（当前已用 ${formatByteSize(usedBytes)}），请分批发送或删减图片`,
    };
  }
  return { ok: true, message: "" };
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string" && /^data:image\//i.test(reader.result)) {
        resolve(reader.result);
      } else {
        reject(new Error("未能读取有效的图片数据"));
      }
    };
    reader.onerror = () => reject(reader.error || new Error("读取图片文件失败"));
    reader.readAsDataURL(file);
  });
}

async function decodeImageSource(file) {
  if (typeof globalThis.createImageBitmap === "function") {
    try {
      const bitmap = await globalThis.createImageBitmap(file);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => {
          try { bitmap.close?.(); } catch {}
        },
      };
    } catch {
      // Fallback to <img> element below when createImageBitmap rejects or is unsupported for this codec.
    }
  }
  if (typeof globalThis.Image === "function" && typeof globalThis.URL?.createObjectURL === "function") {
    const objectUrl = globalThis.URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const el = new globalThis.Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("图片解码失败"));
        el.src = objectUrl;
      });
      return {
        source: img,
        width: img.naturalWidth || img.width || 1,
        height: img.naturalHeight || img.height || 1,
        close: () => {
          try { globalThis.URL.revokeObjectURL(objectUrl); } catch {}
        },
      };
    } catch (error) {
      try { globalThis.URL.revokeObjectURL(objectUrl); } catch {}
      throw error;
    }
  }
  throw new Error("当前运行环境不支持图片解码");
}

function encodeCanvasToJpegDataUrl(source, width, height, quality) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext("2d", { alpha: false }) || canvas.getContext("2d");
  if (!ctx) {
    throw new Error("浏览器 Canvas 初始化失败");
  }
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  if ("imageSmoothingQuality" in ctx) {
    ctx.imageSmoothingQuality = "high";
  }
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

function normalizeCompressedFileName(rawName = "") {
  const clean = String(rawName || "image").trim() || "image";
  if (/\.jpe?g$/i.test(clean)) return clean;
  if (/\.[a-z0-9]{2,5}$/i.test(clean)) return clean.replace(/\.[a-z0-9]{2,5}$/i, ".jpg");
  return `${clean}.jpg`;
}

export async function compressImageFileForUpload(file, options = {}) {
  if (!file) {
    throw new Error("未检测到图片文件");
  }
  const sourceBytes = Number(file.size) || 0;
  if (sourceBytes > MAX_SOURCE_FILE_BYTES) {
    throw new Error("图片文件过大（超过 25MB），请裁剪后重试");
  }

  const maxDimension = Number(options.maxDimension) || DEFAULT_MAX_IMAGE_DIMENSION;
  const targetBytes = Number(options.targetBytes) || TARGET_IMAGE_BYTES;
  const hardMaxBytes = Number(options.hardMaxBytes) || HARD_MAX_IMAGE_BYTES;
  const rawName = String(file.name || "image.png");
  const mimeType = String(file.type || "").toLowerCase();

  let decoded = null;
  try {
    decoded = await decodeImageSource(file);
  } catch {
    decoded = null;
  }

  if (!decoded) {
    if (FALLBACK_PASSTHROUGH_MIME_RE.test(mimeType) && sourceBytes <= hardMaxBytes) {
      const dataUrl = await readFileAsDataUrl(file);
      const byteLength = estimateDataUrlBytes(dataUrl) || sourceBytes;
      if (byteLength > hardMaxBytes) {
        throw new Error(`图片压缩后仍超过 ${formatByteSize(hardMaxBytes)}，请裁剪局部区域后再发送`);
      }
      return {
        name: rawName,
        dataUrl,
        byteLength,
        width: 0,
        height: 0,
        compressed: false,
      };
    }
    throw new Error("当前浏览器无法解析该图片格式（如 HEIC），请截图或转为 JPG/PNG 后发送");
  }

  try {
    const { width, height, scaled } = computeScaledDimensions(decoded.width, decoded.height, maxDimension);
    if (shouldKeepOriginalImageDataUrl({ mimeType, byteLength: sourceBytes, scaled })) {
      const dataUrl = await readFileAsDataUrl(file);
      const byteLength = estimateDataUrlBytes(dataUrl) || sourceBytes;
      return {
        name: rawName,
        dataUrl,
        byteLength,
        width: decoded.width,
        height: decoded.height,
        compressed: false,
      };
    }

    let bestDataUrl = "";
    let bestBytes = Infinity;
    let bestW = width;
    let bestH = height;

    for (const step of COMPRESSION_STEPS) {
      const stepW = Math.max(1, Math.round(width * step.scale));
      const stepH = Math.max(1, Math.round(height * step.scale));
      const candidateUrl = encodeCanvasToJpegDataUrl(decoded.source, stepW, stepH, step.quality);
      const candidateBytes = estimateDataUrlBytes(candidateUrl);
      if (!bestDataUrl || candidateBytes < bestBytes) {
        bestDataUrl = candidateUrl;
        bestBytes = candidateBytes;
        bestW = stepW;
        bestH = stepH;
      }
      if (candidateBytes <= targetBytes) {
        break;
      }
    }

    if (!bestDataUrl || !Number.isFinite(bestBytes)) {
      throw new Error("图片压缩失败，请更换图片后重试");
    }
    if (bestBytes > hardMaxBytes) {
      throw new Error(`图片压缩后仍超过 ${formatByteSize(hardMaxBytes)}，请裁剪局部区域后再发送`);
    }

    return {
      name: normalizeCompressedFileName(rawName),
      dataUrl: bestDataUrl,
      byteLength: bestBytes,
      width: bestW,
      height: bestH,
      compressed: true,
    };
  } finally {
    decoded.close?.();
  }
}
