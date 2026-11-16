import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ExecutionStats } from "../src/execution-stats.mjs";
import { ProviderHub } from "../src/provider-hub.mjs";

test("execution comparisons separate model/effort, failures and unreported tokens", () => {
  let now = 1794823200000;
  const stats = new ExecutionStats({ now: () => now });
  const threadId = "antigravity:cli:one";
  for (const [id, effort, duration, status] of [["a", "low", 1000, "completed"], ["b", "low", 3000, "completed"], ["c", "low", 10000, "failed"], ["d", "high", 8000, "completed"]]) {
    stats.handle({ type: "turn_started", threadId, turn: { id }, provider: "antigravity", model: "gemini-4-carbon", effort });
    now += 200;
    stats.handle({ type: "stream_delta", threadId, turnId: id, kind: "reasoning", delta: "正在思考" });
    for (let i = 0; i < 2; i++) stats.handle({ type: "acp_tool_update", threadId, turnId: id, update: { toolCallId: "same-tool" } });
    now += duration - 200;
    stats.handle({ type: "turn_completed", threadId, turnId: id, status });
  }
  const snapshot = stats.snapshot();
  const low = snapshot.groups.find((g) => g.effort === "low");
  assert.equal(low.count, 3);
  assert.equal(low.completed, 2);
  assert.equal(low.failed, 1);
  assert.equal(low.medianMs, 1000);
  assert.equal(low.p90Ms, 3000);
  assert.equal(low.firstResponseMs, 200);
  assert.equal(low.meanToolCalls, 1);
  assert.equal(low.meanInputTokens, null);
  assert.equal(low.meanOutputTokens, null);
  assert.equal(snapshot.runs[0].tokenSource, "estimated");
  assert.equal(stats.snapshot({ provider: "codex" }).count, 0);
});

test("Codex token counters use per-turn deltas, deduplicate snapshots, and label an unknown baseline partial", () => {
  let now = 1794823200000;
  const stats = new ExecutionStats({ now: () => now });
  const threadId = "codex:work:one";
  const update = (turnId, input, output) => stats.handle({ threadId, method: "thread/tokenUsage/updated", params: {
    turnId, tokenUsage: { total: { inputTokens: input, outputTokens: output, cachedInputTokens: 10, reasoningOutputTokens: output / 2 },
      last: { inputTokens: 20, outputTokens: 4 } },
  } });
  update("", 100, 20);
  stats.handle({ method: "turn/started", provider: "codex", threadId, params: { turn: { id: "a" } } });
  update("a", 120, 24); update("a", 150, 30); update("a", 150, 30);
  now += 500;
  stats.handle({ method: "turn/completed", threadId, params: { turn: { id: "a", status: "completed" } } });
  const row = stats.snapshot().runs[0];
  assert.equal(row.inputTokens, 50);
  assert.equal(row.outputTokens, 10);
  assert.equal(row.reasoningTokens, 5);
  assert.equal(row.tokenSource, "reported");
  const other = "codex:work:other";
  stats.handle({ method: "turn/started", provider: "codex", threadId: other, params: { turn: { id: "x" } } });
  stats.handle({ method: "thread/tokenUsage/updated", threadId: other, params: {
    turnId: "x", tokenUsage: { total: { inputTokens: 1000 }, last: { inputTokens: 30 } },
  } });
  assert.equal(stats.snapshot().runs[0].tokenSource, "partial");
  assert.equal(stats.snapshot().runs[0].inputTokens, 30);
});

