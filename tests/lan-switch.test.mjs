import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { isLanListeningHost, listLanUrls } from "../src/lan-network.mjs";
import { createAgentControlServer } from "../src/server.mjs";

test("listLanUrls 识别监听地址并按内网段优先级排序", () => {
  assert.equal(isLanListeningHost("127.0.0.1"), false);
  assert.equal(isLanListeningHost("localhost"), false);
  assert.equal(isLanListeningHost("0.0.0.0"), true);

  const loopbackOnly = listLanUrls({
    port: 43310,
    host: "127.0.0.1",
    interfaces: { en0: [{ family: "IPv4", internal: false, address: "192.168.31.88" }] },
  });
  assert.equal(loopbackOnly.enabled, false);
  assert.deepEqual(loopbackOnly.urls, []);
  assert.equal(loopbackOnly.primaryUrl, "");

  const lanResult = listLanUrls({
    port: 43310,
    host: "0.0.0.0",
    interfaces: {
      lo0: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
      utun3: [{ family: "IPv4", internal: false, address: "100.64.0.9" }],
      en1: [{ family: "IPv4", internal: false, address: "169.254.12.34" }],
      en2: [{ family: "IPv4", internal: false, address: "172.16.0.12" }],
      en3: [{ family: "IPv4", internal: false, address: "10.0.0.8" }],
      en0: [{ family: "IPv4", internal: false, address: "192.168.31.88" }],
    },
  });
  assert.equal(lanResult.enabled, true);
  assert.deepEqual(lanResult.urls, [
    "http://192.168.31.88:43310",
    "http://10.0.0.8:43310",
    "http://172.16.0.12:43310",
  ]);
  assert.equal(lanResult.primaryUrl, "http://192.168.31.88:43310");
});

test("lan-switch 在仅回环监听时返回 409，在 0.0.0.0 监听时下发带会话跳转的配对链接并记录回切地址", async (t) => {
  const dataDirA = await mkdtemp(resolve(os.tmpdir(), "ac-lan-loopback-"));
  const dataDirB = await mkdtemp(resolve(os.tmpdir(), "ac-lan-open-"));
  t.after(async () => {
    await rm(dataDirA, { recursive: true, force: true });
    await rm(dataDirB, { recursive: true, force: true });
  });

  const loopbackSrv = await createAgentControlServer({
    host: "127.0.0.1",
    port: 0,
    dataDir: dataDirA,
    disableRelay: true,
    disableTunnel: true,
    disableUpdateCheck: true,
    providers: [],
  });
  await loopbackSrv.start();
  t.after(() => loopbackSrv.close());

  const deniedRes = await fetch(`${loopbackSrv.url}/api/remote/lan-switch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadId: "codex:default:t1", fallbackUrl: "https://relay.example.com/i/demo/" }),
  });
  assert.equal(deniedRes.status, 409);

  const openSrv = await createAgentControlServer({
    host: "0.0.0.0",
    port: 0,
    dataDir: dataDirB,
    disableRelay: true,
    disableTunnel: true,
    disableUpdateCheck: true,
    providers: [],
  });
  await openSrv.start();
  t.after(() => openSrv.close());

  const openPort = new URL(openSrv.url).port;
  const localBase = `http://127.0.0.1:${openPort}`;
  const switchRes = await fetch(`${localBase}/api/remote/lan-switch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      threadId: "codex:default:t1",
      fallbackUrl: "https://relay.example.com/i/demo/?stale=1#hash",
    }),
  });
  const switchJson = await switchRes.json();
  if (!switchJson.lan?.urls?.length) {
    assert.equal(switchRes.status, 409);
    return;
  }
  assert.equal(switchRes.status, 200);
  assert.equal(switchJson.ok, true);
  assert.equal(switchJson.lan.fallbackUrl, "https://relay.example.com/i/demo/");
  assert.match(switchJson.connectUrl, /\/connect\/[A-Za-z0-9_-]+\?thread=codex%3Adefault%3At1$/);

  const connectPath = new URL(switchJson.connectUrl).pathname + new URL(switchJson.connectUrl).search;
  const connectRes = await fetch(`${localBase}${connectPath}`, { redirect: "manual" });
  assert.equal(connectRes.status, 302);
  assert.equal(connectRes.headers.get("location"), "/?thread=codex%3Adefault%3At1");
  assert.match(String(connectRes.headers.get("set-cookie") || ""), /ac_tunnel_/);
});
