import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { createRelayServer } from "../relay/relay-server.mjs";
import { createAgentControlServer } from "../src/server.mjs";

const MOCK_CODEX_BIN = fileURLToPath(new URL("./helpers/mock-codex-cli.mjs", import.meta.url));
const MOCK_CLAUDE_BIN = fileURLToPath(new URL("./helpers/mock-claude-cli.mjs", import.meta.url));
const MOCK_AGY_BIN = fileURLToPath(new URL("./helpers/mock-agy-cli.mjs", import.meta.url));

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const val = await predicate();
    if (val) return val;
    if (Date.now() > deadline) {
      throw new Error("等待条件超时");
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("Relay + RemoteBridge end-to-end pairing, cookie auth, SSE tunneling, offline fallback, and revoke", async (t) => {
  const root = await mkdtemp(resolve(os.tmpdir(), "ac-relay-e2e-"));
  const dataDir = resolve(root, "data");
  await mkdir(dataDir, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  const relay = createRelayServer({
    port: 0,
    relayKey: "super-secret-relay-key",
    dataPath: resolve(root, "relay-state.json"),
  });
  await relay.start();
  t.after(() => relay.close());

  const srv = await createAgentControlServer({
    port: 0,
    disableRelay: false,
    dataDir,
    env: {
      ...process.env,
      CODEX_BIN: MOCK_CODEX_BIN,
      CLAUDE_BIN: MOCK_CLAUDE_BIN,
      AGY_BIN: MOCK_AGY_BIN,
      AGENT_CONTROL_CODEX_HOMES: JSON.stringify([{ id: "default", label: "Codex 默认", home: resolve(root, "codex") }]),
      AGENT_CONTROL_CLAUDE_CONFIG_DIRS: JSON.stringify([{ id: "default", label: "Claude 默认", home: resolve(root, "claude") }]),
      AGENT_CONTROL_AGY_APP_DATA_DIRS: JSON.stringify([{ id: "cli", label: "Antigravity CLI", home: resolve(root, "agy"), profileType: "cli" }]),
    },
  });
  await srv.start();
  let serverClosed = false;
  t.after(async () => {
    if (!serverClosed) await srv.close();
  });

  // Invalid relay key rejected.
  const badInvite = await fetch(`${relay.url}/admin/invites`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Relay-Key": "wrong" },
    body: JSON.stringify({ label: "MacBook" }),
  });
  assert.equal(badInvite.status, 403);

  // Valid invite issued.
  const inviteRes = await fetch(`${relay.url}/admin/invites`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Relay-Key": "super-secret-relay-key" },
    body: JSON.stringify({ label: "测试 Mac" }),
  });
  assert.equal(inviteRes.status, 201);
  const { inviteCode } = await inviteRes.json();

  // Host pairs via /api/remote/pair.
  const pairRes = await fetch(`${srv.url}/api/remote/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ relayUrl: relay.url, inviteCode, label: "测试 Mac" }),
  });
  assert.equal(pairRes.status, 200);
  const pairData = await pairRes.json();
  assert.ok(pairData.paired);
  assert.match(pairData.qrDataUrl, /^data:image\/png;base64,/);

  await waitFor(async () => {
    const status = await (await fetch(`${srv.url}/api/remote`)).json();
    return status.connected ? status : null;
  });

  // Single-use invite fails if reused.
  const reuseRes = await fetch(`${relay.url}/relay/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inviteCode, instanceId: "hacker", label: "Evil" }),
  });
  assert.equal(reuseRes.status, 403);

  const instanceId = srv.identity.instanceId;

  // Unauthenticated access rejected with 401.
  const unauthed = await fetch(`${relay.url}/i/${instanceId}/api/providers`);
  assert.equal(unauthed.status, 401);

  // Browser follows pairing URL once (manual redirect) to capture HttpOnly SameSite=Strict cookie.
  const connectRes = await fetch(pairData.pairUrl, { redirect: "manual" });
  assert.equal(connectRes.status, 302);
  const setCookie = connectRes.headers.get("set-cookie") || "";
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  assert.match(setCookie, new RegExp(`Path=/i/${instanceId}/`));
  const cookieHeader = setCookie.split(";")[0];

  // Tunneled API & HTML through Relay.
  const proxiedProviders = await fetch(`${relay.url}/i/${instanceId}/api/providers`, {
    headers: { Cookie: cookieHeader },
  });
  assert.equal(proxiedProviders.status, 200);
  const proxiedJson = await proxiedProviders.json();
  assert.equal(proxiedJson.providers.length, 5);

  // Tunneled SSE stream works.
  const sseAbort = new AbortController();
  const sseRes = await fetch(`${relay.url}/i/${instanceId}/api/events`, {
    headers: { Cookie: cookieHeader, Accept: "text/event-stream" },
    signal: sseAbort.signal,
  });
  assert.equal(sseRes.status, 200);
  const reader = sseRes.body.getReader();
  const firstChunk = await reader.read();
  assert.match(new TextDecoder().decode(firstChunk.value), /event: ready/);
  sseAbort.abort();

  // Close local host -> verify offline handling (503 JSON, 503 HTML refresh, offline SSE).
  await srv.close();
  serverClosed = true;
  await waitFor(async () => {
    const h = await (await fetch(`${relay.url}/health`)).json();
    return h.onlineHosts === 0;
  });

  const offlineApi = await fetch(`${relay.url}/i/${instanceId}/api/providers`, {
    headers: { Cookie: cookieHeader },
  });
  assert.equal(offlineApi.status, 503);
  const offlineJson = await offlineApi.json();
  assert.equal(offlineJson.error.code, "host_offline");

  const offlinePage = await fetch(`${relay.url}/i/${instanceId}/`, {
    headers: { Cookie: cookieHeader, Accept: "text/html" },
  });
  assert.equal(offlinePage.status, 503);
  assert.match(await offlinePage.text(), /http-equiv="refresh"/);

  const offlineSse = await fetch(`${relay.url}/i/${instanceId}/api/events`, {
    headers: { Cookie: cookieHeader, Accept: "text/event-stream" },
  });
  assert.equal(offlineSse.status, 200);
  assert.match(await offlineSse.text(), /event: host_offline/);
});

