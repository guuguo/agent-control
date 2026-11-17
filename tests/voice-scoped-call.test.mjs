import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { VoiceCallService } from "../src/voice-call-service.mjs";

test("thread-scoped voice call skips global listThreads, replies fast, delegates to active thread, and handles deterministic shortcuts", async (t) => {
  const root = await mkdtemp(resolve(os.tmpdir(), "ac-voice-scoped-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const mockAgyBin = fileURLToPath(new URL("./helpers/mock-agy-cli.mjs", import.meta.url));
  const mockAsrBin = fileURLToPath(new URL("./helpers/mock-voice-asr.mjs", import.meta.url));
  const activeThreadId = "antigravity:cli:target-sess-1";
  let listThreadsCalls = 0;
  let interruptedIds = [];
  let sentPayloads = [];
  let threadLive = false;

  const mockHub = {
    listThreads: async () => {
      listThreadsCalls += 1;
      return { threads: [], projectsMeta: {} };
    },
    listProvidersAndProfiles: async () => ({
      profiles: [{ provider: "antigravity", id: "cli", label: "CLI", installed: true, authenticated: true }],
    }),
    allPendingRequests: () => [],
    readThread: async (id) => ({
      thread: {
        id,
        cwd: root,
        title: "检查第二集分镜异常",
        provider: "antigravity",
        model: "gemini-4-carbon",
        live: threadLive,
        turns: [
          {
            id: "t1",
            status: "completed",
            items: [
              { type: "userMessage", content: [{ type: "text", text: "刚才改了哪几个分镜？" }] },
              { type: "agentMessage", text: "已修改 s02 和 s04 的光影参数并重新导出。" },
            ],
          },
        ],
      },
    }),
    getActivity: async () => ({ live: threadLive, phase: threadLive ? "执行中" : "", queuedCount: 0 }),
    sendTurn: async (payload) => {
      sentPayloads.push(payload);
      return { turn: { id: "turn-new" }, thread: { id: payload.threadId, title: "检查第二集分镜异常" } };
    },
    queueTurn: async (payload) => {
      sentPayloads.push({ ...payload, queued: true });
      return { ok: true, entry: { id: "q1" }, items: [{ id: "q1" }] };
    },
    interrupt: async ({ threadId }) => {
      interruptedIds.push(threadId);
      return { ok: true };
    },
  };

  const service = new VoiceCallService({
    hub: mockHub,
    dataDir: root,
    env: {
      ...process.env,
      HOME: root,
      AGY_BIN: mockAgyBin,
      VOICE_ASR_BIN: mockAsrBin,
    },
  });
  t.after(() => service.close());

  const snap = await service.buildThreadScopedSnapshot({ activeThreadId, callId: "call-1" });
  assert.equal(listThreadsCalls, 0);
  assert.equal(snap.callScope, "thread");
  assert.equal(snap.recentTurns.length, 1);
  assert.match(snap.recentTurns[0].assistant, /s02 和 s04/);

  // Deterministic shortcut: interrupt when thread is live (zero coordinator model call)
  threadLive = true;
  const stopRes = await service.handleTurn({
    callId: "call-1",
    callScope: "thread",
    activeThreadId,
    transcriptText: "停一下",
    tts: false,
  });
  assert.equal(stopRes.callScope, "thread");
  assert.equal(stopRes.model, "local-shortcut");
  assert.equal(stopRes.plan.intent, "interrupt_thread");
  assert.deepEqual(interruptedIds, [activeThreadId]);

  // Deterministic shortcut: repeat_last
  const repeatRes = await service.handleTurn({
    callId: "call-1",
    callScope: "thread",
    activeThreadId,
    transcriptText: "再说一遍",
    tts: false,
  });
  assert.equal(repeatRes.model, "local-shortcut");
  assert.equal(repeatRes.plan.intent, "repeat_last");
  assert.equal(listThreadsCalls, 0);

  // Compact L1 direct reply from lightweight model
  threadLive = false;
  const replyService = new VoiceCallService({
    hub: mockHub,
    dataDir: root,
    env: {
      ...process.env,
      HOME: root,
      AGY_BIN: mockAgyBin,
      VOICE_ASR_BIN: mockAsrBin,
      MOCK_VOICE_COORDINATOR_RESPONSE: JSON.stringify({
        heardText: "刚才改了哪几个分镜",
        action: "reply",
        instruction: "",
        decision: "",
        spokenReply: "刚才改了 s02 和 s04 的光影参数。",
      }),
    },
  });
  t.after(() => replyService.close());
  const l1Res = await replyService.handleTurn({
    callId: "call-l1",
    callScope: "thread",
    activeThreadId,
    transcriptText: "刚才改了哪几个分镜",
    tts: false,
  });
  assert.equal(l1Res.plan.intent, "summarize_progress");
  assert.equal(l1Res.spokenReply, "刚才改了 s02 和 s04 的光影参数。");
  assert.equal(sentPayloads.length, 0);

  // Compact L2 delegate to locked activeThreadId without model specifying targetThreadId
  const delegateService = new VoiceCallService({
    hub: mockHub,
    dataDir: root,
    env: {
      ...process.env,
      HOME: root,
      AGY_BIN: mockAgyBin,
      VOICE_ASR_BIN: mockAsrBin,
      MOCK_VOICE_COORDINATOR_RESPONSE: JSON.stringify({
        heardText: "把 s03 也改一下",
        action: "send",
        instruction: "修改 s03 的光影参数并重新导出",
        decision: "",
        spokenReply: "好，已经交给当前对话去修改 s03 了。",
      }),
    },
  });
  t.after(() => delegateService.close());
  const l2Res = await delegateService.handleTurn({
    callId: "call-l2",
    callScope: "thread",
    activeThreadId,
    transcriptText: "把 s03 也改一下",
    tts: false,
  });
  assert.equal(l2Res.plan.intent, "send_turn");
  assert.equal(l2Res.plan.targetThreadId, activeThreadId);
  assert.equal(sentPayloads.length, 1);
  assert.equal(sentPayloads[0].threadId, activeThreadId);
  assert.equal(sentPayloads[0].text, "修改 s03 的光影参数并重新导出");
  assert.equal(listThreadsCalls, 0);
});
