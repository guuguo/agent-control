import { open, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import { basename, dirname, resolve } from "node:path";
import { isProcessAlive } from "../runtime-lease.mjs";
import {
  cleanPreviewText,
  extractClaudeEventPreview,
  stripClaudeInvisibleNoise,
  stripPromptNoise,
} from "../thread-display.mjs";
import { isContinuationOrControlPrompt } from "../thread-title.mjs";

const INDEX_HEAD_BYTES = 48 * 1024;
const INDEX_TAIL_BYTES = 48 * 1024;

export function isValidClaudeModelId(value) {
  const clean = String(value || "").trim();
  return Boolean(clean && !clean.startsWith("<") && /^claude-[a-z0-9.-]+$/i.test(clean));
}

function parseTsSeconds(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  }
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : fallback;
}

export function decodeSlugFallback(slug) {
  const clean = String(slug || "").trim();
  const winDriveMatch = clean.match(/^([A-Za-z])--(.*)$/);
  if (winDriveMatch) {
    const drive = winDriveMatch[1];
    const rest = winDriveMatch[2].replace(/-/g, "\\").replace(/\\+$/, "");
    return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
  }
  if (/^[A-Za-z]-$/.test(clean)) {
    return `${clean[0]}:\\`;
  }
  if (!clean.startsWith("-")) return "";
  return `/${clean.slice(1).replace(/-/g, "/")}`;
}

const MAX_CLAUDE_HISTORY_BASE64_CHARS = 2_200_000;

function extractUserBlocks(content) {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "image" && part.source) {
      const mediaType = part.source.media_type || "image/png";
      if (part.source.type === "base64" && part.source.data) {
        if (part.source.data.length > MAX_CLAUDE_HISTORY_BASE64_CHARS) {
          const approxMb = Math.max(0.1, Math.round((part.source.data.length * 0.75) / (1024 * 1024) * 10) / 10);
          blocks.push({ type: "image", path: `🖼 历史图片（约 ${approxMb} MB，已省略原图传输）` });
        } else {
          blocks.push({ type: "image", url: `data:${mediaType};base64,${part.source.data}` });
        }
      } else if (part.source.url) {
        blocks.push({ type: "image", url: part.source.url });
      }
    }
  }
  return blocks;
}

function isPureToolResultUserEntry(entry) {
  const content = entry?.message?.content;
  if (!Array.isArray(content) || !content.length) return false;
  return content.every((part) => part?.type === "tool_result");
}

function isNoiseUserText(text) {
  return !stripClaudeInvisibleNoise(text);
}

function resolveClaudePreview(candidates = []) {
  for (const candidate of candidates) {
    const clean = cleanPreviewText(candidate, 120);
    if (clean) return clean;
  }
  return "";
}

export async function scanClaudeActiveSessions(configDir) {
  const sessionsDir = resolve(configDir, "sessions");
  const files = await readdir(sessionsDir).catch(() => []);
  const active = new Map();
  for (const name of files) {
    if (!name.endsWith(".json")) continue;
    try {
      const data = JSON.parse(await readFile(resolve(sessionsDir, name), "utf8"));
      if (!data?.sessionId || !data?.pid) continue;
      if (!isProcessAlive(data.pid)) continue;
      const sessionId = String(data.sessionId);
      const entry = {
        sessionId,
        pid: Number(data.pid),
        cwd: String(data.cwd || ""),
        name: String(data.name || ""),
        status: String(data.status || "running"),
        startedAt: parseTsSeconds(data.startedAt),
        updatedAt: parseTsSeconds(data.updatedAt || data.statusUpdatedAt || data.startedAt),
      };
      const prev = active.get(sessionId);
      if (!prev || entry.updatedAt > prev.updatedAt || (entry.updatedAt === prev.updatedAt && entry.status !== "idle")) {
        active.set(sessionId, entry);
      }
    } catch {
      // Ignore malformed/stale session file.
    }
  }
  return active;
}

const CLAUDE_ACTIVITY_WINDOW_MS = 15_000;

