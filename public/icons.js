const ICON_PATHS = Object.freeze({
  menu: `<path d="M2.5 4.25h11M2.5 8h11M2.5 11.75h11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>`,
  board: `<rect x="2.25" y="2.25" width="4.75" height="4.75" rx="1.2" stroke="currentColor" stroke-width="1.5"/><rect x="9" y="2.25" width="4.75" height="4.75" rx="1.2" stroke="currentColor" stroke-width="1.5"/><rect x="2.25" y="9" width="4.75" height="4.75" rx="1.2" stroke="currentColor" stroke-width="1.5"/><rect x="9" y="9" width="4.75" height="4.75" rx="1.2" stroke="currentColor" stroke-width="1.5"/>`,
  mic: `<rect x="5.75" y="1.75" width="4.5" height="7.5" rx="2.25" stroke="currentColor" stroke-width="1.5"/><path d="M3.25 7.5a4.75 4.75 0 0 0 9.5 0M8 12.25v2M5.75 14.25h4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`,
  stop: `<rect x="3.5" y="3.5" width="9" height="9" rx="1.8" fill="currentColor"/>`,
  steer: `<path d="M3.25 4.25v3.5A2.25 2.25 0 0 0 5.5 10h7M9.75 7.25 12.75 10l-3 2.75" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"/>`,
  pause: `<rect x="4" y="3" width="2.75" height="10" rx="1" fill="currentColor"/><rect x="9.25" y="3" width="2.75" height="10" rx="1" fill="currentColor"/>`,
  more: `<circle cx="3.5" cy="8" r="1.25" fill="currentColor"/><circle cx="8" cy="8" r="1.25" fill="currentColor"/><circle cx="12.5" cy="8" r="1.25" fill="currentColor"/>`,
  close: `<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.65" stroke-linecap="round"/>`,
  target: `<circle cx="8" cy="8" r="5.75" stroke="currentColor" stroke-width="1.45"/><circle cx="8" cy="8" r="3" stroke="currentColor" stroke-width="1.45"/><circle cx="8" cy="8" r="1" fill="currentColor"/>`,
  bolt: `<path d="M9.1 1.75 3.6 9h4.1l-1 5.25 5.7-7.25H8.3l.8-5.25Z" stroke="currentColor" stroke-width="1.45" stroke-linejoin="round"/>`,
  rocket: `<path d="M9.75 2.25c2.1.15 3.85 1.9 4 4-.2 2.4-1.8 4.45-4.15 5.4l-2.6-2.6-2.65-2.65C5.3 4.05 7.35 2.45 9.75 2.25Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><circle cx="9.75" cy="6.25" r="1.15" fill="currentColor"/><path d="M5.25 7.75 2.75 8.5l2 2m3.5.75-.75 2.5-2-2M3.25 12.75l1.5-1.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`,
  edit: `<path d="M11.35 2.4a1.65 1.65 0 0 1 2.33 2.33L5.9 12.5l-3.15.75.75-3.15 7.85-7.7Z" stroke="currentColor" stroke-width="1.45" stroke-linejoin="round"/><path d="M9.85 3.9 12.1 6.15" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/>`,
  shield: `<path d="M8 1.9 13 4v3.8c0 3.1-2.1 5.2-5 6.3-2.9-1.1-5-3.2-5-6.3V4l5-2.1Z" stroke="currentColor" stroke-width="1.45" stroke-linejoin="round"/><path d="M6 8.1 7.45 9.55 10.25 6.5" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/>`,
  compass: `<circle cx="8" cy="8" r="5.75" stroke="currentColor" stroke-width="1.45"/><path d="m10.45 5.55-1.45 3.7-3.45 1.2 1.45-3.7 3.45-1.2Z" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/>`,
  star: `<path d="m8 2.1 1.78 3.6 3.97.58-2.87 2.8.68 3.96L8 11.17l-3.56 1.87.68-3.96-2.87-2.8 3.97-.58L8 2.1Z" stroke="currentColor" stroke-width="1.45" stroke-linejoin="round"/>`,
  "star-filled": `<path d="m8 2.1 1.78 3.6 3.97.58-2.87 2.8.68 3.96L8 11.17l-3.56 1.87.68-3.96-2.87-2.8 3.97-.58L8 2.1Z" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>`,
  plus: `<path d="M8 3.25v9.5M3.25 8h9.5" stroke="currentColor" stroke-width="1.65" stroke-linecap="round"/>`,
  folder: `<path d="M2 4.25A1.5 1.5 0 0 1 3.5 2.75h3l1.35 1.5h4.65A1.5 1.5 0 0 1 14 5.75v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.75v-7.5Z" stroke="currentColor" stroke-width="1.45" stroke-linejoin="round"/>`,
  clipboard: `<rect x="3.5" y="3" width="9" height="10.75" rx="1.4" stroke="currentColor" stroke-width="1.45"/><path d="M6 2.25h4v1.75H6z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M5.75 7.25h4.5M5.75 10h3.25" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>`,
  image: `<rect x="2.25" y="2.75" width="11.5" height="10.5" rx="1.5" stroke="currentColor" stroke-width="1.45"/><circle cx="5.6" cy="6" r="1.1" fill="currentColor"/><path d="m3.5 11.5 3.1-3.1 2.15 2.05 1.65-1.55 2.1 2.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`,
  paperclip: `<path d="M11.75 7.1 6.9 11.95a2.65 2.65 0 0 1-3.75-3.75L8.4 2.95a1.75 1.75 0 0 1 2.48 2.48L5.85 10.45a.88.88 0 0 1-1.24-1.24L9.1 4.72" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/>`,
  settings: `<path d="M2.5 4.75h11M2.5 11.25h11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="5.75" cy="4.75" r="1.65" fill="var(--bg, #0d121a)" stroke="currentColor" stroke-width="1.5"/><circle cx="10.25" cy="11.25" r="1.65" fill="var(--bg, #0d121a)" stroke="currentColor" stroke-width="1.5"/>`,
  refresh: `<path d="M13 6.25A5.25 5.25 0 0 0 3.7 4.65M3 9.75a5.25 5.25 0 0 0 9.3 1.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M13.25 3.1v3.25H10M2.75 12.9V9.65H6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  "chevron-down": `<path d="m4.25 6.25 3.75 3.75 3.75-3.75" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`,
  "chevron-up": `<path d="m4.25 9.75 3.75-3.75 3.75 3.75" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`,
  chat: `<path d="M2.75 4A1.75 1.75 0 0 1 4.5 2.25h7A1.75 1.75 0 0 1 13.25 4v5.5a1.75 1.75 0 0 1-1.75 1.75H6.6l-2.85 2.3v-2.3H4.5A1.75 1.75 0 0 1 2.75 9.5V4Z" stroke="currentColor" stroke-width="1.45" stroke-linejoin="round"/>`,
  bulb: `<path d="M8 2a4.1 4.1 0 0 0-2.55 7.3c.55.44.85 1.04.9 1.7h3.3c.05-.66.35-1.26.9-1.7A4.1 4.1 0 0 0 8 2Z" stroke="currentColor" stroke-width="1.45" stroke-linejoin="round"/><path d="M6.4 13h3.2M6.85 14.5h2.3" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/>`,
  info: `<circle cx="8" cy="8" r="5.75" stroke="currentColor" stroke-width="1.45"/><path d="M8 7.25v4M8 5.1h.01" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>`,
  warning: `<path d="M7.15 2.6a1 1 0 0 1 1.7 0l4.8 8.3A1 1 0 0 1 12.8 12.4H3.2a1 1 0 0 1-.85-1.5l4.8-8.3Z" stroke="currentColor" stroke-width="1.45" stroke-linejoin="round"/><path d="M8 6v3.1M8 10.95h.01" stroke="currentColor" stroke-width="1.55" stroke-linecap="round"/>`,
  error: `<circle cx="8" cy="8" r="5.75" stroke="currentColor" stroke-width="1.45"/><path d="M5.75 5.75 10.25 10.25M10.25 5.75 5.75 10.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`,
  speaker: `<path d="M2.75 6.25h2.4l3.35-2.8v9.1l-3.35-2.8h-2.4v-3.5Z" stroke="currentColor" stroke-width="1.45" stroke-linejoin="round"/><path d="M10.9 5.5a3.7 3.7 0 0 1 0 5M12.7 3.85a6.1 6.1 0 0 1 0 8.3" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/>`,
  "speaker-off": `<path d="M2.75 6.25h2.4l3.35-2.8v9.1l-3.35-2.8h-2.4v-3.5Z" stroke="currentColor" stroke-width="1.45" stroke-linejoin="round"/><path d="m10.75 6 3.5 4m0-4-3.5 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`,
  radio: `<circle cx="8" cy="8.5" r="1.25" fill="currentColor"/><path d="M5.4 6.05a3.7 3.7 0 0 0 0 4.9M10.6 6.05a3.7 3.7 0 0 1 0 4.9M3.55 4.2a6.25 6.25 0 0 0 0 8.6M12.45 4.2a6.25 6.25 0 0 1 0 8.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>`,
  bell: `<path d="M4.25 6.75a3.75 3.75 0 1 1 7.5 0c0 2.65.9 3.7 1.5 4.25H2.75c.6-.55 1.5-1.6 1.5-4.25Z" stroke="currentColor" stroke-width="1.45" stroke-linejoin="round"/><path d="M6.65 12.75a1.5 1.5 0 0 0 2.7 0" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/>`,
  keyboard: `<rect x="1.75" y="4" width="12.5" height="8" rx="1.4" stroke="currentColor" stroke-width="1.45"/><path d="M4.25 6.75h.5m2 0h.5m2 0h.5m2 0h.5M4.75 9.5h6.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`,
  offline: `<path d="M2.25 12.75 13.75 3.25M4.5 10.85a4.6 4.6 0 0 1 5.65-5.65M11.65 10.65a4.6 4.6 0 0 1-5.15 1.1" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/>`,
  check: `<path d="m3.5 8.25 3 3 6-6.25" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/>`,
  clock: `<circle cx="8" cy="8" r="5.75" stroke="currentColor" stroke-width="1.45"/><path d="M8 4.75v3.5l2.35 1.45" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/>`,
  list: `<path d="M5 4.5h8M5 8h8M5 11.5h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="2.75" cy="4.5" r=".85" fill="currentColor"/><circle cx="2.75" cy="8" r=".85" fill="currentColor"/><circle cx="2.75" cy="11.5" r=".85" fill="currentColor"/>`,
  pin: `<path d="M5.25 2.75h5.5l-.8 3.6 1.8 1.9v1.1H8.6v3.9l-.6.75-.6-.75v-3.9H4.25v-1.1l1.8-1.9-.8-3.6Z" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/>`,
  archive: `<rect x="2" y="2.75" width="12" height="3" rx="1" stroke="currentColor" stroke-width="1.45"/><path d="M3.25 5.75v6.25a1.5 1.5 0 0 0 1.5 1.5h6.5a1.5 1.5 0 0 0 1.5-1.5V5.75M6.5 8.5h3" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/>`,
  minus: `<path d="M4 8h8" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>`,
  film: `<rect x="2" y="2.75" width="12" height="10.5" rx="1.6" stroke="currentColor" stroke-width="1.45"/><path d="M5 2.75v10.5M11 2.75v10.5M2 6h3m6 0h3M2 10h3m6 0h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="m7 6.3 2.5 1.7L7 9.7V6.3Z" fill="currentColor"/>`,
  "external-link": `<path d="M6.5 3.25H3.75A1.5 1.5 0 0 0 2.25 4.75v7.5a1.5 1.5 0 0 0 1.5 1.5h7.5a1.5 1.5 0 0 0 1.5-1.5V9.5" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/><path d="M9.5 2.25h4.25V6.5M13.6 2.4 7.75 8.25" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/>`,
  fork: `<circle cx="4.75" cy="3.75" r="1.5" stroke="currentColor" stroke-width="1.45"/><circle cx="4.75" cy="12.25" r="1.5" stroke="currentColor" stroke-width="1.45"/><circle cx="11.25" cy="5.75" r="1.5" stroke="currentColor" stroke-width="1.45"/><path d="M4.75 5.25v5.5M4.75 9.5c0-1.9 6.5-1.15 6.5-2.25" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/>`,
});

