import { EventEmitter } from "node:events";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import { resolve } from "node:path";
import { grokPermissionArgs, normalizePermissionMode } from "../permissions.mjs";
import {
  execFileCrossPlatform,
  killProcessTreeCrossPlatform,
  normalizePlatform,
  prepareCrossPlatformSpawn,
} from "../platform.mjs";
import { resolveProviderExecutables } from "./profile-discovery.mjs";

const EFFORT_ORDER = ["low", "medium", "high", "xhigh"];
const EFFORT_DESCRIPTIONS = {
  low: "Fastest responses. Best for simple tasks.",
  medium: "Balanced effort with standard implementation.",
  high: "Thorough reasoning and quality. Recommended.",
  xhigh: "Maximum reasoning for the hardest tasks.",
};

export const DEFAULT_GROK_MODELS = [
  {
    id: "grok-4.7",
    model: "grok-4.7",
    displayName: "Grok 4.7",
    description: "SpaceXAI's latest frontier model",
    provider: "grok",
    supportedReasoningEfforts: EFFORT_ORDER.map((value) => ({
      reasoningEffort: value,
      description: EFFORT_DESCRIPTIONS[value],
    })),
    defaultReasoningEffort: "high",
    isDefault: true,
  },
  {
    id: "grok-4.7-build-fast",
    model: "grok-4.7-build-fast",
    displayName: "Grok 4.7 Fast",
    description: "Fast variant",
    provider: "grok",
    supportedReasoningEfforts: EFFORT_ORDER.map((value) => ({
      reasoningEffort: value,
      description: EFFORT_DESCRIPTIONS[value],
    })),
    defaultReasoningEffort: "high",
    isDefault: false,
  },
  {
    id: "grok-4.6",
    model: "grok-4.6",
    displayName: "Grok 4.6",
    description: "Balanced frontier coding model",
    provider: "grok",
    supportedReasoningEfforts: EFFORT_ORDER.map((value) => ({
      reasoningEffort: value,
      description: EFFORT_DESCRIPTIONS[value],
    })),
    defaultReasoningEffort: "high",
    isDefault: false,
  },
  {
    id: "grok-4.5",
    model: "grok-4.5",
    displayName: "Grok 4.5",
    description: "Previous generation Grok model",
    provider: "grok",
    supportedReasoningEfforts: ["low", "medium", "high"].map((value) => ({
      reasoningEffort: value,
      description: EFFORT_DESCRIPTIONS[value],
    })),
    defaultReasoningEffort: "high",
    isDefault: false,
  },
];

async function pathExists(targetPath) {
  if (!targetPath) return false;
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function grokExecutable(env = process.env) {
  return resolveProviderExecutables(env).grok || "grok";
}

export function grokEnvironment({ env = process.env, grokHome = "" } = {}) {
  const next = { ...env };
  delete next.TERM_PROGRAM;
  if (grokHome) {
    next.GROK_HOME = grokHome;
  }
  return next;
}

function normalizeEfforts(rawEfforts, defaultEffortRaw = "high") {
  const map = new Map();
  if (Array.isArray(rawEfforts)) {
    for (const item of rawEfforts) {
      const value = String(item?.value || item?.id || item?.reasoningEffort || "").trim().toLowerCase();
      if (!EFFORT_ORDER.includes(value)) continue;
      map.set(value, {
        reasoningEffort: value,
        description: String(item?.description || EFFORT_DESCRIPTIONS[value] || value).trim(),
      });
    }
  }
  if (map.size === 0) {
    for (const value of ["low", "medium", "high"]) {
      map.set(value, {
        reasoningEffort: value,
        description: EFFORT_DESCRIPTIONS[value],
      });
    }
  }
  const ordered = EFFORT_ORDER.filter((k) => map.has(k)).map((k) => map.get(k));
  const def = String(defaultEffortRaw || "").trim().toLowerCase();
  const defaultReasoningEffort = map.has(def)
    ? def
    : (ordered.some((e) => e.reasoningEffort === "high") ? "high" : ordered[0]?.reasoningEffort || "high");
  return { supportedReasoningEfforts: ordered, defaultReasoningEffort };
}

function parseGrokConfigDefaults(tomlText) {
  const out = { defaultModel: "", defaultEffort: "" };
  for (const rawLine of String(tomlText || "").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const modelMatch = line.match(/^(?:default_model|model)\s*=\s*"([^"]+)"/);
    if (modelMatch && !out.defaultModel) out.defaultModel = modelMatch[1].trim();
    const effortMatch = line.match(/^(?:reasoning_effort|effort)\s*=\s*"([^"]+)"/);
    if (effortMatch && !out.defaultEffort) out.defaultEffort = effortMatch[1].trim().toLowerCase();
  }
  return out;
}

