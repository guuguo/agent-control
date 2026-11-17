import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const FORK_CTX_START = "<!-- AC_FORK_CONTEXT_START -->";
const FORK_CTX_END = "<!-- AC_FORK_CONTEXT_END -->";
const MAX_FORK_CONTEXT_CHARS = 16000;

function extractTurnRoleTexts(turn) {
  const users = [];
  const agents = [];
  for (const item of turn?.items || []) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "userMessage") {
      const text = (item.content || [])
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => stripForkContextPrefix(part.text).trim())
        .filter(Boolean)
        .join("\n");
      if (text) users.push(text);
    } else if (item.type === "agentMessage") {
      const text = String(item.text || "").trim();
      if (text) agents.push(text);
    }
  }
  return {
    userText: users.join("\n\n"),
    agentText: agents.join("\n\n"),
  };
}

export function stripForkContextPrefix(text = "") {
  const raw = String(text || "");
  const startIdx = raw.indexOf(FORK_CTX_START);
  const endIdx = raw.indexOf(FORK_CTX_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return raw;
  return `${raw.slice(0, startIdx)}${raw.slice(endIdx + FORK_CTX_END.length)}`.replace(/^\s+/, "");
}

export function buildForkContextPrompt(turns = [], userText = "") {
  const blocks = [];
  let usedChars = 0;
  const list = Array.isArray(turns) ? turns : [];
  // Prefer keeping the most recent turns within the character budget.
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const { userText: u, agentText: a } = extractTurnRoleTexts(list[i]);
    const parts = [];
    if (u) parts.push(`用户：${u}`);
    if (a) parts.push(`助手：${a}`);
    if (!parts.length) continue;
    const block = parts.join("\n\n");
    if (usedChars + block.length > MAX_FORK_CONTEXT_CHARS && blocks.length > 0) break;
    blocks.unshift(block.slice(-MAX_FORK_CONTEXT_CHARS));
    usedChars += block.length;
  }
  const cleanUserText = String(userText || "").trim();
  if (!blocks.length) return cleanUserText;
  return [
    FORK_CTX_START,
    "[以下是从原会话分叉保留的历史对话记录，请以此作为上下文继续完成用户的新请求]",
    "",
    blocks.join("\n\n---\n\n"),
    FORK_CTX_END,
    cleanUserText,
  ].filter(Boolean).join("\n");
}

function slimTurnForFork(turn, index) {
  const items = [];
  for (const item of turn?.items || []) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "userMessage" || item.type === "agentMessage" || item.type === "reasoning") {
      if (item.type === "userMessage" && Array.isArray(item.content)) {
        items.push({
          ...item,
          content: item.content.map((part) => (
            part?.type === "text" && typeof part.text === "string"
              ? { ...part, text: stripForkContextPrefix(part.text) }
              : part
          )),
        });
      } else {
        items.push(item);
      }
    }
  }
  return {
    id: String(turn?.id || `fork-turn-${index + 1}`),
    status: turn?.status || "completed",
    startedAt: turn?.startedAt || 0,
    ...(turn?.model ? { model: turn.model } : {}),
    ...(turn?.effort ? { effort: turn.effort } : {}),
    items,
  };
}

export class ForkStore {
  #filePath;
  #entries = new Map();
  #byMaterialized = new Map();
  #writes = Promise.resolve();

  constructor({ filePath = "" } = {}) {
    this.#filePath = filePath;
  }

  async load() {
    if (!this.#filePath) return;
    try {
      const saved = JSON.parse(await readFile(this.#filePath, "utf8"));
      this.#entries.clear();
      this.#byMaterialized.clear();
      for (const entry of saved?.forks || []) {
        if (!entry?.id) continue;
        this.#entries.set(entry.id, entry);
        if (entry.materializedThreadId) {
          this.#byMaterialized.set(entry.materializedThreadId, entry.id);
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  #persist() {
    if (!this.#filePath) return Promise.resolve();
    const payload = JSON.stringify({ version: 1, forks: [...this.#entries.values()] }, null, 2);
    this.#writes = this.#writes.then(async () => {
      await mkdir(dirname(this.#filePath), { recursive: true });
      const tmp = `${this.#filePath}.tmp`;
      await writeFile(tmp, payload, { mode: 0o600 });
      await rename(tmp, this.#filePath);
    });
    this.#writes.catch(() => {});
    return this.#writes;
  }

  get(id) {
    return this.#entries.get(id) || null;
  }

  getByMaterialized(threadId) {
    const forkId = this.#byMaterialized.get(threadId);
    return forkId ? (this.#entries.get(forkId) || null) : null;
  }

  listPending() {
    return [...this.#entries.values()].filter((entry) => !entry.materializedThreadId);
  }

  async create({
    provider,
    profileId,
    profileLabel = "",
    cwd = "",
    name = "",
    model = "",
    reasoningEffort = "",
    permissionMode = "workspace",
    forkedFrom = null,
    turns = [],
  }) {
    const rawId = `fork-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const id = `${provider}:${profileId}:${rawId}`;
    const nowSec = Math.floor(Date.now() / 1000);
    const prefixTurns = (Array.isArray(turns) ? turns : []).map(slimTurnForFork);
    const entry = {
      id,
      rawId,
      provider,
      profileId,
      profileLabel,
      cwd,
      name: String(name || "分叉会话"),
      title: String(name || "分叉会话"),
      preview: prefixTurns[0] ? extractTurnRoleTexts(prefixTurns[0]).userText.slice(0, 120) : "",
      model,
      reasoningEffort,
      permissionMode,
      createdAt: nowSec,
      updatedAt: nowSec,
      archived: false,
      forkedFrom,
      prefixTurns,
      materializedThreadId: "",
      isForkDraft: true,
    };
    this.#entries.set(id, entry);
    await this.#persist();
    return entry;
  }

  async markMaterialized(forkId, realThreadId) {
    const entry = this.#entries.get(forkId);
    if (!entry) return null;
    entry.materializedThreadId = realThreadId;
    entry.isForkDraft = false;
    this.#byMaterialized.set(realThreadId, forkId);
    await this.#persist();
    return entry;
  }

  async rename(id, name) {
    const entry = this.#entries.get(id);
    if (!entry) return null;
    entry.name = String(name || "").trim() || entry.name;
    entry.title = entry.name;
    entry.updatedAt = Math.floor(Date.now() / 1000);
    await this.#persist();
    return entry;
  }

  async archive(id, archived = true) {
    const entry = this.#entries.get(id);
    if (!entry) return null;
    entry.archived = Boolean(archived);
    entry.updatedAt = Math.floor(Date.now() / 1000);
    await this.#persist();
    return entry;
  }

  async flush() {
    await this.#writes;
  }
}
