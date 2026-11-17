import { PROVIDER_META } from "./instance-switcher.js?v=20261117qoder";

export const PROVIDER_TABS_PREF_KEY = "agentControl.hiddenProviderTabs.v1";
const providers = Object.keys(PROVIDER_META).filter((id) => id !== "all");

export function loadHiddenProviderTabs(storage) {
  try {
    const value = JSON.parse((storage || globalThis.localStorage).getItem(PROVIDER_TABS_PREF_KEY) || "[]");
    return Array.isArray(value) ? providers.filter((id) => value.includes(id)) : [];
  } catch { return []; }
}

export function saveHiddenProviderTabs(hidden, storage) {
  try { (storage || globalThis.localStorage).setItem(PROVIDER_TABS_PREF_KEY, JSON.stringify(providers.filter((id) => hidden.includes(id)))); } catch {}
}

export function renderProviderTabsHtml(hidden = [], selected = "all") {
  return ["all", ...providers.filter((id) => !hidden.includes(id))].map((id) =>
    `<button type="button" role="tab" aria-selected="${id === selected}" class="provider-tab${id === selected ? " is-active" : ""}" data-provider="${id}" title="${PROVIDER_META[id].label}">${PROVIDER_META[id].short}</button>`,
  ).join("");
}

export function renderProviderTabsSettingsHtml(hidden = []) {
  return `<strong>显示智能体入口</strong>${providers.map((id) => `<label><input type="checkbox" data-provider-tab-visible="${id}"${hidden.includes(id) ? "" : " checked"}>${PROVIDER_META[id].label}</label>`).join("")}
    <span class="provider-tabs-settings-note">仅隐藏筛选入口，会话仍保留在“全部”中。</span>
    <button type="button" data-provider-tabs-reset>全部显示</button>`;
}

export function visibleProviderFilter(selected, hidden = []) {
  return hidden.includes(selected) ? "all" : selected;
}