/**
 * 读取本地 Grok models_cache.json 与 config.toml（严格只读 models 与公开字段，绝不读取 api_key / auth）。
 */
export async function readGrokModelsCatalog(grokHome, fallbackHomes = []) {
  const candidates = [grokHome, ...fallbackHomes].filter(Boolean);
  let rawModels = [];
  let configDefaults = { defaultModel: "", defaultEffort: "" };

  if (grokHome) {
    const cfg = await readFile(resolve(grokHome, "config.toml"), "utf8").catch(() => "");
    if (cfg) configDefaults = parseGrokConfigDefaults(cfg);
  }

  for (const homeDir of candidates) {
    const cachePath = resolve(homeDir, "models_cache.json");
    const raw = await readFile(cachePath, "utf8").catch(() => "");
    if (!raw) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const modelsField = parsed?.models;
    if (Array.isArray(modelsField)) {
      rawModels = modelsField.map((entry) => entry?.info || entry).filter(Boolean);
    } else if (modelsField && typeof modelsField === "object") {
      rawModels = Object.entries(modelsField).map(([key, entry]) => {
        const info = entry?.info || entry;
        return info && typeof info === "object" ? { id: key, ...info } : null;
      }).filter(Boolean);
    }
    if (rawModels.length > 0) break;
  }

  const normalized = rawModels
    .filter((m) => m && !m.hidden && (m.id || m.model))
    .map((m) => {
      const id = String(m.id || m.model).trim();
      const { supportedReasoningEfforts, defaultReasoningEffort } = normalizeEfforts(
        m.reasoning_efforts,
        m.reasoning_effort || configDefaults.defaultEffort || "high",
      );
      return {
        id,
        model: id,
        displayName: String(m.name || id).trim(),
        description: String(m.description || "").trim(),
        provider: "grok",
        supportedReasoningEfforts,
        defaultReasoningEffort,
        isDefault: false,
      };
    });

  const baseList = normalized.length > 0
    ? normalized
    : DEFAULT_GROK_MODELS.map((m) => ({ ...m }));

  const preferredDefault = configDefaults.defaultModel
    || (baseList.some((m) => m.id === "grok-4.7") ? "grok-4.7" : baseList[0]?.id || "");

  return baseList.map((m) => ({
    ...m,
    provider: "grok",
    isDefault: m.id === preferredDefault,
  }));
}

export async function probeGrokProfile(
  profile,
  { env = process.env, platform = process.platform, timeoutMs = 10_000 } = {},
) {
  const startedAt = Date.now();
  const cmd = grokExecutable(env);
  if (!cmd) {
    throw new Error("未检测到 grok CLI");
  }

  const grokHome = String(profile?.home || profile?.grokHome || "").trim();
  if (!grokHome || !(await pathExists(grokHome))) {
    throw new Error("Grok 配置目录不存在");
  }

  let res;
  try {
    res = await execFileCrossPlatform(cmd, ["models"], {
      env: grokEnvironment({ env, grokHome }),
      timeout: timeoutMs,
      maxBuffer: 512 * 1024,
    }, { platform });
  } catch (error) {
    const stderr = String(error?.stderr || error?.message || "Grok 探测失败").trim();
    const firstLine = stderr.split("\n")[0] || "Grok 探测失败";
    throw new Error(firstLine);
  }

  const output = `${res.stdout || ""}\n${res.stderr || ""}`.trim();
  const notAuthed = /not authenticated|not logged in|please login/i.test(output);
  const modelLines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("*") || line.startsWith("-"));
  if (notAuthed || profile?.authenticated === false) {
    throw new Error("未登录（仅可浏览历史，请切换已登录 Grok 实例）");
  }

  return {
    ok: true,
    authenticated: true,
    latencyMs: Date.now() - startedAt,
    modelCount: modelLines.length,
  };
}

function extensionFromMime(mimeType = "") {
  const m = String(mimeType || "").toLowerCase();
  if (m.includes("png")) return ".png";
  if (m.includes("webp")) return ".webp";
  if (m.includes("gif")) return ".gif";
  return ".jpg";
}

