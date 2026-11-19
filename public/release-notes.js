/**
 * Multi-dimensional user-friendly release notes renderer for the update modal.
 * Pure rendering module with zero DOM globals or pictographic emojis.
 */

const CATEGORY_CLASS_MAP = {
  new: "is-new",
  improve: "is-improve",
  fix: "is-fix",
  note: "is-note",
};

function isChineseLocale(locale = "zh-CN") {
  const clean = String(locale || "").trim().toLowerCase();
  return !clean || clean.startsWith("zh");
}

function getUiCopy(locale = "zh-CN") {
  if (isChineseLocale(locale)) {
    return {
      isEn: false,
      categoryLabels: { new: "新增", improve: "优化", fix: "修复", note: "说明" },
      allLabel: "全部",
      pendingLabel: (ver) => (ver ? `待更新 v${ver}` : "本次待更新"),
      currentLabel: (ver) => (ver ? `当前 v${ver}` : "当前版本"),
      fallbackTitle: (ver) => (ver ? `v${ver} 版本更新` : "更新内容"),
      cumulativeTitle: (count) => `${count} 个新版本累积更新`,
      fallbackHint: "本次更新暂未附带专属更新文档，以下按提交记录自动整理",
      emptyCategory: "该分类下暂无更新条目。",
      emptyEntry: "该版本暂无分条说明。",
      versionAria: "版本历史切换",
      filterAria: "按更新类型筛选",
      itemSep: "：",
    };
  }
  return {
    isEn: true,
    categoryLabels: { new: "New", improve: "Improved", fix: "Fixed", note: "Note" },
    allLabel: "All",
    pendingLabel: (ver) => (ver ? `Update v${ver}` : "Pending Update"),
    currentLabel: (ver) => (ver ? `Current v${ver}` : "Current"),
    fallbackTitle: (ver) => (ver ? `v${ver} Release` : "Release Notes"),
    cumulativeTitle: (count) => `${count} new releases included`,
    fallbackHint: "No dedicated release notes included yet; auto-summarized from recent commits.",
    emptyCategory: "No entries in this category.",
    emptyEntry: "No release notes available for this version.",
    versionAria: "Version history",
    filterAria: "Filter by category",
    itemSep: ": ",
  };
}

function normalizeCategory(rawCategory = "") {
  const key = String(rawCategory || "").trim().toLowerCase();
  return CATEGORY_CLASS_MAP[key] ? key : "note";
}

function hasBucketEntries(bucket) {
  if (!bucket || typeof bucket !== "object") return false;
  return Boolean(
    (Array.isArray(bucket.pending) && bucket.pending.length > 0)
    || (Array.isArray(bucket.recent) && bucket.recent.length > 0)
    || bucket.current
    || bucket.remote,
  );
}

export function resolveReleaseNotesBucket(snap, locale = "zh-CN") {
  const rn = snap?.releaseNotes && typeof snap.releaseNotes === "object" ? snap.releaseNotes : null;
  if (!rn) return null;
  if (!isChineseLocale(locale) && hasBucketEntries(rn.locales?.en)) {
    return rn.locales.en;
  }
  if (isChineseLocale(locale) && hasBucketEntries(rn.locales?.zh)) {
    return rn.locales.zh;
  }
  return rn;
}

function stripTitleVersionPrefix(entry) {
  if (!entry || typeof entry !== "object") return "";
  let title = String(entry.title || entry.heading || "").trim();
  if (entry.version) {
    const escapedVer = String(entry.version).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    title = title
      .replace(new RegExp(`^v?${escapedVer}\\s*(?:\\(\\d{4}-\\d{2}-\\d{2}\\))?\\s*[—\\-:：]*\\s*`, "i"), "")
      .trim();
  }
  return title;
}

function cleanEntryTitle(entry, locale = "zh-CN") {
  const copy = getUiCopy(locale);
  return stripTitleVersionPrefix(entry) || copy.fallbackTitle(entry?.version);
}

export function renderReleaseHeadline(entry) {
  if (!entry || typeof entry !== "object") return "";
  return stripTitleVersionPrefix(entry) || String(entry.summary || "").trim() || String(entry.heading || "").trim();
}

