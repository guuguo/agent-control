import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  assert.deepEqual(new Set(stats.groups.map((g) => g.model)), new Set(["gpt-5.4", "claude-haiku-5-5", "gemini-4-carbon"]));
});

test("Antigravity model names normalize effort suffixes on record and load", async (t) => {
  const root = await mkdtemp(resolve(os.tmpdir(), "ac-exec-agy-norm-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 1794823200000;
  const filePath = resolve(root, "stats.json");
  const stats = new ExecutionStats({ filePath, now: () => now });
  const threadId = "antigravity:desktop:one";

  stats.handle({ type: "turn_started", threadId, turn: { id: "t1" }, provider: "antigravity", model: "gemini-4-hydrogen-high", effort: "medium" });
  now += 1000;
  stats.handle({ type: "turn_completed", threadId, turnId: "t1", status: "completed" });

  stats.handle({ type: "turn_started", threadId, turn: { id: "t2" }, provider: "antigravity", model: "gemini-4-hydrogen", effort: "medium" });
  now += 2000;
  stats.handle({ type: "turn_completed", threadId, turnId: "t2", status: "completed" });

  stats.handle({ type: "turn_started", threadId, turn: { id: "t3" }, provider: "antigravity", model: "gemini-4-hydrogen-high", effort: "" });
  now += 3000;
  stats.handle({ type: "turn_completed", threadId, turnId: "t3", status: "completed" });

  await stats.flush();
  // Existing records may still contain suffixed model IDs. The explicit effort
  // remains authoritative even when it disagrees with the model-name suffix.
  const saved = JSON.parse(await readFile(filePath, "utf8"));
  saved.runs.find((row) => row.turnId === "t1").model = "gemini-4-hydrogen-high";
  saved.runs.find((row) => row.turnId === "t2").model = "gemini-4-hydrogen-medium";
  await writeFile(filePath, JSON.stringify(saved));
  const reloaded = new ExecutionStats({ filePath, now: () => now });
  await reloaded.load();
  const groups = reloaded.snapshot().groups;
  assert.equal(groups.length, 2);
  const med = groups.find((g) => g.model === "gemini-4-hydrogen" && g.effort === "medium");
  const high = groups.find((g) => g.model === "gemini-4-hydrogen" && g.effort === "high");
  assert.equal(med?.count, 2);
  assert.equal(high?.count, 1);
});

test("ExecutionStats computes medianTokensPerSec, handles short turns, and sorts groups by volume", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { ExecutionStats, computeRunTokensPerSec } = await import("../src/execution-stats.mjs");

  assert.equal(
    computeRunTokensPerSec({
      durationMs: 3000,
      firstResponseMs: 1000,
      outputTokens: 200,
      tokenSource: "reported",
    }),
    100,
  );
  // Estimated tokens are ignored unless useEstimated is enabled
  assert.equal(
    computeRunTokensPerSec({
      durationMs: 3000,
      firstResponseMs: 1000,
      outputTokens: null,
      estimatedOutputTokens: 160,
      tokenSource: "estimated",
    }),
    null,
  );
  assert.equal(
    computeRunTokensPerSec(
      {
        durationMs: 3000,
        firstResponseMs: 1000,
        outputTokens: null,
        estimatedOutputTokens: 160,
        tokenSource: "estimated",
      },
      { useEstimated: true },
    ),
    80,
  );
  // Short generation (< 200ms) is ignored to prevent Infinity/distorted speeds
  assert.equal(
    computeRunTokensPerSec({
      durationMs: 1150,
      firstResponseMs: 1000,
      outputTokens: 50,
      tokenSource: "reported",
    }),
    null,
  );
  assert.equal(
    computeRunTokensPerSec({
      durationMs: 150,
      firstResponseMs: 0,
      outputTokens: 50,
      tokenSource: "reported",
    }),
    null,
  );
  // ACP history-replay burst (>2000 tok/s) is excluded as implausible
  assert.equal(
    computeRunTokensPerSec(
      {
        durationMs: 349,
        firstResponseMs: 47,
        outputTokens: null,
        estimatedOutputTokens: 41092,
        tokenSource: "estimated",
      },
      { useEstimated: true },
    ),
    null,
  );

  const dir = await mkdtemp(join(tmpdir(), "ac-exec-speed-"));
  const filePath = join(dir, "execution-stats.json");
  const now = 1_795_000_000_000;
  try {
    await writeFile(
      filePath,
      JSON.stringify({
        startedAt: now - 20_000,
        runs: [
          // Small volume group (1 completed) with high reported speed
          {
            id: "codex-1",
            threadId: "codex:default:th-1",
            provider: "codex",
            model: "gpt-6.1-sol",
            effort: "medium",
            status: "completed",
            startedAt: now - 10_000,
            endedAt: now - 5_000,
            durationMs: 5000,
            firstResponseMs: 1000,
            inputTokens: 1000,
            outputTokens: 400,
            cachedInputTokens: 0,
            reasoningTokens: 0,
            toolIds: [],
            tokenSource: "reported",
          },
          // Ultra-short turn in another group (<200ms generation) -> unavailable speed
          {
            id: "fast-1",
            threadId: "claude:default:th-short",
            provider: "claude",
            model: "claude-sonnet-5-5",
            effort: "low",
            status: "completed",
            startedAt: now - 9_000,
            endedAt: now - 8_850,
            durationMs: 150,
            firstResponseMs: 0,
            inputTokens: 100,
            outputTokens: 20,
            cachedInputTokens: 0,
            reasoningTokens: 0,
            toolIds: [],
            tokenSource: "reported",
          },
          // High volume group (3 completed) with estimated streaming speed
          {
            id: "agy-1",
            threadId: "antigravity:default:th-2",
            provider: "antigravity",
            model: "gemini-4-hydrogen",
            effort: "medium",
            status: "completed",
            startedAt: now - 8_000,
            endedAt: now - 5_000,
            durationMs: 3000,
            firstResponseMs: 1000,
            inputTokens: null,
            outputTokens: null,
            estimatedOutputTokens: 100,
            cachedInputTokens: null,
            reasoningTokens: null,
            toolIds: [],
            tokenSource: "estimated",
          },
          {
            id: "agy-2",
            threadId: "antigravity:default:th-2",
            provider: "antigravity",
            model: "gemini-4-hydrogen",
            effort: "medium",
            status: "completed",
            startedAt: now - 7_000,
            endedAt: now - 3_000,
            durationMs: 4000,
            firstResponseMs: 1000,
            inputTokens: null,
            outputTokens: null,
            estimatedOutputTokens: 180,
            cachedInputTokens: null,
            reasoningTokens: null,
            toolIds: [],
            tokenSource: "estimated",
          },
          {
            id: "agy-3",
            threadId: "antigravity:default:th-2",
            provider: "antigravity",
            model: "gemini-4-hydrogen",
            effort: "medium",
            status: "completed",
            startedAt: now - 6_000,
            endedAt: now - 3_000,
            durationMs: 3000,
            firstResponseMs: 1000,
            inputTokens: null,
            outputTokens: null,
            estimatedOutputTokens: 140,
            cachedInputTokens: null,
            reasoningTokens: null,
            toolIds: [],
            tokenSource: "estimated",
          },
        ],
      }),
    );

    const stats = new ExecutionStats({ filePath, now: () => now });
    await stats.load();
    const snap = stats.snapshot({ days: 7 });
    assert.equal(snap.groups.length, 3);
    // Sorted descending by completed count (3 -> 1 -> 1)
    assert.equal(snap.groups[0].model, "gemini-4-hydrogen");
    assert.equal(snap.groups[0].completed, 3);
    assert.equal(snap.groups[0].tokensPerSecSource, "estimated");
    assert.equal(snap.groups[0].speedSampleCount, 3);
    assert.equal(snap.groups[0].medianTokensPerSec, 60);

    const codexGroup = snap.groups.find((g) => g.model === "gpt-6.1-sol");
    assert.equal(codexGroup?.tokensPerSecSource, "reported");
    assert.equal(codexGroup?.speedSampleCount, 1);
    assert.equal(codexGroup?.medianTokensPerSec, 100);

    const shortGroup = snap.groups.find((g) => g.model === "claude-sonnet-5-5");
    assert.equal(shortGroup?.tokensPerSecSource, "unavailable");
    assert.equal(shortGroup?.speedSampleCount, 0);
    assert.equal(shortGroup?.medianTokensPerSec, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("execution-stats UI builds human summary ignoring 1-turn outliers, renders collapsible raw metrics, escapes XSS, and uses no emojis", async () => {
  const { buildExecutionSummary, renderExecutionStatsHtml } = await import("../public/execution-stats.js");

  const snapshot = {
    days: 7,
    startedAt: 1_794_400_000_000,
    updatedAt: 1_795_000_000_000,
    groups: [
      {
        provider: "antigravity",
        model: "gemini-4-hydrogen",
        effort: "medium",
        count: 737,
        completed: 681,
        failed: 56,
        interrupted: 0,
        running: 0,
        incomplete: 0,
        medianMs: 52_500,
        p90Ms: 240_000,
        firstResponseMs: 7_700,
        medianTokensPerSec: 60,
        tokensPerSecSource: "estimated",
        speedSampleCount: 400,
        meanInputTokens: null,
        meanOutputTokens: null,
        meanCachedTokens: null,
        meanReasoningTokens: null,
        meanToolCalls: 2,
        reportedCount: 0,
      },
      {
        provider: "codex",
        model: "gpt-6.1-sol",
        effort: "medium",
        count: 46,
        completed: 46,
        failed: 0,
        interrupted: 0,
        running: 0,
        incomplete: 0,
        medianMs: 72_000,
        p90Ms: 497_000,
        firstResponseMs: 6_000,
        medianTokensPerSec: 120,
        tokensPerSecSource: "reported",
        speedSampleCount: 46,
        meanInputTokens: 3_044_377,
        meanOutputTokens: 3_492,
        meanCachedTokens: 1_200_000,
        meanReasoningTokens: 500,
        meanToolCalls: 3,
        reportedCount: 46,
      },
      {
        provider: "antigravity",
        model: "gemini-3.8-flash",
        effort: "low",
        count: 18,
        completed: 18,
        failed: 0,
        interrupted: 0,
        running: 0,
        incomplete: 0,
        medianMs: 13_700,
        p90Ms: 33_700,
        firstResponseMs: 2_600,
        medianTokensPerSec: 85,
        tokensPerSecSource: "estimated",
        speedSampleCount: 18,
        meanInputTokens: null,
        meanOutputTokens: null,
        meanCachedTokens: null,
        meanReasoningTokens: null,
        meanToolCalls: 1,
        reportedCount: 0,
      },
      // 1-turn fast outlier should NOT beat high-sample groups
      {
        provider: "codex",
        model: "gpt-outlier-fast",
        effort: "low",
        count: 1,
        completed: 1,
        failed: 0,
        interrupted: 0,
        running: 0,
        incomplete: 0,
        medianMs: 1_000,
        p90Ms: 1_000,
        firstResponseMs: 400,
        medianTokensPerSec: 999,
        tokensPerSecSource: "reported",
        speedSampleCount: 1,
        meanInputTokens: 1000,
        meanOutputTokens: 500,
        meanCachedTokens: 0,
        meanReasoningTokens: 0,
        meanToolCalls: 0,
        reportedCount: 1,
      },
      // 1-turn slow outlier
      {
        provider: "grok",
        model: "grok-4.7",
        effort: "default",
        count: 1,
        completed: 1,
        failed: 0,
        interrupted: 0,
        running: 0,
        incomplete: 0,
        medianMs: 1_265_000,
        p90Ms: 1_265_000,
        firstResponseMs: 148_000,
        medianTokensPerSec: 12,
        tokensPerSecSource: "estimated",
        speedSampleCount: 1,
        meanInputTokens: null,
        meanOutputTokens: null,
        meanCachedTokens: null,
        meanReasoningTokens: null,
        meanToolCalls: 0,
        reportedCount: 0,
      },
      // Group with script tag in model name to verify HTML escaping
      {
        provider: "codex",
        model: "<script>alert(1)</script>",
        effort: "high",
        count: 4,
        completed: 4,
        failed: 0,
        interrupted: 0,
        running: 0,
        incomplete: 0,
        medianMs: 90_000,
        p90Ms: 150_000,
        firstResponseMs: 8_000,
        medianTokensPerSec: 50,
        tokensPerSecSource: "reported",
        speedSampleCount: 4,
        meanInputTokens: 20_000,
        meanOutputTokens: 1_000,
        meanCachedTokens: 0,
        meanReasoningTokens: 100,
        meanToolCalls: 1,
        reportedCount: 4,
      },
    ],
    runs: [
      {
        id: "recent-1",
        startedAt: 1_794_999_000_000,
        threadId: "codex:default:th-recent-1",
        profileId: "default",
        provider: "codex",
        model: "<script>xss</script>",
        effort: "medium",
        status: "completed",
        durationMs: 72_000,
        firstResponseMs: 6_000,
        inputTokens: 10_000,
        outputTokens: 3_492,
        estimatedOutputTokens: 0,
        toolCalls: 2,
        tokenSource: "reported",
      },
    ],
  };

  const summary = buildExecutionSummary(snapshot, { days: 7 });
  assert.equal(summary.fastestFirstOutput?.model, "gemini-3.8-flash");
  assert.equal(summary.fastestThroughput?.model, "gpt-6.1-sol");
  assert.equal(summary.fastestTurn?.model, "gemini-3.8-flash");
  assert.equal(summary.mostUsed?.model, "gemini-4-hydrogen");
  assert.ok(typeof summary.headlineText === "string" && summary.headlineText.length > 0);

  const html = renderExecutionStatsHtml(snapshot, { days: 7, provider: "all" });
  assert.match(html, /class="execution-summary-grid"/);
  assert.match(html, /class="execution-summary-verdict"/);
  assert.match(html, /class="execution-stats-table is-human"/);
  assert.match(html, /<details class="execution-stats-raw"/);
  assert.match(html, /<details class="execution-stats-recent"/);
  assert.match(html, /class="execution-stats-scroll"/);
  assert.match(html, /data-execution-days/);
  assert.match(html, /data-execution-provider/);
  assert.match(html, /data-execution-refresh/);
  assert.match(html, /data-execution-thread/);
  assert.equal(/\p{Extended_Pictographic}/u.test(html), false);
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes("&lt;script&gt;"), true);

  // Legacy backend payload omitting medianTokensPerSec falls back cleanly to meanOutputTokens/medianMs estimation
  const legacySnapshot = {
    days: 7,
    startedAt: 1_794_400_000_000,
    updatedAt: 1_795_000_000_000,
    groups: [
      {
        provider: "codex",
        model: "gpt-6.1-sol",
        effort: "medium",
        count: 46,
        completed: 46,
        failed: 0,
        interrupted: 0,
        running: 0,
        incomplete: 0,
        medianMs: 72_000,
        p90Ms: 497_000,
        firstResponseMs: 6_000,
        meanInputTokens: 3_044_377,
        meanOutputTokens: 3_492,
        meanCachedTokens: 1_200_000,
        meanReasoningTokens: 500,
        meanToolCalls: 3,
        reportedCount: 46,
      },
    ],
    runs: [],
  };
  const legacySummary = buildExecutionSummary(legacySnapshot, { days: 7 });
  assert.equal(legacySummary.fastestThroughput?.model, "gpt-6.1-sol");
  const legacyHtml = renderExecutionStatsHtml(legacySnapshot, { days: 7, provider: "all" });
  assert.equal(legacyHtml.includes("暂无速率"), false);
  assert.match(legacyHtml, /≈53 tok\/s/);
});
