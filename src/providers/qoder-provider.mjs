import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { formatCompositeThreadId } from "../composite-id.mjs";
import { defaultDataDir } from "../instance-identity.mjs";
import { isBypassPermissionMode, normalizePermissionMode } from "../permissions.mjs";
import { resolveExecutableCrossPlatform, resolveUserHome } from "../platform.mjs";
import { cleanPreviewText, displayThreadTitle } from "../thread-display.mjs";
import { createAcpPermissionResponse, normalizeAcpPermissionRequest } from "./antigravity-acp-client.mjs";
import { QoderAcpClient } from "./qoder-acp-client.mjs";

export const QODER_MODELS = ["auto", "lite", "performance"].map((id) => ({
  id, model: id, displayName: { auto: "Auto", lite: "Lite", performance: "Performance" }[id],
  provider: "qoder", isDefault: id === "auto", defaultReasoningEffort: "medium", supportedReasoningEfforts: ["low", "medium", "high"],
}));

export class QoderProvider {
  id = "qoder";
  label = "Qoder";
  #env;
  #dataPath;
  #loaded;
  #writes = Promise.resolve();
  #threads = new Map();
  #clients = new Map();
  #active = new Map();
  #operations = new Map();
  #onEvent;
  #onServerRequest;

  constructor({ env = process.env, dataDir = defaultDataDir(env), onEvent = () => {}, onServerRequest = () => {} } = {}) {
    this.#env = env;
    this.#dataPath = resolve(dataDir, "qoder-threads.json");
    this.setCallbacks({ onEvent, onServerRequest });
  }

  setCallbacks({ onEvent, onServerRequest } = {}) {
    if (onEvent) this.#onEvent = onEvent;
    if (onServerRequest) this.#onServerRequest = onServerRequest;
  }

