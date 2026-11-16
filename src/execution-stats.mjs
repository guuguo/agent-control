import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { estimateTextTokens } from "./telemetry-service.mjs";

const LIMIT = 5000;
const TOKEN_KEYS = ["inputTokens", "outputTokens", "cachedInputTokens", "reasoningTokens"];
const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] : null;
const average = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

function tokens(raw = {}, { claude = false } = {}) {
  const input = finite(raw.inputTokens ?? raw.input_tokens ?? raw.prompt_tokens);
  const read = finite(raw.cachedInputTokens ?? raw.cached_input_tokens ?? raw.cache_read_input_tokens ?? raw.prompt_tokens_details?.cached_tokens);
  const write = finite(raw.cache_creation_input_tokens);
  return {
    inputTokens: input === null ? null : input + (claude ? (read || 0) + (write || 0) : 0),
    outputTokens: finite(raw.outputTokens ?? raw.output_tokens ?? raw.completion_tokens),
    cachedInputTokens: read,
    reasoningTokens: finite(raw.reasoningOutputTokens ?? raw.reasoning_tokens ?? raw.completion_tokens_details?.reasoning_tokens),
  };
}

export class ExecutionStats {
  #filePath;
  #now;
  #rows = new Map();
  #active = new Map();
  #contexts = new Map();
  #codexTotals = new Map();
  #writes = Promise.resolve();
  #startedAt;

  constructor({ filePath = "", now = () => Date.now() } = {}) {
    this.#filePath = filePath;
    this.#now = now;
    this.#startedAt = now();
  }

