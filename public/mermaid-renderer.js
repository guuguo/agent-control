import { apiUrl } from "./api-client.js";

const MAX_SVG_CACHE = 120;
const svgCache = new Map();
let loadLibraryPromise = null;
let renderQueue = Promise.resolve();
let initializedTheme = "";
let initializedLib = null;
let renderSeq = 0;
let previewSeq = 0;

const MERMAID_TYPE_LABELS = [
  [/^(?:flowchart|graph)(?:\s|$)/i, "流程图"],
  [/^sequenceDiagram(?:\s|$)/i, "时序图"],
  [/^stateDiagram(?:-v2)?(?:\s|$)/i, "状态图"],
  [/^classDiagram(?:-v2)?(?:\s|$)/i, "类图"],
  [/^erDiagram(?:\s|$)/i, "ER 图"],
  [/^gantt(?:\s|$)/i, "甘特图"],
  [/^pie(?:\s|$)/i, "饼图"],
  [/^mindmap(?:\s|$)/i, "思维导图"],
  [/^timeline(?:\s|$)/i, "时间线"],
  [/^xychart-beta(?:\s|$)/i, "图表"],
  [/^gitGraph(?:\s|$)/i, "Git 图"],
  [/^journey(?:\s|$)/i, "旅程图"],
  [/^quadrantChart(?:\s|$)/i, "象限图"],
  [/^architecture-beta(?:\s|$)/i, "架构图"],
];

export function normalizeMermaidSource(code = "") {
  return String(code ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

export function detectMermaidDiagramLabel(code = "") {
  const lines = normalizeMermaidSource(code).split("\n");
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("%%")) continue;
    for (const [pattern, label] of MERMAID_TYPE_LABELS) {
      if (pattern.test(trimmed)) return label;
    }
    break;
  }
  return "";
}

export function buildMermaidInitConfig(theme = "dark") {
  const isLight = theme === "light";
  return {
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    theme: isLight ? "default" : "dark",
    darkMode: !isLight,
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
    flowchart: {
      htmlLabels: true,
      useMaxWidth: true,
      curve: "basis",
    },
    sequence: {
      useMaxWidth: true,
    },
    themeVariables: isLight
      ? {
          background: "transparent",
          fontSize: "13px",
          primaryColor: "#eff6ff",
          primaryBorderColor: "#93c5fd",
          primaryTextColor: "#0f172a",
          lineColor: "#64748b",
          secondaryColor: "#f8fafc",
          tertiaryColor: "#f1f5f9",
        }
      : {
          background: "transparent",
          fontSize: "13px",
          primaryColor: "#172438",
          primaryBorderColor: "#4c8dff",
          primaryTextColor: "#e6edf3",
          lineColor: "#8b9bb4",
          secondaryColor: "#131c2b",
          tertiaryColor: "#0e1522",
        },
  };
}

export function extractMermaidErrorMessage(error) {
  const raw = String(error?.str || error?.message || error || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return "";
  return raw.length > 160 ? `${raw.slice(0, 159).trim()}…` : raw;
}

export function resetMermaidRenderCache() {
  svgCache.clear();
  initializedTheme = "";
  initializedLib = null;
}

function getCachedSvg(key) {
  if (!svgCache.has(key)) return null;
  const val = svgCache.get(key);
  svgCache.delete(key);
  svgCache.set(key, val);
  return val;
}

function setCachedSvg(key, svg) {
  if (!key || !svg) return;
  if (svgCache.has(key)) svgCache.delete(key);
  while (svgCache.size >= MAX_SVG_CACHE) {
    const oldest = svgCache.keys().next().value;
    if (oldest === undefined) break;
    svgCache.delete(oldest);
  }
  svgCache.set(key, svg);
}

function cleanupStrayMermaidDom(renderId) {
  if (typeof document === "undefined" || !renderId) return;
  try {
    document.getElementById(`d${renderId}`)?.remove?.();
    document.getElementById(renderId)?.remove?.();
  } catch {}
}

export async function loadMermaidLibrary() {
  if (globalThis.mermaid && typeof globalThis.mermaid.render === "function") {
    return globalThis.mermaid;
  }
  if (loadLibraryPromise) return loadLibraryPromise;
  if (typeof document === "undefined" || !document.head) {
    throw new Error("当前环境不支持加载 Mermaid 渲染引擎");
  }
  loadLibraryPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = apiUrl("vendor/mermaid.min.js");
    script.async = true;
    script.onload = () => {
      if (globalThis.mermaid && typeof globalThis.mermaid.render === "function") {
        resolve(globalThis.mermaid);
      } else {
        loadLibraryPromise = null;
        reject(new Error("Mermaid 引擎初始化失败"));
      }
    };
    script.onerror = () => {
      loadLibraryPromise = null;
      reject(new Error("Mermaid 脚本加载失败"));
    };
    document.head.appendChild(script);
  });
  return loadLibraryPromise;
}

