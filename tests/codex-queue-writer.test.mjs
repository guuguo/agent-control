import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ProviderHub } from "../src/provider-hub.mjs";

async function waitFor(check, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((done) => setTimeout(done, 25));
  }
  assert.fail("等待 Mock 队列状态超时");
}

test("Codex active-writer RPC errors keep queued text and images until idle; genuine failures still surface", async (t) => {
  const root = await mkdtemp(resolve(os.tmpdir(), "ac-writer-queue-"));
  const codexHome = resolve(root, "codex");
  await mkdir(codexHome);
  const hub = new ProviderHub({ dataDir: resolve(root, "data"), env: {
    ...process.env,
    HOME: root, USERPROFILE: root,
    CODEX_BIN: fileURLToPath(new URL("./helpers/mock-codex-cli.mjs", import.meta.url)),
    AGENT_CONTROL_CODEX_HOMES: JSON.stringify([{ id: "default", home: codexHome }]),
    AGENT_CONTROL_CLAUDE_CONFIG_DIRS: "[]", AGENT_CONTROL_AGY_APP_DATA_DIRS: "[]", AGENT_CONTROL_GROK_HOMES: "[]",
  } });
  t.after(async () => { await hub.close(); await rm(root, { recursive: true, force: true }); });
  await hub.init();
  const events = [];
  hub.subscribe((name, data) => { if (name === "queued_turn_event") events.push(data); });
  const threadId = "codex:default:01900000-0000-7000-8000-000000000001";
  const errorFile = resolve(codexHome, ".mock-turn-start-error");
  await writeFile(errorFile, "thread 01a178b2-de1d-76d2-84f0-46b7a876a8a2 already has an active writer");
  const payload = { threadId, text: "定时任务关了吧，已经备案通过了",
    images: [{ name: "image.png", dataUrl: "data:image/png;base64,AA==" }],
    model: "gpt-5.4", effort: "high", permissionMode: "workspace" };
  await assert.rejects(hub.sendTurn(payload), (error) => error.status === 409 && error.code === "thread_busy");
  const queued = await hub.queueTurn(payload);
  await new Promise((done) => setTimeout(done, 250));
  const waiting = await hub.listQueuedTurns(threadId);
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].id, queued.entry.id);
  assert.equal(waiting[0].text, payload.text);
  assert.equal(waiting[0].imageCount, 1);
  assert.equal(events.some((event) => event.eventType === "failed"), false);
  await rm(errorFile);
  await waitFor(() => events.find((event) => event.eventType === "started" && event.entry.id === queued.entry.id));
  const read = await hub.readThread(threadId);
  const deliveries = read.thread.turns.filter((turn) => turn.items?.some((item) => item.type === "userMessage"
    && item.content?.some((part) => part.type === "text" && part.text === payload.text)));
  assert.equal(deliveries.length, 1);
  assert.equal((await hub.listQueuedTurns(threadId)).length, 0);

  await writeFile(errorFile, "operation rejected by policy");
  const rejected = await hub.queueTurn({ threadId, text: "真实失败的消息" });
  const failure = await waitFor(() => events.find((event) => event.eventType === "failed" && event.entry.id === rejected.entry.id));
  assert.match(failure.error.message, /operation rejected by policy/);
  assert.equal((await hub.listQueuedTurns(threadId)).length, 0);
});
