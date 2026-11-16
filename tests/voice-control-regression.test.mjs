import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";
import { VoiceCallService } from "../src/voice-call-service.mjs";

const snapshot = {
  activeThreadId: "codex:default:work",
  threads: [{ id: "codex:default:work", title: "当前任务", cwd: "/dev/demo", live: true }],
  projects: [],
  pendingRequests: [],
};
const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

test("final browser recognition is retained while a previous voice turn is processing", () => {
  const source = appSource.match(/function startBrowserSpeechRecognitionPipeline\(\) \{[\s\S]*?\n\}/)?.[0];
  const sent = [];
  let recognizer;
  const status = { textContent: "免提聆听中" };
  const state = { voice: { callActive: true, isMuted: false, isSpeaking: false, isProcessing: true, asrAvailable: false } };
  const start = vm.runInNewContext(`(${source})`, {
    window: { SpeechRecognition: class { constructor() { recognizer = this; } start() {} } },
    state,
    $: () => status,
    renderVoiceCallUi() {},
    sendVoiceTurnToMac: (input) => sent.push(input.transcriptText),
  });
  assert.equal(start(), true);
  recognizer.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: "任务怎么停了" }], { isFinal: true })] });
  assert.deepEqual(sent, ["任务怎么停了"]);
  recognizer.onerror({ error: "not-allowed" });
  assert.equal(state.voice.isMuted, true);
  assert.match(status.textContent, /权限/);
});

test("voice playback does not fall back to phone speech synthesis when server audio is missing", async () => {
  const source = appSource.match(/async function playVoiceTtsResult\([\s\S]*?\n\}\n/)?.[0];
  let browserCalls = 0;
  let unheard = false;
  const play = vm.runInNewContext(`(${source})`, {
    state: { voice: { callActive: true, backendMissing: true } },
    stripMarkdownForSpeech: (text) => text,
    normalizeVoiceTtsPayload: () => ({ hasAudio: false, provider: "none", expectedMs: 1000 }),
    nextVoiceUtteranceId: () => "utt-1",
    updateVoiceTranscriptEntry() {},
    renderVoiceCallUi() {},
    scheduleVoiceListenResume() {},
    speakWithBrowserFallback: async () => { browserCalls += 1; return { outcome: "error" }; },
    evaluateVoicePlaybackOutcome: () => ({ heard: false, reason: "speech_unavailable", playedMs: 0 }),
    markUtteranceUnheard() { unheard = true; },
    reportVoicePlaybackAck() {},
  });
  await play({ spokenReply: "任务状态已更新" });
  assert.equal(browserCalls, 0);
  assert.equal(unheard, true);
});

test("voice turns received during processing are submitted once in chronological order", async () => {
  const source = appSource.match(/async function sendVoiceTurnToMac\([\s\S]*?\n\}\n/)?.[0];
  const sent = [];
  const state = { voice: { callActive: true, isProcessing: true, isSpeaking: false, pendingVoiceTurns: [] } };
  const send = vm.runInNewContext(`(${source})`, {
    state,
    setTimeout: () => 1,
    clearVoiceProcessingStageTimer() {},
    clearApprovalVoiceReminder() {},
    renderVoiceCallUi() {},
    scheduleVoiceListenResume() {},
    voiceSelectionPayload: () => ({}),
    apiPostWithHotFallback: async (_, body) => { sent.push(body.transcriptText); return { noSpeech: true }; },
  });
  await send({ transcriptText: "第一句" });
  await send({ transcriptText: "第二句" });
  assert.equal(state.voice.pendingVoiceTurns.length, 2);
  assert.deepEqual(sent, []);
  state.voice.isProcessing = false;
  await send();
  await send();
  assert.deepEqual(sent, ["第一句", "第二句"]);
  assert.equal(state.voice.pendingVoiceTurns.length, 0);
});

test("listen resume drains pending speech without clearing an utterance already being recorded", () => {
  const source = appSource.match(/function scheduleVoiceListenResume\(\) \{[\s\S]*?\n\}/)?.[0];
  let timer;
  let sends = 0;
  let resets = 0;
  const state = { voice: { callActive: true, isRecording: false, pendingVoiceTurns: [{}], vadDetector: { reset() { resets += 1; } } } };
  const resume = vm.runInNewContext(`(${source})`, {
    state,
    clearVoiceResumeTimer() {},
    resumeVoiceAudioContextIfNeeded() {},
    renderVoiceCallUi() {},
    setTimeout: (handler) => { timer = handler; },
    sendVoiceTurnToMac() { sends += 1; },
  });
  resume();
  timer();
  assert.equal(sends, 1);
  state.voice.isRecording = true;
  resume();
  timer();
  assert.equal(sends, 1);
  assert.equal(resets, 0);
});