async function statClaudeSubagents(filePath) {
  if (!filePath) return { count: 0, totalSize: 0, latestMtimeMs: 0 };
  const subagentsDir = resolve(dirname(filePath), basename(filePath, ".jsonl"), "subagents");
  const entries = await readdir(subagentsDir, { withFileTypes: true }).catch(() => []);
  const jsonlFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"));
  if (!jsonlFiles.length) return { count: 0, totalSize: 0, latestMtimeMs: 0 };

  const stats = await Promise.all(
    jsonlFiles.map((entry) => stat(resolve(subagentsDir, entry.name)).catch(() => null)),
  );
  let count = 0;
  let totalSize = 0;
  let latestMtimeMs = 0;
  for (const info of stats) {
    if (!info?.isFile()) continue;
    count += 1;
    totalSize += Number(info.size || 0);
    if (info.mtimeMs > latestMtimeMs) latestMtimeMs = info.mtimeMs;
  }
  return { count, totalSize, latestMtimeMs };
}

/**
 * Inspect external Claude Code / Claude Desktop liveness for a single session.
 * Combines live session PID status files (~/.claude/sessions/*.json) with recent
 * main transcript and subagent JSONL writes so silent tool/thinking/subagent runs
 * are not misclassified as stopped.
 */
export async function readClaudeExternalSessionActivity(configDir, rawId, {
  index = null,
  located = null,
  activeWindowMs = CLAUDE_ACTIVITY_WINDOW_MS,
  nowMs = Date.now(),
} = {}) {
  const sessionId = String(rawId || "");
  const [activeMap, sessionLocated] = await Promise.all([
    scanClaudeActiveSessions(configDir),
    located ? Promise.resolve(located) : (index ? index.findSessionFile(configDir, sessionId) : Promise.resolve(null)),
  ]);
  const activeSession = activeMap.get(sessionId) || null;
  const sessionBusy = Boolean(activeSession && activeSession.status !== "idle");

  const filePath = sessionLocated?.filePath || "";
  const [fileStat, subagents] = filePath
    ? await Promise.all([stat(filePath).catch(() => null), statClaudeSubagents(filePath)])
    : [null, { count: 0, totalSize: 0, latestMtimeMs: 0 }];

  const sessionExplicitIdle = Boolean(activeSession && activeSession.status === "idle");
  const mainRecentlyActive = Boolean(fileStat?.mtimeMs > 0 && (nowMs - fileStat.mtimeMs) < activeWindowMs);
  const subagentsRecentlyActive = Boolean(subagents.latestMtimeMs > 0 && (nowMs - subagents.latestMtimeMs) < activeWindowMs);
  const readThreadLive = Boolean(sessionBusy || subagentsRecentlyActive);
  const live = Boolean(readThreadLive || (!sessionExplicitIdle && mainRecentlyActive));
  const latestMtimeMs = Math.max(fileStat?.mtimeMs || 0, subagents.latestMtimeMs || 0);
  const updatedAt = Math.max(
    activeSession?.updatedAt || 0,
    latestMtimeMs > 0 ? Math.floor(latestMtimeMs / 1000) : 0,
  );
  const statusTag = activeSession?.status || "none";
  const cursor = (fileStat || activeSession || subagents.count > 0)
    ? `file:${fileStat?.size || 0}:${Math.floor(fileStat?.mtimeMs || 0)}:${statusTag}:${subagents.count}:${subagents.totalSize}:${Math.floor(subagents.latestMtimeMs || 0)}`
    : (sessionLocated ? sessionLocated.filePath : "idle");

  return {
    live,
    readThreadLive,
    sessionBusy,
    recentlyActive: Boolean(mainRecentlyActive || subagentsRecentlyActive),
    updatedAt: updatedAt || Math.floor(nowMs / 1000),
    cursor,
    located: sessionLocated,
    activeSession,
  };
}

async function readHeadTailLines(filePath, fileSize) {
  if (fileSize <= INDEX_HEAD_BYTES + INDEX_TAIL_BYTES + 1024) {
    const raw = await readFile(filePath, "utf8");
    return raw.split("\n").filter(Boolean);
  }
  const fh = await open(filePath, "r");
  try {
    const headBuf = Buffer.allocUnsafe(Math.min(INDEX_HEAD_BYTES, fileSize));
    await fh.read(headBuf, 0, headBuf.length, 0);
    const tailStart = Math.max(headBuf.length, fileSize - INDEX_TAIL_BYTES);
    const tailBuf = Buffer.allocUnsafe(fileSize - tailStart);
    await fh.read(tailBuf, 0, tailBuf.length, tailStart);
    const headLines = headBuf.toString("utf8").split("\n");
    if (headBuf.length < fileSize) headLines.pop();
    const tailLines = tailBuf.toString("utf8").split("\n");
    if (tailStart > 0) tailLines.shift();
    return [...headLines, ...tailLines].filter(Boolean);
  } finally {
    await fh.close();
  }
}

