#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
if (!args.includes("--acp")) throw new Error("Mock Qoder 只允许 ACP，不会调用模型");
const value = (flag) => args[args.indexOf(flag) + 1];
if (!["default", "accept_edits", "bypass_permissions", "dont_ask", "auto"].includes(value("--permission-mode"))) throw new Error("无效的 Qoder CLI 权限参数");
const home = value("--config-dir");
mkdirSync(home, { recursive: true });
const store = resolve(home, "mock-sessions.json");
let sessions = [];
try { sessions = JSON.parse(readFileSync(store, "utf8")); } catch {}
const trace = (entry) => appendFileSync(resolve(home, "mock-trace.jsonl"), `${JSON.stringify(entry)}\n`);
trace({ args, cwd: process.cwd() });
const send = (payload) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...payload })}\n`);
const reply = (id, result) => send({ id, result });
const notify = (sessionId, update) => send({ method: "session/update", params: { sessionId, update } });
const pending = new Map();
const prompts = new Map();
let nextId = 1000;
function ask(method, params) {
  const id = nextId++;
  return new Promise((done, fail) => { pending.set(id, { done, fail }); send({ id, method, params }); });
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  const msg = JSON.parse(line);
  trace(msg);
  if (!msg.method) {
    const request = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) request?.fail(new Error(msg.error.message)); else request?.done(msg.result);
    return;
  }
  const p = msg.params || {};
  try {
    if (msg.method === "initialize") {
      if (!p.clientCapabilities?.terminal || !p.clientCapabilities?.fs?.writeTextFile) throw new Error("缺少 ACP 客户端能力");
      return reply(msg.id, { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } });
    }
    if (msg.method === "session/new") {
      const sessionId = randomUUID();
      sessions.push(sessionId); writeFileSync(store, JSON.stringify(sessions));
      return reply(msg.id, { sessionId });
    }
    if (msg.method === "session/load") {
      if (!sessions.includes(p.sessionId)) throw new Error("找不到原会话，禁止隐式创建分叉");
      return reply(msg.id, {});
    }
    if (msg.method === "session/cancel") {
      const entry = prompts.get(p.sessionId);
      if (entry) { entry.cancelled = true; reply(entry.id, { stopReason: "cancelled" }); prompts.delete(p.sessionId); }
      return;
    }
    if (msg.method !== "session/prompt") throw new Error(`未实现 ${msg.method}`);
    const text = p.prompt.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    const run = { id: msg.id, cancelled: false };
    prompts.set(p.sessionId, run);
    if (text === "wait") return;
    if (text === "approval") {
      const result = await ask("session/request_permission", { sessionId: p.sessionId,
        toolCall: { title: "Mock 写文件" }, options: [{ optionId: "yes", kind: "allow_once", name: "允许" }, { optionId: "no", kind: "reject_once", name: "拒绝" }] });
      if (result.outcome.optionId !== "yes") throw new Error("用户拒绝");
    }
    if (text === "tools") {
      await ask("fs/write_text_file", { sessionId: p.sessionId, path: resolve(process.cwd(), "qoder-result.txt"), content: "第一行\n第二行\n" });
      const file = await ask("fs/read_text_file", { sessionId: p.sessionId, path: resolve(process.cwd(), "qoder-result.txt"), line: 2, limit: 1 });
      if (file.content !== "第二行\n") throw new Error("ACP 文件行范围不正确");
      const term = await ask("terminal/create", { sessionId: p.sessionId, command: process.execPath, args: ["-e", "process.stdout.write('测试终端')"], cwd: process.cwd(), outputByteLimit: 10 });
      const exit = await ask("terminal/wait_for_exit", { sessionId: p.sessionId, terminalId: term.terminalId });
      const output = await ask("terminal/output", { sessionId: p.sessionId, terminalId: term.terminalId });
      if (exit.exitCode !== 0 || Buffer.byteLength(output.output) > 10 || output.output.includes("�")) throw new Error("ACP 终端输出或退出状态不正确");
      await ask("terminal/release", { sessionId: p.sessionId, terminalId: term.terminalId });
    }
    if (text === "outside") await ask("fs/write_text_file", { sessionId: p.sessionId, path: resolve(process.cwd(), "../escape.txt"), content: "不得写入" });
    notify(p.sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "正在分析" } });
    notify(p.sessionId, { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "检查项目", kind: "read", status: "in_progress" });
    notify(p.sessionId, { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "已检查" } }] });
    notify(p.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `完成：${text}` } });
    setTimeout(() => {
      if (!run.cancelled) reply(msg.id, { stopReason: "end_turn" });
      prompts.delete(p.sessionId);
    }, 80);
  } catch (error) { send({ id: msg.id, error: { code: -32000, message: error.message } }); }
});
