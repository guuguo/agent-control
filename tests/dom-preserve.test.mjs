import assert from "node:assert/strict";
import test from "node:test";
import {
  captureSubtreeUiState,
  replaceHtmlPreservingUiState,
  restoreSubtreeUiState,
} from "../public/dom-preserve.js";
import { renderSpriteAssistantHtml } from "../public/sprite-assistant.js";

function mockNode({
  tagName = "DIV",
  id = "",
  classes = [],
  attrs = {},
  textContent = "",
  open = false,
  scrollTop = 0,
  scrollLeft = 0,
  scrollHeight = 400,
  clientHeight = 150,
  children = [],
} = {}) {
  const attrMap = new Map(Object.entries(attrs));
  const node = {
    tagName,
    id,
    classList: new Set(classes),
    textContent,
    open,
    scrollTop,
    scrollLeft,
    scrollHeight,
    clientHeight,
    style: { scrollBehavior: "smooth" },
    children,
    getAttribute(k) {
      return attrMap.has(k) ? attrMap.get(k) : null;
    },
    querySelector(sel) {
      if (sel === ":scope > summary") {
        return this.children.find((c) => c.tagName === "SUMMARY") || null;
      }
      return null;
    },
    querySelectorAll(sel) {
      const out = [];
      const walk = (el) => {
        for (const ch of el.children || []) {
          if (sel === "*" || (sel === "details" && ch.tagName === "DETAILS")) {
            out.push(ch);
          }
          walk(ch);
        }
      };
      walk(this);
      return out;
    },
    contains(target) {
      if (target === this) return true;
      return this.querySelectorAll("*").includes(target);
    },
  };
  return node;
}

test("captureSubtreeUiState and restoreSubtreeUiState preserve nested details[open], horizontal scrollLeft, and vertical scrollTop across live state mutations", () => {
  const tableScroll1 = mockNode({ classes: ["execution-stats-scroll"], scrollLeft: 240 });
  const tableScroll2 = mockNode({ classes: ["execution-stats-scroll"], scrollLeft: 380 });
  const recentSummary = mockNode({ tagName: "SUMMARY", textContent: "最近 12 轮执行明细 · 最多保留 200 轮" });
  const recentDetails = mockNode({
    tagName: "DETAILS",
    classes: ["execution-stats-recent"],
    open: true,
    children: [recentSummary, tableScroll2],
  });
  const compactItems = mockNode({
    classes: ["telemetry-compact-items", "is-running"],
    scrollLeft: 135,
  });
  const previewRoutes = mockNode({
    classes: ["sprite-preview-routes"],
    scrollTop: 92,
  });
  const feedList = mockNode({
    id: "spriteFeedList",
    classes: ["sprite-feed"],
    scrollTop: 64,
    scrollHeight: 500,
    clientHeight: 180,
  });

  const rootPrev = mockNode({
    id: "agentTelemetryBar",
    scrollTop: 118,
    children: [compactItems, tableScroll1, recentDetails, previewRoutes, feedList],
  });

  const snap = captureSubtreeUiState(rootPrev);
  assert.equal(snap.rootTop, 118);
  assert.equal(snap.openDetails.size, 1);

  // Simulate re-rendered DOM where transient classes changed (is-running removed) and summary counter incremented (12 -> 13)
  const nextTable1 = mockNode({ classes: ["execution-stats-scroll"], scrollLeft: 0 });
  const nextTable2 = mockNode({ classes: ["execution-stats-scroll"], scrollLeft: 0 });
  const nextSummary = mockNode({ tagName: "SUMMARY", textContent: "最近 13 轮执行明细 · 最多保留 200 轮" });
  const nextDetails = mockNode({
    tagName: "DETAILS",
    classes: ["execution-stats-recent"],
    open: false,
    children: [nextSummary, nextTable2],
  });
  const nextCompact = mockNode({
    classes: ["telemetry-compact-items"],
    scrollLeft: 0,
  });
  const nextPreview = mockNode({
    classes: ["sprite-preview-routes"],
    scrollTop: 0,
  });
  const nextFeed = mockNode({
    id: "spriteFeedList",
    classes: ["sprite-feed"],
    scrollTop: 0,
  });
  const rootNext = mockNode({
    id: "agentTelemetryBar",
    scrollTop: 0,
    children: [nextCompact, nextTable1, nextDetails, nextPreview, nextFeed],
  });

  restoreSubtreeUiState(rootNext, snap);
  assert.equal(rootNext.scrollTop, 118);
  assert.equal(nextDetails.open, true, "open <details> should stay open even when numeric counter updates");
  assert.equal(nextTable1.scrollLeft, 240, "first horizontal scroll table preserved");
  assert.equal(nextTable2.scrollLeft, 380, "second horizontal scroll table inside <details> preserved");
  assert.equal(nextCompact.scrollLeft, 135, "horizontal capsule strip scroll preserved despite transient class change");
  assert.equal(nextPreview.scrollTop, 92, "sprite archive preview scroll preserved");
  assert.equal(nextFeed.scrollTop, 64, "sprite feed scroll preserved when user scrolled up");
});