export class ClaudeSessionHistoryIndex {
  #cache = new Map();

  async #summarizeFile(filePath, slug) {
    const info = await stat(filePath).catch(() => null);
    if (!info || !info.isFile()) return null;
    const cached = this.#cache.get(filePath);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      return cached.summary;
    }

    const lines = await readHeadTailLines(filePath, info.size).catch(() => []);
    const rawId = basename(filePath, ".jsonl");
    let cwd = "";
    let gitBranch = "";
    let createdAt = 0;
    let updatedAt = Math.floor(info.mtimeMs / 1000);
    let customTitle = "";
    let agentName = "";
    let lastPrompt = "";
    let firstUserText = "";
    let lastUserText = "";
    let lastSubstantiveUserText = "";
    let fallbackEventPreview = "";
    let userTurnCount = 0;
    let model = "";
    let hasConversation = false;

    for (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!entry || typeof entry !== "object") continue;
      if (entry.cwd && !cwd) cwd = String(entry.cwd);
      if (entry.gitBranch) gitBranch = String(entry.gitBranch);
      const ts = parseTsSeconds(entry.timestamp);
      if (ts > 0) {
        if (!createdAt || ts < createdAt) createdAt = ts;
        if (ts > updatedAt) updatedAt = ts;
      }
      if (entry.type === "relocated" && entry.relocatedCwd) {
        cwd = String(entry.relocatedCwd).trim();
      } else if (entry.type === "custom-title" && entry.customTitle) {
        customTitle = String(entry.customTitle).trim();
      } else if (entry.type === "agent-name" && entry.agentName) {
        agentName = String(entry.agentName).trim();
      } else if (entry.type === "last-prompt" && entry.lastPrompt) {
        lastPrompt = String(entry.lastPrompt).trim();
      } else if (entry.type === "user" && !entry.isMeta && !isPureToolResultUserEntry(entry)) {
        hasConversation = true;
        const blocks = extractUserBlocks(entry.message?.content);
        const rawText = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
        if (!isNoiseUserText(rawText)) {
          const summaryText = stripPromptNoise(rawText);
          if (summaryText) {
            userTurnCount += 1;
            if (!firstUserText) firstUserText = summaryText;
            lastUserText = summaryText;
            if (!isContinuationOrControlPrompt(summaryText)) {
              lastSubstantiveUserText = summaryText;
            }
          } else {
            const eventPreview = extractClaudeEventPreview(rawText);
            if (eventPreview) fallbackEventPreview = eventPreview;
          }
        }
      } else if (entry.type === "assistant") {
        hasConversation = true;
        if (!entry.isSidechain && isValidClaudeModelId(entry.message?.model)) {
          model = String(entry.message.model).trim();
        }
      }
    }

    if (!hasConversation && !customTitle && !lastPrompt) {
      return null;
    }
    if (
      String(firstUserText || "").trim().startsWith("[AGENT_CONTROL_PING]")
      || String(lastPrompt || "").trim().startsWith("[AGENT_CONTROL_PING]")
    ) {
      return null;
    }

    const effectiveLastUser = lastSubstantiveUserText || lastUserText || lastPrompt || "";
    const hasFollowUpTurns = userTurnCount > 1 || Boolean(
      lastPrompt && firstUserText && stripPromptNoise(lastPrompt) !== stripPromptNoise(firstUserText),
    );
    const summary = {
      id: rawId,
      filePath,
      cwd: cwd || decodeSlugFallback(slug) || os.homedir(),
      gitInfo: gitBranch ? { branch: gitBranch } : null,
      createdAt: createdAt || Math.floor((info.birthtimeMs || info.mtimeMs) / 1000),
      updatedAt,
      name: customTitle || agentName || "",
      upstreamCustomTitle: customTitle,
      firstUserText,
      lastUserText: effectiveLastUser,
      hasFollowUpTurns,
      preview: resolveClaudePreview([
        lastPrompt,
        lastUserText,
        firstUserText,
        customTitle,
        agentName,
        fallbackEventPreview,
      ]),
      model,
    };
    this.#cache.set(filePath, { mtimeMs: info.mtimeMs, size: info.size, summary });
    return summary;
  }

  async listSessions(configDir, { limit = 300 } = {}) {
    const projectsDir = resolve(configDir, "projects");
    const slugs = await readdir(projectsDir, { withFileTypes: true }).catch(() => []);
    const activeMap = await scanClaudeActiveSessions(configDir);
    const items = [];
    const seenIds = new Set();

    const fileEntries = [];
    for (const slugEntry of slugs) {
      if (!slugEntry.isDirectory()) continue;
      const slugPath = resolve(projectsDir, slugEntry.name);
      const files = await readdir(slugPath, { withFileTypes: true }).catch(() => []);
      for (const fileEntry of files) {
        if (!fileEntry.isFile() || !fileEntry.name.endsWith(".jsonl")) continue;
        fileEntries.push({
          filePath: resolve(slugPath, fileEntry.name),
          slug: slugEntry.name,
        });
      }
    }

    const summaries = await Promise.all(
      fileEntries.map(({ filePath, slug }) => this.#summarizeFile(filePath, slug)),
    );

    for (const summary of summaries) {
      if (!summary) continue;
      seenIds.add(summary.id);
      const active = activeMap.get(summary.id);
      items.push({
        ...summary,
        name: summary.name || active?.name || "",
        updatedAt: Math.max(summary.updatedAt, active?.updatedAt || 0),
        live: Boolean(active && active.status !== "idle"),
      });
    }

    for (const [sessionId, active] of activeMap.entries()) {
      if (seenIds.has(sessionId)) continue;
      items.push({
        id: sessionId,
        filePath: "",
        cwd: active.cwd || os.homedir(),
        gitInfo: null,
        createdAt: active.startedAt || Math.floor(Date.now() / 1000),
        updatedAt: active.updatedAt || active.startedAt || Math.floor(Date.now() / 1000),
        name: active.name || "",
        preview: active.name || "进行中的 Claude 会话",
        model: "",
        live: active.status !== "idle",
      });
    }

    items.sort((left, right) => right.updatedAt - left.updatedAt);
    return items.slice(0, Math.max(1, Number(limit) || 300));
  }

  async findSessionFile(configDir, rawId) {
    const projectsDir = resolve(configDir, "projects");
    const slugs = await readdir(projectsDir, { withFileTypes: true }).catch(() => []);
    for (const slugEntry of slugs) {
      if (!slugEntry.isDirectory()) continue;
      const candidate = resolve(projectsDir, slugEntry.name, `${rawId}.jsonl`);
      const info = await stat(candidate).catch(() => null);
      if (info?.isFile()) return { filePath: candidate, slug: slugEntry.name };
    }
    return null;
  }
}

