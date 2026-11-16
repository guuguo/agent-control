import { iconSvg, providerIconSvg } from "./icons.js";
import { compactModelBadgeLabel, permissionVisualMeta } from "./instance-switcher.js";

function compactTriggerLabel(id, value, label) {
  if (id === "permissionSelect") {
    return ({ turbo: "Turbo", workspace: "工作区", full: "Auto", safe: "只读", plan: "规划" })[value] || label;
  }
  if (id === "modelSelect") return compactModelBadgeLabel(label);
  return label;
}

function escapeSelectHtml(value = "") {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function resolveLeadingGlyphHtml(selectId, value) {
  if (selectId === "permissionSelect") {
    const meta = permissionVisualMeta(value || "turbo");
    return `<span class="ac-select-leading is-perm-${escapeSelectHtml(meta.tone)}" aria-hidden="true">${iconSvg(meta.iconName, { size: 12 })}</span>`;
  }
  if (selectId === "composerProviderSelect" && value) {
    return `<span class="ac-select-leading is-provider-${escapeSelectHtml(value)}" aria-hidden="true">${providerIconSvg(value, { size: 12 })}</span>`;
  }
  if (selectId === "runningSubmitMode") {
    const iconName = value === "steer" ? "steer" : "list";
    return `<span class="ac-select-leading" aria-hidden="true">${iconSvg(iconName, { size: 11 })}</span>`;
  }
  return "";
}

function resolveVariantAndTone(selectId, value) {
  let variant = "default";
  let toneClass = "";
  if (selectId === "composerProviderSelect") variant = "provider";
  else if (selectId === "composerProfileSelect") variant = "profile";
  else if (selectId === "modelSelect") variant = "model";
  else if (selectId === "effortSelect") variant = "effort";
  else if (selectId === "permissionSelect") {
    variant = "permission";
    const meta = permissionVisualMeta(value || "turbo");
    toneClass = `is-tone-${meta.tone}`;
  } else if (selectId === "runningSubmitMode") {
    variant = "submit-mode";
  }
  return { variant, toneClass };
}

/**
 * Extract a pure UI descriptor from a <select> element (or test stub).
 */
export function extractSelectDescriptor(selectEl) {
  if (!selectEl) {
    return {
      id: "",
      disabled: false,
      hidden: true,
      value: "",
      selectedLabel: "",
      title: "",
      ariaLabel: "",
      variant: "default",
      toneClass: "",
      leadingHtml: "",
      options: [],
    };
  }
  const id = String(selectEl.id || "");
  const rawOpts = Array.from(selectEl.options || []);
  const currentValue = String(selectEl.value ?? "");
  const options = rawOpts.map((opt) => {
    const val = String(opt?.value ?? "");
    const label = String(opt?.textContent ?? opt?.label ?? val).trim() || val;
    const selected = Boolean(opt?.selected) || (currentValue !== "" && val === currentValue);
    return {
      value: val,
      label,
      compactLabel: String(opt?.dataset?.compactLabel || ""),
      disabled: Boolean(opt?.disabled),
      selected,
    };
  });
  const selectedOpt = options.find((o) => o.value === currentValue) || options.find((o) => o.selected) || options[0] || null;
  const resolvedValue = selectedOpt ? selectedOpt.value : currentValue;
  const selectedLabel = selectedOpt ? selectedOpt.label : (resolvedValue || "默认");
  const { variant, toneClass } = resolveVariantAndTone(id, resolvedValue);
  return {
    id,
    disabled: Boolean(selectEl.disabled),
    hidden: Boolean(selectEl.hidden),
    value: resolvedValue,
    selectedLabel,
    triggerLabel: selectedOpt?.compactLabel || compactTriggerLabel(id, resolvedValue, selectedLabel),
    title: String(selectEl.title || ""),
    ariaLabel: String(selectEl.getAttribute?.("aria-label") || selectEl.ariaLabel || ""),
    variant,
    toneClass,
    leadingHtml: resolveLeadingGlyphHtml(id, resolvedValue),
    options,
  };
}

export function renderCustomSelectTriggerInnerHtml(descriptor) {
  const d = descriptor || extractSelectDescriptor(null);
  return `${d.leadingHtml || ""}`
    + `<span class="ac-select-label">${escapeSelectHtml(d.triggerLabel || d.selectedLabel || "默认")}</span>`
    + `<span class="ac-select-caret" aria-hidden="true">${iconSvg("chevron-down", { size: 11 })}</span>`;
}

export function renderCustomSelectMenuHtml(descriptor) {
  const d = descriptor || extractSelectDescriptor(null);
  const options = Array.isArray(d.options) ? d.options : [];
  if (!options.length) {
    return `<div class="ac-select-empty">暂无可选项</div>`;
  }
  return options.map((opt, idx) => {
    const isSelected = opt.value === d.value || opt.selected;
    const leading = resolveLeadingGlyphHtml(d.id, opt.value);
    return `<button`
      + ` type="button"`
      + ` role="option"`
      + ` class="ac-select-option${isSelected ? " is-selected" : ""}"`
      + ` data-ac-option-value="${escapeSelectHtml(opt.value)}"`
      + ` data-ac-option-index="${idx}"`
      + ` aria-selected="${isSelected ? "true" : "false"}"`
      + `${opt.disabled ? " disabled" : ""}`
      + `>`
      + `<span class="ac-select-opt-main">${leading}<span class="ac-select-opt-text">${escapeSelectHtml(opt.label)}</span></span>`
      + `<span class="ac-select-opt-check" aria-hidden="true">${isSelected ? iconSvg("check", { size: 11 }) : ""}</span>`
      + `</button>`;
  }).join("");
}

const registry = new Map();
let activeOpenId = "";
let globalBound = false;

function ensurePopoverEl() {
  if (typeof document === "undefined") return null;
  let pop = document.getElementById("acCustomSelectPopover");
  if (!pop) {
    pop = document.createElement("div");
    pop.id = "acCustomSelectPopover";
    pop.className = "ac-select-popover";
    pop.setAttribute("role", "listbox");
    pop.hidden = true;
    document.body.appendChild(pop);
  }
  return pop;
}

function positionPopover(pop, trigger) {
  if (!pop || !trigger || typeof window === "undefined") return;
  const rect = trigger.getBoundingClientRect();
  const vw = window.innerWidth || document.documentElement.clientWidth || 1024;
  const vh = window.innerHeight || document.documentElement.clientHeight || 768;

  pop.style.minWidth = `${Math.max(120, Math.round(rect.width))}px`;
  pop.style.maxWidth = `${Math.min(340, vw - 16)}px`;
  pop.style.left = "0px";
  pop.style.top = "0px";

  const popRect = pop.getBoundingClientRect();
  const menuW = popRect.width || Math.max(120, rect.width);
  const menuH = Math.min(popRect.height || 220, 280);

  let left = Math.round(rect.left);
  if (left + menuW > vw - 8) {
    left = Math.round(rect.right - menuW);
  }
  left = Math.max(8, Math.min(left, vw - menuW - 8));

  const openBelow = rect.top < menuH + 16 && (vh - rect.bottom) > rect.top;
  let top = openBelow
    ? Math.round(rect.bottom + 6)
    : Math.round(rect.top - menuH - 6);
  top = Math.max(8, Math.min(top, vh - menuH - 8));

  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  pop.classList.toggle("is-below", openBelow);
}

export function closeCustomSelectMenu() {
  if (typeof document === "undefined") {
    activeOpenId = "";
    return;
  }
  const pop = document.getElementById("acCustomSelectPopover");
  if (pop) {
    pop.hidden = true;
    pop.innerHTML = "";
    delete pop.dataset.forSelectId;
  }
  if (activeOpenId && registry.has(activeOpenId)) {
    const entry = registry.get(activeOpenId);
    entry.trigger.setAttribute("aria-expanded", "false");
    entry.trigger.classList.remove("is-open");
  }
  activeOpenId = "";
}

function openCustomSelectMenu(selectId) {
  const entry = registry.get(selectId);
  if (!entry) return;
  const { selectEl, trigger } = entry;
  const descriptor = extractSelectDescriptor(selectEl);
  if (descriptor.hidden || descriptor.disabled || !descriptor.options.length) return;

  if (activeOpenId === selectId) {
    closeCustomSelectMenu();
    return;
  }
  closeCustomSelectMenu();

  const pop = ensurePopoverEl();
  if (!pop) return;
  pop.innerHTML = renderCustomSelectMenuHtml(descriptor);
  pop.dataset.forSelectId = selectId;
  pop.hidden = false;

  activeOpenId = selectId;
  trigger.setAttribute("aria-expanded", "true");
  trigger.classList.add("is-open");
  positionPopover(pop, trigger);

  const selectedBtn = pop.querySelector('.ac-select-option.is-selected') || pop.querySelector('.ac-select-option:not(:disabled)');
  selectedBtn?.scrollIntoView?.({ block: "nearest" });
}

export function syncCustomSelect(idOrEl) {
  if (typeof document === "undefined") return;
  const selectId = typeof idOrEl === "string" ? idOrEl : String(idOrEl?.id || "");
  const entry = registry.get(selectId);
  if (!entry) return;
  const { selectEl, trigger } = entry;
  const d = extractSelectDescriptor(selectEl);

  trigger.hidden = d.hidden || (selectEl.options.length === 0 && d.id !== "composerProfileSelect");
  trigger.disabled = d.disabled;
  trigger.className = [
    "ac-select-trigger",
    `is-variant-${d.variant}`,
    `is-${d.variant}`,
    d.toneClass,
    d.disabled ? "is-disabled" : "",
    activeOpenId === selectId ? "is-open" : "",
  ].filter(Boolean).join(" ");
  trigger.title = [d.title || d.ariaLabel, d.selectedLabel].filter(Boolean).join("：");
  if (d.ariaLabel) trigger.setAttribute("aria-label", d.ariaLabel);
  trigger.setAttribute("aria-expanded", activeOpenId === selectId ? "true" : "false");
  trigger.innerHTML = renderCustomSelectTriggerInnerHtml(d);

  if (activeOpenId === selectId && (d.hidden || d.disabled)) {
    closeCustomSelectMenu();
  }
}

export function syncAllCustomSelects() {
  for (const selectId of registry.keys()) {
    syncCustomSelect(selectId);
  }
}

function bindGlobalListeners() {
  if (globalBound || typeof document === "undefined") return;
  globalBound = true;

  document.addEventListener("click", (e) => {
    const trigger = e.target.closest?.("[data-custom-select-for]");
    if (trigger) {
      e.preventDefault();
      e.stopPropagation();
      const targetId = trigger.dataset.customSelectFor || "";
      if (targetId) openCustomSelectMenu(targetId);
      return;
    }

    const optBtn = e.target.closest?.("#acCustomSelectPopover [data-ac-option-value]");
    if (optBtn && activeOpenId && registry.has(activeOpenId)) {
      e.preventDefault();
      e.stopPropagation();
      if (optBtn.disabled) return;
      const entry = registry.get(activeOpenId);
      const nextVal = optBtn.dataset.acOptionValue ?? "";
      const selectEl = entry.selectEl;
      if (selectEl.value !== nextVal) {
        selectEl.value = nextVal;
        selectEl.dispatchEvent(new Event("change", { bubbles: true }));
      }
      closeCustomSelectMenu();
      syncAllCustomSelects();
      entry.trigger.focus?.();
      return;
    }

    if (activeOpenId && !e.target.closest?.("#acCustomSelectPopover")) {
      closeCustomSelectMenu();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (!activeOpenId) return;
    const pop = document.getElementById("acCustomSelectPopover");
    if (e.key === "Escape") {
      const trigger = registry.get(activeOpenId)?.trigger;
      closeCustomSelectMenu();
      trigger?.focus?.();
      return;
    }
    if (!pop || pop.hidden) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const opts = Array.from(pop.querySelectorAll(".ac-select-option:not(:disabled)"));
      if (!opts.length) return;
      const curIdx = opts.indexOf(document.activeElement);
      const nextIdx = e.key === "ArrowDown"
        ? (curIdx < opts.length - 1 ? curIdx + 1 : 0)
        : (curIdx > 0 ? curIdx - 1 : opts.length - 1);
      opts[nextIdx]?.focus?.();
    } else if (e.key === "Enter" && document.activeElement?.closest?.("#acCustomSelectPopover")) {
      e.preventDefault();
      document.activeElement.click?.();
    }
  });

  window.addEventListener("resize", () => {
    if (activeOpenId) closeCustomSelectMenu();
  });
  window.addEventListener("scroll", (e) => {
    if (!activeOpenId) return;
    if (e.target && e.target.id === "acCustomSelectPopover") return;
    closeCustomSelectMenu();
  }, true);
}

export function initComposerCustomSelects(selectIds = []) {
  if (typeof document === "undefined") return;
  bindGlobalListeners();

  for (const id of selectIds) {
    const selectEl = document.getElementById(id);
    if (!selectEl) continue;
    if (registry.has(id)) {
      syncCustomSelect(id);
      continue;
    }
    selectEl.classList.add("is-custom-enhanced");
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.dataset.customSelectFor = id;
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    selectEl.insertAdjacentElement("afterend", trigger);

    const observer = new MutationObserver(() => {
      syncCustomSelect(id);
    });
    observer.observe(selectEl, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden", "disabled", "class", "title", "value"],
    });

    selectEl.addEventListener("change", () => syncCustomSelect(id));
    registry.set(id, { selectEl, trigger, observer });
    syncCustomSelect(id);
  }
}