test("Claude usage includes cached input, keeps missing reasoning unknown and survives late metadata", async (t) => {
  const root = await mkdtemp(resolve(os.tmpdir(), "ac-exec-stats-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 1794823200000;
  const filePath = resolve(root, "stats.json");
  const stats = new ExecutionStats({ filePath, now: () => now });
  const threadId = "claude:work:one";
  stats.handle({ type: "turn_started", threadId, provider: "claude", turn: { id: "a" } });
  now += 2000;
  const done = { type: "turn_completed", threadId, provider: "claude", turnId: "a", status: "completed",
    usage: { input_tokens: 100, cache_read_input_tokens: 400, cache_creation_input_tokens: 50, output_tokens: 20 },
    lastAgentMessage: "不要持久化这段正文" };
  stats.handle(done); stats.handle(done);
  stats.context(threadId, "a", { model: "claude-haiku-5-5", effort: "high" });
  stats.handle({ type: "turn_started", threadId, provider: "claude", turn: { id: "b" } });
  await stats.flush();
  const raw = await readFile(filePath, "utf8");
  assert.doesNotMatch(raw, /不要持久化/);
  const reloaded = new ExecutionStats({ filePath, now: () => now });
  await reloaded.load();
  const snapshot = reloaded.snapshot();
  assert.equal(snapshot.runs[0].status, "incomplete");
  const finished = snapshot.runs[1];
  assert.equal(finished.model, "claude-haiku-5-5");
  assert.equal(finished.effort, "high");
  assert.equal(finished.inputTokens, 550);
  assert.equal(finished.cachedInputTokens, 400);
  assert.equal(finished.outputTokens, 20);
  assert.equal(finished.reasoningTokens, null);
  assert.equal(snapshot.count, 2);
  stats.context(threadId, "a", { internal: true });
  assert.equal(stats.snapshot().count, 1);
  await stats.flush();
});

test("ProviderHub records actual Mock Codex, Claude and Agy rounds with chosen model and effort", async (t) => {
  const root = await mkdtemp(resolve(os.tmpdir(), "ac-exec-hub-"));
  const homes = Object.fromEntries(["codex", "claude", "agy"].map((p) => [p, resolve(root, p)]));
  await Promise.all(Object.values(homes).map((p) => mkdir(p, { recursive: true })));
  const bin = (name) => fileURLToPath(new URL(`./helpers/mock-${name}-cli.mjs`, import.meta.url));
  const hub = new ProviderHub({ dataDir: resolve(root, "data"), enableQueueDrain: false, env: {
    ...process.env, HOME: root, USERPROFILE: root,
    CODEX_BIN: bin("codex"), CLAUDE_BIN: bin("claude"), AGY_BIN: bin("agy"),
    AGENT_CONTROL_CODEX_HOMES: JSON.stringify([{ id: "default", home: homes.codex }]),
    AGENT_CONTROL_CLAUDE_CONFIG_DIRS: JSON.stringify([{ id: "default", home: homes.claude }]),
    AGENT_CONTROL_AGY_APP_DATA_DIRS: JSON.stringify([{ id: "cli", home: homes.agy, profileType: "cli" }]),
    AGENT_CONTROL_GROK_HOMES: "[]",
  } });
  t.after(async () => { await hub.close(); await rm(root, { recursive: true, force: true }); });
  await hub.init();
  for (const [provider, model] of [["codex", "gpt-5.4"], ["claude", "claude-haiku-5-5"], ["antigravity", "gemini-4-carbon-high"]]) {
    await hub.startThread({ provider, profileId: provider === "antigravity" ? "cli" : "default", cwd: root,
      text: "统计测试 [COMPLETE_NOW]", model, effort: "high" });
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && hub.getExecutionStats().runs.filter((r) => r.status === "completed").length < 3) await new Promise((r) => setTimeout(r, 20));
  const stats = hub.getExecutionStats();
  assert.equal(stats.runs.length, 3);
  assert.equal(stats.runs.every((r) => r.status === "completed" && r.effort === "high" && r.durationMs >= 0), true, JSON.stringify(stats.runs));
  assert.deepEqual(new Set(stats.groups.map((g) => g.model)), new Set(["gpt-5.4", "claude-haiku-5-5", "gemini-4-carbon-high"]));
});