function mapToolUseBlock(block, cwd = "") {
  const id = block.id || `tool-${Date.now()}`;
  const name = String(block.name || "Tool");
  const input = block.input && typeof block.input === "object" ? block.input : {};
  if (name === "Bash") {
    return {
      type: "commandExecution",
      id,
      command: String(input.command || ""),
      cwd: String(input.cwd || cwd || ""),
      status: "inProgress",
      aggregatedOutput: "",
    };
  }
  if (name === "Edit" || name === "Write" || name === "MultiEdit") {
    return {
      type: "fileChange",
      id,
      status: "inProgress",
      changes: [{
        path: String(input.file_path || input.path || ""),
        kind: name === "Write" ? "add" : "modify",
        diff: String(input.new_string || input.content || ""),
      }],
    };
  }
  return {
    type: "mcpToolCall",
    id,
    server: "claude",
    tool: name,
    arguments: input,
    status: "inProgress",
    result: null,
    error: null,
  };
}

function toolResultText(block) {
  if (typeof block?.content === "string") return block.content;
  if (Array.isArray(block?.content)) {
    return block.content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && part.type === "image" && part.source?.type === "base64") {
          return "[图片Base64已省略]";
        }
        return part?.text || JSON.stringify(part);
      })
      .join("\n");
  }
  return block?.content ? JSON.stringify(block.content) : "";
}

function applyToolResultToTurn(turn, block) {
  if (!turn || !block?.tool_use_id) return;
  const item = turn.items.find((entry) => entry.id === block.tool_use_id);
  if (!item) return;
  const text = toolResultText(block);
  const failed = Boolean(block.is_error);
  item.status = failed ? "failed" : "completed";
  if (item.type === "commandExecution") {
    item.aggregatedOutput = text;
    item.exitCode = failed ? 1 : 0;
  } else if (item.type === "fileChange") {
    if (failed) item.error = { message: text };
  } else if (failed) {
    item.error = { message: text };
  } else {
    item.result = { content: [{ type: "text", text }] };
  }
}

