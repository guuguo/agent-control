import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { readLargeThreadPreview } from "../src/providers/codex-large-preview.mjs";
import { CodexProvider } from "../src/providers/codex-provider.mjs";
import { readRolloutActivitySnapshot } from "../src/providers/codex-thread-activity.mjs";
import { loadCodexThreadHistory } from "../src/providers/codex-thread-history.mjs";
import { parseCodexQueuedPayload, readIndexedThreadById, readIndexedThreads } from "../src/providers/codex-thread-index.mjs";
import { ProviderHub } from "../src/provider-hub.mjs";
import { createAgentControlServer } from "../src/server.mjs";

const MOCK_CODEX_BIN = fileURLToPath(new URL("./helpers/mock-codex-cli.mjs", import.meta.url));

function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveWait, rejectWait) => {
    const check = () => {
      const value = predicate();
      if (value) return resolveWait(value);
      if (Date.now() > deadline) return rejectWait(new Error("等待条件超时"));
      setTimeout(check, 20);
    };
    check();
  });
}

test("codex-thread-index, large-preview, and activity read SQLite/rollout fixtures cleanly", async (t) => {
  const dir = await mkdtemp(resolve(os.tmpdir(), "ac-codex-idx-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const db = new DatabaseSync(resolve(dir, "state_5.sqlite"));
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      source TEXT,
      model_provider TEXT,
      cwd TEXT,
      title TEXT,
      archived INTEGER,
      git_sha TEXT,
      git_branch TEXT,
      git_origin_url TEXT,
      first_user_message TEXT,
      model TEXT,
      reasoning_effort TEXT,
      thread_source TEXT,
      preview TEXT,
      name TEXT
    );
  `);

  const rolloutFile = resolve(dir, "rollout-1.jsonl");
  const lines = [
    JSON.stringify({ timestamp: "2026-11-14T01:00:00Z", type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }),
    JSON.stringify({ timestamp: "2026-11-14T01:00:01Z", type: "event_msg", payload: { type: "user_message", message: "检查大历史预览" } }),
    JSON.stringify({ timestamp: "2026-11-14T01:00:02Z", type: "event_msg", payload: { type: "agent_message", message: "预览内容已完成" } }),
    JSON.stringify({ timestamp: "2026-11-14T01:00:03Z", type: "event_msg", payload: { type: "task_complete", turn_id: "t1", duration_ms: 2000 } }),
  ];
  await writeFile(rolloutFile, `${lines.join("\n")}\n`, "utf8");

  const insert = db.prepare(`
    INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, archived, first_user_message, model, reasoning_effort, thread_source, preview, name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run("thr-main", rolloutFile, 1700000000, 1700000100, "vscode", "openai", "/tmp/proj", "主会话", 0, "检查大历史预览", "gpt-5.4", "medium", "user", "检查大历史预览", "主会话");
  insert.run("thr-sub", "", 1700000050, 1700000150, "{\"subagent\":\"research\"}", "openai", "/tmp/proj", "子代理", 0, "内部", "gpt-5.4", "low", "subagent", "内部", "子代理");
  db.close();

  const rows = readIndexedThreads(dir);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].id, "thr-main");
  assert.equal(rows[0].threadSource, "subagent");
  const singleRow = readIndexedThreadById(dir, "thr-main");
  assert.equal(singleRow?.id, "thr-main");
  assert.equal(singleRow?.rolloutPath, rolloutFile);
  assert.equal(readIndexedThreadById(dir, "missing-id"), null);

  const preview = await readLargeThreadPreview(rolloutFile, { limit: 5 });
  assert.equal(preview.turns.length, 1);
  assert.equal(preview.turns[0].status, "completed");
  assert.equal(preview.turns[0].items[1].text, "预览内容已完成");

  const lazyLarge = await loadCodexThreadHistory({
    getClient: () => {
      throw new Error("large preview should not start app-server client");
    },
    rawId: "thr-main",
    indexedThread: singleRow,
    largeBytesThreshold: 1,
    limit: 5,
  });
  assert.equal(lazyLarge.thread.largeHistory, true);
  assert.equal(lazyLarge.thread.turns.length, 1);

  const act = await readRolloutActivitySnapshot(rolloutFile);
  assert.equal(act.changed, true);
  assert.equal(act.activity.status, "completed");
  const act2 = await readRolloutActivitySnapshot(rolloutFile, act.cursor);
  assert.equal(act2.changed, false);
});