export function buildReleaseVersionTabs(snap, { locale = "zh-CN" } = {}) {
  if (!snap || typeof snap !== "object") return [];
  const rn = resolveReleaseNotesBucket(snap, locale);
  if (!rn) return [];
  const copy = getUiCopy(locale);

  const tabs = [];
  const hasUpdate = Boolean(snap.hasUpdate);
  const pendingEntries = Array.isArray(rn.pending) ? rn.pending.filter(Boolean) : [];
  if (hasUpdate && pendingEntries.length > 0) {
    const ver = snap.remoteVersion || pendingEntries[0]?.version || "";
    tabs.push({
      key: "pending",
      label: copy.pendingLabel(ver),
      isPending: true,
      isCurrent: false,
      pendingSource: rn.pendingSource || "release_notes",
      entries: pendingEntries,
    });
  }

  const recentEntries = Array.isArray(rn.recent) && rn.recent.length > 0
    ? rn.recent.filter(Boolean)
    : (rn.current ? [rn.current] : []);

  for (let i = 0; i < recentEntries.length && tabs.length < 5; i += 1) {
    const entry = recentEntries[i];
    const ver = String(entry?.version || "").trim();
    const fallbackKey = i === 0 ? "current" : `hist-${i}`;
    let key = String(entry?.id || (ver ? `v${ver}` : fallbackKey)).trim() || fallbackKey;
    if (tabs.some((t) => t.key === key)) {
      key = `${key}-${i}`;
    }
    const label = i === 0
      ? copy.currentLabel(ver)
      : (ver ? `v${ver}` : cleanEntryTitle(entry, locale).slice(0, 12));
    tabs.push({
      key,
      label,
      isPending: false,
      isCurrent: i === 0,
      pendingSource: "release_notes",
      entries: [entry],
    });
  }

  return tabs;
}

function renderItemsListHtml(items, { escapeHtml, locale = "zh-CN" } = {}) {
  const copy = getUiCopy(locale);
  if (!Array.isArray(items) || items.length === 0) {
    return `<p class="update-notes-empty">${escapeHtml(copy.emptyCategory)}</p>`;
  }
  return `<ul class="update-notes-list">${items.map((item) => {
    const cat = normalizeCategory(item?.category);
    const badgeCls = CATEGORY_CLASS_MAP[cat];
    const badgeText = copy.categoryLabels[cat] || String(item?.categoryLabel || copy.categoryLabels.note).trim();
    const itemTitle = String(item?.title || "").trim();
    const itemDetail = String(item?.detail || item?.text || "").trim();
    if (!itemTitle && !itemDetail) return "";
    const copyHtml = itemTitle && itemDetail && itemTitle !== itemDetail
      ? `<strong class="update-notes-item-title">${escapeHtml(itemTitle)}</strong><span class="update-notes-item-sep">${escapeHtml(copy.itemSep)}</span><span class="update-notes-item-detail">${escapeHtml(itemDetail)}</span>`
      : `<span class="update-notes-item-detail">${escapeHtml(itemTitle || itemDetail)}</span>`;
    return `
      <li class="update-notes-item">
        <span class="update-notes-badge ${badgeCls}">${escapeHtml(badgeText)}</span>
        <div class="update-notes-copy">${copyHtml}</div>
      </li>
    `;
  }).filter(Boolean).join("")}</ul>`;
}

