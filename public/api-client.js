export function resolveAppBaseUrl() {
  if (typeof document !== "undefined" && document.baseURI) {
    return document.baseURI;
  }
  if (typeof globalThis.location !== "undefined" && globalThis.location?.href) {
    return globalThis.location.href;
  }
  return "http://127.0.0.1/";
}

export function isDemoMode() {
  try {
    return typeof globalThis.location !== "undefined"
      && new URLSearchParams(globalThis.location.search || "").get("demo") === "1";
  } catch {
    return false;
  }
}

export function apiUrl(path, base = resolveAppBaseUrl()) {
  const clean = String(path || "").replace(/^\/+/, "");
  return new URL(clean, base).toString();
}

const MAX_ETAG_CACHE_ENTRIES = 48;
const MAX_SINGLE_CACHE_CHARS = 2_500_000;
const MAX_TOTAL_CACHE_CHARS = 6_000_000;
const getEtagCache = new Map();
let getEtagCacheChars = 0;

export function clearApiEtagCache() {
  getEtagCache.clear();
  getEtagCacheChars = 0;
}

function deleteEtagCacheEntry(key) {
  const existing = getEtagCache.get(key);
  if (!existing) return;
  getEtagCacheChars = Math.max(0, getEtagCacheChars - existing.rawText.length);
  getEtagCache.delete(key);
}

function touchEtagCacheEntry(key, entry) {
  getEtagCache.delete(key);
  getEtagCache.set(key, entry);
}

function setEtagCacheEntry(key, etag, rawText) {
  if (!key || !etag || !rawText || rawText.length > MAX_SINGLE_CACHE_CHARS) {
    deleteEtagCacheEntry(key);
    return;
  }
  deleteEtagCacheEntry(key);
  while (
    getEtagCache.size >= MAX_ETAG_CACHE_ENTRIES
    || (getEtagCache.size > 0 && (getEtagCacheChars + rawText.length) > MAX_TOTAL_CACHE_CHARS)
  ) {
    const oldestKey = getEtagCache.keys().next().value;
    if (oldestKey === undefined) break;
    deleteEtagCacheEntry(oldestKey);
  }
  getEtagCache.set(key, { etag, rawText });
  getEtagCacheChars += rawText.length;
}

export async function apiRequest(path, { method = "GET", body = null, signal, timeoutMs = 0, useEtagCache = true } = {}) {
  if (isDemoMode()) {
    const { handleDemoApiRequest } = await import("./demo-fixtures.js");
    return handleDemoApiRequest(path, { method, body });
  }
  const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : 0;
  let controller = null;
  let timer = null;
  let timedOut = false;
  let cleanupSignal = null;

  if (timeout > 0) {
    controller = new AbortController();
    if (signal) {
      if (signal.aborted) {
        controller.abort(signal.reason);
      } else {
        const onAbort = () => controller.abort(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        cleanupSignal = () => signal.removeEventListener("abort", onAbort);
      }
    }
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeout);
  }

  const url = apiUrl(path);
  const methodUpper = String(method || "GET").toUpperCase();
  const isCacheableGet = methodUpper === "GET" && (body === null || body === undefined) && useEtagCache !== false;
  const cached = isCacheableGet ? getEtagCache.get(url) : null;

  const options = {
    method: methodUpper,
    headers: { Accept: "application/json" },
    credentials: "same-origin",
    signal: controller ? controller.signal : signal,
  };
  if (isCacheableGet) {
    options.cache = "no-store";
    if (cached?.etag) {
      options.headers["If-None-Match"] = cached.etag;
    }
  }
  if (body !== null && body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(url, options);
    if (response.status === 304 && cached) {
      touchEtagCacheEntry(url, cached);
      return JSON.parse(cached.rawText);
    }
    const contentType = String(response.headers?.get?.("content-type") || "");
    let data = null;
    let rawJsonText = "";
    if (contentType.includes("application/json")) {
      if (typeof response.text === "function") {
        rawJsonText = await response.text().catch(() => "");
        if (rawJsonText) {
          try {
            data = JSON.parse(rawJsonText);
          } catch {
            data = null;
            rawJsonText = "";
          }
        }
      } else if (typeof response.json === "function") {
        data = await response.json().catch(() => null);
        if (data !== null) {
          rawJsonText = JSON.stringify(data);
        }
      }
    } else {
      const text = await response.text?.().catch(() => "");
      data = text ? { message: text } : null;
    }
    if (!response.ok) {
      const message = data?.error?.message || data?.message || `请求失败（HTTP ${response.status}）`;
      const error = new Error(message);
      error.status = response.status;
      error.code = data?.error?.code || null;
      error.data = data;
      throw error;
    }
    if (isCacheableGet && rawJsonText) {
      const etag = String(response.headers?.get?.("etag") || "").trim();
      if (etag) {
        setEtagCacheEntry(url, etag, rawJsonText);
      }
    }
    return data;
  } catch (error) {
    if (timedOut) {
      const timeoutError = new Error("请求发送超时，远控网络较慢或连接中断，请检查连接后重试");
      timeoutError.status = 504;
      timeoutError.code = "request_timeout";
      throw timeoutError;
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (cleanupSignal) cleanupSignal();
  }
}

export function apiGet(path, options = {}) {
  return apiRequest(path, { ...options, method: "GET" });
}

export function apiPost(path, body = {}, options = {}) {
  return apiRequest(path, { ...options, method: "POST", body });
}

export function isHostOfflineError(error) {
  return error?.status === 503 || error?.code === "host_offline" || error?.code === "host_disconnected";
}