const PROVIDER_ICON_PATHS = Object.freeze({
  antigravity: `<path d="M8 1.5 9.65 6.35 14.5 8 9.65 9.65 8 14.5 6.35 9.65 1.5 8 6.35 6.35 8 1.5Z" fill="currentColor"/>`,
  codex: `<path d="M8 1.85 13.3 4.9v6.2L8 14.15 2.7 11.1V4.9L8 1.85Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="m5.9 6.6 2.1 1.4-2.1 1.4M8.5 9.5h2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`,
  claude: `<path d="M8 1.8v12.4M1.8 8h12.4M3.6 3.6l8.8 8.8M12.4 3.6l-8.8 8.8" stroke="currentColor" stroke-width="1.65" stroke-linecap="round"/><circle cx="8" cy="8" r="1.45" fill="currentColor"/>`,
  grok: `<path d="M3.2 2.8 12.8 13.2M6.2 2.8l6.6 10.4M12.5 2.8 3.5 13.2" stroke="currentColor" stroke-width="1.55" stroke-linecap="round"/>`,
  default: `<circle cx="8" cy="8" r="4.5" stroke="currentColor" stroke-width="1.6"/><circle cx="8" cy="8" r="1.5" fill="currentColor"/>`,
});

function escapeAttr(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function iconSvg(name, opts = {}) {
  const key = String(name || "").trim();
  const body = ICON_PATHS[key] || ICON_PATHS.info;
  const size = Number.isFinite(Number(opts.size)) ? Math.max(10, Number(opts.size)) : 14;
  const extraClass = opts.className ? ` ${String(opts.className).trim()}` : "";
  const titleAttr = opts.title ? ` aria-label="${escapeAttr(opts.title)}"` : ` aria-hidden="true"`;
  return `<svg class="ac-icon ac-icon-${escapeAttr(key)}${escapeAttr(extraClass)}" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" focusable="false"${titleAttr}>${body}</svg>`;
}

export function providerIconSvg(provider = "antigravity", opts = {}) {
  const key = String(provider || "antigravity").trim().toLowerCase();
  const body = PROVIDER_ICON_PATHS[key] || PROVIDER_ICON_PATHS.default;
  const size = Number.isFinite(Number(opts.size)) ? Math.max(10, Number(opts.size)) : 14;
  const extraClass = opts.className ? ` ${String(opts.className).trim()}` : "";
  return `<svg class="ac-icon ac-provider-icon is-${escapeAttr(key)}${escapeAttr(extraClass)}" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" focusable="false" aria-hidden="true">${body}</svg>`;
}

export function hydrateDeclarativeIcons(root = typeof document !== "undefined" ? document : null) {
  if (!root || typeof root.querySelectorAll !== "function") return;
  for (const el of root.querySelectorAll("[data-icon]")) {
    const name = el.getAttribute("data-icon");
    if (!name) continue;
    const size = el.getAttribute("data-icon-size") || undefined;
    el.innerHTML = iconSvg(name, size ? { size: Number(size) } : undefined);
  }
  for (const el of root.querySelectorAll("[data-provider-icon]")) {
    const provider = el.getAttribute("data-provider-icon");
    if (!provider) continue;
    const size = el.getAttribute("data-icon-size") || undefined;
    el.innerHTML = providerIconSvg(provider, size ? { size: Number(size) } : undefined);
  }
}
