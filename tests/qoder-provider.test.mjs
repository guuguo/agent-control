import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { QoderProvider } from "../src/providers/qoder-provider.mjs";
import { ProviderHub } from "../src/provider-hub.mjs";
import { parseCompositeThreadId } from "../src/composite-id.mjs";
import { qoderPermissionMode } from "../src/providers/qoder-acp-client.mjs";

const mock = fileURLToPath(new URL("./helpers/mock-qoder-cli.mjs", import.meta.url));
async function setup(t) {
  const root = await mkdtemp(resolve(tmpdir(), "ac-qoder-"));
  const cwd = resolve(root, "项目 含空格");
  await mkdir(cwd); await chmod(mock, 0o755);
  const env = { ...process.env, HOME: root, USERPROFILE: root, QODER_BIN: mock, AGENT_CONTROL_QODER_CONFIG_DIR: resolve(root, "config") };
  const dataDir = resolve(root, "data");
  t.after(() => rm(root, { recursive: true, force: true }));
  return { env, dataDir, cwd };
}
async function waitFor(check) {
  const end = Date.now() + 6000;
  while (Date.now() < end) { const result = await check(); if (result) return result; await new Promise((done) => setTimeout(done, 15)); }
  assert.fail("等待 Qoder Mock 状态超时");
}