test("CodexProvider drives multi-profile mock codex CLI for turns, approvals, userInput, steer, and interrupt", async (t) => {
  const dir = await mkdtemp(resolve(os.tmpdir(), "ac-codex-prov-"));
  const homeDefault = resolve(dir, "codex-default");
  const homeWork = resolve(dir, "codex-work");
  await mkdir(homeDefault, { recursive: true });
  await mkdir(homeWork, { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));

  const events = [];
  const serverRequests = [];
  const completedTurns = [];

  const provider = new CodexProvider({
    env: {
      ...process.env,
      CODEX_BIN: MOCK_CODEX_BIN,
      AGENT_CONTROL_CODEX_HOMES: JSON.stringify([
        { id: "default", label: "Codex 默认", home: homeDefault },
        { id: "work", label: "Codex 工作", home: homeWork },
      ]),
    },
    onEvent: (evt) => {
      events.push(evt);
      if (evt.method === "turn/completed") completedTurns.push(evt);
    },
    onServerRequest: (req) => serverRequests.push(req),
  });
  t.after(() => provider.close());

  const profiles = await provider.listProfiles();
  assert.equal(profiles.length, 2);
  assert.equal(profiles[0].id, "default");
  assert.equal(profiles[1].id, "work");

  const models = await provider.listModels("default");
  assert.ok(models.some((m) => m.id === "gpt-5.4"));

  const listed = await provider.listThreads("default");
  assert.ok(listed.some((th) => th.id === "codex:default:01900000-0000-7000-8000-000000000001"));

  // Start a turn requesting approval in profile "work".
  const started = await provider.startThread({
    profileId: "work",
    cwd: "/tmp/mock-codex-project",
    text: "请执行 [REQUEST_APPROVAL]",
  });
  assert.ok(started.thread.id.startsWith("codex:work:"));

  const approvalReq = await waitFor(() => serverRequests.find((r) => r.kind === "command"));
  provider.respondServerRequest("work", approvalReq, { decision: "accept" });

  await waitFor(() => completedTurns.find((e) => e.threadId === started.thread.id));
  const afterApproval = await provider.readThread("work", started.thread.rawId);
  assert.match(JSON.stringify(afterApproval.thread.turns), /Codex 审批结果: accept/);

  // Ask user input.
  await provider.sendTurn({
    profileId: "work",
    rawId: started.thread.rawId,
    text: "需要确认 [ASK_INPUT]",
  });
  const inputReq = await waitFor(() => serverRequests.find((r) => r.kind === "userInput"));
  provider.respondServerRequest("work", inputReq, {
    answers: { framework: { answers: ["方案 B"] } },
  });
  await waitFor(() => completedTurns.length >= 2);

  // Slow turn -> steer, then slow turn -> interrupt.
  const slow1 = await provider.sendTurn({
    profileId: "default",
    rawId: "01900000-0000-7000-8000-000000000001",
    text: "慢任务 [SLOW]",
  });
  await provider.sendTurn({
    profileId: "default",
    rawId: "01900000-0000-7000-8000-000000000001",
    text: "改成快速验证",
    steer: true,
    expectedTurnId: slow1.turn.id,
  });
  await waitFor(() => completedTurns.length >= 3);

  const slow2 = await provider.sendTurn({
    profileId: "default",
    rawId: "01900000-0000-7000-8000-000000000001",
    text: "再次慢任务 [SLOW]",
  });
  await provider.interrupt({
    profileId: "default",
    rawId: "01900000-0000-7000-8000-000000000001",
    turnId: slow2.turn.id,
  });
  const interrupted = await waitFor(() => completedTurns.find((e) => e.params?.turn?.id === slow2.turn.id));
  assert.equal(interrupted.params.turn.status, "interrupted");
});

test("codex-thread-index + ProviderHub detect topic drift in rollout files when SQLite title froze on turn 1", async (t) => {
  const dir = await mkdtemp(resolve(os.tmpdir(), "ac-codex-drift-"));
  const codexHome = resolve(dir, "codex-home");
  const dataDir = resolve(dir, "hub-data");
  await Promise.all([mkdir(codexHome, { recursive: true }), mkdir(dataDir, { recursive: true })]);

  const rolloutPath = resolve(codexHome, "rollout-drift.jsonl");
  await writeFile(rolloutPath, [
    JSON.stringify({ timestamp: "2026-11-15T01:00:00Z", type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }),
    JSON.stringify({ timestamp: "2026-11-15T01:00:01Z", type: "event_msg", payload: { type: "user_message", message: "Claude 项目进度查询" } }),
    JSON.stringify({ timestamp: "2026-11-15T01:00:02Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Claude 项目进度查询" }] } }),
    JSON.stringify({ timestamp: "2026-11-15T01:05:00Z", type: "event_msg", payload: { type: "task_started", turn_id: "t2" } }),
    JSON.stringify({ timestamp: "2026-11-15T01:05:01Z", type: "event_msg", payload: { type: "user_message", message: "优化 Agent Control 的会话标题生成与更新逻辑" } }),
    JSON.stringify({ timestamp: "2026-11-15T01:05:02Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "优化 Agent Control 的会话标题生成与更新逻辑" }] } }),
    JSON.stringify({ timestamp: "2026-11-15T01:06:00Z", type: "event_msg", payload: { type: "task_started", turn_id: "t3" } }),
    JSON.stringify({ timestamp: "2026-11-15T01:06:01Z", type: "event_msg", payload: { type: "user_message", message: "继续" } }),
  ].join("\n") + "\n", "utf8");

  const db = new DatabaseSync(resolve(codexHome, "state_5.sqlite"));
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      source TEXT,
      model_provider TEXT,
      cwd TEXT,
      title TEXT,
      archived INTEGER,
      git_sha TEXT,
      git_branch TEXT,
      git_origin_url TEXT,
      first_user_message TEXT,
      model TEXT,
      reasoning_effort TEXT,
      thread_source TEXT,
      preview TEXT,
      name TEXT
    );
  `);
  db.prepare(`
    INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, archived, first_user_message, model, reasoning_effort, thread_source, preview, name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "thr-drift-1",
    rolloutPath,
    1700000000,
    1700000200,
    "vscode",
    "openai",
    "/tmp/drift-proj",
    "Claude 项目进度查询",
    0,
    "Claude 项目进度查询",
    "gpt-5.4",
    "medium",
    "user",
    "Claude 项目进度查询",
    "Claude 项目进度查询",
  );
  db.close();

  const rows = readIndexedThreads(codexHome);
  assert.equal(rows[0].firstUserText, "Claude 项目进度查询");
  assert.equal(rows[0].lastUserText, "优化 Agent Control 的会话标题生成与更新逻辑");
  assert.equal(rows[0].hasFollowUpTurns, true);

  const provider = new CodexProvider({
    env: {
      ...process.env,
      CODEX_BIN: MOCK_CODEX_BIN,
      AGENT_CONTROL_CODEX_HOMES: JSON.stringify([{ id: "default", label: "Codex 默认", home: codexHome }]),
    },
  });
  const hub = new ProviderHub({ dataDir, providers: [provider], enableQueueDrain: false });
  t.after(async () => {
    await hub.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  await hub.init();

  const listed = await hub.listThreads({ provider: "codex" });
  const target = listed.threads.find((th) => th.id === "codex:default:thr-drift-1");
  assert.equal(target?.title, "AgentCtrl·优化会话标题生成与更新逻辑");
});

