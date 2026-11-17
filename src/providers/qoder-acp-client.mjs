import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { AntigravityAcpClient } from "./antigravity-acp-client.mjs";
import { isBypassPermissionMode, normalizePermissionMode } from "../permissions.mjs";
import { isSubpathOrEqual, killProcessTreeCrossPlatform, prepareCrossPlatformSpawn } from "../platform.mjs";

export function qoderPermissionMode(mode) {
  switch (normalizePermissionMode(mode)) {
    case "turbo": case "full": return "bypass_permissions";
    case "plan": return "default";
    case "workspace": return "accept_edits";
    default: return "default";
  }
}

export class QoderAcpClient extends AntigravityAcpClient {
  #terminals = new Map();
  #env;
  #authorize;
  #spawn;

  constructor({ executable, configDir, cwd, model = "auto", effort = "", permissionMode = "workspace", env = process.env, authorize = async () => false, spawnImpl = spawn } = {}) {
    const args = ["--acp", "--config-dir", configDir, "--permission-mode", qoderPermissionMode(permissionMode), "--model", model];
    if (effort) args.push("--reasoning-effort", effort);
    if (permissionMode === "plan") args.push("--append-system-prompt", "当前会话处于规划模式：只分析现有信息并制定方案，不修改文件、不运行终端命令、不执行有副作用的操作。");
    super({ executable, env, spawnImpl, agentName: "Qoder", launch: { args, cwd, env },
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true } });
    this.#env = env;
    this.#authorize = authorize;
    this.#spawn = spawnImpl;
  }

  async #checkPath(path, thread) {
    if (!isAbsolute(path || "")) throw new Error("Qoder 文件或工作目录必须是绝对路径");
    if (isBypassPermissionMode(thread.permissionMode)) return;
    const root = await realpath(thread.cwd);
    const target = await realpath(path).catch(async (error) => {
      if (error.code !== "ENOENT") throw error;
      return resolve(await realpath(dirname(path)), path.slice(dirname(path).length + 1));
    });
    if (!isSubpathOrEqual(root, target)) throw new Error("Qoder 请求超出当前项目目录，请调整权限后重试");
  }

  async handleClientRequest(msg, thread) {
    const p = msg.params || {};
    try {
      if (!thread || p.sessionId !== thread.rawId) throw new Error("Qoder 会话不匹配");
      let result;
      if (msg.method === "fs/read_text_file" || msg.method === "fs/write_text_file") {
        await this.#checkPath(p.path, thread);
        if (msg.method === "fs/read_text_file") {
          const text = await readFile(p.path, "utf8");
          const start = Math.max(0, (Number(p.line) || 1) - 1);
          result = { content: p.line || p.limit ? text.split(/(?<=\n)/).slice(start, p.limit == null ? undefined : start + Number(p.limit)).join("") : text };
        } else {
          if (["safe", "plan"].includes(thread.permissionMode)) throw new Error("当前 Qoder 权限模式不允许写文件");
          await writeFile(p.path, String(p.content ?? ""), "utf8");
          result = {};
        }
      } else if (msg.method === "terminal/create") {
        const cwd = p.cwd || thread.cwd;
        await this.#checkPath(cwd, thread);
        if (thread.permissionMode === "plan") throw new Error("Qoder 规划模式不允许执行终端命令");
        if (!isBypassPermissionMode(thread.permissionMode) && !await this.#authorize(msg, thread)) throw new Error("用户拒绝执行 Qoder 命令");
        const commandEnv = { ...this.#env };
        for (const entry of p.env || []) commandEnv[entry.name] = entry.value;
        const launch = prepareCrossPlatformSpawn(p.command, p.args || [], { cwd, env: commandEnv, stdio: ["ignore", "pipe", "pipe"] });
        const proc = this.#spawn(launch.command, launch.args, launch.options);
        const terminalId = randomUUID();
        const term = { proc, output: "", truncated: false, exitStatus: null };
        const publish = () => this.emit("terminalOutput", { terminalId, command: [p.command, ...(p.args || [])].join(" "), output: term.output, exitStatus: term.exitStatus });
        const limit = Math.max(1, Math.min(Number(p.outputByteLimit) || 64 * 1024, 1024 * 1024));
        const append = (chunk) => {
          term.output += chunk;
          while (Buffer.byteLength(term.output) > limit) {
            const excess = Buffer.byteLength(term.output) - limit;
            const bytes = Buffer.from(term.output);
            let start = excess;
            while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
            term.output = bytes.subarray(start).toString("utf8");
            term.truncated = true;
          }
          publish();
        };
        proc.stdout.setEncoding("utf8").on("data", append);
        proc.stderr.setEncoding("utf8").on("data", append);
        term.done = new Promise((done) => {
          proc.once("close", (exitCode, signal) => { term.exitStatus = { exitCode, signal }; publish(); done(term.exitStatus); });
          proc.once("error", () => { term.exitStatus = { exitCode: 1, signal: null }; done(term.exitStatus); });
        });
        await new Promise((done, fail) => { proc.once("spawn", done); proc.once("error", fail); });
        this.#terminals.set(terminalId, term);
        publish();
        result = { terminalId };
      } else if (msg.method.startsWith("terminal/")) {
        const term = this.#terminals.get(p.terminalId);
        if (!term) throw new Error("Qoder 终端不存在或已释放");
        if (msg.method === "terminal/output") result = { output: term.output, truncated: term.truncated, ...(term.exitStatus ? { exitStatus: term.exitStatus } : {}) };
        else if (msg.method === "terminal/wait_for_exit") result = await term.done;
        else if (["terminal/kill", "terminal/release"].includes(msg.method)) {
          if (!term.exitStatus) killProcessTreeCrossPlatform(term.proc);
          if (msg.method === "terminal/release") this.#terminals.delete(p.terminalId);
          result = {};
        }
      }
      if (result === undefined) return this.respondError(msg.id, -32601, `不支持的 Qoder 客户端方法：${msg.method}`);
      this.respond(msg.id, result);
    } catch (error) {
      this.respondError(msg.id, -32000, error.message);
    }
  }

  async close() {
    for (const term of this.#terminals.values()) if (!term.exitStatus) killProcessTreeCrossPlatform(term.proc);
    this.#terminals.clear();
    await super.close();
  }

  async cancel(sessionId) {
    for (const term of this.#terminals.values()) if (!term.exitStatus) killProcessTreeCrossPlatform(term.proc);
    await super.cancel(sessionId);
  }
}