export function renderReleaseNotesCardHtml(
  snap,
  {
    escapeHtml,
    selectedVersionKey = "",
    selectedCategory = "all",
    locale = "zh-CN",
  } = {},
) {
  if (typeof escapeHtml !== "function") {
    throw new TypeError("renderReleaseNotesCardHtml requires an escapeHtml helper");
  }
  const tabs = buildReleaseVersionTabs(snap, { locale });
  if (tabs.length === 0) return "";
  const copy = getUiCopy(locale);

  const activeTab = tabs.find((t) => t.key === selectedVersionKey) || tabs[0];
  const entries = Array.isArray(activeTab.entries) ? activeTab.entries.filter(Boolean) : [];
  if (entries.length === 0) return "";

  const counts = { all: 0, new: 0, improve: 0, fix: 0, note: 0 };
  for (const entry of entries) {
    for (const item of Array.isArray(entry.items) ? entry.items : []) {
      const cat = normalizeCategory(item?.category);
      counts.all += 1;
      counts[cat] = (counts[cat] || 0) + 1;
    }
  }

  const categoryMeta = [
    { key: "new", label: copy.categoryLabels.new },
    { key: "improve", label: copy.categoryLabels.improve },
    { key: "fix", label: copy.categoryLabels.fix },
    { key: "note", label: copy.categoryLabels.note },
  ];
  const nonZeroCatCount = categoryMeta.filter((m) => counts[m.key] > 0).length;
  const activeCat = (
    selectedCategory !== "all"
    && CATEGORY_CLASS_MAP[selectedCategory]
    && counts[selectedCategory] > 0
  )
    ? selectedCategory
    : "all";

  const versionStripHtml = `
    <div class="update-version-strip" role="tablist" aria-label="${escapeHtml(copy.versionAria)}">
      ${tabs.map((tab) => {
        const isActive = tab.key === activeTab.key;
        const cls = `update-ver-chip${isActive ? " is-active" : ""}${tab.isPending ? " is-pending" : ""}`;
        return `<button type="button" class="${cls}" data-notes-version="${escapeHtml(tab.key)}" aria-pressed="${isActive ? "true" : "false"}">${escapeHtml(tab.label)}</button>`;
      }).join("")}
    </div>
  `;

  const leadEntry = entries[0];
  const heroTitle = entries.length > 1
    ? copy.cumulativeTitle(entries.length)
    : cleanEntryTitle(leadEntry, locale);
  const heroDate = String(leadEntry?.date || "").trim();
  const heroSummary = entries.length === 1 ? String(leadEntry?.summary || "").trim() : "";
  const fallbackHint = activeTab.pendingSource === "commits_fallback"
    ? `<div class="update-notes-fallback-hint">${escapeHtml(copy.fallbackHint)}</div>`
    : "";

  const heroHtml = `
    <div class="update-notes-hero">
      <div class="update-notes-hero-head">
        <span class="update-notes-hero-title">${escapeHtml(heroTitle)}</span>
        ${heroDate ? `<span class="update-notes-entry-date">${escapeHtml(heroDate)}</span>` : ""}
      </div>
      ${heroSummary ? `<p class="update-notes-summary">${escapeHtml(heroSummary)}</p>` : ""}
      ${fallbackHint}
    </div>
  `;

  const catFilterHtml = counts.all >= 2 && nonZeroCatCount >= 2
    ? `
      <div class="update-cat-filter" role="group" aria-label="${escapeHtml(copy.filterAria)}">
        <button type="button" class="update-cat-chip${activeCat === "all" ? " is-active" : ""}" data-notes-category="all" aria-pressed="${activeCat === "all" ? "true" : "false"}">
          <span>${escapeHtml(copy.allLabel)}</span>
          <span class="update-cat-num">${counts.all}</span>
        </button>
        ${categoryMeta.filter((m) => counts[m.key] > 0).map((m) => {
          const isAct = activeCat === m.key;
          return `
            <button type="button" class="update-cat-chip is-${m.key}${isAct ? " is-active" : ""}" data-notes-category="${m.key}" aria-pressed="${isAct ? "true" : "false"}">
              <span class="update-cat-dot" aria-hidden="true"></span>
              <span>${escapeHtml(m.label)}</span>
              <span class="update-cat-num">${counts[m.key]}</span>
            </button>
          `;
        }).join("")}
      </div>
    `
    : "";

  const bodyEntriesHtml = entries.map((entry, idx) => {
    const rawItems = Array.isArray(entry.items) ? entry.items : [];
    const filteredItems = activeCat === "all"
      ? rawItems
      : rawItems.filter((item) => normalizeCategory(item?.category) === activeCat);
    if (entries.length > 1 && filteredItems.length === 0) return "";
    const groupHeader = entries.length > 1
      ? `<div class="update-notes-group-sub">${entry.version ? `<strong>v${escapeHtml(entry.version)}</strong> · ` : ""}${escapeHtml(cleanEntryTitle(entry, locale))}${entry.date ? ` (${escapeHtml(entry.date)})` : ""}</div>`
      : "";
    return `${groupHeader}${renderItemsListHtml(filteredItems, { escapeHtml, locale })}${idx < entries.length - 1 && entries.length > 1 ? '<div class="update-notes-group-gap"></div>' : ""}`;
  }).filter(Boolean).join("");

  return `
    ${versionStripHtml}
    ${heroHtml}
    ${catFilterHtml}
    <div class="update-notes-scroll">
      ${bodyEntriesHtml || `<p class="update-notes-empty">${escapeHtml(copy.emptyEntry)}</p>`}
    </div>
  `;
}
