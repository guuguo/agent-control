import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ProviderHub } from "../src/provider-hub.mjs";

test("ProviderHub forkThread truncates following turns and materializes with clean prefix on first message", async (t) => {
  const root = await mkdtemp(resolve(os.tmpdir(), "ac-fork-test-"));
  const homes = Object.fromEntries(["codex", "claude", "agy"].map((p) => [p, resolve(root, p)]));
  await Promise.all(Object.values(homes).map((p) => mkdir(p, { recursive: true })));
  const bin = (name) => fileURLToPath(new URL(`./helpers/mock-${name}-cli.mjs`, import.meta.url));
  const hub = new ProviderHub({
    dataDir: resolve(root, "data"),
    enableQueueDrain: false,
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      CODEX_BIN: bin("codex"),
      CLAUDE_BIN: bin("claude"),
      AGY_BIN: bin("agy"),
      AGENT_CONTROL_CODEX_HOMES: JSON.stringify([{ id: "default", home: homes.codex }]),
      AGENT_CONTROL_CLAUDE_CONFIG_DIRS: JSON.stringify([{ id: "default", home: homes.claude }]),
      AGENT_CONTROL_AGY_APP_DATA_DIRS: JSON.stringify([{ id: "cli", home: homes.agy, profileType: "cli" }]),
      AGENT_CONTROL_GROK_HOMES: "[]",
    },
  });
  t.after(async () => {
    await hub.close();
    await rm(root, { recursive: true, force: true });
  });
  await hub.init();

  const waitDone = async (threadId, expectedTurns) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const res = await hub.readThread(threadId, { detail: "full", limit: 20 });
      const turns = res?.thread?.turns || [];
      if (turns.length >= expectedTurns && turns.every((turn) => turn.status !== "inProgress" && turn.status !== "running")) {
        return res;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`Timed out waiting for ${expectedTurns} turns on ${threadId}`);
  };

  const started = await hub.startThread({
    provider: "claude",
    profileId: "default",
    cwd: root,
    text: "第一轮问题 [COMPLETE_NOW]",
  });
  await waitDone(started.thread.id, 1);
  await hub.sendTurn({
    threadId: started.thread.id,
    cwd: root,
    text: "第二轮问题（分叉时应丢弃） [COMPLETE_NOW]",
  });
  await waitDone(started.thread.id, 2);

  // Fork from turn index 0 (drop turn 1)
  const forked = await hub.forkThread({
    threadId: started.thread.id,
    upToTurnIndex: 0,
  });
  assert.equal(forked.ok, true);
  assert.equal(forked.native, false);
  assert.match(forked.thread.name, /\(分叉\)$/);

  const draftRead = await hub.readThread(forked.thread.id, { detail: "full" });
  assert.equal(draftRead.thread.turns.length, 1);
  assert.match(JSON.stringify(draftRead.thread.turns[0]), /第一轮问题/);
  assert.doesNotMatch(JSON.stringify(draftRead.thread.turns), /第二轮问题/);

  const listed = await hub.listThreads({ provider: "claude" });
  assert.equal(listed.threads.some((item) => item.id === forked.thread.id), true);

  // Send first new turn on the forked thread -> materializes into a real thread with prefix kept
  const sent = await hub.sendTurn({
    threadId: forked.thread.id,
    cwd: root,
    text: "沿着第一轮继续聊 [COMPLETE_NOW]",
  });
  assert.ok(sent.redirectedThreadId);
  const finalRead = await waitDone(sent.redirectedThreadId, 2);
  assert.equal(finalRead.thread.turns.length, 2);
  assert.match(JSON.stringify(finalRead.thread.turns[0]), /第一轮问题/);
  assert.match(JSON.stringify(finalRead.thread.turns[1]), /沿着第一轮继续聊/);
  assert.doesNotMatch(JSON.stringify(finalRead.thread.turns[1]), /AC_FORK_CONTEXT_START/);
});
