function escapeSlashHtml(value = "") {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Only trigger slash popup at the start of text or after a newline/whitespace before `/...`,
 * so typing paths like `src/app.js` never pops up the command menu.
 */
export function parseSlashTrigger(text = "", cursorPos = null) {
  const source = String(text ?? "");
  const pos = cursorPos === null || cursorPos === undefined
    ? source.length
    : Math.max(0, Math.min(source.length, Number(cursorPos) || 0));
  const before = source.slice(0, pos);
  const match = before.match(/(?:^|\n)([/$])([^\s/$]*)$/);
  if (!match) return null;
  const triggerPrefix = match[1];
  const query = match[2] || "";
  const tokenStart = before.length - (triggerPrefix.length + query.length);
  return {
    triggerPrefix,
    query,
    start: tokenStart,
    end: pos,
  };
}

export function filterSlashCommands(items = [], query = "", { maxItems = 12 } = {}) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  const cleanQuery = String(query || "").trim().replace(/^[/$\s]+/, "").toLowerCase();
  if (!cleanQuery) {
    return list.filter((item) => item.pinned !== false).slice(0, maxItems);
  }
  const scored = [];
  for (const item of list) {
    const cmd = String(item.command || "").toLowerCase();
    const cmdBare = cmd.replace(/^[/$\s]+/, "");
    const desc = String(item.description || "").toLowerCase();
    let score = 0;
    if (cmdBare === cleanQuery) score = 100;
    else if (cmdBare.startsWith(cleanQuery)) score = 80;
    else if (cmdBare.includes(cleanQuery)) score = 60;
    else if (desc.includes(cleanQuery)) score = 30;
    if (score > 0) scored.push({ item, score });
  }
  scored.sort((a, b) => (b.score - a.score) || ((b.item.priority || 0) - (a.item.priority || 0)));
  return scored.slice(0, maxItems).map((x) => x.item);
}

export function applySlashCommandSelection(text = "", commandItem = null, trigger = null) {
  const source = String(text ?? "");
  const insertText = String(commandItem?.insertText || commandItem?.command || "");
  if (!insertText) return { text: source, cursorPos: source.length };
  if (trigger && Number.isInteger(trigger.start) && Number.isInteger(trigger.end)) {
    const head = source.slice(0, trigger.start);
    const tail = source.slice(trigger.end);
    const nextText = `${head}${insertText}${tail}`;
    return {
      text: nextText,
      cursorPos: head.length + insertText.length,
    };
  }
  const trimmedHead = source.trim() ? `${source.replace(/\s+$/, "")}\n` : "";
  const nextText = `${trimmedHead}${insertText}`;
  return {
    text: nextText,
    cursorPos: nextText.length,
  };
}

export function renderSlashMenuHtml(items = [], activeIndex = 0) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) return "";
  const safeIndex = Math.max(0, Math.min(list.length - 1, Number(activeIndex) || 0));
  return `
    <div class="slash-menu-head">
      <span>常用指令</span>
      <span class="slash-menu-hint">↑↓ 选择 · Enter/Tab 填入</span>
    </div>
    <div class="slash-menu-list">
      ${list.map((item, idx) => {
        const activeClass = idx === safeIndex ? " is-active" : "";
        const badgeClass = `is-${escapeSlashHtml(item.category || "native")}`;
        return `
          <button
            type="button"
            class="slash-command-item${activeClass}"
            role="option"
            aria-selected="${idx === safeIndex ? "true" : "false"}"
            data-slash-index="${idx}"
            data-slash-id="${escapeSlashHtml(item.id || item.command)}"
          >
            <span class="slash-command-main">
              <span class="slash-command-name">${escapeSlashHtml(item.label || item.command)}</span>
              <span class="slash-command-desc">${escapeSlashHtml(item.description || "")}</span>
            </span>
            <span class="slash-badge ${badgeClass}">${escapeSlashHtml(item.categoryLabel || "指令")}</span>
          </button>
        `;
      }).join("")}
    </div>
  `;
}
