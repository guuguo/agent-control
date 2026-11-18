import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import { ForkStore } from "../src/fork-store.mjs";
import { ProviderHub } from "../src/provider-hub.mjs";
import { AntigravityProvider } from "../src/providers/antigravity-provider.mjs";

test("分叉历史只接在最早一页，滚动加载后刷新尾部不丢中间轮次", async (t) => {
  const root = await mkdtemp(resolve(os.tmpdir(), "ac-fork-pages-"));
  const home = resolve(root, "agy"), dataDir = resolve(root, "data");
  await mkdir(home, { recursive: true });
  const prefix = Array.from({ length: 45 }, (_, i) => ({
    id: `parent-${i}`, status: "completed", items: [
      { type: "userMessage", content: [{ type: "text", text: `原会话问题 ${i}` }] },
      { type: "agentMessage", text: `原会话答复 ${i}` },
    ],
  }));
  const store = new ForkStore({ filePath: resolve(dataDir, "forked-threads.json") });
  const fork = await store.create({ provider: "antigravity", profileId: "cli", cwd: root, turns: prefix });
  const rawId = "fork-materialized", threadId = `antigravity:cli:${rawId}`;
  await store.markMaterialized(fork.id, threadId);
  const steps = Array.from({ length: 20 }, (_, i) => [
    { step_index: i * 2, type: "USER_INPUT", created_at: "2026-01-01T00:00:00Z", content: `分叉后问题 ${i}` },
    { step_index: i * 2 + 1, type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-01-01T00:00:01Z", content: `分叉后答复 ${i}` },
  ]).flat();
  steps[0].content = `<!-- AC_FORK_CONTEXT_START -->\n原会话上下文\n<!-- AC_FORK_CONTEXT_END -->\n${steps[0].content}`;
  const logs = resolve(home, "brain", rawId, ".system_generated/logs");
  await mkdir(logs, { recursive: true });
  await writeFile(resolve(logs, "transcript.jsonl"), steps.map((step) => JSON.stringify(step)).join("\n") + "\n");
  const env = { ...process.env, HOME: root, USERPROFILE: root,
    AGY_BIN: fileURLToPath(new URL("./helpers/mock-agy-cli.mjs", import.meta.url)),
    AGENT_CONTROL_AGY_APP_DATA_DIRS: JSON.stringify([{ id: "cli", home, profileType: "cli" }]),
    AGENT_CONTROL_DISABLE_AUTOMATIONS: "1" };
  const provider = new AntigravityProvider({ env });
  const hub = new ProviderHub({ env, dataDir, providers: [provider], enableQueueDrain: false });
  t.after(async () => { await hub.close(); await rm(root, { recursive: true, force: true }); });
  await hub.init();

  // 使用前端实际的轮次合并代码，覆盖每次仅拉最新两轮的后台刷新。
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const merge = vm.runInNewContext(source.slice(source.indexOf("function mergeReloadedTurns("), source.indexOf("let activeThreadReloadInFlight")) + "\nmergeReloadedTurns;");
  const ids = (turns) => Array.from(turns, (turn) => turn.id);
  const first = await hub.readThread(threadId, { limit: 12 });
  const tail = await hub.readThread(threadId, { limit: 2 });
  let loaded = merge(first.thread.turns, tail.thread.turns);
  assert.deepEqual(ids(loaded), ids(first.thread.turns), "刷新最新两轮不应抹掉中间已加载的十轮");
  assert.equal(first.thread.turns.length, 12);
  assert.equal(first.nextCursor, "turn:8");
  assert.equal(tail.thread.turns.length, 2);

  const older = await hub.readThread(threadId, { cursor: first.nextCursor, limit: 4 });
  assert.equal(older.thread.turns.length, 4);
  assert.equal(older.nextCursor, "turn:4");
  loaded = [...older.thread.turns, ...loaded];
  const beforeRefresh = ids(loaded);
  loaded = merge(loaded, (await hub.readThread(threadId, { limit: 2 })).thread.turns);
  assert.deepEqual(ids(loaded), beforeRefresh);

  const oldest = await hub.readThread(threadId, { cursor: older.nextCursor, limit: 25 });
  assert.equal(oldest.nextCursor, null);
  assert.equal(oldest.thread.turns.length, 49);
  assert.deepEqual(ids(oldest.thread.turns.slice(0, 45)), ids(prefix));
  assert.doesNotMatch(JSON.stringify(oldest.thread.turns.slice(45)), /AC_FORK_CONTEXT_START/);
  loaded = [...oldest.thread.turns, ...loaded];
  const full = await hub.readThread(threadId, { detail: "full", limit: 300 });
  assert.equal(loaded.length, 65);
  assert.deepEqual(ids(loaded), ids(full.thread.turns));
  loaded = merge(loaded, (await hub.readThread(threadId, { limit: 2 })).thread.turns);
  assert.deepEqual(ids(loaded), ids(full.thread.turns));

  // 少于一页的新轮次仍直接展示全部继承历史；普通会话分页保持原样。
  const all = await hub.readThread(threadId, { limit: 25 });
  assert.equal(all.thread.turns.length, 65);
  const native = await provider.readThread("cli", rawId, { limit: 2 });
  assert.deepEqual(ids(native.thread.turns), ids(tail.thread.turns));
  assert.equal(native.nextCursor, tail.nextCursor);
});
