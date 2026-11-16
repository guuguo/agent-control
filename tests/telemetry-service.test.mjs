import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, utimes, writeFile, appendFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  AgentTelemetryService,
  computeSlidingTokensPerSec,
  estimateTextTokens,
} from "../src/telemetry-service.mjs";

test("estimateTextTokens estimates English and Chinese text deterministically", () => {
  assert.equal(estimateTextTokens(""), 0);
  assert.ok(estimateTextTokens("hello world this is a test") >= 6);
  assert.ok(estimateTextTokens("正在分析项目结构并生成总结文档") >= 8);
});

test("computeSlidingTokensPerSec handles stream deltas and exact span decay", () => {
  const t0 = 1_700_000_000_000;
  const streamSamples = [
    { atMs: t0 - 2000, tokens: 60, spanMs: 0 },
    { atMs: t0 - 500, tokens: 120, spanMs: 0 },
  ];
  assert.equal(computeSlidingTokensPerSec(streamSamples, t0, { windowMs: 6000 }), 30);
  assert.equal(computeSlidingTokensPerSec(streamSamples, t0 + 7000, { windowMs: 6000 }), 0);

  const exactSamples = [
    { atMs: t0 - 500, tokens: 240, spanMs: 2000 },
  ];
  const rateMid = computeSlidingTokensPerSec(exactSamples, t0, { windowMs: 6000 });
  assert.ok(rateMid > 0);
  const rateDecayed = computeSlidingTokensPerSec(exactSamples, t0 + 4000, { windowMs: 6000 });
  assert.equal(rateDecayed, 0);
});