export function parseClaudeJsonlTranscript(lines, { rawId = "", fallbackCwd = "" } = {}) {
  const turns = [];
  let currentTurn = null;
  const assistantMessageIndex = new Map();
  let cwd = "";
  let relocatedCwd = "";
  let gitBranch = "";
  let model = "";
  let customTitle = "";
  let agentName = "";
  let lastPrompt = "";
  let firstUserText = "";
  let lastUserText = "";
  let lastSubstantiveUserText = "";
  let fallbackEventPreview = "";
  let userTurnCount = 0;
  let createdAt = 0;
  let updatedAt = 0;

  const ensureTurn = (idSeed, ts) => {
    if (!currentTurn) {
      currentTurn = {
        id: idSeed || `turn-${turns.length + 1}`,
        items: [],
        status: "completed",
        error: null,
        startedAt: ts || null,
        completedAt: ts || null,
        durationMs: null,
      };
      turns.push(currentTurn);
    }
    return currentTurn;
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    if (entry.cwd && !cwd) cwd = String(entry.cwd);
    if (entry.gitBranch) gitBranch = String(entry.gitBranch);
    const ts = parseTsSeconds(entry.timestamp);
    if (ts > 0) {
      if (!createdAt || ts < createdAt) createdAt = ts;
      if (ts > updatedAt) updatedAt = ts;
    }

    if (entry.type === "relocated" && entry.relocatedCwd) {
      relocatedCwd = String(entry.relocatedCwd).trim();
      continue;
    }
    if (entry.type === "custom-title" && entry.customTitle) {
      customTitle = String(entry.customTitle).trim();
      continue;
    }
    if (entry.type === "agent-name" && entry.agentName) {
      agentName = String(entry.agentName).trim();
      continue;
    }
    if (entry.type === "last-prompt" && entry.lastPrompt) {
      lastPrompt = String(entry.lastPrompt).trim();
      continue;
    }
    if (entry.type === "system") {
      if (entry.subtype === "turn_duration" && currentTurn && Number.isFinite(entry.durationMs)) {
        currentTurn.durationMs = entry.durationMs;
      }
      continue;
    }

    if (entry.type === "user") {
      if (entry.isMeta) continue;
      if (isPureToolResultUserEntry(entry)) {
        const target = ensureTurn(entry.uuid, ts);
        for (const block of entry.message.content) {
          applyToolResultToTurn(target, block);
        }
        if (ts > 0) target.completedAt = ts;
        continue;
      }
      const blocks = extractUserBlocks(entry.message?.content);
      const rawText = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      if (isNoiseUserText(rawText) && !blocks.some((b) => b.type === "image")) continue;

      const normalizedBlocks = blocks
        .map((b) => (b.type === "text" ? { type: "text", text: stripClaudeInvisibleNoise(b.text) } : b))
        .filter((b) => b.type !== "text" || Boolean(b.text));
      if (!normalizedBlocks.length) continue;

      const cleanUserText = stripPromptNoise(rawText);
      if (cleanUserText) {
        userTurnCount += 1;
        if (!firstUserText) firstUserText = cleanUserText;
        lastUserText = cleanUserText;
        if (!isContinuationOrControlPrompt(cleanUserText)) {
          lastSubstantiveUserText = cleanUserText;
        }
      } else {
        const eventPreview = extractClaudeEventPreview(rawText);
        if (eventPreview) fallbackEventPreview = eventPreview;
      }
      currentTurn = {
        id: entry.uuid || `turn-${turns.length + 1}`,
        items: [{
          type: "userMessage",
          id: entry.uuid || `user-${turns.length + 1}`,
          content: normalizedBlocks,
        }],
        status: "completed",
        error: null,
        startedAt: ts || null,
        completedAt: ts || null,
        durationMs: null,
      };
      turns.push(currentTurn);
      assistantMessageIndex.clear();
      continue;
    }

    if (entry.type === "assistant") {
      const msg = entry.message || {};
      if (!entry.isSidechain && isValidClaudeModelId(msg.model)) {
        model = String(msg.model).trim();
      }
      const turn = ensureTurn(entry.uuid, ts);
      if (isValidClaudeModelId(msg.model) && (!entry.isSidechain || !turn.model)) {
        turn.model = String(msg.model).trim();
      }
      const msgKey = String(msg.id || entry.uuid || turn.items.length);
      const content = Array.isArray(msg.content) ? msg.content : [];
      const hasToolUse = content.some((b) => b?.type === "tool_use");
      const seenForMessage = assistantMessageIndex.get(msgKey) || new Set();
      assistantMessageIndex.set(msgKey, seenForMessage);

      for (let i = 0; i < content.length; i += 1) {
        const block = content[i];
        if (!block || typeof block !== "object") continue;
        const blockKey = block.id || `${block.type}:${i}`;
        if (block.type === "thinking" && block.thinking) {
          const itemId = `${msgKey}:thinking:${i}`;
          const existing = turn.items.find((it) => it.id === itemId);
          if (existing) {
            existing.summary = [block.thinking];
            existing.content = [block.thinking];
          } else {
            turn.items.push({
              type: "reasoning",
              id: itemId,
              summary: [block.thinking],
              content: [block.thinking],
            });
          }
        } else if (block.type === "text" && block.text) {
          const itemId = `${msgKey}:text:${i}`;
          const existing = turn.items.find((it) => it.id === itemId);
          if (existing) {
            existing.text = block.text;
            existing.phase = hasToolUse ? "commentary" : "final_answer";
          } else {
            turn.items.push({
              type: "agentMessage",
              id: itemId,
              text: block.text,
              phase: hasToolUse ? "commentary" : "final_answer",
            });
          }
        } else if (block.type === "tool_use" && !seenForMessage.has(blockKey)) {
          seenForMessage.add(blockKey);
          turn.items.push(mapToolUseBlock(block, cwd));
        }
      }
      if (ts > 0) turn.completedAt = ts;
    }
  }

  // Any tool calls left without tool_result in completed historical turns should not spin forever.
  for (const turn of turns) {
    for (const item of turn.items) {
      if ((item.type === "commandExecution" || item.type === "fileChange" || item.type === "mcpToolCall") && item.status === "inProgress") {
        item.status = "completed";
      }
    }
  }

  const effectiveLastUser = lastSubstantiveUserText || lastUserText || lastPrompt || "";
  const hasFollowUpTurns = userTurnCount > 1 || Boolean(
    lastPrompt && firstUserText && stripPromptNoise(lastPrompt) !== stripPromptNoise(firstUserText),
  );
  return {
    id: rawId,
    cwd: relocatedCwd || cwd || fallbackCwd || os.homedir(),
    gitInfo: gitBranch ? { branch: gitBranch } : null,
    model,
    name: customTitle || agentName || "",
    upstreamCustomTitle: customTitle,
    firstUserText,
    lastUserText: effectiveLastUser,
    hasFollowUpTurns,
    preview: resolveClaudePreview([
      lastPrompt,
      lastUserText,
      firstUserText,
      customTitle,
      agentName,
      fallbackEventPreview,
    ]),
    createdAt,
    updatedAt,
    turns,
  };
}

