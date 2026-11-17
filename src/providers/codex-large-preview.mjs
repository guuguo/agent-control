import { open } from "node:fs/promises";
import {
  collapseSilentHeartbeatTurns,
  normalizeCodexAgentMessageItem,
  normalizeCodexUserMessageItem,
} from "../codex-input-clean.mjs";

const DEFAULT_TAIL_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_SCAN_BYTES = 64 * 1024 * 1024;
const FALLBACK_NO_TURN_MAX_SCAN_BYTES = 256 * 1024 * 1024;
const LARGE_PREVIEW_CACHE_MAX = 64;
const CURSOR_PREFIX = "tail:";
const DUPLICATE_MESSAGE_WINDOW_MS = 2_000;
const BUF_TYPE_EVENT_MSG = Buffer.from('"type":"event_msg"');
const BUF_TYPE_RESPONSE_ITEM = Buffer.from('"type":"response_item"');
const BUF_PAYLOAD_MESSAGE = Buffer.from('"payload":{"type":"message"');
const BUF_TYPE_TURN_CONTEXT = Buffer.from('"type":"turn_context"');
const largePreviewCache = new Map();
const PREVIEW_EVENT_TYPES = new Set([
  "task_started",
  "task_complete",
  "turn_aborted",
  "user_message",
  "agent_message",
]);

function previewRecordType(record) {
  const payload = record?.payload || {};
  if (record?.type === "event_msg") {
    if (PREVIEW_EVENT_TYPES.has(payload.type)) return payload.type;
    if (payload.type === "item_completed") {
      if (payload.item?.type === "UserMessage") return "item_user_message";
      if (payload.item?.type === "AgentMessage") return "item_agent_message";
    }
  }
  if (record?.type === "response_item" && payload.type === "message") {
    if (payload.role === "user") return "response_user_message";
    if (payload.role === "assistant") return "response_agent_message";
  }
  if (record?.type === "turn_context") return "turn_context";
  return "";
}

