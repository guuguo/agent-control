import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSpriteOpeningBriefing,
  buildSpriteQueryReply,
  captureSpriteOverviewSnapshot,
  classifySpriteUserInput,
  diffSpriteOverviewEvents,
  renderSpriteAssistantHtml,
} from "../public/sprite-assistant.js";

const mockOverview = {
  topics: [
    { id: "manga-trans", name: "漫画翻译" },
    { id: "ops-service", name: "服务端运维" },
  ],
  bossFocus: [
    {
      topicId: "manga-trans",
      name: "漫画翻译",
      stageIndex: 3,
      stageLabel: "打磨",
      readyToHarvest: true,
      bottleneck: "缺爱发电回调日志",
      nextStep: "补齐爱发电回调验收",
    },
  ],
  radar: {
    liveThreads: [{ id: "codex:default:t1", title: "日志联调" }],
    pendingThreads: [],
    harvestReadyCount: 1,
  },
  domains: [
    {
      id: "indie-lab",
      topics: [
        {
          id: "manga-trans",
          name: "漫画翻译",
          pipeline: { readyToHarvest: true },
          nextStep: "补齐爱发电回调验收",
          activeThreads: [{ id: "codex:default:t1", title: "日志联调", live: true }],
        },
        {
          id: "ops-service",
          name: "服务端运维",
          pipeline: { readyToHarvest: false },
          activeThreads: [{ id: "claude:default:t2", title: "录音排查", live: false }],
        },
      ],
    },
  ],
};

test("Sprite Assistant generates opening briefing and detects pending/harvest/completed/failed events", () => {
  const brief = buildSpriteOpeningBriefing(mockOverview, []);
  assert.match(brief.text, /1 名 AI 员工正在运转/);
  assert.match(brief.text, /漫画翻译/);
  assert.equal(brief.tone, "coin");

  const snap1 = captureSpriteOverviewSnapshot(mockOverview, []);
  const nextOverview = structuredClone(mockOverview);
  nextOverview.radar.liveThreads = [];
  nextOverview.domains[0].topics[0].activeThreads[0].live = false;
  nextOverview.radar.pendingThreads = [
    { id: "claude:default:t2", title: "录音排查", pendingCount: 1 },
  ];
  nextOverview.domains[0].topics[1].pipeline.readyToHarvest = true;

  const snap2 = captureSpriteOverviewSnapshot(nextOverview, []);
  const events = diffSpriteOverviewEvents(snap1, snap2);
  const types = events.map((e) => e.type);
  assert.deepEqual(types, ["pending", "harvest", "completed"]);

  // Verify failed transition detection
  const snapFailNext = captureSpriteOverviewSnapshot(
    {
      ...mockOverview,
      radar: { liveThreads: [], pendingThreads: [] },
      domains: [
        {
          id: "indie-lab",
          topics: [
            {
              id: "manga-trans",
              name: "漫画翻译",
              pipeline: { readyToHarvest: true },
              activeThreads: [{ id: "codex:default:t1", title: "日志联调", live: false, lastError: "API timeout" }],
            },
          ],
        },
      ],
    },
    [],
  );
  const failEvents = diffSpriteOverviewEvents(snap1, snapFailNext);
  assert.equal(failEvents[0]?.type, "failed");
  assert.match(failEvents[0]?.text || "", /API timeout/);
});

test("Sprite Assistant classifies confirm/cancel/queries/dispatch and escapes XSS in preview card", () => {
  const agentOptions = [
    { key: "antigravity:cli", provider: "antigravity", label: "Antigravity" },
    { key: "codex:default", provider: "codex", label: "Codex" },
  ];

  assert.equal(classifySpriteUserInput("确认", { hasPendingPreview: true }).intent, "confirm_preview");
  assert.equal(classifySpriteUserInput("算了", { hasPendingPreview: true }).intent, "cancel_preview");
  assert.equal(classifySpriteUserInput("汇报进展").intent, "briefing");
  assert.equal(classifySpriteUserInput("谁待拍板").intent, "query_pending");
  assert.equal(classifySpriteUserInput("准收菜").intent, "query_harvest");

  const disp = classifySpriteUserInput("帮我派单：用 Antigravity 给漫画翻译新开分身补齐回调日志", {
    overview: mockOverview,
    agentOptions,
  });
  assert.equal(disp.intent, "dispatch_preview");
  assert.equal(disp.agentKey, "antigravity:cli");
  assert.equal(disp.topicId, "manga-trans");
  assert.equal(disp.mode, "new");

  const queryPending = buildSpriteQueryReply("query_pending", mockOverview, []);
  assert.match(queryPending.text, /没有需要拍板/);

  const html = renderSpriteAssistantHtml({
    open: true,
    ttsEnabled: true,
    messages: [{ role: "sprite", text: "你好 <script>alert(1)</script>" }],
    pendingPreview: {
      payload: { model: "gemini-4-pro" },
      routes: [
        {
          action: "reuse_clean",
          topicName: "漫画翻译 <img onerror=alert(1)>",
          agentLabel: "Antigravity",
          reason: "复用空闲干净工位",
        },
      ],
    },
  }, { is3dMode: true });

  assert.doesNotMatch(html, /<script>|<img onerror/);
  assert.match(html, /确认派出/);
  assert.match(html, /Antigravity/);
  assert.match(html, /gemini-4-pro/);
});

test("Sprite Assistant supports scoped topic archive preview, confirm, and context inheritance UI", () => {
  const archCmd = classifySpriteUserInput("把过去很久的对话归档总结", {
    scopedTopicId: "manga-trans",
    overview: mockOverview,
  });
  assert.equal(archCmd.intent, "archive_preview");
  assert.equal(archCmd.topicId, "manga-trans");
  assert.equal(archCmd.staleDays, 3);

  assert.equal(
    classifySpriteUserInput("确认", { hasPendingArchive: true }).intent,
    "confirm_archive",
  );
  assert.equal(
    classifySpriteUserInput("取消", { hasPendingArchive: true }).intent,
    "cancel_archive",
  );

  const archHtml = renderSpriteAssistantHtml({
    open: true,
    scopedTopicId: "manga-trans",
    scopedTopicName: "漫画翻译",
    pendingArchive: {
      topicId: "manga-trans",
      topicName: "漫画翻译",
      staleDays: 3,
      candidates: [{ id: "t1", title: "旧会话 <script>x</script>", preview: "已完成", idleDays: 5 }],
    },
  });
  assert.doesNotMatch(archHtml, /<script>x<\/script>/);
  assert.match(archHtml, /确认归档 \(1\)/);
  assert.match(archHtml, /\.agent-context\.manga-trans\.md/);

  const inheritHtml = renderSpriteAssistantHtml({
    open: true,
    pendingPreview: {
      payload: { inheritContext: true },
      routes: [{ action: "spawn_parallel", topicName: "漫画翻译", hasTopicDigest: true, agentLabel: "Agy" }],
    },
  });
  assert.match(inheritHtml, /继承归档记忆/);
  assert.match(inheritHtml, /data-sprite-toggle-inherit/);
});