test("Codex native token_count supports nested usage and preserves single-line increments", async (t) => {
  const root = await mkdtemp(join(os.tmpdir(), "ac-codex-tps-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let nowMs = Date.now();
  const rolloutPath = join(root, "rollout.jsonl");
  const db = new DatabaseSync(join(root, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT, title TEXT, name TEXT, rollout_path TEXT, updated_at INTEGER, archived INTEGER)");
  db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, 0)").run("native-thread", "Codex 任务", "", rolloutPath, Math.floor(nowMs / 1000));
  db.close();
  const profiles = [{ provider: "codex", id: "default", home: root }];
  for (const nested of [true, false]) {
    const tokenEvent = (tokens) => ({ type: "event_msg", payload: {
      type: "token_count",
      ...(nested ? { info: { last_token_usage: { output_tokens: tokens } } } : { last_token_usage: { output_tokens: tokens } }),
    } });
    await writeFile(rolloutPath, [
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
      tokenEvent(10_000),
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const svc = new AgentTelemetryService({ nowFn: () => nowMs });
    assert.equal((await svc.collectSnapshot({ profiles })).byProvider.codex.tokensPerSec, 0);
    nowMs += 2000;
    await appendFile(rolloutPath, JSON.stringify(tokenEvent(300)) + "\n");
    await utimes(rolloutPath, new Date(nowMs), new Date(nowMs));
    const snap = await svc.collectSnapshot({ profiles });
    assert.equal(snap.byProfile["codex:default"].tokensPerSec, 50, nested ? "现代嵌套字段" : "旧版外层字段");
    assert.equal(snap.byProvider.codex.tokensPerSec, 50);
    assert.equal((await svc.collectSnapshot({ profiles })).byProvider.codex.tokensPerSec, 50, "没有新行时不能重复计数");
    nowMs += 7000;
    assert.equal((await svc.collectSnapshot({ profiles })).byProvider.codex.tokensPerSec, 0);
    svc.recordStreamDelta("codex", "codex:default:native-thread", "a".repeat(100), nowMs);
    await appendFile(rolloutPath, JSON.stringify(tokenEvent(600)) + "\n");
    const managed = await svc.collectSnapshot({
      profiles,
      activeTurnsByProvider: { codex: [{ id: "codex:default:native-thread", rawId: "native-thread" }] },
    });
    assert.equal(managed.byProvider.codex.tokensPerSec, 4.3, "托管会话已按流式文本计数，不再叠加磁盘 token");
    await appendFile(rolloutPath, JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } }) + "\n");
    assert.equal((await svc.collectSnapshot({ profiles })).byProvider.codex.runningCount, 0);
  }
});

test("AgentTelemetryService aggregates managed runs and tails native disk runs across all 4 providers", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "ac-telemetry-"));
  let nowMs = 1_700_000_100_000;
  try {
    const agyHome = join(root, "agy-desktop");
    const codexHome = join(root, "codex-home");
    const claudeHome = join(root, "claude-home");
    const grokHome = join(root, "grok-home");

    // 1. Antigravity desktop DB + transcript_full tailing
    const agyConvId = "11111111-1111-1111-1111-111111111111";
    const agyLogDir = join(agyHome, "brain", agyConvId, ".system_generated", "logs");
    await mkdir(agyLogDir, { recursive: true });
    const agyDb = new DatabaseSync(join(agyHome, "conversation_summaries.db"));
    agyDb.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT,
        status TEXT,
        last_modified_time TEXT,
        workspace_uris TEXT,
        not_fully_idle INTEGER,
        killed INTEGER
      );
    `);
    agyDb.prepare(`
      INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      agyConvId,
      "修复移动端 HUD",
      "CONVERSATION_STATUS_RUNNING",
      new Date(nowMs - 2000).toISOString(),
      JSON.stringify(["file:///tmp/demo"]),
      1,
      0,
    );
    agyDb.close();
    const agyTfPath = join(agyLogDir, "transcript_full.jsonl");
    await writeFile(
      agyTfPath,
      `${JSON.stringify({ step_index: 1, created_at: new Date(nowMs - 4000).toISOString(), type: "PLANNER_RESPONSE", content: "initial" })}\n`,
      "utf8",
    );

    // 2. Codex sqlite + rollout jsonl
    const codexRawId = "019a0000-0000-7000-8000-000000000001";
    await mkdir(codexHome, { recursive: true });
    const rolloutPath = join(codexHome, "rollout-1.jsonl");
    await writeFile(
      rolloutPath,
      `${JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t1" } })}\n`,
      "utf8",
    );
    const codexDb = new DatabaseSync(join(codexHome, "state_5.sqlite"));
    codexDb.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        title TEXT,
        name TEXT,
        rollout_path TEXT,
        updated_at INTEGER,
        archived INTEGER
      );
    `);
    codexDb.prepare(`INSERT INTO threads VALUES (?, ?, ?, ?, ?, 0)`).run(
      codexRawId,
      "Codex 原生重构",
      "Codex 原生重构",
      rolloutPath,
      Math.floor(nowMs / 1000),
    );
    codexDb.close();

    // 3. Claude active session JSONL
    const claudeProjDir = join(claudeHome, "projects", "-tmp-demo");
    await mkdir(claudeProjDir, { recursive: true });
    const claudeJsonl = join(claudeProjDir, "claude-sess-1.jsonl");
    await writeFile(
      claudeJsonl,
      [
        JSON.stringify({ type: "user", message: { content: "分析脚本耗时" }, timestamp: new Date(nowMs - 4000).toISOString() }),
        JSON.stringify({
          type: "assistant",
          timestamp: new Date(nowMs - 1000).toISOString(),
          message: { stop_reason: "tool_use", usage: { output_tokens: 180 }, content: [{ type: "text", text: "好的" }] },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    await utimes(claudeJsonl, new Date(nowMs - 1000), new Date(nowMs - 1000));

    // 4. Grok session usage.json + meta.json
    const grokSessDir = join(grokHome, "sessions", "proj-a", "grok-sess-1");
    await mkdir(grokSessDir, { recursive: true });
    const grokUsagePath = join(grokSessDir, "usage.json");
    await writeFile(grokUsagePath, JSON.stringify({ session: { totalTokens: 100 } }), "utf8");
    await writeFile(join(grokSessDir, "meta.json"), JSON.stringify({ title: "Grok 原生研究" }), "utf8");
    await utimes(grokUsagePath, new Date(nowMs - 1000), new Date(nowMs - 1000));

    const svc = new AgentTelemetryService({
      homeDir: root,
      nowFn: () => nowMs,
    });
    const profiles = [
      { provider: "antigravity", id: "desktop", home: agyHome },
      { provider: "codex", id: "default", home: codexHome },
      { provider: "claude", id: "default", home: claudeHome },
      { provider: "grok", id: "cockpit-1", home: grokHome },
    ];

    // Record managed stream delta on claude as well
    svc.recordStreamDelta("codex", "codex:default:managed-1", "a".repeat(240), nowMs - 1000);

    const first = await svc.collectSnapshot({
      profiles,
      activeTurnsByProvider: {
        codex: [{ id: "codex:default:managed-1", rawId: "managed-1", title: "托管 Codex 任务" }],
      },
      queuedByProvider: { antigravity: 2, claude: 1 },
    });

    assert.equal(first.byProvider.antigravity.runningCount, 1);
    assert.equal(first.byProvider.antigravity.queuedCount, 2);
    assert.equal(first.byProvider.codex.runningCount, 2);
    assert.ok(first.byProvider.codex.tokensPerSec > 0);
    assert.equal(first.byProvider.claude.runningCount, 1);
    assert.equal(first.byProvider.claude.queuedCount, 1);
    assert.ok(first.byProvider.claude.tokensPerSec > 0);
    assert.equal(first.byProvider.grok.runningCount, 1);
    assert.equal(first.totals.runningCount, 5);
    assert.equal(first.totals.queuedCount, 3);

    // Advance 2s and append incremental deltas to Antigravity, Codex rollout, and Grok usage.json
    nowMs += 2000;
    await appendFile(
      agyTfPath,
      `${JSON.stringify({ step_index: 2, created_at: new Date(nowMs - 1500).toISOString(), type: "PLANNER_RESPONSE", content: "这里是一大段实时生成的架构排查结论与修改步骤".repeat(4) })}\n`,
      "utf8",
    );
    await appendFile(
      rolloutPath,
      `${JSON.stringify({ type: "event_msg", payload: { type: "token_count", last_token_usage: { output_tokens: 300 } } })}\n`,
      "utf8",
    );
    await utimes(rolloutPath, new Date(nowMs), new Date(nowMs));
    await writeFile(grokUsagePath, JSON.stringify({ session: { totalTokens: 460 } }), "utf8");
    await utimes(grokUsagePath, new Date(nowMs), new Date(nowMs));

    const second = await svc.collectSnapshot({ profiles });
    assert.ok(second.byProvider.antigravity.tokensPerSec > 0);
    assert.ok(second.byProvider.codex.tokensPerSec > 0);
    assert.ok(second.byProvider.grok.tokensPerSec > 0);
    assert.ok(second.totals.tokensPerSec > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tracks per-instance byProfile metrics and attributes Cockpit desktop Claude sessions", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "ac-telemetry-byprofile-"));
  let nowMs = 1_794_680_000_000;
  try {
    const claudeHome = join(root, ".claude");
    const claudeProj = join(claudeHome, "projects", "-tmp-app");
    const cockpitInstDir = join(root, ".cockpit_tools", "instances", "claude", "06c986e6488fe0fa");
    await mkdir(claudeProj, { recursive: true });
    await mkdir(join(cockpitInstDir, "claude-code-sessions", "acct-h", "org-h"), { recursive: true });

    const claimedSid = "22561d92-dfd7-44fb-b6ab-5d5035bb0240";
    const defaultSid = "99999999-aaaa-bbbb-cccc-dddddddddddd";
    await writeFile(
      join(cockpitInstDir, "claude-code-sessions", "acct-h", "org-h", "local_1.json"),
      JSON.stringify({ cliSessionId: claimedSid }),
      "utf8",
    );

    const claimedPath = join(claudeProj, `${claimedSid}.jsonl`);
    await writeFile(
      claimedPath,
      [
        JSON.stringify({ type: "user", message: { content: "Hotmail 桌面会话任务" } }),
        JSON.stringify({
          type: "assistant",
          timestamp: new Date(nowMs - 1000).toISOString(),
          message: { stop_reason: "tool_use", usage: { output_tokens: 240 } },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    await utimes(claimedPath, new Date(nowMs - 500), new Date(nowMs - 500));

    const svc = new AgentTelemetryService({
      env: { HOME: root },
      homeDir: root,
      nowFn: () => nowMs,
    });

    const profiles = [
      { key: "codex:default", provider: "codex", id: "default", home: join(root, ".codex") },
      { key: "codex:codex", provider: "codex", id: "codex", home: join(root, ".codex-alt") },
      { key: "claude:default", provider: "claude", id: "default", home: claudeHome, cliConfigDir: claudeHome },
      {
        key: "claude:claude-hotmail",
        provider: "claude",
        id: "claude-hotmail",
        home: claudeHome,
        cliConfigDir: claudeHome,
        desktopUserDataDir: cockpitInstDir,
        isDesktopInstance: true,
        cockpitAccount: { accountUuid: "acct-h", organizationUuid: "org-h" },
      },
    ];

    svc.recordStreamDelta("codex", "codex:codex:t-alt", "streaming tokens ".repeat(20), nowMs - 1000);
    svc.recordStreamDelta("claude", `claude:default:${defaultSid}`, "default tokens ".repeat(15), nowMs - 1000);

    const snap = await svc.collectSnapshot({
      profiles,
      activeTurnsByProvider: {
        codex: [{ id: "codex:codex:t-alt", rawId: "t-alt", title: "Alt Codex 任务" }],
        claude: [{ id: `claude:default:${defaultSid}`, rawId: defaultSid, title: "Default Claude 任务" }],
      },
      queuedByProvider: { codex: 2, claude: 1 },
      queuedByProfile: { "codex:default": 1, "codex:codex": 1, "claude:claude-hotmail": 1 },
    });

    assert.equal(snap.byProfile["codex:default"].runningCount, 0);
    assert.equal(snap.byProfile["codex:default"].queuedCount, 1);
    assert.equal(snap.byProfile["codex:default"].tokensPerSec, 0);

    assert.equal(snap.byProfile["codex:codex"].runningCount, 1);
    assert.equal(snap.byProfile["codex:codex"].queuedCount, 1);
    assert.ok(snap.byProfile["codex:codex"].tokensPerSec > 0);
    assert.equal(snap.byProfile["codex:codex"].activeThreads[0].id, "codex:codex:t-alt");

    assert.equal(snap.byProfile["claude:default"].runningCount, 1);
    assert.equal(snap.byProfile["claude:default"].queuedCount, 0);
    assert.ok(snap.byProfile["claude:default"].tokensPerSec > 0);

    assert.equal(snap.byProfile["claude:claude-hotmail"].runningCount, 1);
    assert.equal(snap.byProfile["claude:claude-hotmail"].queuedCount, 1);
    assert.ok(snap.byProfile["claude:claude-hotmail"].tokensPerSec > 0);
    assert.equal(snap.byProfile["claude:claude-hotmail"].activeThreads[0].id, `claude:claude-hotmail:${claimedSid}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
