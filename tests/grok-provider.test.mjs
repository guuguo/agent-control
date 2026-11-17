import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { ExecutionStats } from "../src/execution-stats.mjs";
import { createThreadMetaStore } from "../src/thread-meta-store.mjs";
import { GrokProvider } from "../src/providers/grok-provider.mjs";
import {
  GrokHistoryIndex,
  readGrokThreadHistory,
  stripGrokInjectedUserInfo,
} from "../src/providers/grok-history.mjs";
import { readGrokModelsCatalog } from "../src/providers/grok-runner.mjs";

async function createFakeGrokCli(binPath) {
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "models") {
  if ((process.env.GROK_HOME || "").includes("unauthed")) {
    console.log("You are not authenticated.");
  } else {
    console.log("You are logged in with grok.com.\\nAvailable models:\\n  * grok-4.7 (default)\\n  - grok-4.6");
  }
  process.exit(0);
}
if (args.includes("--help")) {
  console.log("Grok Fake CLI");
  process.exit(0);
}
const promptIdx = args.indexOf("-p");
const prompt = promptIdx >= 0 ? args[promptIdx + 1] : "";
if (prompt.includes("[SLOW]")) {
  console.log(JSON.stringify({ type: "thought", data: "正在思考..." }));
  process.on("SIGINT", () => {
    process.exit(130);
  });
  setTimeout(() => {
    console.log(JSON.stringify({ type: "text", data: "不应输出" }));
    process.exit(0);
  }, 15000);
  return;
}
console.log(JSON.stringify({ type: "thought", data: "先查一下目录。" }));
console.log(JSON.stringify({ type: "text", data: "准备调用工具" }));
console.log(JSON.stringify({ type: "tool_call", id: "tc-1", name: "bash", arguments: { command: "ls -la" } }));
console.log(JSON.stringify({ type: "tool_call_update", id: "tc-1", status: "completed", output: "ok" }));
console.log(JSON.stringify({ type: "usage", input_tokens: 10, output_tokens: 5 }));
console.log(JSON.stringify({ type: "text", data: "执行完成。" }));
console.log(JSON.stringify({ type: "end", session_id: "fake-sess" }));
`;
  await writeFile(binPath, script, "utf8");
  await chmod(binPath, 0o755);
}

test("stripGrokInjectedUserInfo strips injected rules/user_info and unwraps user_query", () => {
  const raw = `<user_info>\nOS Version: macos\n</user_info>\n<rules>\nrule body\n</rules>\n<user_query>\n修一下分页 bug\n</user_query>`;
  assert.equal(stripGrokInjectedUserInfo(raw), "修一下分页 bug");
  assert.equal(stripGrokInjectedUserInfo("<user_info>x</user_info>\n<rules>y</rules>"), "");
});

test("GrokHistoryIndex & readGrokThreadHistory filter title-helper sessions, ignore encrypted_content, and paginate", async (t) => {
  const root = await mkdtemp(resolve(os.tmpdir(), "ac-grok-hist-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const grokHome = resolve(root, "grok-home");
  const desktopIdx = resolve(root, "sessions_index.json");
  const sessDir = resolve(grokHome, "sessions", "%2Ftmp%2Fproj", "sess-real-1");
  const helperDir = resolve(grokHome, "sessions", "%2F", "sess-helper-1");
  await Promise.all([
    mkdir(sessDir, { recursive: true }),
    mkdir(helperDir, { recursive: true }),
  ]);

  await writeFile(desktopIdx, JSON.stringify([
    { agentSessionId: "sess-real-1", title: "桌面端同步标题", archived: false },
  ]));

  await writeFile(resolve(helperDir, "summary.json"), JSON.stringify({
    info: { id: "sess-helper-1", cwd: "/" },
    generated_title: "为下面这条用户消息起一个简短会话标题。要求：你好",
    num_chat_messages: 4,
    updated_at: "2026-11-14T10:00:00Z",
  }));
  await writeFile(resolve(helperDir, "chat_history.jsonl"), JSON.stringify({
    type: "user",
    prompt_index: 0,
    content: [{ type: "text", text: "<user_query>为下面这条用户消息起一个简短会话标题。你好</user_query>" }],
  }) + "\n");

  await writeFile(resolve(sessDir, "summary.json"), JSON.stringify({
    info: { id: "sess-real-1", cwd: "/tmp/proj" },
    current_model_id: "grok-4.7",
    reasoning_effort: "high",
    num_chat_messages: 6,
    created_at: "2026-11-14T08:00:00Z",
    last_active_at: "2026-11-14T09:00:00Z",
  }));

  await writeFile(resolve(sessDir, "chat_history.jsonl"), [
    JSON.stringify({ type: "system", content: "You are Grok" }),
    JSON.stringify({ type: "user", content: [{ type: "text", text: "<user_info>info</user_info><rules>rules</rules>" }] }),
    JSON.stringify({ type: "user", synthetic_reason: "system_reminder", content: [{ type: "text", text: "<system-reminder>skills</system-reminder>" }] }),
    JSON.stringify({ type: "user", prompt_index: 0, content: [{ type: "text", text: "<user_query>第一轮问题</user_query>" }] }),
    JSON.stringify({ type: "reasoning", id: "rs-1", summary: [{ type: "summary_text", text: "安全思考" }], encrypted_content: "TOP_SECRET_BLOB" }),
    JSON.stringify({
      type: "assistant",
      content: "正在检查",
      tool_calls: [{ id: "tc-1", name: "bash", arguments: '{"command":"pwd"}' }],
      model_id: "grok-4.7",
    }),
    JSON.stringify({ type: "tool_result", tool_call_id: "tc-1", content: "/tmp/proj" }),
    JSON.stringify({ type: "user", prompt_index: 1, content: [{ type: "text", text: "<user_query>第二轮问题</user_query>" }] }),
    JSON.stringify({ type: "assistant", content: "第二轮回复", model_id: "grok-4.7" }),
  ].join("\n") + "\n");

  const index = new GrokHistoryIndex({ desktopIndexPath: desktopIdx });
  const sessions = await index.listSessions(grokHome);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, "sess-real-1");
  assert.equal(sessions[0].name, "桌面端同步标题");

  const page1 = await readGrokThreadHistory(grokHome, "sess-real-1", { index, limit: 1 });
  assert.equal(page1.totalTurns, 2);
  assert.equal(page1.turns.length, 1);
  assert.equal(page1.turns[0].items[0].content[0].text, "第二轮问题");
  assert.equal(page1.hasMore, true);
  assert.equal(page1.nextCursor, "turn:1");

  const page0 = await readGrokThreadHistory(grokHome, "sess-real-1", { index, cursor: page1.nextCursor, limit: 1 });
  assert.equal(page0.turns.length, 1);
  assert.equal(page0.turns[0].items[0].content[0].text, "第一轮问题");
  const cmdItem = page0.turns[0].items.find((it) => it.type === "commandExecution");
  assert.equal(cmdItem.command, "pwd");
  assert.equal(cmdItem.aggregatedOutput, "/tmp/proj");
  assert.doesNotMatch(JSON.stringify(page0), /TOP_SECRET_BLOB|encrypted_content/);
});

test("readGrokModelsCatalog reads dict & array caches safely without exposing api_key", async (t) => {
  const root = await mkdtemp(resolve(os.tmpdir(), "ac-grok-mod-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const home1 = resolve(root, "h1");
  await mkdir(home1, { recursive: true });
  await writeFile(resolve(home1, "models_cache.json"), JSON.stringify({
    api_key: "SECRET_API_KEY_123",
    models: {
      "grok-4.7": {
        info: {
          id: "grok-4.7",
          name: "Grok 4.7",
          description: "Frontier",
          reasoning_effort: "high",
          reasoning_efforts: [
            { value: "xhigh", description: "Max" },
            { value: "low", description: "Fast" },
            { value: "high", description: "Recommended" },
          ],
          hidden: false,
        },
      },
      "hidden-internal": { info: { id: "hidden-internal", hidden: true } },
    },
  }));

  const models = await readGrokModelsCatalog(home1);
  assert.equal(models.length, 1);
  assert.equal(models[0].provider, "grok");
  assert.equal(models[0].isDefault, true);
  assert.deepEqual(
    models[0].supportedReasoningEfforts.map((e) => e.reasoningEffort),
    ["low", "high", "xhigh"],
  );
  assert.doesNotMatch(JSON.stringify(models), /SECRET_API_KEY_123/);
});

test("GrokProvider enforces auth gate, executes headless streaming turns, and supports interrupt", async (t) => {
  const root = await mkdtemp(resolve(os.tmpdir(), "ac-grok-prov-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const fakeBin = resolve(root, "fake-grok");
  await createFakeGrokCli(fakeBin);

  const authedHome = resolve(root, "authed");
  const unauthedHome = resolve(root, "unauthed");
  await Promise.all([mkdir(authedHome, { recursive: true }), mkdir(unauthedHome, { recursive: true })]);
  await writeFile(resolve(authedHome, "auth.json"), JSON.stringify({ session: "present" }));
  await writeFile(resolve(unauthedHome, "auth.json"), JSON.stringify({}));

  const env = {
    ...process.env,
    GROK_BIN: fakeBin,
    AGENT_CONTROL_GROK_HOMES: JSON.stringify([
      { id: "authed", label: "已登录", home: authedHome },
      { id: "default", label: "未登录", home: unauthedHome },
    ]),
  };
  const events = [];
  const provider = new GrokProvider({
    env,
    desktopIndexPath: resolve(root, "missing-desktop.json"),
    onEvent: (evt) => events.push(evt),
  });
  t.after(() => provider.close());

  const profiles = await provider.listProfiles();
  assert.equal(profiles[0].id, "authed");
  assert.equal(profiles[1].id, "default");
  assert.equal(profiles[1].authenticated, false);

  const probeOk = await provider.probeProfile("authed");
  assert.equal(probeOk.ok, true);
  await assert.rejects(() => provider.probeProfile("default"), /未登录/);

  await assert.rejects(
    () => provider.startThread({ profileId: "default", cwd: root, text: "hello" }),
    (err) => err?.status === 400 && /未登录/.test(err.message),
  );

  const started = await provider.startThread({
    profileId: "authed",
    cwd: root,
    text: "请测试",
    model: "grok-4.7",
    effort: "high",
  });
  assert.ok(started.turn?.id);
  assert.equal(started.thread.provider, "grok");

  // Wait for completion event
  await new Promise((resolveWait, rejectWait) => {
    const deadline = Date.now() + 5_000;
    const check = () => {
      if (events.some((e) => e.rawId === started.thread.rawId && e.type === "turn_completed")) {
        return resolveWait();
      }
      if (Date.now() > deadline) return rejectWait(new Error("timeout waiting turn_completed"));
      setTimeout(check, 20);
    };
    check();
  });

  const completedEvt = events.find((e) => e.rawId === started.thread.rawId && e.type === "turn_completed");
  assert.equal(completedEvt.status, "completed");
  assert.equal(completedEvt.lastAgentMessage, "准备调用工具\n\n执行完成。");

  const readBack = await provider.readThread("authed", started.thread.rawId);
  assert.equal(readBack.thread.provider, "grok");
  assert.ok(Array.isArray(readBack.thread.turns));

  // Interrupt test on [SLOW] turn
  const slowStart = await provider.startThread({
    profileId: "authed",
    cwd: root,
    text: "测试中断 [SLOW]",
  });
  const intr = await provider.interrupt({ rawId: slowStart.thread.rawId });
  assert.equal(intr.ok, true);
  await new Promise((resolveWait, rejectWait) => {
    const deadline = Date.now() + 5_000;
    const check = () => {
      if (events.some((e) => e.rawId === slowStart.thread.rawId && e.type === "turn_completed")) {
        return resolveWait();
      }
      if (Date.now() > deadline) return rejectWait(new Error("timeout waiting interrupt turn_completed"));
      setTimeout(check, 20);
    };
    check();
  });
  const slowDone = events.find((e) => e.rawId === slowStart.thread.rawId && e.type === "turn_completed");
  assert.equal(slowDone.status, "interrupted");
});

test("ExecutionStats and ThreadMetaStore strip [object Object] and unpack object effort entries", async (t) => {
  const dir = await mkdtemp(resolve(os.tmpdir(), "ac-grok-effort-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const metaPath = resolve(dir, "thread-meta.json");
  await writeFile(metaPath, JSON.stringify({
    version: 1,
    threads: {
      "grok:default:t-1": {
        model: "grok-4.7",
        reasoningEffort: "[object Object]",
      },
    },
    projects: {},
  }), "utf8");

  const metaStore = createThreadMetaStore({ filePath: metaPath });
  await metaStore.load();
  const loadedThread = metaStore.applyToThread({ id: "grok:default:t-1", provider: "grok", profileId: "default", rawId: "t-1" });
  assert.equal(loadedThread.reasoningEffort, undefined);

  await metaStore.setThreadPrefs("grok:default:t-1", { reasoningEffort: { reasoningEffort: "xhigh" } });
  const updated = metaStore.applyToThread({ id: "grok:default:t-1", provider: "grok", profileId: "default", rawId: "t-1" });
  assert.equal(updated.reasoningEffort, "xhigh");

  const statsPath = resolve(dir, "execution-stats.json");
  await writeFile(statsPath, JSON.stringify({
    version: 1,
    startedAt: 1000,
    runs: [{
      id: "grok:default:t-old/turn-old",
      threadId: "grok:default:t-old",
      turnId: "turn-old",
      provider: "grok",
      profileId: "default",
      model: "grok-4.7",
      effort: "[object Object]",
      startedAt: Date.now() - 1000,
      status: "completed",
      toolIds: [],
    }],
  }), "utf8");

  const stats = new ExecutionStats({ filePath: statsPath });
  await stats.load();
  stats.context("grok:default:t-new", "turn-new", { model: "grok-4.7", effort: { reasoningEffort: "high" } });
  stats.handle({
    type: "turn_started",
    provider: "grok",
    profileId: "default",
    threadId: "grok:default:t-new",
    turnId: "turn-new",
    model: "grok-4.7",
  }, { reasoningEffort: "[object Object]" });

  const snap = stats.snapshot({ days: 7, provider: "grok" });
  assert.equal(snap.runs.find((r) => r.turnId === "turn-old")?.effort, "");
  assert.equal(snap.runs.find((r) => r.turnId === "turn-new")?.effort, "high");
  await stats.flush();
});