function applyRenderedSvg(block, svg, theme, bindFunctions = null) {
  if (!block || block.isConnected === false) return;
  const stage = block.querySelector("[data-mermaid-stage]");
  const sourceEl = block.querySelector("pre.md-mermaid-source");
  const errorEl = block.querySelector("[data-mermaid-error]");
  const toggleBtn = block.querySelector("[data-mermaid-toggle]");
  const zoomBtn = block.querySelector("[data-mermaid-zoom]");

  const showSource = block.dataset?.mermaidView === "source";
  if (stage) {
    stage.innerHTML = svg;
    stage.hidden = showSource;
    if (typeof bindFunctions === "function" && !showSource) {
      try {
        bindFunctions(stage);
      } catch {}
    }
  }
  if (sourceEl) sourceEl.hidden = !showSource;
  if (errorEl) {
    errorEl.hidden = true;
    errorEl.textContent = "";
  }
  if (zoomBtn) zoomBtn.hidden = false;
  if (toggleBtn) {
    toggleBtn.hidden = false;
    toggleBtn.disabled = false;
    toggleBtn.textContent = showSource ? "图表" : "源码";
    toggleBtn.setAttribute?.("aria-pressed", showSource ? "true" : "false");
  }
  if (block.dataset) {
    block.dataset.mermaidState = "rendered";
    block.dataset.mermaidTheme = theme;
  }
}

function applyErrorFallback(block, error, theme) {
  if (!block || block.isConnected === false) return;
  const stage = block.querySelector("[data-mermaid-stage]");
  const sourceEl = block.querySelector("pre.md-mermaid-source");
  const errorEl = block.querySelector("[data-mermaid-error]");
  const toggleBtn = block.querySelector("[data-mermaid-toggle]");
  const zoomBtn = block.querySelector("[data-mermaid-zoom]");

  if (stage) {
    stage.hidden = true;
    stage.innerHTML = "";
  }
  if (sourceEl) sourceEl.hidden = false;
  if (zoomBtn) zoomBtn.hidden = true;
  if (toggleBtn) toggleBtn.hidden = true;
  const detail = extractMermaidErrorMessage(error);
  if (errorEl) {
    errorEl.hidden = false;
    errorEl.textContent = detail
      ? `图表语法暂无法渲染，已展示源码（${detail}）`
      : "图表语法暂无法渲染，已展示源码";
  }
  if (block.dataset) {
    block.dataset.mermaidState = "error";
    block.dataset.mermaidView = "source";
    block.dataset.mermaidTheme = theme;
  }
}

function renderWithQueue(lib, source, theme) {
  const run = async () => {
    if (initializedLib !== lib || initializedTheme !== theme) {
      lib.initialize?.(buildMermaidInitConfig(theme));
      initializedLib = lib;
      initializedTheme = theme;
    }
    const renderId = `ac-mermaid-${++renderSeq}`;
    try {
      const result = await lib.render(renderId, source);
      const svg = String(result?.svg || "").trim();
      if (!svg || !svg.includes("<svg")) {
        throw new Error("图表生成结果为空");
      }
      return { svg, bindFunctions: result?.bindFunctions || null };
    } finally {
      cleanupStrayMermaidDom(renderId);
    }
  };
  const next = renderQueue.then(run, run);
  renderQueue = next.catch(() => {});
  return next;
}

export async function hydrateMermaidBlocks(
  root = typeof document !== "undefined" ? document : null,
  { forceThemeSync = false, mermaidRuntime = null, theme = "" } = {},
) {
  const summary = { rendered: 0, cached: 0, errors: 0, skipped: 0 };
  if (!root || typeof root.querySelectorAll !== "function") return summary;

  const blocks = Array.from(root.querySelectorAll("[data-mermaid-block]"));
  if (!blocks.length) return summary;

  const currentTheme = theme
    || (typeof document !== "undefined" && document?.documentElement?.dataset?.theme === "light" ? "light" : "dark");

  const work = [];
  for (const block of blocks) {
    const state = block.dataset?.mermaidState || "";
    const prevTheme = block.dataset?.mermaidTheme || "";
    if (state === "streaming") {
      summary.skipped += 1;
      continue;
    }
    if (state === "rendered" && prevTheme === currentTheme) {
      summary.skipped += 1;
      continue;
    }
    if (state === "error" && !forceThemeSync && prevTheme === currentTheme) {
      summary.skipped += 1;
      continue;
    }
    const source = normalizeMermaidSource(block.querySelector("pre > code")?.textContent || "");
    if (!source) {
      applyErrorFallback(block, new Error("图表内容为空"), currentTheme);
      summary.errors += 1;
      continue;
    }
    const cacheKey = `${currentTheme}::${source}`;
    const cachedSvg = getCachedSvg(cacheKey);
    if (cachedSvg) {
      applyRenderedSvg(block, cachedSvg, currentTheme);
      summary.cached += 1;
      continue;
    }
    work.push({ block, source, cacheKey });
  }

  if (!work.length) return summary;

  let lib;
  try {
    lib = mermaidRuntime || await loadMermaidLibrary();
  } catch (loadError) {
    for (const item of work) {
      applyErrorFallback(item.block, loadError, currentTheme);
      summary.errors += 1;
    }
    return summary;
  }

  for (const item of work) {
    if (item.block.isConnected === false) {
      summary.skipped += 1;
      continue;
    }
    try {
      const { svg, bindFunctions } = await renderWithQueue(lib, item.source, currentTheme);
      setCachedSvg(item.cacheKey, svg);
      applyRenderedSvg(item.block, svg, currentTheme, bindFunctions);
      summary.rendered += 1;
    } catch (renderError) {
      applyErrorFallback(item.block, renderError, currentTheme);
      summary.errors += 1;
    }
  }
  return summary;
}