  async load() {
    if (!this.#filePath) return;
    try {
      const saved = JSON.parse(await readFile(this.#filePath, "utf8"));
      this.#startedAt = saved.startedAt || this.#startedAt;
      for (const row of (saved.runs || []).slice(-LIMIT)) {
        if (row.status === "running") row.status = "incomplete";
        this.#rows.set(row.id, row);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  #persist() {
    if (!this.#filePath) return;
    const body = JSON.stringify({ version: 1, startedAt: this.#startedAt, runs: [...this.#rows.values()] });
    this.#writes = this.#writes.then(async () => {
      await mkdir(dirname(this.#filePath), { recursive: true });
      const tmp = `${this.#filePath}.tmp`;
      await writeFile(tmp, body, { mode: 0o600 });
      await rename(tmp, this.#filePath);
    });
    // Do not leave an unhandled rejection while callers wait for flush().
    this.#writes.catch(() => {});
  }

  #row(threadId, turnId) {
    return this.#rows.get(`${threadId}/${turnId}`) || (!turnId ? this.#rows.get(this.#active.get(threadId)) : null);
  }

  context(threadId, turnId, { model = "", effort = "", internal = false, goalMode = false } = {}) {
    const row = this.#row(threadId, turnId);
    if (!row) {
      if (turnId) this.#contexts.set(`${threadId}/${turnId}`, { model, effort, internal, goalMode });
      return;
    }
    if (internal) {
      this.#rows.delete(row.id);
      if (this.#active.get(threadId) === row.id) this.#active.delete(threadId);
    } else {
      if (model) row.model = model;
      if (effort) row.effort = effort;
      row.goalMode = Boolean(goalMode);
    }
    this.#persist();
  }

  handle(event, preferences = {}) {
    const threadId = event.threadId;
    if (!threadId) return;
    const p = event.params || {};
    const method = event.method || "";
    const turnId = event.turnId || event.turn?.id || p.turnId || p.turn?.id || "";
    const now = this.#now();
    const starts = event.type === "turn_started" || method === "turn/started";
    const ends = event.type === "turn_completed" || method === "turn/completed";
    if (starts && turnId) {
      const id = `${threadId}/${turnId}`;
      const context = this.#contexts.get(id);
      this.#contexts.delete(id);
      if (context?.internal) return;
      if (!this.#rows.has(id)) {
        this.#rows.set(id, {
          id, threadId, turnId, provider: event.provider, profileId: event.profileId || "",
          model: context?.model || event.model || event.turn?.model || preferences.model || "",
          effort: context?.effort || event.effort || event.turn?.effort || preferences.reasoningEffort || "",
          startedAt: now, endedAt: null, durationMs: null, firstResponseMs: null, status: "running",
          inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null,
          tokenSource: "unavailable", estimatedOutputTokens: 0, toolIds: [], goalMode: Boolean(context?.goalMode),
        });
      }
      this.#active.set(threadId, id);
      while (this.#rows.size > LIMIT) {
        const oldest = [...this.#rows.values()].find((row) => row.status !== "running");
        if (!oldest) break;
        this.#rows.delete(oldest.id);
      }
      this.#persist();
    }
    const row = this.#row(threadId, turnId);
    const stream = event.type === "stream_delta" && ["text", "reasoning", "toolInput"].includes(event.kind)
      ? event.delta
      : (["item/agentMessage/delta", "item/reasoning/textDelta", "item/reasoning/summaryTextDelta"].includes(method) ? p.delta : "");
    if (row?.status === "running" && stream) {
      if (row.firstResponseMs === null) row.firstResponseMs = Math.max(0, now - row.startedAt);
      row.estimatedOutputTokens += estimateTextTokens(stream);
    }
    const toolId = event.type === "tool_use" ? event.toolUse?.id
      : event.type === "acp_tool_update" ? event.update?.toolCallId
      : method === "item/started" && ["commandExecution", "fileChange", "mcpToolCall", "webSearch"].includes(p.item?.type) ? p.item.id : "";
    if (row && toolId && !row.toolIds.includes(toolId)) row.toolIds.push(toolId);

    if (method === "thread/tokenUsage/updated") {
      const total = p.tokenUsage?.total ? tokens(p.tokenUsage.total) : null;
      const previous = this.#codexTotals.get(threadId);
      if (row && total) {
        const delta = previous ? Object.fromEntries(TOKEN_KEYS.map((key) => [key,
          total[key] !== null && previous[key] !== null && total[key] >= previous[key] ? total[key] - previous[key] : null,
        ])) : tokens(p.tokenUsage?.last);
        for (const key of TOKEN_KEYS) if (delta[key] !== null) row[key] = (row[key] || 0) + delta[key];
        if (row.tokenSource === "unavailable") row.tokenSource = previous ? "reported" : "partial";
      }
      if (total) this.#codexTotals.set(threadId, total);
    } else if (row && event.usage) {
      const usage = tokens(event.usage, { claude: event.provider === "claude" });
      // Provider result usage is a per-turn total, not a streaming increment.
      Object.assign(row, usage, { tokenSource: TOKEN_KEYS.some((key) => usage[key] !== null) ? "reported" : row.tokenSource });
    }
    if (row && row.status !== "running" && (event.usage || method === "thread/tokenUsage/updated")) this.#persist();
    if (ends && row?.status === "running") {
      row.endedAt = now;
      row.durationMs = Math.max(0, now - row.startedAt);
      row.status = event.status || p.turn?.status || "completed";
      if (!row.outputTokens && row.estimatedOutputTokens > 0 && row.tokenSource === "unavailable") row.tokenSource = "estimated";
      this.#active.delete(threadId);
      this.#persist();
    }
  }

  snapshot({ days = 7, provider = "all" } = {}) {
    const windowDays = [1, 7, 30, 0].includes(Number(days)) ? Number(days) : 7;
    const cutoff = windowDays ? this.#now() - windowDays * 86400000 : 0;
    const runs = [...this.#rows.values()].filter((r) => r.startedAt >= cutoff && (!provider || provider === "all" || r.provider === provider));
    const grouped = new Map();
    for (const row of runs) {
      const key = JSON.stringify([row.provider, row.model, row.effort]);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(row);
    }
    const groups = [...grouped.values()].map((list) => {
      const finished = list.filter((r) => r.status === "completed");
      const exact = finished.filter((r) => r.tokenSource === "reported");
      return {
        provider: list[0].provider, model: list[0].model, effort: list[0].effort,
        count: list.length, completed: finished.length, failed: list.filter((r) => r.status === "failed").length,
        interrupted: list.filter((r) => r.status === "interrupted").length,
        running: list.filter((r) => r.status === "running").length,
        incomplete: list.filter((r) => r.status === "incomplete").length,
        medianMs: percentile(finished.map((r) => r.durationMs).filter((n) => n !== null), 0.5),
        p90Ms: percentile(finished.map((r) => r.durationMs).filter((n) => n !== null), 0.9),
        firstResponseMs: percentile(finished.map((r) => r.firstResponseMs).filter((n) => n !== null), 0.5),
        reportedCount: exact.length,
        meanInputTokens: average(exact.map((r) => r.inputTokens).filter((n) => n !== null)),
        meanOutputTokens: average(exact.map((r) => r.outputTokens).filter((n) => n !== null)),
        meanCachedTokens: average(exact.map((r) => r.cachedInputTokens).filter((n) => n !== null)),
        meanReasoningTokens: average(exact.map((r) => r.reasoningTokens).filter((n) => n !== null)),
        meanToolCalls: average(finished.map((r) => r.toolIds.length)),
      };
    });
    return { startedAt: this.#startedAt, updatedAt: this.#now(), days: windowDays, retainedLimit: LIMIT, count: runs.length, groups,
      runs: runs.slice(-30).reverse().map(({ toolIds, ...row }) => ({ ...row, toolCalls: toolIds.length })),
    };
  }

  async flush() { await this.#writes; }
}