async function materializeTurnPrompt(prompt, images = []) {
  let cleanPrompt = String(prompt || "");
  const tempFiles = [];
  let tempDir = "";

  if (Array.isArray(images) && images.length > 0) {
    tempDir = await mkdtemp(resolve(os.tmpdir(), "agent-control-grok-"));
    const imageLines = [];
    for (let i = 0; i < images.length; i += 1) {
      const img = images[i];
      if (!img) continue;
      if (img.type === "localImage" && img.path) {
        imageLines.push(`[附图 ${i + 1}: ${img.path}]`);
        continue;
      }
      const dataUrl = String(img.url || img.dataUrl || "");
      const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/i);
      if (match) {
        const ext = extensionFromMime(match[1]);
        const target = resolve(tempDir, `image-${i + 1}${ext}`);
        await writeFile(target, Buffer.from(match[2], "base64"));
        tempFiles.push(target);
        imageLines.push(`[附图 ${i + 1}: ${target}]`);
      }
    }
    if (imageLines.length > 0) {
      cleanPrompt = `${cleanPrompt}\n\n${imageLines.join("\n")}`.trim();
    }
  }

  let promptFile = "";
  if (cleanPrompt.length > 4000) {
    if (!tempDir) tempDir = await mkdtemp(resolve(os.tmpdir(), "agent-control-grok-"));
    promptFile = resolve(tempDir, "prompt.txt");
    await writeFile(promptFile, cleanPrompt, "utf8");
  }

  return { promptText: cleanPrompt, promptFile, tempDir };
}

function summarizeGrokToolTitle(name, rawInput) {
  const n = String(name || "tool");
  const args = rawInput && typeof rawInput === "object" ? rawInput : {};
  const cmd = args.command || args.cmd;
  if (cmd) return `${n}: ${String(cmd).slice(0, 72)}`;
  const target = args.path || args.file_path || args.target_file || args.query;
  if (target) return `${n}: ${String(target).slice(0, 72)}`;
  return n;
}

export class GrokTurnManager extends EventEmitter {
  #env;
  #platform;
  #runs = new Map();

  constructor({ env = process.env, platform = process.platform } = {}) {
    super();
    this.#env = env;
    this.#platform = normalizePlatform(platform);
  }

  hasActiveTurn(rawId) {
    return this.#runs.has(String(rawId || "").trim());
  }

  getActiveTurn(rawId) {
    const run = this.#runs.get(String(rawId || "").trim());
    if (!run) return null;
    return {
      id: run.turnId,
      turnId: run.turnId,
      status: "inProgress",
      items: run.items.slice(),
      error: null,
      startedAt: run.startedAt,
      userText: run.prompt,
      reasoningText: run.reasoningText,
      text: run.lastText,
      lastText: run.lastText,
    };
  }

  async startTurn({
    rawId,
    turnId,
    cwd,
    prompt,
    images = [],
    model = "",
    reasoningEffort = "",
    permissionMode = "workspace",
    resume = false,
    grokHome = "",
    env = this.#env,
  }) {
    const cleanId = String(rawId || "").trim();
    if (!cleanId) throw new Error("Grok turn requires session id");
    if (this.#runs.has(cleanId)) {
      const err = new Error("当前 Grok 会话仍在执行中");
      err.status = 409;
      throw err;
    }

    const workDir = String(cwd || "").trim() || os.homedir();
    const { promptText, promptFile, tempDir } = await materializeTurnPrompt(prompt, images);
    const args = [];
    if (promptFile) {
      args.push("--prompt-file", promptFile);
    } else {
      args.push("-p", promptText);
    }
    args.push("--output-format", "streaming-json");
    if (workDir) args.push("--cwd", workDir);
    if (model) args.push("-m", String(model).trim());
    const effort = String(reasoningEffort || "").trim().toLowerCase();
    if (effort && EFFORT_ORDER.includes(effort)) {
      args.push("--reasoning-effort", effort);
    }
    args.push(...grokPermissionArgs(normalizePermissionMode(permissionMode)));
    if (resume) {
      args.push("-r", cleanId);
    } else {
      args.push("-s", cleanId);
    }

    const command = grokExecutable(env);
    const spawnEnv = grokEnvironment({ env, grokHome });
    const prepared = prepareCrossPlatformSpawn(
      command,
      args,
      { cwd: workDir, env: spawnEnv, stdio: ["ignore", "pipe", "pipe"] },
      { platform: this.#platform },
    );

    const proc = spawn(prepared.command, prepared.args, prepared.options);
    const run = {
      rawId: cleanId,
      turnId,
      proc,
      tempDir,
      prompt: String(prompt || ""),
      startedAt: Date.now(),
      items: [{
        type: "userMessage",
        id: `${turnId}-user`,
        content: [{ type: "text", text: String(prompt || "") }],
      }],
      toolItems: new Map(),
      reasoningItem: null,
      agentItem: null,
      reasoningText: "",
      lastText: "",
      needsParagraphBreak: false,
      sawEnd: false,
      interrupted: false,
      errorMessage: "",
      stderrTail: [],
      killTimer: null,
    };
    this.#runs.set(cleanId, run);

    this.emit("event", {
      type: "turn_started",
      rawId: cleanId,
      turnId,
      startedAt: run.startedAt,
      prompt: run.prompt,
      model,
    });

    let stdoutBuffer = "";
    const handleLine = (rawLine) => {
      const line = String(rawLine || "").trim();
      if (!line) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (!event || typeof event !== "object") return;
      this.#handleStreamEvent(run, event);
    };

    proc.stdout?.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    });

