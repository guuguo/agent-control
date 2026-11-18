import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  formatCompositeThreadId,
  formatProfileKey,
  parseCompositeThreadId,
  parseProfileKey,
  tryParseCompositeThreadId,
} from "../src/composite-id.mjs";
import { createGoalController, GOAL_COMPLETE_MARKER } from "../src/goal-controller.mjs";
import { createThreadMetaStore } from "../src/thread-meta-store.mjs";

test("composite ID parsing handles colons inside rawId and validates provider/profileId", () => {
  const full = formatCompositeThreadId("codex", "work_2", "urn:uuid:abc:123");
  assert.equal(full, "codex:work_2:urn:uuid:abc:123");

  const parsed = parseCompositeThreadId(full);
  assert.deepEqual(parsed, {
    id: full,
    provider: "codex",
    profileId: "work_2",
    rawId: "urn:uuid:abc:123",
  });

  assert.throws(() => parseCompositeThreadId("unknown:default:123"), (err) => err.status === 400);
  assert.throws(() => parseCompositeThreadId("claude:bad space:123"), (err) => err.status === 400);
  assert.throws(() => parseCompositeThreadId("claude:default"), (err) => err.status === 400);
  assert.equal(tryParseCompositeThreadId("bad"), null);

  assert.equal(formatProfileKey("antigravity", "cli"), "antigravity:cli");
  assert.deepEqual(parseProfileKey("antigravity:cli"), {
    provider: "antigravity",
    profileId: "cli",
    key: "antigravity:cli",
  });
});

test("thread-meta-store persists customName and archived without touching provider dirs", async (t) => {
  const dir = await mkdtemp(resolve(os.tmpdir(), "ac-meta-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const filePath = resolve(dir, "thread-meta.json");
  const store1 = createThreadMetaStore({ filePath });
  await store1.setAutoTitle("claude:default:s1", "自动总结标题", { sourceSig: "sig-1", isDrift: true });
  await store1.setCustomName("claude:default:s1", "自定义会话标题");
  await store1.setArchived("claude:default:s1", true);
  await store1.setAutoTitle("codex:default:s2", "偏离后自动标题", { sourceSig: "sig-2", isDrift: true });

  const store2 = createThreadMetaStore({ filePath });
  await store2.load();
  const applied = store2.applyToThread({
    id: "claude:default:s1",
    name: "原标题",
    title: "原标题",
    archived: false,
  });
  assert.equal(applied.name, "自定义会话标题");
  assert.equal(applied.title, "自定义会话标题");
  assert.equal(applied.originalName, "原标题");
  assert.equal(applied.originalTitle, "原标题");
  assert.equal(applied.archived, true);

  const appliedAuto = store2.applyToThread({
    id: "codex:default:s2",
    name: "初始标题",
    title: "初始标题",
    archived: false,
  });
  assert.equal(appliedAuto.title, "初始标题");
  assert.equal(appliedAuto.autoTitle, "");
  assert.equal(appliedAuto.autoTitleIsDrift, false);
});

test("goal-controller drives continuation, completion marker, interrupt, and maxTurns", async (t) => {
  const dir = await mkdtemp(resolve(os.tmpdir(), "ac-goal-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const controller = createGoalController({
    filePath: resolve(dir, "goal-states.json"),
    defaultMaxTurns: 3,
  });

  await controller.arm("claude:default:s1", { goalPrompt: "实现功能", maxTurns: 3 });

  const step1 = await controller.evaluateAfterTurn("claude:default:s1", {
    lastAgentMessage: "正在继续推进",
  });
  assert.equal(step1.action, "continue");
  assert.equal(step1.state.turnCount, 2);
  assert.match(step1.prompt, /Goal 自动推进/);

  const step2 = await controller.evaluateAfterTurn("claude:default:s1", {
    lastAgentMessage: `已完成全部测试\n${GOAL_COMPLETE_MARKER}`,
  });
  assert.equal(step2.action, "completed");
  assert.equal(step2.state.status, "completed");
  assert.equal(step2.state.active, false);

  await controller.arm("antigravity:cli:s2", { maxTurns: 2 });
  await controller.evaluateAfterTurn("antigravity:cli:s2", { lastAgentMessage: "第 1 轮" });
  const exceeded = await controller.evaluateAfterTurn("antigravity:cli:s2", { lastAgentMessage: "第 2 轮" });
  assert.equal(exceeded.action, "stopped");
  assert.equal(exceeded.state.stopReason, "max_turns");

  await controller.arm("codex:default:s3", { maxTurns: 5 });
  const aborted = await controller.evaluateAfterTurn("codex:default:s3", { interrupted: true });
  assert.equal(aborted.action, "stopped");
  assert.equal(aborted.state.stopReason, "interrupted");
});