test("Codex image wrappers, Files mentioned headers, question replies, and /api/thread/image render cleanly and securely", async (t) => {
  const dir = await mkdtemp(resolve(os.tmpdir(), "ac-codex-img-"));
  const codexHome = resolve(dir, "codex-home");
  const dataDir = resolve(dir, "hub-data");
  const workspace = resolve(dir, "workspace");
  const outsideFile = resolve(dir, "outside.png");
  const imgRel = "demo-studio/assets/hero.png";
  const imgRel2 = "demo-studio/assets/npc.png";
  const imgAbs1 = resolve(workspace, imgRel);
  const fakePngAbs = resolve(workspace, "demo-studio/fake.png");
  const scriptAbs = resolve(workspace, "hack.mjs");
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );

  await Promise.all([
    mkdir(codexHome, { recursive: true }),
    mkdir(dataDir, { recursive: true }),
    mkdir(resolve(workspace, "demo-studio/assets"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(imgAbs1, pngBytes),
    writeFile(outsideFile, pngBytes),
    writeFile(fakePngAbs, "not a png"),
    writeFile(scriptAbs, "export default 1;\n"),
  ]);

  const rollout1 = resolve(codexHome, "rollout-img-1.jsonl");
  const giganticBase64 = `data:image/png;base64,${"A".repeat(600_000)}`;
  await writeFile(rollout1, [
    JSON.stringify({ timestamp: "2026-11-16T03:00:00Z", type: "event_msg", payload: { type: "task_started", turn_id: "t-img-1" } }),
    JSON.stringify({
      timestamp: "2026-11-16T03:00:01Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: `<image name=[Image #1] path="${imgRel}">` },
          { type: "input_image", image_url: giganticBase64 },
          { type: "input_text", text: "</image>" },
          { type: "input_text", text: `<image name=[Image #2] path="${imgRel2}">` },
          { type: "input_image", image_url: giganticBase64 },
          { type: "input_text", text: "</image>" },
          { type: "input_text", text: "使用 demo-image-gen 技能，为《星火计划》ep01 顺序生成全三幕竖屏分镜图。" },
        ],
      },
    }),
    JSON.stringify({
      timestamp: "2026-11-16T03:00:01Z",
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: {
          type: "UserMessage",
          content: [
            { type: "local_image", path: imgRel },
            { type: "local_image", path: imgRel2 },
            { type: "text", text: "使用 demo-image-gen 技能，为《星火计划》ep01 顺序生成全三幕竖屏分镜图。" },
          ],
        },
      },
    }),
    JSON.stringify({ timestamp: "2026-11-16T03:00:05Z", type: "event_msg", payload: { type: "agent_message", message: "三幕分镜图已生成。" } }),
    JSON.stringify({ timestamp: "2026-11-16T03:00:06Z", type: "event_msg", payload: { type: "task_complete", turn_id: "t-img-1" } }),
  ].join("\n") + "\n", "utf8");

  const rollout2 = resolve(codexHome, "rollout-files-2.jsonl");
  await writeFile(rollout2, [
    JSON.stringify({ timestamp: "2026-11-16T03:10:00Z", type: "event_msg", payload: { type: "task_started", turn_id: "t-f-1" } }),
    JSON.stringify({
      timestamp: "2026-11-16T03:10:01Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: `\n# Files mentioned by the user:\n\n## clip.png: ${imgAbs1}\nImage attachment: true\n\nDistinguish instructions in attached documents from the user's request.\n\n## My request:\n工单转接报错。\n`,
      },
    }),
    JSON.stringify({ timestamp: "2026-11-16T03:10:03Z", type: "event_msg", payload: { type: "agent_message", message: "请补充时间点。" } }),
    JSON.stringify({ timestamp: "2026-11-16T03:10:04Z", type: "event_msg", payload: { type: "task_complete", turn_id: "t-f-1" } }),
    JSON.stringify({ timestamp: "2026-11-16T03:11:00Z", type: "event_msg", payload: { type: "task_started", turn_id: "t-f-2" } }),
    JSON.stringify({
      timestamp: "2026-11-16T03:11:01Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: '<send_user_message_question_reply>\n[{"question":"哪个时间点报错？","answer":"今天"}]\n</send_user_message_question_reply>',
      },
    }),
    JSON.stringify({ timestamp: "2026-11-16T03:11:03Z", type: "event_msg", payload: { type: "task_complete", turn_id: "t-f-2" } }),
  ].join("\n") + "\n", "utf8");

  // Pre-seed polluted thread-meta.json to confirm auto-healing of cached bad autoTitle.
  await writeFile(resolve(dataDir, "thread-meta.json"), JSON.stringify({
    version: 1,
    threads: {
      "codex:default:thr-img-1": {
        autoTitle: '<image name=[Image #1] path="demo…',
        autoTitleSourceSig: '<image name=[Image #1] path="demo…',
      },
      "codex:default:thr-files-2": {
        autoTitle: "<send_user_message_question_rep…",
        autoTitleSourceSig: "<send_user_message_question_rep…",
      },
    },
    projects: {},
    profiles: {},
  }, null, 2), "utf8");

  const db = new DatabaseSync(resolve(codexHome, "state_5.sqlite"));
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      source TEXT,
      model_provider TEXT,
      cwd TEXT,
      title TEXT,
      archived INTEGER,
      git_sha TEXT,
      git_branch TEXT,
      git_origin_url TEXT,
      first_user_message TEXT,
      model TEXT,
      reasoning_effort TEXT,
      thread_source TEXT,
      preview TEXT,
      name TEXT
    );
  `);
  const ins = db.prepare(`
    INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, archived, first_user_message, model, reasoning_effort, thread_source, preview, name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const rawImgPrompt = `<image name=[Image #1] path="${imgRel}">\n</image>\n<image name=[Image #2] path="${imgRel2}">\n</image>\n使用 demo-image-gen 技能，为《星火计划》ep01 顺序生成全三幕竖屏分镜图。`;
  ins.run("thr-img-1", rollout1, 1700000000, 1700000300, "vscode", "openai", workspace, rawImgPrompt, 0, rawImgPrompt, "gpt-5.4", "medium", "user", rawImgPrompt, "");
  ins.run("thr-files-2", rollout2, 1700000010, 1700000250, "vscode", "openai", workspace, "# Files mentioned by the user:\n\n## clip.png: /tmp/clip", 0, "# Files mentioned by the user:\n\n## clip.png: /tmp/clip", "gpt-5.4", "medium", "user", "# Files mentioned by the user: ## clip.png: /tmp/cli…", "【工单｜转接】提交返回504");
  ins.run("thr-skill-3", "", 1700000020, 1700000200, "vscode", "openai", workspace, "建立项目复盘技能", 0, "我们用 codex 做了一个 [$video-prompt-compiler](/Users/demo/.agents/skills/video-prompt-compiler/SKILL.md) 工具", "gpt-5.4", "medium", "user", "我们用 codex 做了一个 [$video-prompt-compiler](/Users/demo/.agents/skills/video…", "建立项目复盘技能");
  db.close();

  const indexed = readIndexedThreads(codexHome);
  assert.equal(indexed.length, 3);
  const large = await readLargeThreadPreview(rollout1, { limit: 5 });
  assert.equal(large.turns.length, 1);
  const umItems = large.turns[0].items.filter((it) => it.type === "userMessage");
  assert.equal(umItems.length, 1);
  const localImgs = umItems[0].content.filter((p) => p.type === "localImage");
  assert.equal(localImgs.length, 2);
  assert.equal(localImgs[0].path, imgRel);
  assert.equal(localImgs[1].path, imgRel2);
  const userText = umItems[0].content.find((p) => p.type === "text")?.text || "";
  assert.doesNotMatch(userText, /<image|<\/image>/);
  assert.match(userText, /为《星火计划》ep01/);

  const large2 = await readLargeThreadPreview(rollout2, { limit: 5 });
  assert.equal(large2.turns.length, 2);
  assert.equal(large2.turns[0].items[0].content.some((p) => p.type === "localImage" && p.path === imgAbs1), true);
  assert.equal(large2.turns[0].items[0].content.find((p) => p.type === "text")?.text, "工单转接报错。");
  assert.deepEqual(large2.turns[1].items[0].questionReplies, [{ question: "哪个时间点报错？", answer: "今天" }]);

  const queued = parseCodexQueuedPayload(JSON.stringify({
    input: [{ type: "text", text: `<image name=[Image #1] path="${imgRel}">\n</image>\n请继续生成` }],
  }));
  assert.equal(queued.text, "请继续生成");
  assert.equal(queued.images.length, 1);
  assert.equal(queued.images[0].path, imgRel);

  const provider = new CodexProvider({
    env: {
      ...process.env,
      CODEX_BIN: MOCK_CODEX_BIN,
      AGENT_CONTROL_CODEX_HOMES: JSON.stringify([{ id: "default", label: "Codex 默认", home: codexHome }]),
    },
  });
  const srv = await createAgentControlServer({
    port: 0,
    dataDir,
    providers: [provider],
    disableRelay: true,
    disableTunnel: true,
  });
  await srv.start();
  t.after(async () => {
    await srv.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  const listRes = await fetch(`${srv.url}/api/threads?provider=codex`).then((r) => r.json());
  const th1 = listRes.threads.find((th) => th.id === "codex:default:thr-img-1");
  const th2 = listRes.threads.find((th) => th.id === "codex:default:thr-files-2");
  const th3 = listRes.threads.find((th) => th.id === "codex:default:thr-skill-3");

  assert.equal(th1?.title, "ep01全三幕竖屏分镜");
  assert.doesNotMatch(th1?.preview || "", /<image|<\/image>/);
  assert.equal(th2?.title, "工单·转接提交返回504");
  assert.equal(th2?.preview, "工单转接报错。");
  assert.equal(th3?.preview, "我们用 codex 做了一个 $video-prompt-compiler");

  // Check /api/thread/image security + caching
  const imgUrl = `${srv.url}/api/thread/image?threadId=${encodeURIComponent("codex:default:thr-img-1")}&path=${encodeURIComponent(imgRel)}`;
  const okRes = await fetch(imgUrl);
  assert.equal(okRes.status, 200);
  assert.equal(okRes.headers.get("content-type"), "image/png");
  assert.equal(okRes.headers.get("cache-control"), "private, max-age=600, stale-while-revalidate=3600");
  const etag = okRes.headers.get("etag");
  assert.ok(etag);
  assert.deepEqual(Buffer.from(await okRes.arrayBuffer()), pngBytes);

  const notModRes = await fetch(imgUrl, { headers: { "If-None-Match": etag } });
  assert.equal(notModRes.status, 304);
  assert.equal(notModRes.headers.get("cache-control"), "private, max-age=600, stale-while-revalidate=3600");

  const traversalRes = await fetch(`${srv.url}/api/thread/image?threadId=${encodeURIComponent("codex:default:thr-img-1")}&path=${encodeURIComponent("../outside.png")}`);
  assert.equal(traversalRes.status, 403);

  const extRes = await fetch(`${srv.url}/api/thread/image?threadId=${encodeURIComponent("codex:default:thr-img-1")}&path=${encodeURIComponent("hack.mjs")}`);
  assert.equal(extRes.status, 403);

  const magicRes = await fetch(`${srv.url}/api/thread/image?threadId=${encodeURIComponent("codex:default:thr-img-1")}&path=${encodeURIComponent("demo-studio/fake.png")}`);
  assert.equal(magicRes.status, 403);

  // Large PNG (>160KB) compression + raw opt-out + /api/thread/file (markdown, basename lookup, #L, Range, security blocks)
  function buildLargeNoisyPng(width = 300, height = 300) {
    const raw = Buffer.alloc(height * (1 + width * 3));
    let seed = 0x12345678;
    for (let y = 0; y < height; y += 1) {
      const rowOff = y * (1 + width * 3);
      raw[rowOff] = 0;
      for (let x = 0; x < width * 3; x += 1) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        raw[rowOff + 1 + x] = seed >>> 24;
      }
    }
    const chunk = (type, data) => {
      const tBuf = Buffer.from(type, "ascii");
      const lenBuf = Buffer.allocUnsafe(4);
      lenBuf.writeUInt32BE(data.length, 0);
      const crcBuf = Buffer.allocUnsafe(4);
      crcBuf.writeUInt32BE(crc32(Buffer.concat([tBuf, data])) >>> 0, 0);
      return Buffer.concat([lenBuf, tBuf, data, crcBuf]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const idat = deflateSync(raw, { level: 1 });
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", idat),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  }

  const largePngBuf = buildLargeNoisyPng(300, 300);
  assert.ok(largePngBuf.length > 160 * 1024);
  const largePngRel = "demo-studio/episodes/ep01/large-scene.png";
  const planRel = "demo-studio/episodes/ep01/提交计划.md";
  await mkdir(resolve(workspace, "demo-studio/episodes/ep01"), { recursive: true });
  await Promise.all([
    writeFile(resolve(workspace, largePngRel), largePngBuf),
    writeFile(resolve(workspace, planRel), "# 提交计划\n\n第1幕：pass\n第2幕：pass\n", "utf8"),
    writeFile(resolve(workspace, "hack.mjs"), "const a = 1;\nconst b = 2;\n", "utf8"),
    writeFile(resolve(workspace, ".env"), "API_KEY=secret\n", "utf8"),
    writeFile(resolve(dir, "outside.txt"), "secret outside", "utf8"),
  ]);

  const compRes = await fetch(
    `${srv.url}/api/thread/image?threadId=${encodeURIComponent("codex:default:thr-img-1")}&path=${encodeURIComponent(largePngRel)}&w=480&q=65`,
  );
  assert.equal(compRes.status, 200);
  const compBytes = Buffer.from(await compRes.arrayBuffer());
  if (process.platform === "darwin") {
    assert.equal(compRes.headers.get("content-type"), "image/jpeg");
    assert.equal(compRes.headers.get("x-compressed"), "1");
    assert.ok(compBytes.length < largePngBuf.length);
  }

  const rawImgRes = await fetch(
    `${srv.url}/api/thread/image?threadId=${encodeURIComponent("codex:default:thr-img-1")}&path=${encodeURIComponent(largePngRel)}&raw=1`,
  );
  assert.equal(rawImgRes.status, 200);
  assert.equal(rawImgRes.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await rawImgRes.arrayBuffer()), largePngBuf);

  const mdFileRes = await fetch(
    `${srv.url}/api/thread/file?threadId=${encodeURIComponent("codex:default:thr-img-1")}&path=${encodeURIComponent(planRel)}`,
  ).then((r) => r.json());
  assert.equal(mdFileRes.kind, "markdown");
  assert.match(mdFileRes.content, /# 提交计划/);

  const bareNameRes = await fetch(
    `${srv.url}/api/thread/file?threadId=${encodeURIComponent("codex:default:thr-img-1")}&path=${encodeURIComponent("提交计划.md")}`,
  ).then((r) => r.json());
  assert.equal(bareNameRes.kind, "markdown");
  assert.match(bareNameRes.displayPath, /提交计划\.md/);

  const anchorRes = await fetch(
    `${srv.url}/api/thread/file?threadId=${encodeURIComponent("codex:default:thr-img-1")}&path=${encodeURIComponent("hack.mjs#L2")}`,
  ).then((r) => r.json());
  assert.equal(anchorRes.kind, "code");
  assert.equal(anchorRes.startLine, 2);
  assert.equal(anchorRes.endLine, 2);

  const rangeRes = await fetch(
    `${srv.url}/api/thread/file?threadId=${encodeURIComponent("codex:default:thr-img-1")}&path=${encodeURIComponent(planRel)}&mode=raw`,
    { headers: { Range: "bytes=0-3" } },
  );
  assert.equal(rangeRes.status, 206);
  assert.match(String(rangeRes.headers.get("content-range") || ""), /^bytes 0-3\//);
  assert.equal((await rangeRes.arrayBuffer()).byteLength, 4);

  const envBlockedRes = await fetch(
    `${srv.url}/api/thread/file?threadId=${encodeURIComponent("codex:default:thr-img-1")}&path=${encodeURIComponent(".env")}`,
  );
  assert.equal(envBlockedRes.status, 403);

  const fileTraversalRes = await fetch(
    `${srv.url}/api/thread/file?threadId=${encodeURIComponent("codex:default:thr-img-1")}&path=${encodeURIComponent("../outside.txt")}`,
  );
  assert.equal(fileTraversalRes.status, 403);
});

test("Codex normalizer cleans pasted files, ambient browser wrappers, and collapses silent <heartbeat> runs", async () => {
  const {
    collapseSilentHeartbeatTurns,
    normalizeCodexAgentMessageItem,
    normalizeCodexUserMessageItem,
  } = await import("../src/codex-input-clean.mjs");
  const { isLowQualityTitle, resolveAdaptiveThreadTitle } = await import("../src/thread-title.mjs");
  const { isBlockedPreviewFile } = await import("../src/file-preview.mjs");

  const automationNames = new Map([["automation-8", "番茄每天随机续发三章"]]);

  const pastedItem = normalizeCodexUserMessageItem({
    type: "userMessage",
    id: "u-pasted-1",
    content: [
      {
        type: "text",
        text: '# Files pasted by the user:\n\n## "# 客户支持-张工 11-10 上午 10:09 … - Project: 工单系统": /workspace/demo/attachments/0acd/已粘贴的文本.txt\n\n## My request:\n&#x20;继续查。',
      },
    ],
  });
  assert.deepEqual(pastedItem.content, [
    {
      type: "localFile",
      name: "已粘贴的文本.txt",
      path: "/workspace/demo/attachments/0acd/已粘贴的文本.txt",
      label: "# 客户支持-张工 11-10 上午 10:09 … - Project: 工单系统",
    },
    { type: "text", text: "继续查。" },
  ]);
  assert.equal(
    isBlockedPreviewFile("/workspace/demo/attachments/0acd/已粘贴的文本.txt"),
    false,
  );

  const ambientItem = normalizeCodexUserMessageItem({
    type: "userMessage",
    id: "u-amb-1",
    content: [
      {
        type: "text",
        text: '<in-app-browser-context source="ambient-ui-state">\nThis block is ambient.\n</in-app-browser-context>\n## My request:\n&#x20;检查布局转向 bug',
      },
    ],
  });
  assert.deepEqual(ambientItem.content, [{ type: "text", text: "检查布局转向 bug" }]);
  assert.equal(isLowQualityTitle('<in-app-browser-context source="ambient-ui-state">'), true);
  assert.equal(isLowQualityTitle('# Files pasted by the user:\n\n## "foo"'), true);

  const titleRes = resolveAdaptiveThreadTitle({
    upstreamTitle: '<in-app-browser-context source="ambient-ui-state">\n</in-app-browser-context>\n## My request:\n看看示例应用是不是有bug',
    firstUserText: '<in-app-browser-context source="ambient-ui-state">\n</in-app-browser-context>\n## My request:\n看看示例应用是不是有bug',
    lastUserText: "<heartbeat>\n  <automation_id>automation-8</automation_id>\n  <instructions>忽略我</instructions>\n</heartbeat>",
  });
  assert.equal(titleRes.title, "示例应用是不是有bug");

  const hbUser = normalizeCodexUserMessageItem({
    type: "userMessage",
    id: "u-hb",
    content: [
      {
        type: "text",
        text: "<heartbeat>\n  <automation_id>automation-8</automation_id>\n  <current_time_iso>2026-11-16T04:14:15.535Z</current_time_iso>\n  <instructions>\n每天续发三章\n</instructions>\n</heartbeat>",
      },
    ],
  }, { automationNames });
  assert.deepEqual(hbUser.content, []);
  assert.equal(hbUser.heartbeat.automationId, "automation-8");
  assert.equal(hbUser.heartbeat.automationName, "番茄每天随机续发三章");

  const hbSilentAgent = normalizeCodexAgentMessageItem({
    type: "agentMessage",
    id: "a-hb-silent",
    text: "<heartbeat>\n  <automation_id>automation-8</automation_id>\n  <decision>DONT_NOTIFY</decision>\n  <message>今日三章已全部提交并记录，无需补发。</message>\n</heartbeat>",
  }, { automationNames });
  assert.equal(hbSilentAgent.text, "今日三章已全部提交并记录，无需补发。");
  assert.equal(hbSilentAgent.heartbeat.notify, false);
  assert.equal(hbSilentAgent.heartbeat.automationName, "番茄每天随机续发三章");

  const hbNotifyAgent = normalizeCodexAgentMessageItem({
    type: "agentMessage",
    id: "a-hb-notify",
    text: "<heartbeat>\n  <automation_id>automation-8</automation_id>\n  <decision>NOTIFY</decision>\n  <message>今日第126—128章已提交。</message>\n</heartbeat>",
  }, { automationNames });
  assert.equal(hbNotifyAgent.heartbeat.notify, true);

  const collapsed = collapseSilentHeartbeatTurns([
    {
      id: "turn-normal",
      status: "completed",
      items: [
        { type: "userMessage", id: "u0", content: [{ type: "text", text: "最近好几天没发了为啥？" }] },
        { type: "agentMessage", id: "a0", text: "已排查并补发。" },
      ],
    },
    {
      id: "turn-notify",
      status: "completed",
      startedAt: 100,
      completedAt: 110,
      items: [hbUser, hbNotifyAgent],
    },
    {
      id: "turn-silent-1",
      status: "completed",
      startedAt: 200,
      completedAt: 205,
      _sourceIndex: 2,
      _offset: 2048,
      items: [hbUser, hbSilentAgent],
    },
    {
      id: "turn-silent-2",
      status: "completed",
      startedAt: 500,
      completedAt: 505,
      _sourceIndex: 3,
      _offset: 4096,
      items: [hbUser, hbSilentAgent],
    },
  ]);

  assert.equal(collapsed.length, 3);
  assert.equal(collapsed[1].id, "turn-notify");
  assert.equal(collapsed[2].quietHeartbeatGroup.count, 2);
  assert.equal(collapsed[2].quietHeartbeatGroup.automationName, "番茄每天随机续发三章");
  assert.equal(collapsed[2]._offset, 2048);
  assert.equal(collapsed[2]._firstSourceIndex, 2);
});

test("CodexProvider detects external running Codex turns from response_item tail beyond 256KB", async (t) => {
  const dir = await mkdtemp(resolve(os.tmpdir(), "ac-codex-ext-live-"));
  const codexHome = resolve(dir, "codex-default");
  await mkdir(codexHome, { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));

  const threadId = "01a1e999-0000-7000-8000-000000000099";
  const rolloutPath = resolve(codexHome, `rollout-${threadId}.jsonl`);
  const filler = "x".repeat(4000);
  const lines = [
    JSON.stringify({ timestamp: "2026-11-16T07:48:38.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "t-long-1" } }),
    JSON.stringify({ timestamp: "2026-11-16T07:48:39.000Z", type: "event_msg", payload: { type: "user_message", message: "排查客户历史文件解冻" } }),
  ];
  // Push task_started well past MAX_TAIL_BYTES (256KB) so tail-only reading only sees response_item + item_completed.
  for (let i = 0; i < 80; i += 1) {
    lines.push(JSON.stringify({
      timestamp: "2026-11-16T08:30:00.000Z",
      type: "response_item",
      payload: { type: "custom_tool_call_output", call_id: `c-${i}`, output: filler },
    }));
  }
  lines.push(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "response_item",
      payload: { type: "reasoning", summary: [{ type: "summary_text", text: "Verifying OSS ACL permissions" }] },
    }),
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "response_item",
      payload: { type: "custom_tool_call", name: "exec", input: "curl -sI https://example.com" },
    }),
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "event_msg",
      payload: { type: "token_count", info: {} },
    }),
  );
  await writeFile(rolloutPath, `${lines.join("\n")}\n`, "utf8");

  const nowSec = Math.floor(Date.now() / 1000);
  const db = new DatabaseSync(resolve(codexHome, "state_5.sqlite"));
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      source TEXT,
      model_provider TEXT,
      cwd TEXT,
      title TEXT,
      archived INTEGER,
      git_sha TEXT,
      git_branch TEXT,
      git_origin_url TEXT,
      first_user_message TEXT,
      model TEXT,
      reasoning_effort TEXT,
      thread_source TEXT,
      preview TEXT,
      name TEXT
    );
  `);
  db.prepare(`
    INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, archived, first_user_message, model, reasoning_effort, thread_source, preview, name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(threadId, rolloutPath, nowSec - 600, nowSec, "vscode", "openai", "/tmp/customer-proj", "陈琰·历史文件需解冻", 0, "排查客户历史文件解冻", "gpt-5.4", "high", "user", "排查客户历史文件解冻", "");
  db.close();

  const provider = new CodexProvider({
    env: {
      ...process.env,
      CODEX_BIN: MOCK_CODEX_BIN,
      AGENT_CONTROL_CODEX_HOMES: JSON.stringify([{ id: "default", label: "Codex 默认", home: codexHome }]),
    },
  });
  t.after(() => provider.close());

  const listed = await provider.listThreads("default");
  const item = listed.find((th) => th.rawId === threadId);
  assert.equal(item?.live, true);
  assert.equal(item?.livePhase, "调用 exec");

  const actLive = await provider.getActivity("default", threadId);
  assert.equal(actLive.live, true);
  assert.equal(actLive.activity?.status, "running");
  assert.equal(actLive.activity?.phase, "调用 exec");

  const actUnchanged = await provider.getActivity("default", threadId, { cursor: actLive.cursor });
  assert.equal(actUnchanged.changed, false);
  assert.equal(actUnchanged.live, true);
  assert.equal(actUnchanged.activity?.status, "running");

  const loaded = await provider.readThread("default", threadId, { limit: 5 });
  assert.equal(loaded.thread.live, true);
  assert.equal(loaded.activity?.status, "running");

  // Once task_complete arrives, listThreads and getActivity must transition to live=false immediately.
  await writeFile(rolloutPath, `${lines.join("\n")}\n${JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "event_msg",
    payload: { type: "task_complete", turn_id: "t-long-1", last_agent_message: "已解冻完成" },
  })}\n`, "utf8");

  const actDone = await provider.getActivity("default", threadId, { cursor: actLive.cursor });
  assert.equal(actDone.live, false);
  assert.equal(actDone.changed, true);
  assert.equal(actDone.activity?.status, "completed");

  const actDoneUnchanged = await provider.getActivity("default", threadId, { cursor: actDone.cursor });
  assert.equal(actDoneUnchanged.changed, false);
  assert.equal(actDoneUnchanged.live, false);
  assert.equal(actDoneUnchanged.activity?.status, "completed");

  const listedDone = await provider.listThreads("default");
  assert.equal(listedDone.find((th) => th.rawId === threadId)?.live, false);
});