    proc.stderr?.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (!text) return;
      run.stderrTail.push(text);
      if (run.stderrTail.length > 20) run.stderrTail.shift();
    });

    proc.on("error", (err) => {
      run.errorMessage = err?.message || "Grok CLI 启动失败";
    });

    proc.on("close", async (code, signal) => {
      if (stdoutBuffer.trim()) handleLine(stdoutBuffer);
      if (run.killTimer) clearTimeout(run.killTimer);
      if (run.sigkillTimer) clearTimeout(run.sigkillTimer);
      this.#runs.delete(cleanId);
      if (run.tempDir) {
        await rm(run.tempDir, { recursive: true, force: true }).catch(() => {});
      }

      const durationMs = Date.now() - run.startedAt;
      let status = "completed";
      let error = null;
      if (run.interrupted) {
        status = "interrupted";
      } else if (run.errorMessage || (code !== 0 && !run.sawEnd)) {
        status = "failed";
        error = {
          message: run.errorMessage || run.stderrTail.join("\n").trim() || `Grok 退出码 ${code ?? signal ?? 1}`,
        };
      }

      this.emit("event", {
        type: "turn_completed",
        rawId: cleanId,
        turnId,
        status,
        lastAgentMessage: run.lastText,
        error,
        durationMs,
      });
    });

    return {
      turn: {
        id: turnId,
        status: "inProgress",
      },
      turnId,
      startedAt: run.startedAt,
    };
  }

  #handleStreamEvent(run, event) {
    const type = String(event.type || "").trim();

    if (type === "thought") {
      const delta = typeof event.data === "string"
        ? event.data
        : String(event.data?.text || event.text || "");
      if (!delta) return;
      run.reasoningText += delta;
      if (!run.reasoningItem) {
        run.reasoningItem = {
          type: "reasoning",
          id: `${run.turnId}-reason`,
          summary: [run.reasoningText],
          content: [],
        };
        run.items.push(run.reasoningItem);
      } else {
        run.reasoningItem.summary = [run.reasoningText];
      }
      this.emit("event", {
        type: "stream_delta",
        rawId: run.rawId,
        turnId: run.turnId,
        kind: "reasoning",
        delta,
      });
      return;
    }

    if (type === "text") {
      let delta = typeof event.data === "string"
        ? event.data
        : String(event.data?.text || event.text || "");
      if (!delta) return;
      if (run.needsParagraphBreak && run.lastText) {
        if (!delta.startsWith("\n")) delta = `\n\n${delta}`;
        run.needsParagraphBreak = false;
      }
      run.lastText += delta;
      if (!run.agentItem) {
        run.agentItem = {
          type: "agentMessage",
          id: `${run.turnId}-assistant`,
          text: run.lastText,
        };
        run.items.push(run.agentItem);
      } else {
        run.agentItem.text = run.lastText;
      }
      this.emit("event", {
        type: "stream_delta",
        rawId: run.rawId,
        turnId: run.turnId,
        kind: "text",
        delta,
      });
      return;
    }

    if (type === "usage") {
      run.needsParagraphBreak = Boolean(run.lastText);
      this.emit("event", { type: "token_usage", rawId: run.rawId, turnId: run.turnId,
        usage: event.data && typeof event.data === "object" ? event.data : event });
      return;
    }

    if (type === "tool_call") {
      const payload = event.data && typeof event.data === "object" ? event.data : event;
      const toolCallId = String(payload.id || payload.tool_call_id || `${run.turnId}-tool-${run.toolItems.size + 1}`);
      const name = String(payload.name || payload.tool || "tool");
      let rawInput = payload.arguments ?? payload.input ?? {};
      if (typeof rawInput === "string") {
        try {
          rawInput = JSON.parse(rawInput);
        } catch {
          rawInput = { raw: rawInput };
        }
      }
      const title = summarizeGrokToolTitle(name, rawInput);
      const item = {
        type: "mcpToolCall",
        id: toolCallId,
        server: "grok",
        tool: name,
        arguments: rawInput,
        result: null,
        status: "inProgress",
      };
      run.toolItems.set(toolCallId, { item, name, title });
      run.items.push(item);
      this.emit("event", {
        type: "acp_tool_update",
        rawId: run.rawId,
        turnId: run.turnId,
        update: {
          toolCallId,
          title,
          kind: "tool",
          status: "in_progress",
          rawInput,
        },
      });
      return;
    }

    if (type === "tool_call_update") {
      const payload = event.data && typeof event.data === "object" ? event.data : event;
      const toolCallId = String(payload.id || payload.tool_call_id || "");
      const tracked = run.toolItems.get(toolCallId);
      const rawStatus = String(payload.status || "completed").toLowerCase();
      const failed = rawStatus === "error" || rawStatus === "failed" || Boolean(payload.is_error || payload.error);
      const output = payload.output ?? payload.result ?? payload.content ?? "";
      const outputText = typeof output === "string" ? output : JSON.stringify(output);
      if (tracked) {
        tracked.item.status = failed ? "failed" : (rawStatus === "running" || rawStatus === "in_progress" ? "inProgress" : "completed");
        if (outputText) {
          tracked.item.result = { content: [{ type: "text", text: outputText }] };
        }
      }
      this.emit("event", {
        type: "acp_tool_update",
        rawId: run.rawId,
        turnId: run.turnId,
        update: {
          toolCallId: toolCallId || `${run.turnId}-tool`,
          title: tracked?.title || String(payload.name || "tool"),
          status: failed ? "failed" : (rawStatus === "running" || rawStatus === "in_progress" ? "in_progress" : "completed"),
          ...(outputText ? { rawOutput: outputText } : {}),
        },
      });
      return;
    }

    if (type === "plan") {
      const payload = event.data && typeof event.data === "object" ? event.data : event;
      if (Array.isArray(payload.entries)) {
        this.emit("event", {
          type: "acp_plan_update",
          rawId: run.rawId,
          turnId: run.turnId,
          update: { entries: payload.entries },
        });
      }
      return;
    }

    if (type === "error") {
      const msg = typeof event.data === "string"
        ? event.data
        : String(event.data?.message || event.message || event.error || "Grok execution error");
      run.errorMessage = msg;
      return;
    }

    if (type === "end") {
      run.sawEnd = true;
      const payload = event.data && typeof event.data === "object" ? event.data : event;
      if (!run.lastText && typeof payload.text === "string" && payload.text) {
        run.lastText = payload.text;
      }
      if (payload.error && !run.errorMessage) {
        run.errorMessage = typeof payload.error === "string" ? payload.error : String(payload.error?.message || "Grok error");
      }
    }
  }

  async interrupt(rawId) {
    const cleanId = String(rawId || "").trim();
    const run = this.#runs.get(cleanId);
    if (!run) return { ok: false, error: "当前没有进行中的 Grok 回合" };
    run.interrupted = true;
    try {
      await killProcessTreeCrossPlatform(run.proc, { signal: "SIGINT", platform: this.#platform });
    } catch {
      try { run.proc.kill("SIGINT"); } catch {}
    }
    run.killTimer = setTimeout(() => {
      if (run.proc.exitCode === null) {
        killProcessTreeCrossPlatform(run.proc, { signal: "SIGTERM", platform: this.#platform }).catch(() => {});
      }
    }, 1_500);
    run.killTimer.unref?.();
    run.sigkillTimer = setTimeout(() => {
      if (run.proc.exitCode === null) {
        killProcessTreeCrossPlatform(run.proc, { signal: "SIGKILL", platform: this.#platform }).catch(() => {});
      }
    }, 3_500);
    run.sigkillTimer.unref?.();
    return { ok: true, turnId: run.turnId };
  }

  async close() {
    const ids = [...this.#runs.keys()];
    await Promise.all(ids.map((id) => this.interrupt(id).catch(() => {})));
  }
}