function responseMessageText(payload) {
  return (Array.isArray(payload?.content) ? payload.content : [])
    .filter((item) => ["input_text", "output_text", "text"].includes(item?.type) && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function userItemImagePathCount(item) {
  return (Array.isArray(item?.content) ? item.content : [])
    .filter((part) => part?.type === "localImage" && part.path)
    .length;
}

function previewMessageIdentity(item) {
  if (item?.type === "userMessage") {
    const content = Array.isArray(item.content) ? item.content : [];
    const text = content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n");
    const replies = Array.isArray(item.questionReplies)
      ? item.questionReplies.map((r) => `${r.question || ""}:${r.answer || ""}`).join("|")
      : "";
    const goal = item.goalContext?.objective || "";
    if (text || replies || goal) {
      return `user\n${text}\n${replies}${goal ? `\ngoal\n${goal}` : ""}`.trim();
    }
    const imgKey = content
      .map((part) => part?.path || part?.url || part?.name || "")
      .filter(Boolean)
      .join("\n");
    return `user-img\n${imgKey}`;
  }
  return item?.type === "agentMessage" ? `agent\n${String(item.text || "").trim()}` : "";
}

function previewMessageSource(type) {
  return type.startsWith("response_") ? "response" : "event";
}

function sameRecordedMessage(previous, candidate) {
  return previous
    && (previous.source !== candidate.source || previous.recordType !== candidate.recordType)
    && previous.identity
    && previous.identity === candidate.identity
    && Number.isFinite(previous.timestamp)
    && Number.isFinite(candidate.timestamp)
    && Math.abs(previous.timestamp - candidate.timestamp) <= DUPLICATE_MESSAGE_WINDOW_MS;
}

function isInjectedUserContext(text) {
  return /^(?:# AGENTS\.md instructions\b|<environment_context\b|<recommended_plugins\b|<skills_instructions\b|<permissions instructions\b|<collaboration_mode\b|<multi_agent_|<external_codex_apps_|<codex_apps_)/i.test(
    String(text || "").trimStart(),
  );
}

export function encodeTailCursor(offset) {
  return `${CURSOR_PREFIX}${Math.max(0, Number(offset) || 0)}`;
}

export function decodeTailCursor(cursor) {
  if (!String(cursor || "").startsWith(CURSOR_PREFIX)) return null;
  const offset = Number(String(cursor).slice(CURSOR_PREFIX.length));
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : null;
}

function timestampSeconds(record, fallback = null) {
  const value = Date.parse(record?.timestamp || "");
  return Number.isFinite(value) ? Math.floor(value / 1000) : fallback;
}

function previewItem(turn, record, sequence, { automationNames = null } = {}) {
  const payload = record.payload || {};
  const type = previewRecordType(record);
  const id = payload.id || payload.item?.id || `tail-${turn.id}-${sequence}`;
  if (type === "item_user_message") {
    return normalizeCodexUserMessageItem({
      type: "userMessage",
      id,
      clientId: payload.client_id || null,
      content: Array.isArray(payload.item?.content) ? payload.item.content : [],
    }, { automationNames });
  }
  if (type === "user_message" || type === "response_user_message") {
    const rawContent = [];
    if (type === "response_user_message") {
      if (Array.isArray(payload.content)) rawContent.push(...payload.content);
    } else {
      for (const localPath of Array.isArray(payload.local_images) ? payload.local_images : []) {
        if (typeof localPath === "string" && localPath.trim()) {
          rawContent.push({ type: "local_image", path: localPath.trim() });
        } else if (localPath && typeof localPath === "object" && localPath.path) {
          rawContent.push({ type: "local_image", path: String(localPath.path) });
        }
      }
      for (const imgUrl of Array.isArray(payload.images) ? payload.images : []) {
        if (typeof imgUrl === "string" && imgUrl.trim()) {
          rawContent.push({ type: "image", url: imgUrl.trim() });
        } else if (imgUrl && typeof imgUrl === "object") {
          rawContent.push({ type: "image", ...(imgUrl.path ? { path: imgUrl.path } : { url: imgUrl.url || imgUrl.image_url || "" }) });
        }
      }
      rawContent.push({
        type: "text",
        text: payload.message || "",
        text_elements: payload.text_elements || [],
      });
    }
    return normalizeCodexUserMessageItem({
      type: "userMessage",
      id,
      clientId: payload.client_id || null,
      content: rawContent,
    }, { automationNames });
  }
  if (type === "item_agent_message") {
    const item = payload.item || {};
    const text = (Array.isArray(item.content) ? item.content : [])
      .filter((c) => typeof c?.text === "string")
      .map((c) => c.text)
      .join("\n");
    return normalizeCodexAgentMessageItem({
      type: "agentMessage",
      id,
      text,
      phase: item.phase || payload.phase || null,
      memoryCitation: item.memory_citation || payload.memory_citation || null,
    }, { automationNames });
  }
  return normalizeCodexAgentMessageItem({
    type: "agentMessage",
    id,
    text: type === "response_agent_message" ? responseMessageText(payload) : payload.message || "",
    phase: payload.phase || null,
    memoryCitation: payload.memory_citation || null,
  }, { automationNames });
}

function extractUserItemPlainText(item) {
  return (Array.isArray(item?.content) ? item.content : [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function isMessageRecordType(type) {
  return [
    "user_message",
    "agent_message",
    "response_user_message",
    "response_agent_message",
    "item_user_message",
    "item_agent_message",
  ].includes(type);
}

function previewTurns(records, limit, { automationNames = null } = {}) {
  const turns = [];
  const turnById = new Map();
  let current = null;
  let pendingTurnCtx = null;
  let previousMessage = null;
  let sequence = 0;
  for (const { record, offset } of records) {
    const payload = record.payload || {};
    const type = previewRecordType(record);
    if (type === "turn_context") {
      const targetId = String(payload.turn_id || "").trim();
      const targetTurn = targetId ? (turnById.get(targetId) || (current?.id === targetId ? current : null)) : current;
      const ctxModel = String(payload.model || "").trim();
      const ctxEffort = String(payload.effort || payload.reasoning_effort || "").trim().toLowerCase();
      if (targetTurn) {
        if (ctxModel) targetTurn.model = ctxModel;
        if (ctxEffort) targetTurn.effort = ctxEffort;
      } else if (targetId) {
        pendingTurnCtx = { turnId: targetId, model: ctxModel, effort: ctxEffort };
      }
      continue;
    }
    if (type === "task_started" && payload.turn_id) {
      const matchedCtx = pendingTurnCtx?.turnId === payload.turn_id ? pendingTurnCtx : null;
      pendingTurnCtx = null;
      current = {
        id: payload.turn_id,
        items: [],
        itemsView: "summary",
        status: "inProgress",
        error: null,
        startedAt: payload.started_at || timestampSeconds(record),
        completedAt: null,
        durationMs: null,
        ...(matchedCtx?.model ? { model: matchedCtx.model } : {}),
        ...(matchedCtx?.effort ? { effort: matchedCtx.effort } : {}),
        _offset: offset,
      };
      turns.push(current);
      turnById.set(current.id, current);
      previousMessage = null;
      sequence = 0;
      continue;
    }
    if (!current) continue;
    if (isMessageRecordType(type)) {
      const item = previewItem(current, record, sequence, { automationNames });
      const userPlainText = item.type === "userMessage" ? extractUserItemPlainText(item) : "";
      if (item.type !== "userMessage" || !isInjectedUserContext(userPlainText)) {
        const candidate = {
          identity: previewMessageIdentity(item),
          source: previewMessageSource(type),
          recordType: type,
          pathCount: item.type === "userMessage" ? userItemImagePathCount(item) : 0,
          timestamp: Date.parse(record.timestamp || ""),
        };
        if (sameRecordedMessage(previousMessage, candidate)) {
          const shouldReplace = item.type === "userMessage"
            ? (candidate.pathCount > previousMessage.pathCount || (candidate.pathCount === previousMessage.pathCount && candidate.recordType === "item_user_message"))
            : (candidate.source === "response" || candidate.recordType === "item_agent_message");
          if (shouldReplace) {
            current.items[previousMessage.index] = item;
            previousMessage = { ...candidate, index: previousMessage.index };
          }
        } else {
          current.items.push(item);
          previousMessage = { ...candidate, index: current.items.length - 1 };
        }
      }
      sequence += 1;
    } else if (type === "task_complete" && payload.turn_id === current.id) {
      current.status = "completed";
      current.completedAt = payload.completed_at || timestampSeconds(record);
      current.durationMs = payload.duration_ms || null;
    } else if (type === "turn_aborted" && (!payload.turn_id || payload.turn_id === current.id)) {
      current.status = "interrupted";
      current.completedAt = timestampSeconds(record);
    }
  }
  return collapseSilentHeartbeatTurns(turns).slice(-Math.max(1, Number(limit) || 1));
}

function automationCacheSig(automationNames) {
  if (!(automationNames instanceof Map) || !automationNames.size) return "";
  return [...automationNames.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .join("|");
}

function getCachedLargePreview(cacheKey, mtimeMs, size) {
  const entry = largePreviewCache.get(cacheKey);
  if (!entry) return null;
  if (entry.mtimeMs !== mtimeMs || entry.size !== size) {
    largePreviewCache.delete(cacheKey);
    return null;
  }
  // Refresh insertion order for LRU eviction.
  largePreviewCache.delete(cacheKey);
  largePreviewCache.set(cacheKey, entry);
  return {
    turns: structuredClone(entry.result.turns),
    nextCursor: entry.result.nextCursor,
  };
}

function setCachedLargePreview(cacheKey, mtimeMs, size, result) {
  if (largePreviewCache.has(cacheKey)) {
    largePreviewCache.delete(cacheKey);
  }
  largePreviewCache.set(cacheKey, {
    mtimeMs,
    size,
    result: {
      turns: structuredClone(result.turns),
      nextCursor: result.nextCursor,
    },
  });
  while (largePreviewCache.size > LARGE_PREVIEW_CACHE_MAX) {
    const oldestKey = largePreviewCache.keys().next().value;
    if (oldestKey === undefined) break;
    largePreviewCache.delete(oldestKey);
  }
}

export async function readLargeThreadPreview(path, {
  endOffset = null,
  limit = 12,
  maxBytes = DEFAULT_TAIL_BYTES,
  maxScanBytes = null,
  automationNames = null,
} = {}) {
  const chunkBytes = Math.max(1024, Number(maxBytes) || DEFAULT_TAIL_BYTES);
  const explicitMaxScan = Number(maxScanBytes);
  const hasExplicitMaxScan = Number.isFinite(explicitMaxScan) && explicitMaxScan > 0;
  const baseScanLimit = hasExplicitMaxScan
    ? explicitMaxScan
    : Math.max(DEFAULT_MAX_SCAN_BYTES, chunkBytes * 4);
  const extendedScanLimit = hasExplicitMaxScan
    ? baseScanLimit
    : Math.max(baseScanLimit, FALLBACK_NO_TURN_MAX_SCAN_BYTES);

  const file = await open(path, "r");
  try {
    const fileStat = await file.stat();
    const size = fileStat.size;
    const end = Number.isSafeInteger(endOffset) ? Math.min(Math.max(0, endOffset), size) : size;
    const cacheKey = `${path}\0${end}\0${limit}\0${chunkBytes}\0${baseScanLimit}\0${automationCacheSig(automationNames)}`;
    const cached = getCachedLargePreview(cacheKey, fileStat.mtimeMs, size);
    if (cached) return cached;

    const chunks = [];
    let scanEnd = end;
    let scanned = 0;
    let taskStartedCount = 0;
    let totalMatchedRecords = 0;

    while (scanEnd > 0) {
      const activeLimit = taskStartedCount === 0 && totalMatchedRecords > 0
        ? extendedScanLimit
        : baseScanLimit;
      if (scanned >= activeLimit) break;

      const start = Math.max(0, scanEnd - Math.min(chunkBytes, activeLimit - scanned));
      const buffer = Buffer.allocUnsafe(scanEnd - start);
      if (buffer.length) await file.read(buffer, 0, buffer.length, start);
      scanned += buffer.length;

      const firstNewline = start > 0 ? buffer.indexOf(0x0a) : -1;
      if (start > 0 && firstNewline < 0) {
        // Chunk sits entirely inside a single oversized line; step back without UTF-8 allocation.
        scanEnd = start;
        continue;
      }
      let position = start > 0 ? firstNewline + 1 : 0;
      const olderBoundary = start + position;
      const chunkRecords = [];
      while (position < buffer.length) {
        const newline = buffer.indexOf(0x0a, position);
        if (newline < 0) break;
        const offset = start + position;
        const lineBuf = buffer.subarray(position, newline);
        position = newline + 1;

        const mayBeEvent = lineBuf.includes(BUF_TYPE_EVENT_MSG);
        const mayBeMessage = lineBuf.includes(BUF_TYPE_RESPONSE_ITEM)
          && lineBuf.includes(BUF_PAYLOAD_MESSAGE);
        const mayBeTurnCtx = lineBuf.includes(BUF_TYPE_TURN_CONTEXT);
        if (!mayBeEvent && !mayBeMessage && !mayBeTurnCtx) continue;

        const line = lineBuf.toString("utf8");
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        const recType = previewRecordType(record);
        if (recType) {
          chunkRecords.push({ record, offset });
          totalMatchedRecords += 1;
          if (recType === "task_started") {
            taskStartedCount += 1;
          }
        }
      }
      if (chunkRecords.length) {
        chunks.push(chunkRecords);
      }
      if (start === 0) break;
      if (taskStartedCount >= limit) {
        const ordered = [];
        for (let i = chunks.length - 1; i >= 0; i -= 1) {
          ordered.push(...chunks[i]);
        }
        const collapsedCount = previewTurns(ordered, limit * 8, { automationNames }).length;
        if (collapsedCount >= limit) break;
      }
      scanEnd = olderBoundary > start && olderBoundary < scanEnd ? olderBoundary : start;
    }

    const records = [];
    for (let i = chunks.length - 1; i >= 0; i -= 1) {
      records.push(...chunks[i]);
    }
    const selected = previewTurns(records, limit, { automationNames });
    const nextOffset = selected[0]?._offset ?? scanEnd;
    const turns = selected.map(({ _offset, ...turn }) => turn);
    const result = {
      turns,
      nextCursor: nextOffset > 0 ? encodeTailCursor(nextOffset) : null,
    };
    setCachedLargePreview(cacheKey, fileStat.mtimeMs, size, result);
    return result;
  } finally {
    await file.close();
  }
}