test("a reply arriving during user speech does not cut off the new utterance", async () => {
  const source = appSource.match(/async function sendVoiceTurnToMac\([\s\S]*?\n\}\n/)?.[0];
  const state = { voice: { callActive: true, isSpeaking: false, pendingVoiceTurns: [] } };
  let played = 0;
  let missed;
  const send = vm.runInNewContext(`(${source})`, {
    state,
    setTimeout: () => 1,
    clearVoiceProcessingStageTimer() {}, clearApprovalVoiceReminder() {}, renderVoiceCallUi() {}, scheduleVoiceListenResume() {},
    voiceSelectionPayload: () => ({}),
    apiPostWithHotFallback: async () => { state.voice.isRecording = true; return { heardText: "第一句", spokenReply: "第一句的回答" }; },
    nextVoiceUtteranceId: () => "utt-1",
    normalizeVoiceTtsPayload: () => ({ hasAudio: false }),
    appendVoiceTranscriptEntry() {},
    fetchVoiceTtsAudio: async () => { throw new Error("must keep listening before requesting fallback audio"); },
    playVoiceTtsResult: async () => { played += 1; },
    markUtteranceUnheard: (item) => { missed = item; },
    reportVoicePlaybackAck() {},
    estimateVoiceDurationMs: () => 1000,
  });
  await send({ transcriptText: "第一句" });
  assert.equal(state.voice.isRecording, true);
  assert.equal(state.voice.isSpeaking, false);
  assert.equal(played, 0);
  assert.equal(missed.reason, "user_barge_in");
});

test("PCM microphone capture continues during processing but excludes bot playback", () => {
  const source = appSource.match(/processor\.onaudioprocess = \(ev\) => \{[\s\S]*?\n    \};/)?.[0];
  const processor = {};
  const sent = [];
  const state = { voice: { callActive: true, isProcessing: true, isSpeaking: false, isMuted: false } };
  vm.runInNewContext(source, {
    processor, state, ctx: { sampleRate: 48000 },
    detector: { pushSamples: () => ({ type: "utterance", samples: new Int16Array([1, 2]) }) },
    computeRmsLevel: () => 0.03,
    downsampleFloat32ToInt16: () => new Int16Array([1, 2]),
    encodePcm16SamplesToWav: () => new Uint8Array([1, 2]),
    sendVoiceTurnToMac: (input) => sent.push(input),
    renderVoiceCallUi() {},
  });
  const event = { inputBuffer: { getChannelData: () => new Float32Array([0.03]) } };
  processor.onaudioprocess(event);
  assert.equal(sent.length, 1);
  state.voice.isSpeaking = true;
  processor.onaudioprocess(event);
  assert.equal(sent.length, 1);
});

test("stop inquiries use the chosen model in plan mode without interrupting user tasks", async (t) => {
  const dir = await mkdtemp(join(os.tmpdir(), "ac-voice-query-"));
  const calls = [];
  let interrupts = 0;
  let finish;
  const completion = new Promise((resolve) => { finish = resolve; });
  const svc = new VoiceCallService({
    dataDir: dir,
    env: {
      AGY_BIN: fileURLToPath(new URL("./helpers/mock-agy-cli.mjs", import.meta.url)),
      VOICE_ASR_BIN: fileURLToPath(new URL("./helpers/mock-voice-asr.mjs", import.meta.url)),
    },
    hub: {
      listThreads: async () => ({ threads: snapshot.threads, projectsMeta: {} }),
      listProvidersAndProfiles: async () => ({ profiles: [{ provider: "codex", id: "default", installed: true, authenticated: true }] }),
      listModels: async () => [{ id: "gpt-5.4-mini", displayName: "GPT-5.4 Mini" }],
      allPendingRequests: () => [],
      startThread: async (input) => { calls.push(input); return { thread: { id: "codex:default:analysis" } }; },
      readThread: async () => ({ thread: { turns: [{ status: "completed", items: [{ type: "agentMessage", text: calls.length === 1 ? JSON.stringify({ intent: "subagent_hydrogen", instruction: "你为什么停止运行了我的任务", spokenReply: "我先检查已有记录。" }) : "现有记录不足以确认停止原因，没有更改任务。" }] }] } }),
      interrupt: async () => { interrupts += 1; },
      sendTurn: async () => { throw new Error("must not send commands to user tasks"); },
    },
    onEvent: (name, payload) => { if (name === "voice_dispatch") finish(payload); },
  });
  t.after(async () => { await svc.close(); await rm(dir, { recursive: true, force: true }); });
  const result = await svc.handleTurn({
    callId: "call-query",
    transcriptText: "你为什么停止运行了我的任务",
    activeThreadId: snapshot.activeThreadId,
    voiceProvider: "codex",
    voiceModel: "gpt-5.4-mini",
    voiceProfileId: "default",
    tts: false,
  });
  assert.equal(result.plan.intent, "subagent_hydrogen");
  assert.equal(result.model, "gpt-5.4-mini");
  assert.equal(result.asrEngine, "");
  const timeout = setTimeout(() => finish({ status: "timeout" }), 4000);
  const batch = await completion;
  clearTimeout(timeout);
  assert.equal(batch.status, "dispatched");
  assert.equal(batch.model, "gpt-5.4-mini");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].model, "gpt-5.4-mini");
  assert.equal(calls[0].permissionMode, "plan");
  assert.match(calls[1].text, /不得停止、恢复、派发任务/);
  assert.equal(interrupts, 0);
});