export async function readClaudeThreadHistory(configDir, rawId, {
  index,
  cursor = null,
  limit = 40,
} = {}) {
  const located = await index.findSessionFile(configDir, rawId);
  if (!located) {
    return {
      thread: {
        id: rawId,
        cwd: os.homedir(),
        turns: [],
        createdAt: 0,
        updatedAt: 0,
        model: "",
      },
      nextCursor: null,
    };
  }
  const raw = await readFile(located.filePath, "utf8");
  const parsed = parseClaudeJsonlTranscript(raw.split("\n"), {
    rawId,
    fallbackCwd: decodeSlugFallback(located.slug),
  });
  const totalTurns = parsed.turns.length;
  const maxTurns = Math.max(1, Number(limit) || 40);
  let end = totalTurns;
  if (cursor && String(cursor).startsWith("turn:")) {
    const parsedEnd = Number(String(cursor).slice("turn:".length));
    if (Number.isInteger(parsedEnd) && parsedEnd >= 0) end = Math.min(totalTurns, parsedEnd);
  }
  const start = Math.max(0, end - maxTurns);
  const slicedTurns = parsed.turns.slice(start, end);
  return {
    thread: {
      ...parsed,
      turns: slicedTurns,
      largeHistory: start > 0,
    },
    nextCursor: start > 0 ? `turn:${start}` : null,
  };
}
