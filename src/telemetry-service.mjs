import { existsSync } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { formatCompositeThreadId, formatProfileKey } from "./composite-id.mjs";
import { resolveUserHome } from "./platform.mjs";
import { ANTIGRAVITY_STALE_LIVE_AGE_MS, isAntigravityDiskLive } from "./providers/antigravity-history.mjs";
import { readClaudeDesktopSessionsMeta } from "./providers/profile-discovery.mjs";
import { isInternalVoiceCallThread } from "./thread-access.mjs";

const PROVIDERS_ORDER = ["codex", "claude", "antigravity", "grok"];
const MAX_FILE_CURSORS = 80;
const INITIAL_TAIL_BYTES = 128 * 1024;
const DELTA_READ_CAP_BYTES = 256 * 1024;
const AGY_LIVE_AGE_MS = ANTIGRAVITY_STALE_LIVE_AGE_MS;
const CODEX_LIVE_AGE_SEC = 10 * 60;
const RECENT_ACTIVE_SEC = 15;
const STREAM_WINDOW_MS = 6000;
const SAMPLE_MAX_AGE_MS = 12000;

function parseTimeMs(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  const clean = String(value || "").trim();
  if (!clean) return fallback;
  const isoLike = /^\d{4}-\d{2}-\d{2}\s+\d{2}:/.test(clean) ? clean.replace(/\s+/, "T") : clean;
  const parsed = Date.parse(isoLike);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampNumber(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return min;
  return Math.max(min, Math.min(max, num));
}

function sanitizeTelemetryTitle(rawTitle, fallback = "进行中会话") {
  let text = String(rawTitle || "").trim();
  if (!text) return fallback;
  text = text
    .replace(/<user_info>[\s\S]*?<\/user_info>/gi, " ")
    .replace(/<rules>[\s\S]*?<\/rules>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || text.startsWith("为下面这条用户消息起")) return fallback;
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

export function estimateTextTokens(text) {
  if (typeof text !== "string" || !text) return 0;
  let cjk = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if ((code >= 0x3000 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff)) {
      cjk += 1;
    }
  }
  const raw = cjk * 0.7 + (text.length - cjk) * 0.26;
  return Math.max(1, Math.round(raw));
}

export function computeSlidingTokensPerSec(
  samples = [],
  nowMs = Date.now(),
  { windowMs = STREAM_WINDOW_MS } = {},
) {
  if (!Array.isArray(samples) || !samples.length || windowMs <= 0) return 0;
  const winStart = nowMs - windowMs;
  let totalTokens = 0;

  for (const s of samples) {
    if (!s || !(s.tokens > 0)) continue;
    const atMs = Number(s.atMs);
    if (!Number.isFinite(atMs)) continue;
    const span = Number(s.spanMs) || 0;

    if (span > 0) {
      const sampleStart = atMs - span;
      const effEnd = Math.min(atMs, nowMs + 1000);
      const overlap = Math.max(0, effEnd - Math.max(sampleStart, winStart));
      if (overlap <= 0) continue;
      const postAge = Math.max(0, nowMs - atMs);
      if (postAge >= 4000) continue;
      const postDecay = 1 - postAge / 4000;
      totalTokens += s.tokens * Math.min(1, overlap / span) * postDecay;
    } else if (atMs >= winStart && atMs <= nowMs + 2000) {
      totalTokens += s.tokens;
    }
  }

  const rate = totalTokens / (windowMs / 1000);
  if (!Number.isFinite(rate) || rate < 0.1) return 0;
  return Math.round(rate * 10) / 10;
}

async function readFileSliceUtf8(filePath, offset, length) {
  const fh = await open(filePath, "r").catch(() => null);
  if (!fh) return "";
  try {
    const len = Math.max(0, Math.min(length, DELTA_READ_CAP_BYTES));
    if (!len) return "";
    const buf = Buffer.allocUnsafe(len);
    const { bytesRead } = await fh.read(buf, 0, len, offset);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close().catch(() => {});
  }
}

export class AgentTelemetryService {
  #env;
  #homeDir;
  #nowFn;
  #samplesByProvider = new Map();
  #fileCursors = new Map();

  constructor({
    env = process.env,
    homeDir = resolveUserHome(env, process.platform, os.homedir()),
    nowFn = () => Date.now(),
  } = {}) {
    this.#env = env;
    this.#homeDir = resolve(homeDir);
    this.#nowFn = nowFn;
    for (const p of PROVIDERS_ORDER) {
      this.#samplesByProvider.set(p, []);
    }
  }

  #appendSample(provider, sample) {
    if (!this.#samplesByProvider.has(provider)) {
      this.#samplesByProvider.set(provider, []);
    }
    const list = this.#samplesByProvider.get(provider);
    list.push(sample);
    const cutoff = (sample.atMs || this.#nowFn()) - SAMPLE_MAX_AGE_MS;
    while (list.length > 0 && (list.length > 400 || list[0].atMs < cutoff)) {
      list.shift();
    }
  }

  #pruneSamples(provider, nowMs) {
    const list = this.#samplesByProvider.get(provider);
    if (!list || !list.length) return [];
    const cutoff = nowMs - SAMPLE_MAX_AGE_MS;
    let drop = 0;
    while (drop < list.length && list[drop].atMs < cutoff) drop += 1;
    if (drop > 0) list.splice(0, drop);
    return list;
  }

  #getCursor(key) {
    if (!this.#fileCursors.has(key)) return null;
    const val = this.#fileCursors.get(key);
    this.#fileCursors.delete(key);
    this.#fileCursors.set(key, val);
    return val;
  }

  #setCursor(key, val) {
    if (this.#fileCursors.has(key)) {
      this.#fileCursors.delete(key);
    } else if (this.#fileCursors.size >= MAX_FILE_CURSORS) {
      const oldest = this.#fileCursors.keys().next().value;
      if (oldest !== undefined) this.#fileCursors.delete(oldest);
    }
    this.#fileCursors.set(key, val);
  }

  recordStreamDelta(provider, threadId, deltaText, nowMs = this.#nowFn()) {
    if (!provider || !deltaText) return;
    const tokens = estimateTextTokens(String(deltaText));
    if (tokens <= 0) return;
    this.#appendSample(provider, {
      atMs: nowMs,
      tokens,
      spanMs: 0,
      source: "stream",
      threadId: String(threadId || ""),
    });
  }

  recordExactTokens(provider, threadId, tokenDelta, nowMs = this.#nowFn(), spanMs = 0) {
    const tokens = Math.round(Number(tokenDelta) || 0);
    if (!provider || tokens <= 0) return;
    this.#appendSample(provider, {
      atMs: nowMs,
      tokens,
      spanMs: Math.max(0, Number(spanMs) || 0),
      source: "exact",
      threadId: String(threadId || ""),
    });
  }

  async #scanAntigravity(profiles, activeRawSet, nowMs) {
    const runningMap = new Map();
    const seenDbPaths = new Set();

    for (const profile of profiles) {
      const appDir = profile?.home;
      if (!appDir) continue;
      const dbPath = resolve(appDir, "conversation_summaries.db");
      if (seenDbPaths.has(dbPath) || !existsSync(dbPath)) continue;
      seenDbPaths.add(dbPath);

      let rows = [];
      let db;
      try {
        db = new DatabaseSync(dbPath, { readOnly: true });
        rows = db.prepare(`
          SELECT conversation_id, title, status, last_modified_time, workspace_uris
          FROM conversation_summaries
          WHERE not_fully_idle = 1 AND killed = 0
          ORDER BY last_modified_time DESC
          LIMIT 16
        `).all();
      } catch {
        rows = [];
      } finally {
        try { db?.close(); } catch {}
      }

      for (const row of rows) {
        const rawId = String(row?.conversation_id || "").trim();
        if (!rawId) continue;
        if (isInternalVoiceCallThread({ title: row.title, cwd: row.workspace_uris })) continue;
        const modMs = parseTimeMs(row.last_modified_time, 0);
        const compactPath = resolve(appDir, "brain", rawId, ".system_generated", "logs", "transcript.jsonl");
        let transcriptMtimeMs = 0;
        if (modMs > 0 && (nowMs - modMs) > AGY_LIVE_AGE_MS) {
          const cst = await stat(compactPath).catch(() => null);
          transcriptMtimeMs = cst?.isFile() ? cst.mtimeMs : 0;
        }
        if (!isAntigravityDiskLive({
          flaggedLive: true,
          updatedAtMs: modMs,
          transcriptMtimeMs,
          nowMs,
          staleLiveAgeMs: AGY_LIVE_AGE_MS,
        })) {
          continue;
        }

        const compositeId = formatCompositeThreadId("antigravity", profile.id, rawId);
        if (!runningMap.has(rawId)) {
          runningMap.set(rawId, {
            id: compositeId,
            rawId,
            title: sanitizeTelemetryTitle(row.title, "Antigravity 任务"),
          });
        }

        if (activeRawSet.has(rawId)) continue;
        const tfPath = resolve(appDir, "brain", rawId, ".system_generated", "logs", "transcript_full.jsonl");
        const st = await stat(tfPath).catch(() => null);
        if (!st?.isFile() || st.size <= 0) continue;

        const cursorKey = `agy:${tfPath}`;
        let cursor = this.#getCursor(cursorKey);
        const isFirst = !cursor || st.size < cursor.size;
        if (isFirst) {
          cursor = { size: 0, seenKeys: new Set() };
        }

        if (st.size > cursor.size) {
          const readOffset = isFirst
            ? Math.max(0, st.size - INITIAL_TAIL_BYTES)
            : (st.size - cursor.size > DELTA_READ_CAP_BYTES ? st.size - DELTA_READ_CAP_BYTES : cursor.size);
          const text = await readFileSliceUtf8(tfPath, readOffset, st.size - readOffset);
          const lines = text.split("\n");
          if (readOffset > 0) lines.shift();

          for (const line of lines) {
            if (!line.trim() || !line.includes("PLANNER_RESPONSE")) continue;
            let obj;
            try {
              obj = JSON.parse(line);
            } catch {
              continue;
            }
            if (obj?.type !== "PLANNER_RESPONSE") continue;
            const stepKey = String(obj.step_index ?? obj.created_at ?? "");
            if (!stepKey || cursor.seenKeys.has(stepKey)) continue;
            cursor.seenKeys.add(stepKey);
            if (cursor.seenKeys.size > 200) {
              const firstKey = cursor.seenKeys.values().next().value;
              if (firstKey !== undefined) cursor.seenKeys.delete(firstKey);
            }

            const createdMs = parseTimeMs(obj.created_at, st.mtimeMs);
            if (isFirst) {
              const ageMs = nowMs - Math.max(createdMs, st.mtimeMs);
              if (ageMs > RECENT_ACTIVE_SEC * 1000) continue;
            }

            const payloadText = `${obj.thinking || ""}${obj.content || ""}${obj.tool_calls ? JSON.stringify(obj.tool_calls) : ""}`;
            const tok = estimateTextTokens(payloadText);
            if (tok > 0) {
              const endMs = isFirst ? Math.min(nowMs, st.mtimeMs) : nowMs;
              const spanMs = clampNumber(endMs - createdMs, 1500, 15000);
              this.#appendSample("antigravity", {
                atMs: endMs,
                tokens: tok,
                spanMs,
                source: "transcript",
                threadId: compositeId,
              });
            }
          }
          cursor.size = st.size;
          this.#setCursor(cursorKey, cursor);
        } else {
          this.#setCursor(cursorKey, cursor);
        }
      }
    }

    return runningMap;
  }

  async #scanCodex(profiles, activeRawSet, nowMs) {
    const runningMap = new Map();
    const nowSec = Math.floor(nowMs / 1000);
    const seenHomes = new Set();

    for (const profile of profiles) {
      const codexHome = profile?.home;
      if (!codexHome || seenHomes.has(codexHome)) continue;
      seenHomes.add(codexHome);
      const dbPath = resolve(codexHome, "state_5.sqlite");
      if (!existsSync(dbPath)) continue;

      let rows = [];
      let db;
      try {
        db = new DatabaseSync(dbPath, { readOnly: true });
        rows = db.prepare(`
          SELECT id, title, name, rollout_path, updated_at
          FROM threads
          WHERE archived = 0 AND updated_at >= ?
          ORDER BY updated_at DESC
          LIMIT 8
        `).all(nowSec - CODEX_LIVE_AGE_SEC);
      } catch {
        rows = [];
      } finally {
        try { db?.close(); } catch {}
      }

      for (const row of rows) {
        const rawId = String(row?.id || "").trim();
        const rolloutPath = String(row?.rollout_path || "").trim();
        if (!rawId || !rolloutPath) continue;
        const st = await stat(rolloutPath).catch(() => null);
        if (!st?.isFile() || st.size <= 0) continue;

        const compositeId = formatCompositeThreadId("codex", profile.id, rawId);
        const cursorKey = `codex:${rolloutPath}`;
        let cursor = this.#getCursor(cursorKey);
        const isFirst = !cursor || st.size < cursor.size;
        if (isFirst) {
          cursor = { size: 0, running: false, turnId: "" };
        }

        if (st.size > cursor.size) {
          const readOffset = isFirst
            ? Math.max(0, st.size - INITIAL_TAIL_BYTES)
            : (st.size - cursor.size > DELTA_READ_CAP_BYTES ? st.size - DELTA_READ_CAP_BYTES : cursor.size);
          const text = await readFileSliceUtf8(rolloutPath, readOffset, st.size - readOffset);
          const lines = text.split("\n");
          if (readOffset > 0 && (isFirst || readOffset !== cursor.size)) lines.shift();

          for (const line of lines) {
            if (!line.trim()) continue;
            let obj;
            try {
              obj = JSON.parse(line);
            } catch {
              continue;
            }
            const payload = obj?.payload || {};
            if (obj?.type !== "event_msg") continue;
            const pType = payload.type;
            if (pType === "task_started") {
              cursor.running = true;
              cursor.turnId = payload.turn_id || cursor.turnId;
            } else if ((pType === "task_complete" || pType === "turn_aborted") && (!cursor.turnId || !payload.turn_id || payload.turn_id === cursor.turnId)) {
              cursor.running = false;
            } else if (!isFirst && !activeRawSet.has(rawId)) {
              if (pType === "token_count") {
                const outTok = Number(payload.info?.last_token_usage?.output_tokens ?? payload.last_token_usage?.output_tokens ?? 0);
                if (outTok > 0) {
                  this.recordExactTokens("codex", compositeId, outTok, nowMs, 2000);
                }
              } else if (pType === "agent_reasoning" || pType === "agent_message") {
                const deltaStr = String(payload.text || payload.delta || payload.message || "");
                if (deltaStr) this.recordStreamDelta("codex", compositeId, deltaStr, nowMs);
              }
            }
          }
          cursor.size = st.size;
          this.#setCursor(cursorKey, cursor);
        } else {
          this.#setCursor(cursorKey, cursor);
        }

        const isRecent = (nowMs - st.mtimeMs) <= CODEX_LIVE_AGE_SEC * 1000;
        if (cursor.running && isRecent && !runningMap.has(rawId)) {
          runningMap.set(rawId, {
            id: compositeId,
            rawId,
            title: sanitizeTelemetryTitle(row.name || row.title, "Codex 任务"),
          });
        }
      }
    }

    return runningMap;
  }

  async #scanClaude(profiles, activeRawSet, nowMs) {
    const runningMap = new Map();
    const seenDirs = new Set();

    const claimedProfileByRawId = new Map();
    const desktopProfiles = profiles.filter((p) => p?.isDesktopInstance);
    await Promise.all(desktopProfiles.map(async (dp) => {
      const meta = await readClaudeDesktopSessionsMeta(dp).catch(() => null);
      for (const cid of meta?.claimedIds || []) {
        if (cid && !claimedProfileByRawId.has(cid)) {
          claimedProfileByRawId.set(cid, dp.id);
        }
      }
    }));

    for (const profile of profiles) {
      const configDir = profile?.cliConfigDir || profile?.home;
      if (!configDir || seenDirs.has(configDir)) continue;
      seenDirs.add(configDir);

      const fallbackProfile = profiles.find(
        (p) => (p?.cliConfigDir || p?.home) === configDir && !p?.isDesktopInstance,
      ) || profile;
      const fallbackProfileId = fallbackProfile.id || "default";

      // Check sessions metadata for explicit running status.
      const sessDir = resolve(configDir, "sessions");
      const sessEntries = await readdir(sessDir, { withFileTypes: true }).catch(() => []);
      for (const entry of sessEntries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const full = join(sessDir, entry.name);
        const st = await stat(full).catch(() => null);
        if (!st?.isFile() || (nowMs - st.mtimeMs) > AGY_LIVE_AGE_MS) continue;
        try {
          const parsed = JSON.parse(await readFile(full, "utf8"));
          const rawId = String(parsed?.sessionId || basename(entry.name, ".json")).trim();
          if (rawId && parsed?.status && parsed.status !== "idle") {
            const ownerProfileId = claimedProfileByRawId.get(rawId) || fallbackProfileId;
            const compositeId = formatCompositeThreadId("claude", ownerProfileId, rawId);
            if (!runningMap.has(rawId)) {
              runningMap.set(rawId, {
                id: compositeId,
                rawId,
                title: sanitizeTelemetryTitle(parsed.name || parsed.title, "Claude 会话"),
              });
            }
          }
        } catch {
          // Ignore unreadable session state json.
        }
      }

      // Check active project JSONLs modified in last 30s for token/s & external CLI runs.
      const projectsDir = resolve(configDir, "projects");
      const slugs = await readdir(projectsDir, { withFileTypes: true }).catch(() => []);
      const recentJsonls = [];
      for (const slug of slugs) {
        if (!slug.isDirectory()) continue;
        const slugPath = join(projectsDir, slug.name);
        const files = await readdir(slugPath, { withFileTypes: true }).catch(() => []);
        for (const f of files) {
          if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
          const full = join(slugPath, f.name);
          const st = await stat(full).catch(() => null);
          if (st?.isFile() && (nowMs - st.mtimeMs) <= 30_000) {
            recentJsonls.push({ full, rawId: basename(f.name, ".jsonl"), st });
          }
        }
      }
      recentJsonls.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);

      for (const { full, rawId, st } of recentJsonls.slice(0, 8)) {
        const ownerProfileId = claimedProfileByRawId.get(rawId) || fallbackProfileId;
        const compositeId = formatCompositeThreadId("claude", ownerProfileId, rawId);
        const cursorKey = `claude:${full}`;
        let cursor = this.#getCursor(cursorKey);
        const isFirst = !cursor || st.size < cursor.size;
        if (isFirst) {
          cursor = { size: 0, title: "", lastAssistantStopReason: null };
        }

        if (st.size > cursor.size) {
          const readOffset = isFirst
            ? Math.max(0, st.size - INITIAL_TAIL_BYTES)
            : (st.size - cursor.size > DELTA_READ_CAP_BYTES ? st.size - DELTA_READ_CAP_BYTES : cursor.size);
          const text = await readFileSliceUtf8(full, readOffset, st.size - readOffset);
          const lines = text.split("\n");
          if (readOffset > 0) lines.shift();

          for (const line of lines) {
            if (!line.trim()) continue;
            let obj;
            try {
              obj = JSON.parse(line);
            } catch {
              continue;
            }
            if (!cursor.title && obj?.type === "user" && typeof obj?.message?.content === "string") {
              cursor.title = sanitizeTelemetryTitle(obj.message.content, "Claude 会话");
            }
            if (obj?.type === "assistant") {
              cursor.lastAssistantStopReason = obj?.message?.stop_reason ?? null;
              if (!activeRawSet.has(rawId)) {
                const outTok = Number(obj?.message?.usage?.output_tokens || 0);
                const msgTs = parseTimeMs(obj.timestamp, st.mtimeMs);
                const recentLine = !isFirst || (nowMs - msgTs) <= RECENT_ACTIVE_SEC * 1000;
                if (recentLine) {
                  if (outTok > 0) {
                    this.recordExactTokens("claude", compositeId, outTok, isFirst ? Math.min(nowMs, st.mtimeMs) : nowMs, 2500);
                  } else if (Array.isArray(obj?.message?.content)) {
                    const txt = obj.message.content.map((c) => c?.text || c?.thinking || "").join("");
                    const est = estimateTextTokens(txt);
                    if (est > 0) {
                      this.recordExactTokens("claude", compositeId, est, isFirst ? Math.min(nowMs, st.mtimeMs) : nowMs, 2500);
                    }
                  }
                }
              }
            } else if (obj?.type === "result") {
              cursor.lastAssistantStopReason = "end_turn";
            }
          }
          cursor.size = st.size;
          this.#setCursor(cursorKey, cursor);
        } else {
          this.#setCursor(cursorKey, cursor);
        }

        const isRecentlyWriting = (nowMs - st.mtimeMs) <= RECENT_ACTIVE_SEC * 1000;
        if ((isRecentlyWriting || cursor.lastAssistantStopReason === "tool_use") && !runningMap.has(rawId)) {
          runningMap.set(rawId, {
            id: compositeId,
            rawId,
            title: cursor.title || "Claude 会话",
          });
        }
      }
    }

    return runningMap;
  }

  async #scanGrok(profiles, activeRawSet, nowMs) {
    const runningMap = new Map();
    const seenHomes = new Set();

    for (const profile of profiles) {
      const grokHome = profile?.home || profile?.grokHome;
      if (!grokHome || seenHomes.has(grokHome)) continue;
      seenHomes.add(grokHome);

      const sessionsRoot = resolve(grokHome, "sessions");
      const projDirs = await readdir(sessionsRoot, { withFileTypes: true }).catch(() => []);
      const candidates = [];

      for (const projDir of projDirs) {
        if (!projDir.isDirectory()) continue;
        const projPath = join(sessionsRoot, projDir.name);
        const sessDirs = await readdir(projPath, { withFileTypes: true }).catch(() => []);
        for (const sDir of sessDirs) {
          if (!sDir.isDirectory()) continue;
          const sPath = join(projPath, sDir.name);
          const usagePath = join(sPath, "usage.json");
          const st = await stat(usagePath).catch(() => null);
          if (st?.isFile() && (nowMs - st.mtimeMs) <= 30_000) {
            candidates.push({ rawId: sDir.name, sPath, usagePath, st });
          }
        }
      }

      candidates.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
      for (const { rawId, sPath, usagePath, st } of candidates.slice(0, 8)) {
        const compositeId = formatCompositeThreadId("grok", profile.id, rawId);
        let parsed = null;
        try {
          parsed = JSON.parse(await readFile(usagePath, "utf8"));
        } catch {
          parsed = null;
        }
        const totalTokens = Number(parsed?.session?.totalTokens || 0);
        const cursorKey = `grok:${usagePath}`;
        const prev = this.#getCursor(cursorKey);
        if (prev && totalTokens > prev.totalTokens && !activeRawSet.has(rawId)) {
          this.recordExactTokens("grok", compositeId, totalTokens - prev.totalTokens, nowMs, 2500);
        }
        let title = prev?.title || "";
        if (!title) {
          try {
            const meta = JSON.parse(await readFile(join(sPath, "meta.json"), "utf8"));
            title = sanitizeTelemetryTitle(meta?.title, "Grok 会话");
          } catch {
            title = "Grok 会话";
          }
        }
        this.#setCursor(cursorKey, { totalTokens, title, size: st.size });

        if ((nowMs - st.mtimeMs) <= RECENT_ACTIVE_SEC * 1000 && !runningMap.has(rawId)) {
          runningMap.set(rawId, {
            id: compositeId,
            rawId,
            title,
          });
        }
      }
    }

    return runningMap;
  }

  async collectSnapshot({
    profiles = [],
    activeTurnsByProvider = {},
    queuedByProvider = {},
    queuedByProfile = {},
  } = {}) {
    const nowMs = this.#nowFn();
    const list = Array.isArray(profiles) ? profiles : [];
    const profilesByProvider = {
      codex: [],
      claude: [],
      antigravity: [],
      grok: [],
    };
    for (const p of list) {
      if (p?.provider && profilesByProvider[p.provider]) {
        profilesByProvider[p.provider].push(p);
      }
    }

    const activeRawByProvider = {};
    for (const provider of PROVIDERS_ORDER) {
      const set = new Set();
      for (const entry of activeTurnsByProvider[provider] || []) {
        if (entry?.rawId) set.add(String(entry.rawId));
        if (entry?.id) {
          const parts = String(entry.id).split(":");
          if (parts.length >= 3) set.add(parts.slice(2).join(":"));
        }
      }
      activeRawByProvider[provider] = set;
    }

    const [codexDisk, claudeDisk, agyDisk, grokDisk] = await Promise.all([
      this.#scanCodex(profilesByProvider.codex, activeRawByProvider.codex, nowMs),
      this.#scanClaude(profilesByProvider.claude, activeRawByProvider.claude, nowMs),
      this.#scanAntigravity(profilesByProvider.antigravity, activeRawByProvider.antigravity, nowMs),
      this.#scanGrok(profilesByProvider.grok, activeRawByProvider.grok, nowMs),
    ]);

    const diskMaps = {
      codex: codexDisk,
      claude: claudeDisk,
      antigravity: agyDisk,
      grok: grokDisk,
    };

    const byProvider = {};
    const mergedThreadsByProvider = {};
    const samplesByProv = {};
    let totalRunning = 0;
    let totalQueued = 0;
    let totalTokPerSec = 0;

    for (const provider of PROVIDERS_ORDER) {
      const mergedMap = new Map();
      for (const entry of activeTurnsByProvider[provider] || []) {
        const key = String(entry.rawId || entry.id || "");
        if (!key) continue;
        mergedMap.set(key, {
          id: String(entry.id || ""),
          title: sanitizeTelemetryTitle(entry.title, `${provider} 会话`),
        });
      }
      for (const [rawId, diskEntry] of diskMaps[provider].entries()) {
        if (!mergedMap.has(rawId)) {
          mergedMap.set(rawId, {
            id: diskEntry.id,
            title: diskEntry.title,
          });
        }
      }

      const allProvThreads = [...mergedMap.values()];
      mergedThreadsByProvider[provider] = allProvThreads;
      const activeThreads = allProvThreads.slice(0, 4);
      const runningCount = mergedMap.size;
      const queuedCount = Math.max(0, Number(queuedByProvider[provider]) || 0);
      const samples = this.#pruneSamples(provider, nowMs);
      samplesByProv[provider] = samples;
      const tokensPerSec = computeSlidingTokensPerSec(samples, nowMs);

      totalRunning += runningCount;
      totalQueued += queuedCount;
      totalTokPerSec += tokensPerSec;

      byProvider[provider] = {
        provider,
        runningCount,
        queuedCount,
        tokensPerSec,
        activeThreads,
      };
    }

    const byProfile = {};
    for (const p of list) {
      if (!p?.provider || !p?.id) continue;
      const pKey = p.key || formatProfileKey(p.provider, p.id);
      const prefix = `${pKey}:`;
      const provThreads = mergedThreadsByProvider[p.provider] || [];
      const profThreads = provThreads.filter((t) => String(t?.id || "").startsWith(prefix));
      const provSamples = samplesByProv[p.provider] || [];
      const profSamples = provSamples.filter((s) => String(s?.threadId || "").startsWith(prefix));
      const profTps = computeSlidingTokensPerSec(profSamples, nowMs);
      const profQueued = Math.max(0, Number(queuedByProfile[pKey]) || 0);
      byProfile[pKey] = {
        key: pKey,
        provider: p.provider,
        profileId: p.id,
        runningCount: profThreads.length,
        queuedCount: profQueued,
        tokensPerSec: profTps,
        activeThreads: profThreads.slice(0, 4),
      };
    }

    return {
      updatedAt: Math.floor(nowMs / 1000),
      totals: {
        runningCount: totalRunning,
        queuedCount: totalQueued,
        tokensPerSec: Math.round(totalTokPerSec * 10) / 10,
      },
      byProvider,
      byProfile,
    };
  }
}