test("codex-thread-history and codex-large-preview enrich per-turn model and effort from turn_context", async (t) => {
  const dir = await mkdtemp(resolve(os.tmpdir(), "ac-codex-turn-model-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const rolloutPath = resolve(dir, "rollout-model.jsonl");
  const lines = [
    JSON.stringify({ timestamp: "2026-11-16T08:00:00Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-m1", started_at: 1794816000 } }),
    JSON.stringify({ timestamp: "2026-11-16T08:00:01Z", type: "turn_context", payload: { turn_id: "turn-m1", model: "gpt-6.1-sol", effort: "high" } }),
    JSON.stringify({ timestamp: "2026-11-16T08:00:02Z", type: "event_msg", payload: { type: "user_message", message: "第一轮" } }),
    JSON.stringify({ timestamp: "2026-11-16T08:00:04Z", type: "event_msg", payload: { type: "agent_message", message: "完成第一轮" } }),
    JSON.stringify({ timestamp: "2026-11-16T08:00:05Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-m1" } }),
  ];
  await writeFile(rolloutPath, `${lines.join("\n")}\n`, "utf8");

  const preview = await readLargeThreadPreview(rolloutPath, { limit: 10 });
  assert.equal(preview.turns.length, 1);
  assert.equal(preview.turns[0].model, "gpt-6.1-sol");
  assert.equal(preview.turns[0].effort, "high");

  const fakeClient = {
    async request(method) {
      assert.equal(method, "thread/read");
      return {
        thread: {
          id: "t-model-1",
          rolloutPath,
          turns: [
            {
              id: "turn-m1",
              status: "completed",
              items: [
                { type: "userMessage", id: "u-1", content: [{ type: "text", text: "第一轮" }] },
                { type: "agentMessage", id: "a-1", text: "完成第一轮" },
              ],
            },
          ],
        },
      };
    },
  };

  const fullLoaded = await loadCodexThreadHistory({
    client: fakeClient,
    rawId: "t-model-1",
    indexedThread: { id: "t-model-1", rolloutPath },
    detail: "full",
  });
  assert.equal(fullLoaded.thread.turns[0].startedAt, 1794816000);
  assert.equal(fullLoaded.thread.turns[0].model, "gpt-6.1-sol");
  assert.equal(fullLoaded.thread.turns[0].effort, "high");
});