test("Qoder 使用官方 ACP 参数，支持图文、流式工具和思考，并在重启后继续原会话", async (t) => {
  const options = await setup(t);
  let provider = new QoderProvider(options);
  t.after(() => provider.close());
  const events = [];
  provider.setCallbacks({ onEvent: (event) => events.push(event) });
  const first = await provider.startThread({ cwd: options.cwd, text: "检查", images: [{ dataUrl: "data:image/png;base64,AA==" }], model: "lite", effort: "high", permissionMode: "turbo" });
  assert.equal(parseCompositeThreadId(first.thread.id).provider, "qoder");
  await waitFor(() => events.find((event) => event.type === "turn_completed"));
  assert.equal(events.some((event) => event.type === "stream_delta" && event.kind === "reasoning"), true);
  assert.equal(events.some((event) => event.type === "acp_tool_update"), true);
  let read = await provider.readThread("default", first.thread.rawId);
  assert.equal(read.thread.turns[0].items.at(-1).text, "完成：检查");
  await provider.close();
  provider = new QoderProvider(options);
  assert.equal((await provider.listThreads())[0].id, first.thread.id);
  provider.setCallbacks({ onEvent: (event) => events.push(event) });
  await provider.sendTurn({ rawId: first.thread.rawId, text: "继续", model: "performance", effort: "low", permissionMode: "workspace" });
  await waitFor(() => events.filter((event) => event.type === "turn_completed").length === 2);
  read = await provider.readThread("default", first.thread.rawId);
  assert.equal(read.thread.turns.length, 2);
  const trace = (await readFile(resolve(options.env.AGENT_CONTROL_QODER_CONFIG_DIR, "mock-trace.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  const launches = trace.filter((line) => line.args);
  assert.equal(launches[0].cwd, await realpath(options.cwd));
  assert.ok(launches[0].args.includes("bypass_permissions"));
  assert.ok(launches[1].args.includes("performance"));
  assert.ok(launches[1].args.includes("accept_edits"));
  assert.equal(trace.filter((line) => line.method === "session/new").length, 1);
  assert.equal(trace.find((line) => line.method === "session/load").params.sessionId, first.thread.rawId);
  assert.equal(trace.find((line) => line.method === "session/prompt").params.prompt[1].type, "image");
});

test("Qoder 审批、中断与控制端排队通过 Hub 路由，不创建新会话", async (t) => {
  const options = await setup(t);
  const provider = new QoderProvider(options);
  const hub = new ProviderHub({ ...options, providers: [provider] });
  t.after(() => hub.close());
  await hub.init();
  const first = await hub.startThread({ provider: "qoder", profileId: "default", cwd: options.cwd, text: "approval", permissionMode: "workspace" });
  const request = await waitFor(() => hub.allPendingRequests()[0]);
  assert.equal(request.provider, "qoder");
  await hub.respondToRequest(request.id, { optionId: "yes" });
  await waitFor(async () => !(await provider.getActivity("default", first.thread.rawId)).live);
  await hub.sendTurn({ threadId: first.thread.id, text: "wait", permissionMode: "workspace" });
  const telemetry = await hub.getTelemetry();
  assert.equal(telemetry.byProvider.qoder.runningCount, 1);
  await assert.rejects(hub.sendTurn({ threadId: first.thread.id, text: "忙碌" }), (error) => error.code === "thread_busy");
  const queued = await hub.queueTurn({ threadId: first.thread.id, text: "排队继续", model: "lite", effort: "high", permissionMode: "turbo" });
  assert.equal(queued.items.length, 1);
  await hub.interrupt({ threadId: first.thread.id });
  await waitFor(async () => (await provider.readThread("default", first.thread.rawId)).thread.turns.length === 3);
  await waitFor(async () => !(await provider.getActivity("default", first.thread.rawId)).live);
  assert.equal((await hub.listQueuedTurns(first.thread.id)).length, 0);
  assert.equal((await provider.listThreads()).length, 1);
});

test("Qoder ACP 文件与终端能力可用，工作区外写入和只读模式不被越过", async (t) => {
  const options = await setup(t);
  const provider = new QoderProvider(options);
  t.after(() => provider.close());
  const events = [];
  provider.setCallbacks({ onEvent: (event) => events.push(event), onServerRequest: (request) => {
    assert.equal(request.method, "client/operation");
    assert.match(request.command, /测试终端/);
    provider.respondServerRequest("default", request, { optionId: "allow" });
  } });
  await provider.startThread({ cwd: options.cwd, text: "tools", permissionMode: "workspace" });
  const complete = await waitFor(() => events.find((event) => event.type === "turn_completed"));
  assert.equal(complete.status, "completed");
  assert.equal(await readFile(resolve(options.cwd, "qoder-result.txt"), "utf8"), "第一行\n第二行\n");
  await provider.sendTurn({ rawId: complete.rawId, text: "tools", permissionMode: "safe" });
  const readOnly = await waitFor(() => events.filter((event) => event.type === "turn_completed")[1]);
  assert.equal(readOnly.status, "failed");
  assert.match(readOnly.error.message, /不允许写文件/);
  await provider.sendTurn({ rawId: complete.rawId, text: "outside", permissionMode: "workspace" });
  const outside = await waitFor(() => events.filter((event) => event.type === "turn_completed")[2]);
  assert.equal(outside.status, "failed");
  assert.match(outside.error.message, /超出当前项目目录/);
  await assert.rejects(readFile(resolve(options.cwd, "../escape.txt")), { code: "ENOENT" });
  assert.equal(qoderPermissionMode("plan"), "default");
  assert.equal(qoderPermissionMode("safe"), "default");
});

test("Qoder 未安装时返回明确错误，发现和模型目录不运行真实推理", async (t) => {
  const options = await setup(t);
  const provider = new QoderProvider({ ...options, env: { ...options.env, QODER_BIN: resolve(options.cwd, "missing") } });
  t.after(() => provider.close());
  assert.equal((await provider.listProfiles())[0].installed, false);
  assert.equal((await provider.listModels())[0].id, "auto");
  await assert.rejects(provider.startThread({ cwd: options.cwd, text: "不会发送" }), (error) => error.code === "qoder_not_installed");
  assert.deepEqual(await provider.listThreads(), []);
});

test("Qoder 同时发现旧版 qodercli 入口，规划模式不使用 CLI 不支持的 plan 权限参数", async (t) => {
  const options = await setup(t);
  await mkdir(resolve(options.env.HOME, ".local/bin"), { recursive: true });
  await symlink(mock, resolve(options.env.HOME, ".local/bin/qodercli"));
  const provider = new QoderProvider({ ...options, env: { ...options.env, QODER_BIN: "" } });
  t.after(() => provider.close());
  assert.equal((await provider.listProfiles())[0].installed, true);
  const events = [];
  provider.setCallbacks({ onEvent: (event) => events.push(event), onServerRequest: () => assert.fail("规划模式不能放行工具授权") });
  await provider.startThread({ cwd: options.cwd, text: "approval", permissionMode: "plan" });
  const complete = await waitFor(() => events.find((event) => event.type === "turn_completed"));
  assert.equal(complete.status, "failed");
  const first = JSON.parse((await readFile(resolve(options.env.AGENT_CONTROL_QODER_CONFIG_DIR, "mock-trace.jsonl"), "utf8")).split("\n")[0]);
  assert.ok(first.args.includes("--append-system-prompt"));
  assert.equal(first.args[first.args.indexOf("--permission-mode") + 1], "default");
});