test("replaceHtmlPreservingUiState skips identical HTML without touching innerHTML", () => {
  let writes = 0;
  const container = {
    scrollTop: 40,
    scrollLeft: 0,
    _html: "<div>initial</div>",
    get innerHTML() {
      return this._html;
    },
    set innerHTML(v) {
      writes += 1;
      this._html = v;
    },
    querySelectorAll() {
      return [];
    },
  };

  assert.equal(replaceHtmlPreservingUiState(container, "<div>updated</div>"), true);
  assert.equal(writes, 1);
  assert.equal(replaceHtmlPreservingUiState(container, "<div>updated</div>"), false);
  assert.equal(writes, 1, "identical HTML must not trigger redundant innerHTML write");
});

test("renderSpriteAssistantHtml only attaches is-entering on initial open/toast transition, preventing bounce on live refreshes", () => {
  const stateOpen = {
    open: true,
    scopedTopicId: "manga-lens",
    scopedTopicName: "漫译 MangaLens",
    messages: [{ id: "m1", role: "sprite", text: "工位运转中" }],
  };

  const firstOpenHtml = renderSpriteAssistantHtml(stateOpen, { is3dMode: true, enteringOpen: true });
  assert.match(firstOpenHtml, /sprite-popover-card is-entering/);

  const refreshHtml = renderSpriteAssistantHtml({ ...stateOpen, busy: true }, { is3dMode: true, enteringOpen: false });
  assert.doesNotMatch(refreshHtml, /is-entering/, "subsequent live refreshes while open must not replay entry animation");
});

test("renderSpriteAssistantHtml renders inline listening, speech wave, hands-free, speaking, and transcribing states inside Sprite card", () => {
  const singleShotHtml = renderSpriteAssistantHtml({
    open: true,
    recording: true,
    recordElapsedSec: 4,
  }, { is3dMode: true });
  assert.match(singleShotHtml, /id="spriteVoiceBar"/);
  assert.match(singleShotHtml, /正在收听 · 说完自动发送/);
  assert.match(singleShotHtml, /00:04/);
  assert.match(singleShotHtml, /data-sprite-action="finish-mic"/);
  assert.match(singleShotHtml, /data-sprite-action="cancel-mic"/);

  const handsFreeSpeechHtml = renderSpriteAssistantHtml({
    open: true,
    recording: true,
    handsFree: true,
    speechActive: true,
    recordElapsedSec: 15,
  }, { is3dMode: true });
  assert.match(handsFreeSpeechHtml, /正在收听人声…/);
  assert.match(handsFreeSpeechHtml, /00:15/);
  assert.match(handsFreeSpeechHtml, /结束免提/);
  assert.match(handsFreeSpeechHtml, /is-handsfree/);

  const speakingHtml = renderSpriteAssistantHtml({
    open: true,
    handsFree: true,
    speaking: true,
  }, { is3dMode: true });
  assert.match(speakingHtml, /正在播报 · 开口自动打断/);
  assert.match(speakingHtml, /data-sprite-action="stop-speech"/);
});