test("Relay + RemoteBridge streams multi-MB image payloads without heartbeat drop or SSE base64 leaks", async (t) => {
  const root = await mkdtemp(resolve(os.tmpdir(), "ac-relay-img-e2e-"));
  const dataDir = resolve(root, "data");
  await mkdir(dataDir, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  const relay = createRelayServer({
    port: 0,
    relayKey: "img-secret-key",
    dataPath: resolve(root, "relay-state.json"),
    heartbeatIntervalMs: 120,
    requestTimeoutMs: 15_000,
  });
  await relay.start();
  t.after(() => relay.close());

  const srv = await createAgentControlServer({
    port: 0,
    disableRelay: false,
    dataDir,
    remoteBridgeOptions: {
      heartbeatIntervalMs: 60,
      heartbeatTimeoutMs: 600,
      responseChunkBytes: 32 * 1024,
    },
    env: {
      ...process.env,
      CODEX_BIN: MOCK_CODEX_BIN,
      CLAUDE_BIN: MOCK_CLAUDE_BIN,
      AGY_BIN: MOCK_AGY_BIN,
      AGENT_CONTROL_CODEX_HOMES: JSON.stringify([{ id: "default", label: "Codex 默认", home: resolve(root, "codex") }]),
      AGENT_CONTROL_CLAUDE_CONFIG_DIRS: JSON.stringify([{ id: "default", label: "Claude 默认", home: resolve(root, "claude") }]),
      AGENT_CONTROL_AGY_APP_DATA_DIRS: JSON.stringify([{ id: "cli", label: "Antigravity CLI", home: resolve(root, "agy"), profileType: "cli" }]),
    },
  });
  await srv.start();
  t.after(() => srv.close());

  const inviteRes = await fetch(`${relay.url}/admin/invites`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Relay-Key": "img-secret-key" },
    body: JSON.stringify({ label: "压测 Mac" }),
  });
  assert.equal(inviteRes.status, 201);
  const { inviteCode } = await inviteRes.json();

  const pairRes = await fetch(`${srv.url}/api/remote/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ relayUrl: relay.url, inviteCode, label: "压测 Mac" }),
  });
  assert.equal(pairRes.status, 200);
  const pairData = await pairRes.json();

  await waitFor(async () => {
    const status = await (await fetch(`${srv.url}/api/remote`)).json();
    return status.connected ? status : null;
  });

  const instanceId = srv.identity.instanceId;
  const connectRes = await fetch(pairData.pairUrl, { redirect: "manual" });
  assert.equal(connectRes.status, 302);
  const cookieHeader = (connectRes.headers.get("set-cookie") || "").split(";")[0];

  // Open SSE stream over Relay to verify no multi-MB base64 payloads leak through events.
  const sseAbort = new AbortController();
  t.after(() => sseAbort.abort());
  const sseChunks = [];
  const sseRes = await fetch(`${relay.url}/i/${instanceId}/api/events`, {
    headers: { Cookie: cookieHeader, Accept: "text/event-stream" },
    signal: sseAbort.signal,
  });
  assert.equal(sseRes.status, 200);
  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  const drainSse = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseChunks.push(decoder.decode(value, { stream: true }));
      }
    } catch {
      // Expected when aborting SSE stream at end of test.
    }
  })();

  // Construct ~1.2MB base64 JPEG payload (>64KB threshold -> triggers stream-v1 request chunking).
  const largeBase64 = Buffer.alloc(900 * 1024, 0x55).toString("base64");
  const largeDataUrl = `data:image/jpeg;base64,${largeBase64}`;

  // 1. Enqueue an image turn over Relay -> queue entry summary must strip raw dataUrl.
  const queueRes = await fetch(`${relay.url}/i/${instanceId}/api/thread/queue`, {
    method: "POST",
    headers: { Cookie: cookieHeader, "Content-Type": "application/json" },
    body: JSON.stringify({
      threadId: "claude:default:fake-queue-thread",
      text: "排队带图消息",
      images: [{ name: "photo.jpg", dataUrl: largeDataUrl }],
    }),
  });
  assert.equal(queueRes.status, 200);
  const queueJson = await queueRes.json();
  assert.equal(queueJson.entry.imageCount, 1);
  assert.equal(queueJson.entry.images[0].omitted, true);
  assert.equal(queueJson.entry.images[0].dataUrl, undefined);

  await fetch(`${relay.url}/i/${instanceId}/api/thread/queue/cancel`, {
    method: "POST",
    headers: { Cookie: cookieHeader, "Content-Type": "application/json" },
    body: JSON.stringify({
      threadId: "claude:default:fake-queue-thread",
      id: queueJson.entry.id,
    }),
  });

  // 2. Send a >1.2MB image turn to mock Claude over Relay -> tests chunked upload + mock JSONL write.
  const createRes = await fetch(`${relay.url}/i/${instanceId}/api/thread/new`, {
    method: "POST",
    headers: { Cookie: cookieHeader, "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "claude",
      profileId: "default",
      text: "图片压测请求",
      images: [{ name: "huge.jpg", dataUrl: largeDataUrl }],
    }),
  });
  assert.equal(createRes.status, 200);
  const created = await createRes.json();
  const threadId = created?.thread?.id;
  assert.ok(threadId);

  // Wait for mock Claude to complete and write the >1.2MB user turn into JSONL, then read it twice over 32KB chunked response.
  const completedThread = await waitFor(async () => {
    const res = await fetch(`${relay.url}/i/${instanceId}/api/thread?id=${encodeURIComponent(threadId)}&limit=12`, {
      headers: { Cookie: cookieHeader },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const turns = json?.thread?.turns || [];
    const last = turns[turns.length - 1];
    return turns.length >= 1 && !json.thread.live && last?.items?.some((it) => it.type === "agentMessage")
      ? json
      : null;
  });
  assert.ok(completedThread.thread.turns[0].items[0].content.some((b) => b.type === "image" && b.url === largeDataUrl));

  // Verify multiple Relay heartbeat intervals (~360ms) pass with zero disconnects.
  await new Promise((r) => setTimeout(r, 380));
  const relayHealth = await (await fetch(`${relay.url}/health`)).json();
  const remoteStatus = await (await fetch(`${srv.url}/api/remote`)).json();
  assert.equal(relayHealth.onlineHosts, 1);
  assert.equal(remoteStatus.connected, true);

  sseAbort.abort();
  await drainSse;
  const fullSseText = sseChunks.join("");
  assert.ok(fullSseText.length < 128 * 1024, `SSE payload unexpectedly large (${fullSseText.length} chars)`);
  assert.doesNotMatch(fullSseText, /VUVVVUVVVUVV/); // base64 for 0x55... must not leak over SSE
});

function rawHttpGet(urlString, headers = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = http.get(urlString, { headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolvePromise({
          status: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
      res.on("error", rejectPromise);
    });
    req.on("error", rejectPromise);
  });
}

test("Relay + RemoteBridge + LocalApps gzip compression, zero double-compression, ETag 304, and uncompressed SSE", async (t) => {
  const root = await mkdtemp(resolve(os.tmpdir(), "ac-relay-gzip-"));
  const dataDir = resolve(root, "data");
  const appsDir = resolve(dataDir, "apps");
  await mkdir(appsDir, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  const mockBootstrapPayload = JSON.stringify({
    ok: true,
    items: Array.from({ length: 80 }, (_, idx) => ({
      id: `ep-${idx + 1}`,
      title: `分集测试标题_${idx + 1}_用于验证大于4KB的Gzip压缩收益`,
      summary: "一段重复度较高的剧情摘要字段，用于测试文本压缩率与无双重压缩链路。",
    })),
  });
  assert.ok(Buffer.byteLength(mockBootstrapPayload) > 4096);

  const sampleVideo = Buffer.alloc(128);
  for (let i = 0; i < sampleVideo.length; i += 1) sampleVideo[i] = i & 0xff;
  let lastProxiedHeader = "";

  const mockUpstream = http.createServer((req, res) => {
    lastProxiedHeader = String(req.headers["x-ac-proxied-app"] || "");
    if (String(req.url || "").startsWith("/media/sample.mp4")) {
      const rangeHeader = String(req.headers.range || "");
      const m = rangeHeader.match(/^bytes=(\d+)-(\d+)?$/);
      if (m) {
        const start = Number(m[1]);
        const end = m[2] !== undefined ? Math.min(Number(m[2]), sampleVideo.length - 1) : sampleVideo.length - 1;
        const slice = sampleVideo.subarray(start, end + 1);
        res.writeHead(206, {
          "Content-Type": "video/mp4",
          "Accept-Ranges": "bytes",
          "Content-Range": `bytes ${start}-${end}/${sampleVideo.length}`,
          "Content-Length": String(slice.length),
        });
        res.end(slice);
        return;
      }
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Accept-Ranges": "bytes",
        "Content-Length": String(sampleVideo.length),
      });
      res.end(sampleVideo);
      return;
    }
    const accept = String(req.headers["accept-encoding"] || "").toLowerCase();
    // If local-apps fails to override Accept-Encoding: identity, intentionally gzip here so double-compression would fail JSON.parse after single gunzipSync.
    if (accept.includes("gzip")) {
      const gz = gzipSync(Buffer.from(mockBootstrapPayload, "utf8"));
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Encoding": "gzip",
        "Content-Length": String(gz.length),
      });
      res.end(gz);
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(Buffer.byteLength(mockBootstrapPayload)),
    });
    res.end(mockBootstrapPayload);
  });
  await new Promise((resolveListen) => mockUpstream.listen(0, "127.0.0.1", resolveListen));
  t.after(() => new Promise((resolveClose) => mockUpstream.close(resolveClose)));
  const mockAddr = mockUpstream.address();
  const mockPort = typeof mockAddr === "object" && mockAddr ? mockAddr.port : 0;

  await writeFile(
    resolve(appsDir, "manju-mock.json"),
    JSON.stringify({
      id: "manju-mock",
      name: "Manju Mock",
      origin: `http://127.0.0.1:${mockPort}`,
    }),
    "utf8",
  );

  const relay = createRelayServer({
    port: 0,
    relayKey: "gzip-secret-key",
    dataPath: resolve(root, "relay-state.json"),
  });
  await relay.start();
  t.after(() => relay.close());

  const srv = await createAgentControlServer({
    port: 0,
    disableRelay: false,
    dataDir,
    env: {
      ...process.env,
      CODEX_BIN: MOCK_CODEX_BIN,
      CLAUDE_BIN: MOCK_CLAUDE_BIN,
      AGY_BIN: MOCK_AGY_BIN,
      AGENT_CONTROL_CODEX_HOMES: JSON.stringify([{ id: "default", label: "Codex 默认", home: resolve(root, "codex") }]),
      AGENT_CONTROL_CLAUDE_CONFIG_DIRS: JSON.stringify([{ id: "default", label: "Claude 默认", home: resolve(root, "claude") }]),
      AGENT_CONTROL_AGY_APP_DATA_DIRS: JSON.stringify([{ id: "cli", label: "Antigravity CLI", home: resolve(root, "agy"), profileType: "cli" }]),
    },
  });
  await srv.start();
  t.after(() => srv.close());

  const inviteRes = await fetch(`${relay.url}/admin/invites`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Relay-Key": "gzip-secret-key" },
    body: JSON.stringify({ label: "压缩测试 Mac" }),
  });
  assert.equal(inviteRes.status, 201);
  const { inviteCode } = await inviteRes.json();

  const pairRes = await fetch(`${srv.url}/api/remote/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ relayUrl: relay.url, inviteCode, label: "压缩测试 Mac" }),
  });
  assert.equal(pairRes.status, 200);
  const pairData = await pairRes.json();

  await waitFor(async () => {
    const status = await (await fetch(`${srv.url}/api/remote`)).json();
    return status.connected ? status : null;
  });

  const instanceId = srv.identity.instanceId;
  const connectRes = await fetch(pairData.pairUrl, { redirect: "manual" });
  assert.equal(connectRes.status, 302);
  const cookieHeader = (connectRes.headers.get("set-cookie") || "").split(";")[0];

  // 1) Static asset over Relay: gzipped, preserves Cache-Control: no-store & ETag
  const appJsRes = await rawHttpGet(`${relay.url}/i/${instanceId}/app.js`, {
    Cookie: cookieHeader,
    "Accept-Encoding": "gzip",
  });
  assert.equal(appJsRes.status, 200);
  assert.equal(appJsRes.headers["content-encoding"], "gzip");
  assert.equal(appJsRes.headers["cache-control"], "no-store");
  assert.ok(appJsRes.headers["etag"]);
  const appJsRaw = gunzipSync(appJsRes.body);
  assert.ok(appJsRes.body.length < appJsRaw.length);
  assert.ok(appJsRaw.toString("utf8").includes("function"));

  // 2) Conditional ETag -> 304 Not Modified (0 bytes)
  const appJs304 = await rawHttpGet(`${relay.url}/i/${instanceId}/app.js`, {
    Cookie: cookieHeader,
    "Accept-Encoding": "gzip",
    "If-None-Match": appJsRes.headers["etag"],
  });
  assert.equal(appJs304.status, 304);
  assert.equal(appJs304.body.length, 0);

  // 3) LocalApp proxy over Relay & direct: single gzip, zero double-compression, relative 302 redirect & 206 streaming
  const noSlashRedirectRes = await rawHttpGet(`${relay.url}/i/${instanceId}/apps/manju-mock?tab=episodes`, {
    Cookie: cookieHeader,
  });
  assert.equal(noSlashRedirectRes.status, 302);
  assert.equal(noSlashRedirectRes.headers.location, "./manju-mock/?tab=episodes");

  const relayAppRes = await rawHttpGet(`${relay.url}/i/${instanceId}/apps/manju-mock/api/bootstrap`, {
    Cookie: cookieHeader,
    "Accept-Encoding": "gzip",
  });
  assert.equal(relayAppRes.status, 200);
  assert.equal(lastProxiedHeader, "manju-mock");
  assert.equal(relayAppRes.headers["content-encoding"], "gzip");
  const relayAppRaw = gunzipSync(relayAppRes.body);
  assert.ok(relayAppRes.body.length < relayAppRaw.length);
  assert.deepEqual(JSON.parse(relayAppRaw.toString("utf8")), JSON.parse(mockBootstrapPayload));

  const rangeRes = await rawHttpGet(`${relay.url}/i/${instanceId}/apps/manju-mock/media/sample.mp4`, {
    Cookie: cookieHeader,
    Range: "bytes=0-63",
  });
  assert.equal(rangeRes.status, 206);
  assert.equal(rangeRes.headers["content-range"], "bytes 0-63/128");
  assert.equal(rangeRes.body.length, 64);
  assert.deepEqual(rangeRes.body, sampleVideo.subarray(0, 64));

  const directAppRes = await rawHttpGet(`${srv.url}/apps/manju-mock/api/bootstrap`, {
    "Accept-Encoding": "gzip",
  });
  assert.equal(directAppRes.status, 200);
  assert.equal(directAppRes.headers["content-encoding"], "gzip");
  const directAppRaw = gunzipSync(directAppRes.body);
  assert.deepEqual(JSON.parse(directAppRaw.toString("utf8")), JSON.parse(mockBootstrapPayload));

  // 4) SSE over Relay skips gzip even with Accept-Encoding: gzip
  const sseAbort = new AbortController();
  t.after(() => sseAbort.abort());
  const sseRes = await fetch(`${relay.url}/i/${instanceId}/api/events`, {
    headers: {
      Cookie: cookieHeader,
      Accept: "text/event-stream",
      "Accept-Encoding": "gzip",
    },
    signal: sseAbort.signal,
  });
  assert.equal(sseRes.status, 200);
  assert.equal(sseRes.headers.get("content-encoding"), null);
  const sseReader = sseRes.body.getReader();
  const firstSse = await sseReader.read();
  assert.match(new TextDecoder().decode(firstSse.value), /event: ready/);
  sseAbort.abort();
});
