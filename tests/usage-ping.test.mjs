import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { anonymizeInstanceId, createUsagePing, isTelemetryDisabled } from "../src/usage-ping.mjs";

async function startMockPingServer(statusCode = 204) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({
      method: req.method,
      url: req.url,
      userAgent: req.headers["user-agent"] || "",
    });
    res.writeHead(statusCode);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  return {
    url: `http://127.0.0.1:${addr.port}/ping/agent-control`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("usage-ping sends anonymized telemetry and throttles repeats within 12h", async (t) => {
  const dataDir = await mkdtemp(join(os.tmpdir(), "ac-usage-ping-"));
  const mock = await startMockPingServer(204);
  t.after(async () => {
    await mock.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  let currentTime = 1_700_000_000_000;
  const ping = createUsagePing({
    dataDir,
    instanceId: "raw-secret-instance-id",
    version: "0.2.3",
    env: {},
    pingUrl: mock.url,
    now: () => currentTime,
  });

  const first = await ping.pingOnce();
  assert.equal(first.sent, true);
  assert.equal(first.status, 204);
  assert.equal(mock.requests.length, 1);

  const reqUrl = new URL(mock.requests[0].url, "http://127.0.0.1");
  const expectedAnonId = anonymizeInstanceId("raw-secret-instance-id");
  assert.equal(reqUrl.searchParams.get("id"), expectedAnonId);
  assert.notEqual(reqUrl.searchParams.get("id"), "raw-secret-instance-id");
  assert.equal(expectedAnonId.length, 16);
  assert.equal(reqUrl.searchParams.get("v"), "0.2.3");
  assert.equal(reqUrl.searchParams.get("os"), process.platform);
  assert.equal(reqUrl.searchParams.get("arch"), process.arch);

  const state = JSON.parse(await readFile(join(dataDir, "ping-state.json"), "utf8"));
  assert.equal(state.lastPingAt, currentTime);
  assert.equal(state.version, "0.2.3");

  // Within 12h: throttled
  currentTime += 60 * 60 * 1000;
  const second = await ping.pingOnce();
  assert.equal(second.sent, false);
  assert.equal(second.reason, "throttled");
  assert.equal(mock.requests.length, 1);

  // After 12h: sends again
  currentTime += 12 * 60 * 60 * 1000;
  const third = await ping.pingOnce();
  assert.equal(third.sent, true);
  assert.equal(mock.requests.length, 2);

  ping.close();
});

test("usage-ping respects opt-out flags and ignores network errors", async (t) => {
  const dataDir = await mkdtemp(join(os.tmpdir(), "ac-usage-ping-optout-"));
  const mock = await startMockPingServer(204);
  t.after(async () => {
    await mock.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  assert.equal(isTelemetryDisabled({ DO_NOT_TRACK: "1" }), true);
  assert.equal(isTelemetryDisabled({ AGENT_CONTROL_DISABLE_TELEMETRY: "true" }), true);
  assert.equal(isTelemetryDisabled({}), false);

  const disabledPing = createUsagePing({
    dataDir,
    instanceId: "abc",
    env: { DO_NOT_TRACK: "1" },
    pingUrl: mock.url,
  });
  assert.equal(disabledPing.disabled, true);
  const res = await disabledPing.pingOnce();
  assert.equal(res.sent, false);
  assert.equal(res.reason, "disabled");
  assert.equal(mock.requests.length, 0);

  const failingPing = createUsagePing({
    dataDir,
    instanceId: "abc",
    env: {},
    pingUrl: "http://127.0.0.1:1/unreachable",
    timeoutMs: 300,
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  const failRes = await failingPing.pingOnce();
  assert.equal(failRes.sent, false);
  assert.equal(failRes.reason, "network_error");
});