  #profile(profileId = "default") {
    if (profileId !== "default") throw Object.assign(new Error("未知的 Qoder 实例"), { status: 404 });
    const home = resolveUserHome(this.#env);
    const executable = resolveExecutableCrossPlatform({ envVar: "QODER_BIN", binaryName: "qoder", env: this.#env, strictExplicit: true,
      candidates: [resolve(home, ".local/bin/qoder"), resolve(home, ".local/bin/qodercli"), "/opt/homebrew/bin/qoder", "/usr/local/bin/qoder", resolve(this.#env.APPDATA || resolve(home, "AppData/Roaming"), "npm/qoder.cmd"), resolve(this.#env.APPDATA || resolve(home, "AppData/Roaming"), "npm/qodercli.cmd")] })
      || (!this.#env.QODER_BIN ? resolveExecutableCrossPlatform({ binaryName: "qodercli", env: this.#env }) : null);
    return { id: "default", provider: "qoder", label: "Qoder CLI", home: resolve(this.#env.AGENT_CONTROL_QODER_CONFIG_DIR || this.#env.QODER_CONFIG_DIR || resolve(home, ".qoder")),
      executable, installed: Boolean(executable), online: Boolean(executable), account: { label: "本机 CLI 登录" } };
  }

  async refreshProfiles() { return [this.#profile()]; }
  async listProfiles() { return this.refreshProfiles(); }
  async listModels(profileId = "default") { this.#profile(profileId); return QODER_MODELS.map((item) => ({ ...item, profileId })); }

  async #load() {
    if (!this.#loaded) this.#loaded = (async () => {
      const raw = await readFile(this.#dataPath, "utf8").catch((error) => { if (error.code !== "ENOENT") throw error; return ""; });
      if (raw) for (const thread of JSON.parse(raw).threads || []) this.#threads.set(thread.rawId, thread);
    })();
    await this.#loaded;
  }

  #save() {
    const json = JSON.stringify({ version: 1, threads: [...this.#threads.values()] });
    this.#writes = this.#writes.catch(() => {}).then(async () => {
      await mkdir(dirname(this.#dataPath), { recursive: true, mode: 0o700 });
      await writeFile(`${this.#dataPath}.tmp`, json, { mode: 0o600 });
      await rename(`${this.#dataPath}.tmp`, this.#dataPath);
    });
    return this.#writes;
  }

  #summary(thread, includeTurns = false) {
    const { turns, ...summary } = thread;
    return { ...summary, id: formatCompositeThreadId("qoder", "default", thread.rawId), provider: "qoder", providerLabel: "Qoder", profileId: "default", profileLabel: "Qoder CLI",
      title: displayThreadTitle(thread), live: this.#active.has(thread.rawId), ...(includeTurns ? { turns } : {}) };
  }

  #emit(type, rawId, payload) {
    this.#onEvent({ type, provider: "qoder", profileId: "default", rawId, threadId: formatCompositeThreadId("qoder", "default", rawId), ...payload });
  }

  async #client(thread) {
    const settings = JSON.stringify([thread.model, thread.reasoningEffort, thread.permissionMode]);
    const previous = this.#clients.get(thread.rawId);
    if (previous?.settings === settings && previous.client.isConnected) return previous.client;
    if (previous) await previous.client.close();
    const profile = this.#profile();
    if (!profile.installed) throw Object.assign(new Error("未安装 Qoder CLI，请先安装并执行 qoder login（旧命令为 qodercli login）"), { status: 503, code: "qoder_not_installed" });
    const client = new QoderAcpClient({ executable: profile.executable, configDir: profile.home, cwd: thread.cwd,
      model: thread.model, effort: thread.reasoningEffort, permissionMode: thread.permissionMode, env: this.#env,
      authorize: (msg) => new Promise((done) => {
        const id = `operation-${randomUUID()}`;
        this.#operations.set(id, { done, rawId: thread.rawId });
        this.#onServerRequest({ id, rawId: id, provider: "qoder", profileId: "default", method: "client/operation", kind: "acpPermission",
          threadId: formatCompositeThreadId("qoder", "default", thread.rawId), title: "Qoder 请求运行命令",
          command: JSON.stringify({ command: msg.params.command, args: msg.params.args || [], env: msg.params.env || [], cwd: msg.params.cwd || thread.cwd }),
          options: [{ optionId: "allow", name: "允许一次", kind: "allow_once" }, { optionId: "deny", name: "拒绝", kind: "reject_once" }], availableDecisions: ["accept", "decline"] });
      }),
    });
    client.on("sessionUpdate", (params) => this.#update(thread, params));
    client.on("terminalOutput", ({ terminalId, command, output, exitStatus }) => {
      const active = this.#active.get(thread.rawId);
      if (!active) return;
      const id = `terminal-${terminalId}`;
      let item = active.turn.items.find((entry) => entry.id === id);
      if (!item) { item = { id, type: "commandExecution", command }; active.turn.items.push(item); }
      item.aggregatedOutput = output;
      item.status = exitStatus ? (exitStatus.exitCode === 0 ? "completed" : "failed") : "inProgress";
      if (exitStatus) { item.exitCode = exitStatus.exitCode; this.#emit("item_completed", thread.rawId, { turnId: active.turn.id, item }); }
    });
    client.on("serverRequest", (msg) => {
      if (msg.method === "session/request_permission") {
        const request = { ...normalizeAcpPermissionRequest(msg), provider: "qoder", profileId: "default", title: msg.params?.toolCall?.title || "Qoder 请求授权",
          threadId: formatCompositeThreadId("qoder", "default", thread.rawId), sessionId: thread.rawId };
        if (thread.permissionMode === "plan") client.respond(msg.id, createAcpPermissionResponse(request, { decision: "decline" }));
        else if (isBypassPermissionMode(thread.permissionMode)) client.respond(msg.id, createAcpPermissionResponse(request, { decision: "acceptForSession" }));
        else this.#onServerRequest(request);
      } else void client.handleClientRequest(msg, thread).catch(() => {});
    });
    this.#clients.set(thread.rawId, { client, settings });
    return client;
  }

  #update(thread, params) {
    if (params?.sessionId !== thread.rawId) return;
    const active = this.#active.get(thread.rawId);
    if (!active) return;
    const update = params.update || {};
    const type = update.sessionUpdate;
    active.seq++;
    if (type === "agent_message_chunk" || type === "agent_thought_chunk") {
      const thought = type === "agent_thought_chunk";
      const text = update.content?.text || "";
      const id = `${active.turn.id}:${thought ? "thought" : "agent"}:${active.segment}`;
      let item = active.turn.items.find((entry) => entry.id === id);
      if (!item) { item = { id, type: thought ? "reasoning" : "agentMessage", text: "" }; active.turn.items.push(item); }
      item.text += text;
      if (thought) active.thought += text; else active.text += text;
      this.#emit("stream_delta", thread.rawId, { turnId: active.turn.id, itemId: id, kind: thought ? "reasoning" : "text", delta: text });
    } else if (type === "tool_call" || type === "tool_call_update") {
      if (type === "tool_call") { active.segment++; active.text = ""; active.thought = ""; }
      active.phase = update.title || active.phase;
      const id = String(update.toolCallId || update.id);
      let item = active.turn.items.find((entry) => entry.id === id);
      if (!item) { item = { id, type: "mcpToolCall", tool: update.title || update.kind || "Qoder 工具", server: "qoder" }; active.turn.items.push(item); }
      if (update.status) item.status = update.status;
      if (update.content) item.result = { content: update.content };
      this.#emit("acp_tool_update", thread.rawId, { turnId: active.turn.id, update });
    } else if (type === "plan") this.#emit("acp_plan_update", thread.rawId, { turnId: active.turn.id, entries: update.entries || [] });
  }

  async listThreads(profileId = "default", { limit = 300 } = {}) {
    this.#profile(profileId); await this.#load();
    return [...this.#threads.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit).map((thread) => this.#summary(thread));
  }

  async readThread(profileId, rawId) {
    this.#profile(profileId); await this.#load();
    const thread = this.#threads.get(rawId);
    if (!thread) throw Object.assign(new Error("找不到 Qoder 会话"), { status: 404 });
    const activity = await this.getActivity(profileId, rawId);
    return { thread: this.#summary(thread, true), nextCursor: null, activity: activity.activity, activityCursor: activity.cursor, streaming: activity.streaming };
  }

  async getActivity(profileId, rawId, { cursor = null } = {}) {
    this.#profile(profileId);
    const active = this.#active.get(rawId);
    const next = active ? `${active.turn.id}:${active.seq}` : "idle";
    return { live: Boolean(active), cursor: next, changed: cursor !== next,
      activity: active ? { turnId: active.turn.id, status: "running", phase: active.phase, updatedAt: Math.floor(Date.now() / 1000) } : null,
      streaming: active ? { turnId: active.turn.id, text: active.text, thought: active.thought } : null, nativeQueuedTurns: [] };
  }

  async startThread({ profileId = "default", cwd = resolveUserHome(this.#env), text = "", images = [], model = "auto", effort = "", permissionMode = "workspace" } = {}) {
    this.#profile(profileId); await this.#load();
    const now = Math.floor(Date.now() / 1000);
    const thread = { rawId: `draft-${randomUUID()}`, cwd: resolve(cwd), model: model || "auto", reasoningEffort: effort,
      permissionMode: normalizePermissionMode(permissionMode), createdAt: now, updatedAt: now, preview: cleanPreviewText(text), firstUserText: text, turns: [] };
    const client = await this.#client(thread);
    try {
      const created = await client.newSession({ cwd: thread.cwd });
      if (!created?.sessionId) throw new Error("Qoder 未返回会话 ID");
      const draft = thread.rawId;
      thread.rawId = created.sessionId;
      this.#clients.set(thread.rawId, this.#clients.get(draft)); this.#clients.delete(draft);
      this.#threads.set(thread.rawId, thread);
      await this.#save();
      const sent = text.trim() || images.length ? await this.sendTurn({ profileId, rawId: thread.rawId, text, images }) : { turn: null };
      return { thread: this.#summary(thread), turn: sent.turn };
    } catch (error) { await client.close(); throw error; }
  }

  async sendTurn({ profileId = "default", rawId, text = "", images = [], model = "", effort = "", permissionMode = "" } = {}) {
    this.#profile(profileId); await this.#load();
    if (this.#active.has(rawId)) throw Object.assign(new Error("Qoder 会话正在运行，请加入排队"), { status: 409, code: "thread_busy" });
    const thread = this.#threads.get(rawId);
    if (!thread) throw Object.assign(new Error("找不到 Qoder 会话"), { status: 404 });
    const prompt = [{ type: "text", text: String(text) }];
    for (const image of images) {
      const url = typeof image === "string" ? image : image.dataUrl || image.url || "";
      const match = url.match(/^data:([^;]+);base64,([\s\S]+)$/);
      if (!match) throw Object.assign(new Error("Qoder 图片需要上传为内嵌图片"), { status: 400 });
      prompt.push({ type: "image", mimeType: match[1], data: match[2] });
    }
    thread.model = model || thread.model;
    thread.reasoningEffort = effort || thread.reasoningEffort;
    thread.permissionMode = normalizePermissionMode(permissionMode || thread.permissionMode);
    const turn = { id: `qoder-turn-${randomUUID()}`, status: "inProgress", startedAt: Math.floor(Date.now() / 1000), model: thread.model, effort: thread.reasoningEffort,
      items: [{ id: randomUUID(), type: "userMessage", content: [{ type: "text", text }, ...images.map((image) => ({ type: "image", url: typeof image === "string" ? image : image.dataUrl || image.url }))] }] };
    const active = { turn, text: "", thought: "", phase: "Qoder 执行中", seq: 0, segment: 0 };
    this.#active.set(rawId, active);
    let client;
    try {
      client = await this.#client(thread);
      await client.ensureSessionLoaded(rawId, { cwd: thread.cwd });
      thread.turns.push(turn); thread.updatedAt = turn.startedAt; thread.preview = cleanPreviewText(text);
      await this.#save();
    } catch (error) { this.#active.delete(rawId); throw error; }
    this.#emit("turn_started", rawId, { turn, model: thread.model, effort: thread.reasoningEffort });
    const finish = async (error, response) => {
      turn.status = active.interrupted || response?.stopReason === "cancelled" ? "interrupted" : error ? "failed" : "completed";
      turn.completedAt = Math.floor(Date.now() / 1000);
      if (error && turn.status === "failed") turn.error = { message: error.message };
      thread.updatedAt = turn.completedAt;
      await this.#save();
      this.#active.delete(rawId);
      this.#emit("turn_completed", rawId, { turnId: turn.id, status: turn.status, lastAgentMessage: active.text, error: turn.error || null });
    };
    void client.sendPrompt(rawId, prompt).then((response) => finish(null, response), (error) => finish(error)).catch((error) => {
      this.#active.delete(rawId);
      this.#emit("turn_completed", rawId, { turnId: turn.id, status: "failed", error: { message: error.message } });
    });
    return { thread: this.#summary(thread), turn: { id: turn.id, status: "inProgress", startedAt: turn.startedAt } };
  }

  respondServerRequest(profileId, request, input) {
    this.#profile(profileId);
    if (request.method === "client/operation") {
      const pending = this.#operations.get(request.rawId);
      if (!pending) throw new Error("Qoder 命令审批已过期");
      this.#operations.delete(request.rawId);
      pending.done(input.optionId === "allow" || ["accept", "acceptForSession", "approved"].includes(input.decision));
    } else {
      const client = this.#clients.get(request.sessionId)?.client;
      if (!client) throw new Error("Qoder 客户端已断开");
      client.respond(request.rawId, createAcpPermissionResponse(request, input));
    }
    return { ok: true };
  }

  async interrupt({ rawId } = {}) {
    const active = this.#active.get(rawId);
    if (!active) return { ok: true, alreadyIdle: true };
    active.interrupted = true;
    for (const [id, pending] of this.#operations) if (pending.rawId === rawId) { pending.done(false); this.#operations.delete(id); }
    await this.#clients.get(rawId)?.client.cancel(rawId);
    return { ok: true, turnId: active.turn.id };
  }

  async probeProfile(profileId = "default") {
    this.#profile(profileId);
    const thread = { rawId: "probe", cwd: resolveUserHome(this.#env), model: "auto", reasoningEffort: "", permissionMode: "safe" };
    const started = Date.now();
    const client = await this.#client(thread);
    try { await client.ensureReady(); return { ok: true, latencyMs: Date.now() - started, note: "CLI 协议可连接；账号可用性以实际任务为准" }; }
    finally { await client.close(); this.#clients.delete("probe"); }
  }

  async close() {
    for (const pending of this.#operations.values()) pending.done(false);
    this.#operations.clear();
    await Promise.all([...this.#clients.values()].map(({ client }) => client.close()));
    await this.#writes;
  }
}