function parseSvgNumericAttr(attrs = "", attrName = "") {
  const m = String(attrs || "").match(new RegExp(`\\b${attrName}=(["'])\\s*([\\d.]+)(?:px)?\\s*\\1`, "i"));
  const val = m ? Number(m[2]) : NaN;
  return Number.isFinite(val) && val > 0 ? val : 0;
}

export function prepareMermaidSvgForPreview(svgHtml = "", { previewId = "" } = {}) {
  const raw = String(svgHtml || "").trim();
  if (!raw || !raw.includes("<svg")) {
    throw new Error("未找到有效的 Mermaid SVG 内容");
  }
  const nextId = String(previewId || `ac-mermaid-preview-${++previewSeq}`).trim();
  let output = raw;

  const openTagMatch = output.match(/<svg\b([^>]*)>/i);
  const openAttrs = openTagMatch?.[1] || "";
  const idMatch = openAttrs.match(/\bid=(["'])([^"']+)\1/i);
  const oldId = idMatch?.[2] || "";

  if (oldId && oldId !== nextId) {
    const escapedOld = oldId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    output = output
      .replace(new RegExp(`(\\b(?:id|for|aria-labelledby|aria-describedby)=["'])${escapedOld}(?![a-zA-Z0-9])`, "g"), `$1${nextId}`)
      .replace(new RegExp(`#${escapedOld}(?![a-zA-Z0-9])`, "g"), `#${nextId}`);
  }

  const vbMatch = openAttrs.match(/\bviewBox=(["'])\s*[\d.+-]+[\s,]+[\d.+-]+[\s,]+([\d.+-]+)[\s,]+([\d.+-]+)\s*\1/i);
  let viewWidth = vbMatch ? Number(vbMatch[2]) : parseSvgNumericAttr(openAttrs, "width");
  let viewHeight = vbMatch ? Number(vbMatch[3]) : parseSvgNumericAttr(openAttrs, "height");
  if (!Number.isFinite(viewWidth) || viewWidth <= 0) viewWidth = 0;
  if (!Number.isFinite(viewHeight) || viewHeight <= 0) viewHeight = 0;

  output = output.replace(/<svg\b([^>]*)>/i, (full, attrs) => {
    let nextAttrs = String(attrs || "");
    if (!/\bid=/i.test(nextAttrs)) {
      nextAttrs = ` id="${nextId}"${nextAttrs}`;
    }
    if (viewWidth > 0 && viewHeight > 0) {
      nextAttrs = nextAttrs
        .replace(/\s*\b(?:width|height)=(["'])[^"']*\1/gi, "");
      const styleMatch = nextAttrs.match(/\s*\bstyle=(["'])([^"']*)\1/i);
      const cleanedStyle = (styleMatch?.[2] || "")
        .replace(/\bmax-width\s*:[^;]+;?/gi, "")
        .replace(/\baspect-ratio\s*:[^;]+;?/gi, "")
        .replace(/\bwidth\s*:[^;]+;?/gi, "")
        .replace(/\bheight\s*:[^;]+;?/gi, "")
        .trim()
        .replace(/;+$/, "");
      const ratioStyle = `aspect-ratio: ${viewWidth} / ${viewHeight};`;
      const mergedStyle = cleanedStyle ? `${cleanedStyle}; ${ratioStyle}` : ratioStyle;
      nextAttrs = nextAttrs.replace(/\s*\bstyle=(["'])[^"']*\1/gi, "");
      nextAttrs = `${nextAttrs} width="${viewWidth}" height="${viewHeight}" style="${mergedStyle}"`;
    }
    return `<svg${nextAttrs}>`;
  });

  return {
    svg: output,
    viewWidth,
    viewHeight,
    previewId: nextId,
  };
}
