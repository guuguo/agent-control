const TRANSIENT_STATE_CLASSES = new Set([
  "is-entering",
  "is-live",
  "is-running",
  "is-busy",
  "is-scanning",
  "is-pulsing",
  "is-urgent",
  "is-active",
  "is-selected",
  "is-open",
  "is-closed",
  "is-expanded",
  "is-collapsed",
  "is-streaming",
  "is-recording",
  "is-transcribing",
  "has-live",
  "has-pending",
  "tone-idle",
  "tone-coin",
  "tone-urgent",
]);

function stableClassSignature(el) {
  const list = el?.classList ? Array.from(el.classList) : [];
  if (!list.length) return "";
  return list
    .filter((c) => c && !TRANSIENT_STATE_CLASSES.has(c))
    .sort()
    .join(".");
}

function nextOccurrenceKey(baseKey, seenMap) {
  const count = seenMap.get(baseKey) || 0;
  seenMap.set(baseKey, count + 1);
  return `${baseKey}#${count}`;
}

export function buildElementStateKey(el, seenMap = new Map()) {
  if (!el) return "";
  const id = typeof el.id === "string" ? el.id.trim() : "";
  if (id) return nextOccurrenceKey(`id:${id}`, seenMap);
  const tag = String(el.tagName || "div").toLowerCase();
  const cls = stableClassSignature(el);
  const topicId = el.getAttribute?.("data-mo-topic-id") || "";
  if (topicId) return nextOccurrenceKey(`topic:${topicId}:${tag}.${cls}`, seenMap);
  const aria = el.getAttribute?.("aria-label") || "";
  if (aria) return nextOccurrenceKey(`aria:${aria}:${tag}.${cls}`, seenMap);
  return nextOccurrenceKey(`${tag}.${cls}`, seenMap);
}

function buildDetailsStateKey(detailsEl, seenMap = new Map()) {
  const id = typeof detailsEl.id === "string" ? detailsEl.id.trim() : "";
  if (id) return nextOccurrenceKey(`details-id:${id}`, seenMap);
  const cls = stableClassSignature(detailsEl);
  const sumEl = detailsEl.querySelector?.(":scope > summary");
  // Strip live numeric counters so summary text stays stable when counts change
  const sumTxt = String(sumEl?.textContent || "")
    .replace(/\s+/g, " ")
    .replace(/\d+/g, "#")
    .trim()
    .slice(0, 48);
  return nextOccurrenceKey(`details:${cls}:${sumTxt}`, seenMap);
}

export function captureSubtreeUiState(root) {
  if (!root) return null;
  const openDetails = new Set();
  const detailsSeen = new Map();
  const rootIsDetails = String(root.tagName || "").toUpperCase() === "DETAILS";
  const rootOpen = rootIsDetails ? Boolean(root.open) : false;

  const allDetails = root.querySelectorAll ? root.querySelectorAll("details") : [];
  for (const d of allDetails) {
    const k = buildDetailsStateKey(d, detailsSeen);
    if (d.open) openDetails.add(k);
  }

  const scrolls = new Map();
  const scrollSeen = new Map();
  const rootTop = Number(root.scrollTop) || 0;
  const rootLeft = Number(root.scrollLeft) || 0;
  const rootAtBottom = (Number(root.scrollHeight) || 0) - rootTop - (Number(root.clientHeight) || 0) <= 24;

  let focus = null;
  const activeEl = typeof document !== "undefined" ? document.activeElement : null;
  const checkFocus = activeEl && (activeEl === root || Boolean(root.contains?.(activeEl)));

  const allNodes = root.querySelectorAll ? root.querySelectorAll("*") : [];
  for (const node of allNodes) {
    const key = buildElementStateKey(node, scrollSeen);
    const top = Number(node.scrollTop) || 0;
    const left = Number(node.scrollLeft) || 0;
    if (top > 0 || left > 0) {
      const sh = Number(node.scrollHeight) || 0;
      const ch = Number(node.clientHeight) || 0;
      scrolls.set(key, {
        top,
        left,
        atBottom: sh > 0 ? (sh - top - ch <= 24) : false,
      });
    }
    if (checkFocus && node === activeEl) {
      const tag = String(node.tagName || "").toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        let selStart = null;
        let selEnd = null;
        try {
          if (typeof node.selectionStart === "number") selStart = node.selectionStart;
          if (typeof node.selectionEnd === "number") selEnd = node.selectionEnd;
        } catch {}
        focus = {
          id: node.id || "",
          key,
          selStart,
          selEnd,
        };
      }
    }
  }

  return {
    rootIsDetails,
    rootOpen,
    rootTop,
    rootLeft,
    rootAtBottom,
    openDetails,
    scrolls,
    focus,
  };
}

function applyScrollInstant(node, top, left) {
  if (!node) return;
  const prevBehavior = node.style ? node.style.scrollBehavior : "";
  if (node.style) node.style.scrollBehavior = "auto";
  if (top > 0) node.scrollTop = top;
  if (left > 0) node.scrollLeft = left;
  if (node.style) node.style.scrollBehavior = prevBehavior;
}

export function restoreSubtreeUiState(root, snap, { skipIds = null, restoreFocus = true } = {}) {
  if (!root || !snap) return;

  if (snap.rootIsDetails && snap.rootOpen) {
    root.open = true;
  }
  if (snap.openDetails?.size && root.querySelectorAll) {
    const detailsSeen = new Map();
    for (const d of root.querySelectorAll("details")) {
      const k = buildDetailsStateKey(d, detailsSeen);
      if (snap.openDetails.has(k)) d.open = true;
    }
  }

  if (snap.rootTop > 0 || snap.rootLeft > 0) {
    if (!(skipIds && root.id && skipIds.has(root.id))) {
      applyScrollInstant(root, snap.rootTop, snap.rootLeft);
    }
  }

  let focusTarget = null;
  if ((snap.scrolls?.size || (restoreFocus && snap.focus)) && root.querySelectorAll) {
    const scrollSeen = new Map();
    for (const node of root.querySelectorAll("*")) {
      const key = buildElementStateKey(node, scrollSeen);
      const saved = snap.scrolls?.get(key);
      if (saved && !(skipIds && node.id && skipIds.has(node.id))) {
        applyScrollInstant(node, saved.top, saved.left);
      }
      if (restoreFocus && snap.focus && !focusTarget) {
        if ((snap.focus.id && node.id === snap.focus.id) || key === snap.focus.key) {
          focusTarget = node;
        }
      }
    }
  }

  if (restoreFocus && focusTarget && typeof focusTarget.focus === "function") {
    try {
      if (typeof document === "undefined" || document.activeElement !== focusTarget) {
        focusTarget.focus({ preventScroll: true });
      }
      if (typeof snap.focus.selStart === "number" && typeof focusTarget.setSelectionRange === "function") {
        focusTarget.setSelectionRange(snap.focus.selStart, snap.focus.selEnd ?? snap.focus.selStart);
      }
    } catch {}
  }
}

export function replaceHtmlPreservingUiState(containerEl, nextHtml, opts = {}) {
  if (!containerEl) return false;
  const htmlStr = String(nextHtml ?? "");
  if (containerEl._acLastHtml === htmlStr) return false;
  const snap = captureSubtreeUiState(containerEl);
  containerEl._acLastHtml = htmlStr;
  containerEl.innerHTML = htmlStr;
  restoreSubtreeUiState(containerEl, snap, opts);
  return true;
}
