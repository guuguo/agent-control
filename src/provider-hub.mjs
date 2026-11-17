import { open, realpath, stat } from "node:fs/promises";
import os from "node:os";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import {
  formatCompositeThreadId,
  formatProfileKey,
  parseCompositeThreadId,
  PROVIDER_LABELS,
  PROVIDERS,
} from "./composite-id.mjs";
import {
  ALLOWED_PREVIEW_IMAGE_MIMES,
  findWorkspaceFileByBasename,
  hasValidImageMagic,
  isBlockedPreviewFile,
  splitFilePathAndAnchor,
} from "./file-preview.mjs";
import { createGoalController, GOAL_COMPLETE_MARKER } from "./goal-controller.mjs";
import { createInflightTurnStore, inflightTurnsPath } from "./inflight-turns.mjs";
import { ExecutionStats } from "./execution-stats.mjs";
import { ForkStore, buildForkContextPrompt, stripForkContextPrefix } from "./fork-store.mjs";
import { isInternalVoiceCallThread } from "./thread-access.mjs";
import { defaultDataDir } from "./instance-identity.mjs";
import { CliMaintenanceManager } from "./providers/cli-maintenance.mjs";
import { QoderProvider } from "./providers/qoder-provider.mjs";
import { isTurboPermissionMode, normalizePermissionMode } from "./permissions.mjs";
import { isSubpathOrEqual, isUserHomePath, resolveUserHome } from "./platform.mjs";
import {
  classifyProfileError,
  isIgnorableTurnError,
  normalizeProfileHealth,
  sortProfilesByHealth,
} from "./profile-health.mjs";
import {
  computeMultiProfileSignature,
  isAutoAliasUpgradeCandidate,
  resolveAutoProfileAliases,
  suggestFallbackDistinctAliases,
} from "./profile-auto-alias.mjs";
import { createQueuedTurnQueue, queuedTurnsPath } from "./queued-turns.mjs";
import { createThreadMetaStore, threadMetaPath } from "./thread-meta-store.mjs";
import { stripPromptNoise } from "./thread-display.mjs";
import {
  extractTouchedPathsFromTurns,
  extractUserPromptsFromTurns,
  isLowQualityTitle,
  resolveAdaptiveThreadTitle,
  threadTitleSourceSig,
  TITLE_SCHEMA_VERSION,
} from "./thread-title.mjs";
import { goalStatePath } from "./goal-controller.mjs";
import { AntigravityProvider } from "./providers/antigravity-provider.mjs";
import { ClaudeProvider } from "./providers/claude-provider.mjs";
import { CodexProvider } from "./providers/codex-provider.mjs";
import { GrokProvider } from "./providers/grok-provider.mjs";
import { QuotaService } from "./quota-service.mjs";
import { AgentTelemetryService } from "./telemetry-service.mjs";
import { isRecoverableToolExecutionError } from "./tool-errors.mjs";

function extractLastAgentMessageFromCodexParams(params) {
  if (typeof params?.turn?.lastAgentMessage === "string") return params.turn.lastAgentMessage;
  const items = Array.isArray(params?.turn?.items) ? params.turn.items : [];
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i]?.type === "agentMessage" && items[i].text) return items[i].text;
  }
  return "";
}

const DEFAULT_SSE_INLINE_DATA_CHARS = 24 * 1024;
const DEFAULT_THREAD_SINGLE_IMAGE_CHARS = 2_200_000;
const DEFAULT_THREAD_TOTAL_IMAGE_CHARS = 4_200_000;
const DEFAULT_THREAD_TOOL_TEXT_CHARS = 24 * 1024;
const MAX_PREVIEW_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_PREVIEW_OUTPUT_FILE_BYTES = 80 * 1024 * 1024;

function extractFileRefsFromMarkdownText(text = "") {
  const refs = [];
  const raw = String(text || "");
  if (!raw) return refs;

  const linkRe = /!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|((?:\([^()\s]*\)|[^()\n])+?))(?:\s+"[^"\n]*")?\s*\)/g;
  let m;
  while ((m = linkRe.exec(raw)) !== null) {
    const target = String(m[1] || m[2] || "").trim();
    if (target && !/^(?:https?:|mailto:|data:|#)/i.test(target)) {
      refs.push(target);
    }
  }

  const codeRe = /`([^`\n]{2,400})`/g;
  while ((m = codeRe.exec(raw)) !== null) {
    const inner = String(m[1] || "").trim();
    if (!inner || /[\s;&|><$]/.test(inner)) continue;
    if (inner.includes("/") || inner.includes("\\") || /\.[a-z0-9]{1,8}(?:[:#].*)?$/i.test(inner)) {
      refs.push(inner);
    }
  }
  return refs;
}

export function summarizeQueuedTurnEntry(entry) {
  if (!entry || typeof entry !== "object") return entry;
  const rawImages = Array.isArray(entry.images) ? entry.images : [];
  const cleanImages = rawImages
    .filter(Boolean)
    .map((img, idx) => ({
      name: (typeof img === "object" && img.name) ? String(img.name) : `图片${idx + 1}`,
      omitted: true,
    }));
  const source = entry.source || "control";
  const summary = {
    id: entry.id,
    threadId: entry.threadId,
    createdAt: entry.createdAt,
    text: String(entry.text || ""),
    model: entry.model || "",
    effort: entry.effort || "",
    permissionMode: entry.permissionMode || (source === "control" ? "workspace" : ""),
    goalMode: Boolean(entry.goalMode),
    imageCount: cleanImages.length,
    images: cleanImages,
    source,
    sourceLabel: entry.sourceLabel || "控制端队列",
    canCancel: entry.canCancel !== undefined ? Boolean(entry.canCancel) : source === "control",
  };
  if (entry.position !== undefined) summary.position = entry.position;
  const blockedReason = String(entry.lastRetryError || entry.blockedReason || "").trim();
  if (blockedReason) summary.blockedReason = blockedReason;
  return summary;
}

function mergeQueuedTurnLists(nativeItems = [], controlItems = []) {
  const merged = [
    ...(Array.isArray(nativeItems) ? nativeItems : []).map((item) => summarizeQueuedTurnEntry({
      ...item,
      source: item.source || "native",
      canCancel: false,
    })),
    ...(Array.isArray(controlItems) ? controlItems : []).map((item) => summarizeQueuedTurnEntry({
      ...item,
      source: item.source || "control",
      sourceLabel: item.sourceLabel || (item.source === "resume" ? "断点优先恢复" : "控制端队列"),
      canCancel: true,
    })),
  ];
  return merged.map((item, idx) => ({ ...item, position: idx + 1 }));
}

function inlineImagePayloadString(part) {
  if (!part || typeof part !== "object") return "";
  if (typeof part.url === "string" && /^data:image\//i.test(part.url)) return part.url;
  if (typeof part.image_url === "string" && /^data:image\//i.test(part.image_url)) return part.image_url;
  if (typeof part.image_url?.url === "string" && /^data:image\//i.test(part.image_url.url)) return part.image_url.url;
  if (typeof part.data === "string" && /^data:image\//i.test(part.data)) return part.data;
  return "";
}

function truncateSseText(str, maxChars) {
  if (typeof str !== "string" || str.length <= maxChars) return str;
  const cleaned = str.replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]{256,}/gi, "[图片Base64已省略]");
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars)}…[已省略 ${cleaned.length - maxChars} 字符]`;
}

function sanitizeImagePartForSse(part, maxInlineDataChars) {
  if (!part || typeof part !== "object") return part;
  const inlineUrl = inlineImagePayloadString(part);
  if (inlineUrl && inlineUrl.length > maxInlineDataChars) {
    return { type: "image", path: "[图片] 附件图片" };
  }
  if (part.source?.type === "base64" && typeof part.source.data === "string" && part.source.data.length > maxInlineDataChars) {
    return { type: "image", path: "[图片] 附件图片" };
  }
  if ((part.type === "image" || part.type === "input_image" || part.type === "image_url")
    && typeof part.data === "string" && part.data.length > maxInlineDataChars) {
    return { type: "image", path: "[图片] 附件图片" };
  }
  return part;
}

function sanitizePartListForSse(parts, maxInlineDataChars, { truncateText = false } = {}) {
  if (!Array.isArray(parts) || !parts.length) return parts;
  let contentChanged = false;
  const mapped = parts.map((part) => {
    const cleanImg = sanitizeImagePartForSse(part, maxInlineDataChars);
    if (cleanImg !== part) {
      contentChanged = true;
      return cleanImg;
    }
    if (truncateText && part && typeof part === "object") {
      if (typeof part.text === "string" && part.text.length > maxInlineDataChars) {
        contentChanged = true;
        return { ...part, text: truncateSseText(part.text, maxInlineDataChars) };
      }
      if (typeof part.content === "string" && part.content.length > maxInlineDataChars) {
        contentChanged = true;
        return { ...part, content: truncateSseText(part.content, maxInlineDataChars) };
      }
    }
    return part;
  });
  return contentChanged ? mapped : parts;
}

function sanitizeItemForSse(item, maxInlineDataChars) {
  if (!item || typeof item !== "object") return item;
  const directClean = sanitizeImagePartForSse(item, maxInlineDataChars);
  if (directClean !== item) return directClean;

  const isAgentMsg = item.type === "agentMessage";
  let next = null;
  const ensureCopy = () => {
    if (!next) next = { ...item };
    return next;
  };

  if (Array.isArray(item.content)) {
    const mapped = sanitizePartListForSse(item.content, maxInlineDataChars, { truncateText: !isAgentMsg });
    if (mapped !== item.content) {
      ensureCopy().content = mapped;
    }
  } else if (!isAgentMsg && typeof item.content === "string" && item.content.length > maxInlineDataChars) {
    ensureCopy().content = truncateSseText(item.content, maxInlineDataChars);
  }

  if (item.result && typeof item.result === "object") {
    let nextResult = null;
    const ensureResult = () => {
      if (!nextResult) nextResult = { ...item.result };
      return nextResult;
    };
    if (Array.isArray(item.result.content)) {
      const mappedRes = sanitizePartListForSse(item.result.content, maxInlineDataChars, { truncateText: !isAgentMsg });
      if (mappedRes !== item.result.content) {
        ensureResult().content = mappedRes;
      }
    }
    if (!isAgentMsg && typeof item.result.output === "string" && item.result.output.length > maxInlineDataChars) {
      ensureResult().output = truncateSseText(item.result.output, maxInlineDataChars);
    }
    if (nextResult) {
      ensureCopy().result = nextResult;
    }
  }

  if (!isAgentMsg && typeof item.aggregatedOutput === "string" && item.aggregatedOutput.length > maxInlineDataChars) {
    ensureCopy().aggregatedOutput = truncateSseText(item.aggregatedOutput, maxInlineDataChars);
  }
  if (!isAgentMsg && typeof item.output === "string" && item.output.length > maxInlineDataChars) {
    ensureCopy().output = truncateSseText(item.output, maxInlineDataChars);
  }

  return next || item;
}

function sanitizeItemsListForSse(items, maxInlineDataChars) {
  if (!Array.isArray(items) || !items.length) return items;
  let changed = false;
  const next = items.map((item) => {
    const clean = sanitizeItemForSse(item, maxInlineDataChars);
    if (clean !== item) changed = true;
    return clean;
  });
  return changed ? next : items;
}

export function sanitizeEventForSse(event, data, { maxInlineDataChars = DEFAULT_SSE_INLINE_DATA_CHARS } = {}) {
  if (!data || typeof data !== "object") return data;
  if (event === "queued_turn_event") {
    return {
      ...data,
      entry: summarizeQueuedTurnEntry(data.entry),
      queuedTurns: Array.isArray(data.queuedTurns) ? data.queuedTurns.map(summarizeQueuedTurnEntry) : [],
    };
  }
  if (event !== "provider_event") return data;

  let next = null;
  const ensureCopy = () => {
    if (!next) next = { ...data };
    return next;
  };

  if (data.type === "acp_tool_update" && data.update && typeof data.update === "object") {
    const u = data.update;
    const rawStatus = u.status !== undefined && u.status !== null ? String(u.status) : "";
    ensureCopy().update = {
      ...(u.sessionUpdate ? { sessionUpdate: u.sessionUpdate } : {}),
      ...(u.toolCallId ? { toolCallId: u.toolCallId } : {}),
      ...(u.id ? { id: u.id } : {}),
      ...(u.title ? { title: u.title } : {}),
      ...(u.kind ? { kind: u.kind } : {}),
      ...(rawStatus ? { status: rawStatus.length > 600 ? `${rawStatus.slice(0, 600)}…` : rawStatus } : {}),
    };
  }
  if (data.type === "tool_result" && data.toolResult && typeof data.toolResult === "object") {
    const cleanResult = sanitizeItemForSse(data.toolResult, maxInlineDataChars);
    if (cleanResult !== data.toolResult) {
      ensureCopy().toolResult = cleanResult;
    }
  }
  if (
    data.type === "tool_use"
    && data.toolUse
    && typeof data.toolUse === "object"
    && data.toolUse.input
    && typeof data.toolUse.input === "object"
    && !Array.isArray(data.toolUse.input)
  ) {
    let inputChanged = false;
    const nextInput = { ...data.toolUse.input };
    for (const [k, v] of Object.entries(nextInput)) {
      if (typeof v === "string" && v.length > maxInlineDataChars) {
        nextInput[k] = truncateSseText(v, maxInlineDataChars);
        inputChanged = true;
      }
    }
    if (inputChanged) {
      ensureCopy().toolUse = { ...data.toolUse, input: nextInput };
    }
  }

  if (data.turn && Array.isArray(data.turn.items)) {
    const cleanItems = sanitizeItemsListForSse(data.turn.items, maxInlineDataChars);
    if (cleanItems !== data.turn.items) {
      ensureCopy().turn = { ...data.turn, items: cleanItems };
    }
  }
  if (Array.isArray(data.items)) {
    const cleanItems = sanitizeItemsListForSse(data.items, maxInlineDataChars);
    if (cleanItems !== data.items) {
      ensureCopy().items = cleanItems;
    }
  }
  if (data.item) {
    const cleanItem = sanitizeItemForSse(data.item, maxInlineDataChars);
    if (cleanItem !== data.item) {
      ensureCopy().item = cleanItem;
    }
  }
  if (data.params && typeof data.params === "object") {
    let nextParams = null;
    const ensureParams = () => {
      if (!nextParams) nextParams = { ...data.params };
      return nextParams;
    };
    if (data.params.turn && Array.isArray(data.params.turn.items)) {
      const cleanItems = sanitizeItemsListForSse(data.params.turn.items, maxInlineDataChars);
      if (cleanItems !== data.params.turn.items) {
        ensureParams().turn = { ...data.params.turn, items: cleanItems };
      }
    }
    if (data.params.item) {
      const cleanItem = sanitizeItemForSse(data.params.item, maxInlineDataChars);
      if (cleanItem !== data.params.item) {
        ensureParams().item = cleanItem;
      }
    }
    if (data.params.msg && Array.isArray(data.params.msg.images)) {
      const hasLargeImg = data.params.msg.images.some(
        (img) => typeof img === "string" && img.length > maxInlineDataChars,
      );
      if (hasLargeImg) {
        ensureParams().msg = {
          ...data.params.msg,
          images: data.params.msg.images.map((img) => (
            typeof img === "string" && img.length > maxInlineDataChars ? "[图片]" : img
          )),
        };
      }
    }
    if (nextParams) {
      ensureCopy().params = nextParams;
    }
  }
  return next || data;
}

function inlinePartPayloadLength(part) {
  if (!part || typeof part !== "object") return 0;
  const inlineUrl = inlineImagePayloadString(part);
  if (inlineUrl) return inlineUrl.length;
  if (part.source?.type === "base64" && typeof part.source.data === "string") {
    return part.source.data.length;
  }
  if ((part.type === "image" || part.type === "input_image" || part.type === "image_url")
    && typeof part.data === "string") {
    return part.data.length;
  }
  return 0;
}

export function capOversizedThreadInlineImages(thread, {
  maxSingleDataUrlChars = DEFAULT_THREAD_SINGLE_IMAGE_CHARS,
  maxTotalDataUrlChars = DEFAULT_THREAD_TOTAL_IMAGE_CHARS,
} = {}) {
  if (!thread || typeof thread !== "object" || !Array.isArray(thread.turns) || !thread.turns.length) {
    return thread;
  }
  let totalChars = 0;
  let turnsChanged = false;
  const nextTurns = [...thread.turns];

  const capPartArray = (parts) => {
    if (!Array.isArray(parts) || !parts.length) return { changed: false, parts };
    let changed = false;
    const nextParts = [...parts];
    for (let cIdx = nextParts.length - 1; cIdx >= 0; cIdx -= 1) {
      const payloadLen = inlinePartPayloadLength(nextParts[cIdx]);
      if (!payloadLen) continue;
      if (payloadLen > maxSingleDataUrlChars || totalChars + payloadLen > maxTotalDataUrlChars) {
        nextParts[cIdx] = { type: "image", path: "[图片] 历史大图（已省略原图防卡顿）" };
        changed = true;
      } else {
        totalChars += payloadLen;
      }
    }
    return { changed, parts: changed ? nextParts : parts };
  };

  for (let tIdx = nextTurns.length - 1; tIdx >= 0; tIdx -= 1) {
    const turn = nextTurns[tIdx];
    if (!turn || !Array.isArray(turn.items) || !turn.items.length) continue;
    let itemsChanged = false;
    const nextItems = [...turn.items];

    for (let iIdx = nextItems.length - 1; iIdx >= 0; iIdx -= 1) {
      const item = nextItems[iIdx];
      if (!item || typeof item !== "object") continue;

      let nextItem = null;
      if (item.result && typeof item.result === "object" && Array.isArray(item.result.content)) {
        const resCapped = capPartArray(item.result.content);
        if (resCapped.changed) {
          nextItem = { ...item, result: { ...item.result, content: resCapped.parts } };
        }
      }
      if (Array.isArray(item.content)) {
        const contentCapped = capPartArray(item.content);
        if (contentCapped.changed) {
          nextItem = { ...(nextItem || item), content: contentCapped.parts };
        }
      }

      if (nextItem) {
        nextItems[iIdx] = nextItem;
        itemsChanged = true;
      }
    }

    if (itemsChanged) {
      nextTurns[tIdx] = { ...turn, items: nextItems };
      turnsChanged = true;
    }
  }

  return turnsChanged ? { ...thread, turns: nextTurns } : thread;
}

function truncateToolTextForRead(str, maxChars) {
  if (typeof str !== "string" || str.length <= maxChars) return str;
  const cleaned = str
    .replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]{256,}/gi, "[图片Base64已省略]")
    .replace(/"data"\s*:\s*"[A-Za-z0-9+/=\s]{4096,}"/g, '"data":"[Base64已省略]"');
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars)}…[已省略 ${cleaned.length - maxChars} 字符]`;
}

/**
 * Cap oversized tool-call payloads on initial/summary thread reads (detail !== "full")
 * so megabyte-scale MCP/command outputs or JSON-wrapped base64 images don't bloat /api/thread.
 */
export function capOversizedThreadToolOutputs(thread, {
  maxToolTextChars = DEFAULT_THREAD_TOOL_TEXT_CHARS,
} = {}) {
  if (!thread || typeof thread !== "object" || !Array.isArray(thread.turns) || !thread.turns.length) {
    return thread;
  }
  let turnsChanged = false;
  const nextTurns = thread.turns.map((turn) => {
    if (!turn || !Array.isArray(turn.items) || !turn.items.length) return turn;
    let itemsChanged = false;
    const nextItems = turn.items.map((item) => {
      if (!item || typeof item !== "object") return item;
      if (item.type !== "mcpToolCall" && item.type !== "commandExecution" && item.type !== "fileChange") {
        return item;
      }
      let nextItem = null;
      const ensureItem = () => {
        if (!nextItem) nextItem = { ...item };
        return nextItem;
      };
      if (typeof item.aggregatedOutput === "string" && item.aggregatedOutput.length > maxToolTextChars) {
        ensureItem().aggregatedOutput = truncateToolTextForRead(item.aggregatedOutput, maxToolTextChars);
      }
      if (typeof item.output === "string" && item.output.length > maxToolTextChars) {
        ensureItem().output = truncateToolTextForRead(item.output, maxToolTextChars);
      }
      if (item.result && typeof item.result === "object") {
        let nextResult = null;
        const ensureResult = () => {
          if (!nextResult) nextResult = { ...item.result };
          return nextResult;
        };
        if (typeof item.result.output === "string" && item.result.output.length > maxToolTextChars) {
          ensureResult().output = truncateToolTextForRead(item.result.output, maxToolTextChars);
        }
        if (Array.isArray(item.result.content)) {
          let contentChanged = false;
          const nextContent = item.result.content.map((part) => {
            if (!part || typeof part !== "object") return part;
            if (typeof part.text === "string" && part.text.length > maxToolTextChars) {
              contentChanged = true;
              return { ...part, text: truncateToolTextForRead(part.text, maxToolTextChars) };
            }
            if (typeof part.content === "string" && part.content.length > maxToolTextChars) {
              contentChanged = true;
              return { ...part, content: truncateToolTextForRead(part.content, maxToolTextChars) };
            }
            return part;
          });
          if (contentChanged) {
            ensureResult().content = nextContent;
          }
        }
        if (nextResult) {
          ensureItem().result = nextResult;
        }
      }
      if (nextItem) {
        itemsChanged = true;
        return nextItem;
      }
      return item;
    });
    if (!itemsChanged) return turn;
    turnsChanged = true;
    return { ...turn, items: nextItems };
  });
  return turnsChanged ? { ...thread, turns: nextTurns } : thread;
}

const INFLIGHT_RECOVERY_MAX_AGE_MS = 30 * 60 * 1000;
const MAX_AUTO_RESUME_ATTEMPTS = 2;
const RESUME_AFTER_RESTART_PROMPT = [
  "[服务重启后自动断点恢复] 上一轮任务在执行过程中因控制台服务重启被意外中断，尚未完成。",
  "请先核对当前会话上下文与工作区状态，优先继续完成刚才中断的步骤；不要直接跳过去执行后续排队任务。",
].join("");

function turnHasFinalPrimaryReply(turn) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i];
    if (it?.type === "agentMessage" && it.phase !== "commentary" && String(it.text || "").trim()) {
      return true;
    }
  }
  return false;
}

export class ProviderHub {
  #providers = new Map();
  #metaStore;
  #goalController;
  #inflightStore;
  #queue;
  #pendingRequests = new Map();
  #activeTurns = new Map();
  #recoveringThreads = new Set();
  #startupRecoveryReady = true;
  #lastAssistantText = new Map();
  #goalContinuationTimers = new Set();
  #sseListeners = new Set();
  #quotaService;
  #telemetry;
  #executionStats;
  #forkStore;
  #telemetryTimer = null;
  #telemetryTickInFlight = false;
  #lastTelemetrySig = "";
  #lastTelemetrySentAt = 0;
  #cachedRawProfiles = null;
  #cachedRawProfilesAt = 0;
  #threadTitleCache = new Map();
  #threadCwdCache = new Map();
  #lastTurnUserText = new Map();
  #nativeQueuedCache = new Map();
  #drainTimers = new Set();
  #enableQueueDrain = true;
  #env;
  #callLightweightProfileAi = null;
  #autoAliasInFlight = new Set();
  #cliMaintenance;
  #autoMaintainClis = false;
  #closed = false;

  constructor({
    env = process.env,
    dataDir = defaultDataDir(env),
    providers = null,
    metaStore = null,
    goalController = null,
    inflightStore = null,
    quotaService = null,
    telemetryService = null,
    cliMaintenance = null,
    autoMaintainClis = null,
    enableQueueDrain = true,
    callLightweightProfileAi = null,
  } = {}) {
    this.#env = env;
    this.#callLightweightProfileAi = typeof callLightweightProfileAi === "function" ? callLightweightProfileAi : null;
    this.#enableQueueDrain = Boolean(enableQueueDrain);
    this.#startupRecoveryReady = !this.#enableQueueDrain;
    this.#metaStore = metaStore || createThreadMetaStore({ filePath: threadMetaPath(dataDir) });
    this.#goalController = goalController || createGoalController({ filePath: goalStatePath(dataDir) });
    this.#inflightStore = inflightStore || createInflightTurnStore({ filePath: inflightTurnsPath(dataDir) });
    this.#executionStats = new ExecutionStats({ filePath: resolve(dataDir, "execution-stats.json") });
    this.#forkStore = new ForkStore({ filePath: resolve(dataDir, "forked-threads.json") });

    const emitEvent = (evt) => this.#handleProviderEvent(evt);
    const emitServerRequest = (req) => this.#handleProviderServerRequest(req);

    const list = providers || [
      new CodexProvider({ env, onEvent: emitEvent, onServerRequest: emitServerRequest }),
      new ClaudeProvider({ env, onEvent: emitEvent, onServerRequest: emitServerRequest }),
      new AntigravityProvider({ env, onEvent: emitEvent, onServerRequest: emitServerRequest }),
      new GrokProvider({ env, onEvent: emitEvent }),
      new QoderProvider({ env, dataDir, onEvent: emitEvent, onServerRequest: emitServerRequest }),
    ];
    this.#quotaService = quotaService || new QuotaService({
      env,
      codexQuotaReader: (profile, opts) => {
        const codex = this.#providers.get("codex");
        return typeof codex?.readRateLimits === "function"
          ? codex.readRateLimits(profile.id, opts)
          : null;
      },
    });
    this.#telemetry = telemetryService || new AgentTelemetryService({ env });
    this.#autoMaintainClis = typeof autoMaintainClis === "boolean"
      ? autoMaintainClis
      : (!Array.isArray(providers) && env.AGENT_CONTROL_AUTO_INSTALL_CLI !== "0");
    this.#cliMaintenance = cliMaintenance || new CliMaintenanceManager({
      env,
      onUpdated: () => this.refreshProfiles(),
    });
    for (const provider of list) {
      if (Array.isArray(providers)) {
        provider.setCallbacks?.({ onEvent: emitEvent, onServerRequest: emitServerRequest });
      }
      this.#providers.set(provider.id, provider);
    }

    this.#queue = createQueuedTurnQueue({
      filePath: enableQueueDrain ? queuedTurnsPath(dataDir) : "",
      autoStart: Boolean(enableQueueDrain),
      canDeliver: (entry) => this.#canDeliverQueuedTurn(entry),
      deliver: async (entry) => this.sendTurn({
        threadId: entry.threadId,
        text: entry.text,
        images: entry.images,
        model: entry.model,
        effort: entry.effort,
        permissionMode: entry.permissionMode,
        goalMode: entry.goalMode,
        writerConflictPolicy: "reject",
        isSystemResume: entry.source === "resume",
        resumeAttempts: entry.resumeAttempts || 0,
      }),
      isRetryable: (error) => (
        Number(error?.status) === 409
        || error?.code === "thread_busy"
        || error?.code === "writer_conflict"
        || error?.code === "codex_app_running"
        || /already has an active writer|\bactive writer\b|thread is busy/i.test(String(error?.message || ""))
      ),
      onEvent: (event) => {
        const tid = event.entry?.threadId || "";
        void (async () => {
          const queuedTurns = tid
            ? await this.listQueuedTurns(tid).catch(() => mergeQueuedTurnLists([], this.#queue.list(tid)))
            : [];
          this.#broadcast("queued_turn_event", {
            eventType: event.type,
            threadId: tid,
            entry: summarizeQueuedTurnEntry(event.entry),
            error: event.error || null,
            queuedTurns,
          });
        })();
      },
    });
  }

  async init() {
    const [, goalStates] = await Promise.all([
      this.#metaStore.load(),
      this.#goalController.load(),
      this.#inflightStore.load(),
      this.#executionStats.load(),
      this.#forkStore.load(),
      this.#queue.load(),
      ...this.providerList().map((p) => p.refreshProfiles?.().catch(() => {})),
    ]);
    this.#scheduleStartupRecovery(goalStates || {});
  }

  #scheduleStartupRecovery(goalStates = {}) {
    if (!this.#enableQueueDrain || this.#closed) {
      this.#startupRecoveryReady = true;
      return;
    }
    const now = Date.now();
    const candidates = new Map();

    for (const item of this.#inflightStore.all()) {
      if (!item?.threadId) continue;
      if ((now - (Number(item.startedAt) || 0)) > INFLIGHT_RECOVERY_MAX_AGE_MS || (Number(item.resumeAttempts) || 0) >= MAX_AUTO_RESUME_ATTEMPTS) {
        this.#inflightStore.clear(item.threadId);
        continue;
      }
      candidates.set(item.threadId, item);
    }

    for (const [tid, gs] of Object.entries(goalStates || {})) {
      if (!tid || !gs?.active || gs.backend === "native") continue;
      if ((now - (Number(gs.updatedAt || gs.startedAt) || 0)) > INFLIGHT_RECOVERY_MAX_AGE_MS) continue;
      if (!candidates.has(tid)) {
        candidates.set(tid, {
          threadId: tid,
          cwd: "",
          model: gs.model || "",
          effort: gs.effort || "",
          permissionMode: gs.permissionMode || "workspace",
          goalMode: true,
          resumeAttempts: 0,
          startedAt: gs.updatedAt || gs.startedAt || now,
        });
      }
    }

    if (!candidates.size) {
      this.#startupRecoveryReady = true;
      return;
    }

    for (const tid of candidates.keys()) {
      this.#recoveringThreads.add(tid);
    }
    this.#startupRecoveryReady = true;

    void (async () => {
      for (const [tid, cand] of candidates.entries()) {
        if (this.#closed) break;
        let shouldDrainThread = false;
        try {
          const parsed = parseCompositeThreadId(tid);
          const provider = this.getProvider(parsed.provider);
          const act = typeof provider.getActivity === "function"
            ? await provider.getActivity(parsed.profileId, parsed.rawId, { cursor: null }).catch(() => null)
            : null;
          if (this.#closed) break;
          if (act?.live) {
            this.#activeTurns.set(tid, { turnId: act.turnId || "", startedAt: cand.startedAt || Date.now() });
            continue;
          }

          const readRes = await provider.readThread(parsed.profileId, parsed.rawId, { detail: "auto", limit: 4 }).catch(() => null);
          if (this.#closed) break;
          const upstreamThread = readRes?.thread || null;
          if (upstreamThread?.live) {
            this.#activeTurns.set(tid, { turnId: "", startedAt: cand.startedAt || Date.now() });
            continue;
          }
          const turns = Array.isArray(upstreamThread?.turns) ? upstreamThread.turns : [];
          const lastTurn = turns.length ? turns[turns.length - 1] : null;
          const goalState = this.#goalController.get(tid);
          const completedCleanly = Boolean(
            lastTurn
            && lastTurn.status === "completed"
            && turnHasFinalPrimaryReply(lastTurn)
            && !goalState?.active,
          );
          if (completedCleanly) {
            this.#inflightStore.clear(tid);
            shouldDrainThread = this.#queue.has(tid);
            continue;
          }

          const prefs = this.#metaStore.get(tid);
          const nextAttempts = (Number(cand.resumeAttempts) || 0) + 1;
          this.#inflightStore.clear(tid);
          this.#queue.enqueuePriority(tid, {
            text: RESUME_AFTER_RESTART_PROMPT,
            images: [],
            cwd: cand.cwd || upstreamThread?.cwd || "",
            model: cand.model || prefs?.model || upstreamThread?.model || "",
            effort: cand.effort || prefs?.reasoningEffort || "",
            permissionMode: normalizePermissionMode(cand.permissionMode || prefs?.permissionMode || "workspace"),
            goalMode: Boolean(cand.goalMode || goalState?.active),
            resumeAttempts: nextAttempts,
            source: "resume",
            sourceLabel: "断点优先恢复",
          });
          shouldDrainThread = true;
        } catch {
          this.#inflightStore.clear(tid);
          shouldDrainThread = this.#queue.has(tid);
        } finally {
          this.#recoveringThreads.delete(tid);
          if (shouldDrainThread && !this.#closed) {
            this.#scheduleDeferredQueueDrain(40, tid);
          }
        }
      }
    })();
  }

  providerList() {
    return [...this.#providers.values()];
  }

  getProvider(providerId) {
    const provider = this.#providers.get(providerId);
    if (!provider) {
      throw Object.assign(new Error(`未知的智能体提供方：${providerId}`), { status: 400 });
    }
    return provider;
  }

  subscribe(listener) {
    this.#sseListeners.add(listener);
    this.#ensureTelemetryTimer();
    return () => {
      this.#sseListeners.delete(listener);
      if (this.#sseListeners.size === 0) {
        this.#stopTelemetryTimer();
      }
    };
  }

  #ensureTelemetryTimer() {
    if (this.#telemetryTimer || this.#sseListeners.size === 0) return;
    const timer = setInterval(() => {
      void this.#pollTelemetryTick();
    }, 2500);
    timer.unref?.();
    this.#telemetryTimer = timer;
  }

  #stopTelemetryTimer() {
    if (this.#telemetryTimer) {
      clearInterval(this.#telemetryTimer);
      this.#telemetryTimer = null;
    }
  }

  async #pollTelemetryTick() {
    if (this.#telemetryTickInFlight || this.#sseListeners.size === 0) return;
    this.#telemetryTickInFlight = true;
    try {
      const snapshot = await this.getTelemetry();
      const byP = snapshot?.byProvider || {};
      const activeSig = Array.isArray(snapshot?.activeThreads)
        ? snapshot.activeThreads.map((t) => `${t?.id || ""}:${t?.title || ""}:${t?.status || ""}`).join(",")
        : "";
      const sig = [
        ...PROVIDERS.map((id) => {
          const item = byP[id] || {};
          return `${id}:${item.runningCount || 0}:${item.queuedCount || 0}:${item.tokensPerSec || 0}`;
        }),
        activeSig,
      ].join("|");
      const now = Date.now();
      const hasRunning = (snapshot?.totals?.runningCount || 0) > 0;
      const changed = sig !== this.#lastTelemetrySig;
      if (changed || (hasRunning && (now - this.#lastTelemetrySentAt) >= 30_000)) {
        this.#lastTelemetrySig = sig;
        this.#lastTelemetrySentAt = now;
        this.#broadcast("agent_telemetry", snapshot);
      }
    } catch {
      // Non-fatal telemetry sampling error.
    } finally {
      this.#telemetryTickInFlight = false;
    }
  }

  #broadcast(event, data) {
    const safePayload = sanitizeEventForSse(event, data);
    for (const listener of this.#sseListeners) {
      try {
        listener(event, safePayload);
      } catch {
        // Ignore listener errors.
      }
    }
  }

  #handleProviderServerRequest(req) {
    const publicId = `${req.provider}:${req.profileId}:${req.id}`;
    const threadId = req.threadId || (req.rawThreadId ? formatCompositeThreadId(req.provider, req.profileId, req.rawThreadId) : "");
    const savedPerm = threadId ? (this.#metaStore.get(threadId)?.permissionMode || "") : "";
    if (req.kind !== "userInput" && isTurboPermissionMode(savedPerm)) {
      try {
        const provider = this.getProvider(req.provider);
        Promise.resolve(provider.respondServerRequest(req.profileId, req, { decision: "acceptForSession" })).catch(() => {});
        return;
      } catch {
        // Provider unavailable; fall through to queuing pending request.
      }
    }
    const record = {
      ...req,
      id: publicId,
      rawRequestId: req.id,
      threadId,
      createdAt: Math.floor(Date.now() / 1000),
    };
    this.#pendingRequests.set(publicId, {
      providerId: req.provider,
      profileId: req.profileId,
      threadId,
      rawRequest: req,
      publicRequest: record,
    });
    this.#broadcast("server_request", { request: record });
  }

  #scheduleDeferredQueueDrain(delayMs = 0, threadId = "") {
    if (this.#closed || !this.#enableQueueDrain) return;
    const timer = setTimeout(() => {
      this.#drainTimers.delete(timer);
      if (this.#closed || !this.#enableQueueDrain) return;
      if (threadId && (this.#activeTurns.has(threadId) || !this.#queue.has(threadId))) return;
      void this.#queue.drainOnce().catch(() => {});
    }, delayMs);
    timer.unref?.();
    this.#drainTimers.add(timer);
  }

  #clearPendingRequestsForThread(threadId) {
    for (const [reqId, entry] of [...this.#pendingRequests.entries()]) {
      if (entry.threadId !== threadId) continue;
      this.#pendingRequests.delete(reqId);
      this.#broadcast("server_request_resolved", { requestId: reqId, threadId });
    }
  }

  async #cancelPendingRequestsForThread(threadId) {
    for (const [reqId, entry] of [...this.#pendingRequests.entries()]) {
      if (entry.threadId !== threadId) continue;
      try {
        const provider = this.getProvider(entry.providerId);
        const cancelInput = entry.publicRequest?.kind === "userInput"
          ? { answers: {} }
          : { decision: "decline" };
        await Promise.resolve(provider.respondServerRequest(entry.profileId, entry.rawRequest, cancelInput)).catch(() => null);
      } catch {
        // Ignore provider lookup or stale request errors.
      }
    }
    this.#clearPendingRequestsForThread(threadId);
  }

  #handleProviderEvent(evt) {
    const threadId = evt.threadId || "";
    this.#executionStats.handle(evt, threadId ? (this.#metaStore.get(threadId) || {}) : {});

    if (evt.type === "codex_notification") {
      const { method, params } = evt;
      if (method === "serverRequest/resolved") {
        const requestId = `${evt.provider}:${evt.profileId}:${params?.requestId}`;
        if (this.#pendingRequests.delete(requestId)) {
          this.#broadcast("server_request_resolved", { requestId, threadId });
        }
      } else if (threadId && method === "turn/started") {
        this.#activeTurns.set(threadId, { turnId: params?.turn?.id || "", startedAt: Date.now() });
        this.#lastAssistantText.delete(threadId);
      } else if (threadId && (method === "item/agentMessage/delta" || method === "codex/event/agent_message_content_delta")) {
        const delta = String(params?.delta || params?.msg?.delta || "");
        if (delta) {
          this.#lastAssistantText.set(threadId, `${this.#lastAssistantText.get(threadId) || ""}${delta}`);
          this.#telemetry?.recordStreamDelta("codex", threadId, delta);
        }
      } else if (threadId && (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta" || method === "codex/event/agent_reasoning_delta")) {
        const delta = String(params?.delta || params?.msg?.delta || "");
        if (delta) {
          this.#telemetry?.recordStreamDelta("codex", threadId, delta);
        }
      } else if (threadId && method === "item/completed" && params?.item?.type === "agentMessage" && params.item.text) {
        this.#lastAssistantText.set(threadId, params.item.text);
      } else if (threadId && method === "turn/goal/updated" && params?.goalState) {
        void this.#goalController.syncExternal(threadId, { ...params.goalState, backend: "native" });
        this.#broadcast("goal_state", { threadId, goalState: params.goalState });
      } else if (threadId && method === "turn/completed") {
        this.#activeTurns.delete(threadId);
        this.#inflightStore.clear(threadId);
        this.#clearPendingRequestsForThread(threadId);
        const rawError = params?.turn?.error || null;
        const recoverableErr = isRecoverableToolExecutionError(rawError);
        const turnStatus = recoverableErr && (params?.turn?.status === "failed")
          ? "completed"
          : (params?.turn?.status || "completed");
        const fatalError = recoverableErr ? null : rawError;
        const lastMsg = extractLastAgentMessageFromCodexParams(params) || this.#lastAssistantText.get(threadId) || "";
        if (evt.provider && evt.profileId) {
          if (turnStatus === "failed") {
            void this.#recordProfileFailure(evt.provider, evt.profileId, fatalError || "Codex 执行失败");
          } else if (turnStatus === "completed") {
            void this.#recordProfileSuccess(evt.provider, evt.profileId);
          }
        }
        void this.#onTurnCompleted(threadId, {
          turnId: params?.turn?.id || "",
          status: turnStatus,
          lastAgentMessage: lastMsg,
          interrupted: turnStatus === "interrupted",
          error: fatalError,
        });
        if (recoverableErr) {
          evt = {
            ...evt,
            params: {
              ...params,
              turn: {
                ...(params?.turn || {}),
                status: turnStatus,
                error: null,
              },
            },
          };
        }
      }
      this.#broadcast("provider_event", evt);
      return;
    }

    if (evt.type === "turn_started" && threadId) {
      this.#activeTurns.set(threadId, { turnId: evt.turn?.id || "", startedAt: Date.now() });
      this.#lastAssistantText.delete(threadId);
    } else if (evt.type === "stream_delta" && evt.delta && threadId) {
      if (evt.kind === "text") {
        this.#lastAssistantText.set(threadId, `${this.#lastAssistantText.get(threadId) || ""}${evt.delta}`);
      }
      if (evt.kind === "text" || evt.kind === "reasoning" || evt.kind === "toolInput") {
        this.#telemetry?.recordStreamDelta(evt.provider || "", threadId, evt.delta);
      }
    } else if (evt.type === "item_completed" && evt.item?.type === "agentMessage" && evt.item.text && threadId) {
      this.#lastAssistantText.set(threadId, evt.item.text);
    } else if (evt.type === "turn_completed" && threadId) {
      this.#activeTurns.delete(threadId);
      this.#inflightStore.clear(threadId);
      this.#clearPendingRequestsForThread(threadId);
      const rawError = evt.error || null;
      const recoverableErr = isRecoverableToolExecutionError(rawError);
      const normalizedStatus = recoverableErr && evt.status === "failed"
        ? "completed"
        : (evt.status || "completed");
      const fatalError = recoverableErr ? null : rawError;
      const lastMsg = evt.lastAgentMessage || this.#lastAssistantText.get(threadId) || "";
      if (evt.provider && evt.profileId) {
        if (normalizedStatus === "failed") {
          void this.#recordProfileFailure(evt.provider, evt.profileId, fatalError || "执行失败");
        } else if (normalizedStatus === "completed") {
          void this.#recordProfileSuccess(evt.provider, evt.profileId);
        }
      }
      void this.#onTurnCompleted(threadId, {
        turnId: evt.turnId || "",
        status: normalizedStatus,
        lastAgentMessage: lastMsg,
        interrupted: normalizedStatus === "interrupted",
        error: fatalError,
      });
      if (recoverableErr) {
        evt = {
          ...evt,
          status: normalizedStatus,
          error: null,
        };
      }
    } else if (evt.type === "thread_updated" && threadId && evt.title) {
      const cleanTitle = stripPromptNoise(evt.title);
      if (cleanTitle) {
        const meta = this.#metaStore.get(threadId);
        if (!meta?.customName && !meta?.autoTitle && !isLowQualityTitle(cleanTitle)) {
          const prevCached = this.#threadTitleCache.get(threadId) || "";
          const lastUser = this.#lastTurnUserText.get(threadId) || "";
          const existingSig = meta?.autoTitleSourceSig || (lastUser ? threadTitleSourceSig(lastUser) : "");
          this.#setCachedThreadTitle(threadId, cleanTitle);
          if (!this.#closed) {
            void this.#metaStore.setAutoTitle(threadId, cleanTitle, {
              sourceSig: existingSig,
              isDrift: false,
              locked: true,
              schemaVersion: TITLE_SCHEMA_VERSION,
            }).catch(() => {});
          }
          if (cleanTitle !== prevCached) {
            this.#broadcast("thread_renamed", { threadId, name: cleanTitle, auto: true });
          }
        }
      }
    }

    this.#broadcast("provider_event", evt);
  }

  async #onTurnCompleted(threadId, summary) {
    const turnUserText = this.#lastTurnUserText.get(threadId) || "";
    this.#lastTurnUserText.delete(threadId);
    if (!this.#closed) {
      const meta = this.#metaStore.get(threadId);
      const turnSig = turnUserText ? threadTitleSourceSig(turnUserText) : "";
      const needsTitleWork = Boolean(
        !meta?.customName
        && (
          !meta?.titleLocked
          || (Number(meta?.titleSchemaVersion) || 0) < TITLE_SCHEMA_VERSION
          || (turnSig && meta?.autoTitleSourceSig !== turnSig)
        ),
      );
      if (needsTitleWork && (turnUserText || !meta?.titleLocked)) {
        const prevCachedTitle = this.#threadTitleCache.get(threadId) || "";
        const cachedCtx = this.#threadCwdCache.get(threadId);
        let fullUpstream = null;
        if (!meta?.titleLocked) {
          try {
            const parsed = parseCompositeThreadId(threadId);
            const impl = this.getProvider(parsed.provider);
            const readRes = await impl.readThread(parsed.profileId, parsed.rawId, { detail: "summary", limit: 6 }).catch(() => null);
            fullUpstream = readRes?.thread || null;
          } catch {
            // Ignore read failure during completion refinement.
          }
        }
        const seed = this.#metaStore.applyToThread({
          ...(fullUpstream || {}),
          id: threadId,
          cwd: fullUpstream?.cwd || cachedCtx?.cwd || "",
          name: fullUpstream?.name || prevCachedTitle,
          title: fullUpstream?.title || prevCachedTitle,
          upstreamTitle: fullUpstream?.upstreamTitle || ((prevCachedTitle && prevCachedTitle !== "新会话") ? prevCachedTitle : ""),
          ...(turnUserText ? { lastUserText: turnUserText } : {}),
        });
        const { persistPromise } = this.#applyAdaptiveTitle(seed, {
          extraUserText: turnUserText,
          isFollowUp: Boolean(fullUpstream?.hasFollowUpTurns || (prevCachedTitle && prevCachedTitle !== "新会话")),
          assistantText: summary?.lastAgentMessage || "",
          broadcastIfChanged: true,
          persist: true,
        });
        await persistPromise;
      }
    }
    const evalResult = await this.#goalController.evaluateAfterTurn(threadId, {
      lastAgentMessage: summary.lastAgentMessage,
      interrupted: summary.interrupted,
      error: summary.error,
    });
    if (evalResult.action !== "none") {
      this.#broadcast("goal_state", { threadId, goalState: evalResult.state });
    }
    if (evalResult.action === "continue" && evalResult.prompt) {
      const timer = setTimeout(() => {
        this.#goalContinuationTimers.delete(timer);
        if (this.#activeTurns.has(threadId)) return;
        const currentGoal = this.#goalController.get(threadId);
        if (!currentGoal?.enabled || !currentGoal?.active) return;
        void this.sendTurn({
          threadId,
          text: evalResult.prompt,
          model: currentGoal.model || "",
          effort: currentGoal.effort || "",
          permissionMode: currentGoal.permissionMode || this.#metaStore.get(threadId)?.permissionMode || "",
        }).catch(async (err) => {
          const stopped = await this.#goalController.disarm(threadId, {
            status: "stopped",
            stopReason: err?.message || "continuation_failed",
          });
          this.#broadcast("goal_state", { threadId, goalState: stopped });
        });
      }, 250);
      timer.unref?.();
      this.#goalContinuationTimers.add(timer);
      return;
    }

    if (this.#queue.has(threadId)) {
      await this.#queue.drainOnce();
    }
  }

  allPendingRequests() {
    return [...this.#pendingRequests.values()].map((item) => item.publicRequest);
  }

  pendingRequestsForThread(threadId) {
    return this.allPendingRequests().filter((item) => item.threadId === threadId);
  }

  async respondToRequest(requestId, input = {}) {
    const key = String(requestId || "").trim();
    const entry = this.#pendingRequests.get(key)
      || [...this.#pendingRequests.values()].find((item) => String(item.rawRequest?.id) === key);
    if (!entry) {
      throw Object.assign(new Error("该审批或输入请求已处理或已过期"), { status: 404 });
    }
    const provider = this.getProvider(entry.providerId);
    const result = await provider.respondServerRequest(entry.profileId, entry.rawRequest, input);
    this.#pendingRequests.delete(entry.publicRequest.id);
    this.#broadcast("server_request_resolved", {
      requestId: entry.publicRequest.id,
      threadId: entry.threadId,
    });
    return result;
  }

  async #broadcastProfilesUpdated() {
    const payload = await this.listProvidersAndProfiles();
    this.#broadcast("profiles_updated", payload);
    return payload;
  }

  async #recordProfileSuccess(provider, profileId, { latencyMs = null, broadcast = true } = {}) {
    if (this.#closed || !provider || !profileId) return;
    const key = formatProfileKey(provider, profileId);
    const prev = this.#metaStore.getProfileMeta(key);
    const patch = {
      status: "healthy",
      reasonCode: "",
      shortReason: "",
      detail: "",
      cooldownUntil: 0,
      checkedAt: Math.floor(Date.now() / 1000),
      ...(latencyMs !== null && latencyMs !== undefined ? { latencyMs } : {}),
    };
    await this.#metaStore.setProfileMeta(key, patch);
    if (broadcast && prev?.status !== "healthy") {
      await this.#broadcastProfilesUpdated().catch(() => null);
    }
  }

  async #recordProfileFailure(provider, profileId, error, { broadcast = true } = {}) {
    if (this.#closed || !provider || !profileId || isIgnorableTurnError(error)) return;
    const key = formatProfileKey(provider, profileId);
    const prev = this.#metaStore.getProfileMeta(key);
    const classified = classifyProfileError(error);
    await this.#metaStore.setProfileMeta(key, {
      ...classified,
      latencyMs: null,
      checkedAt: Math.floor(Date.now() / 1000),
    });
    if (broadcast && (prev?.status !== classified.status || prev?.reasonCode !== classified.reasonCode)) {
      await this.#broadcastProfilesUpdated().catch(() => null);
    }
  }

  async #collectProfileGroups() {
    const profileGroups = await Promise.all(
      this.providerList().map(async (provider) => {
        const rawProfiles = await provider.listProfiles().catch(() => []);
        const enriched = rawProfiles.map((p) => {
          const key = formatProfileKey(provider.id, p.id);
          const rawMeta = this.#metaStore.getProfileMeta(key);
          const health = normalizeProfileHealth(rawMeta, { installed: Boolean(p.installed) });
          const emailPrefix = p.account?.email ? String(p.account.email).split("@")[0] : "";
          const identityLabel = health.alias || emailPrefix || p.endpointLabel || p.account?.label || "";
          return {
            ...p,
            key,
            providerLabel: PROVIDER_LABELS[provider.id] || provider.label,
            health,
            identityLabel,
          };
        });
        const installedForSig = enriched.filter((p) => p && p.installed !== false && !p.health?.disabled);
        const currentSig = installedForSig.length >= 2 ? computeMultiProfileSignature(installedForSig) : "";
        const forFallback = enriched.map((item) => (
          currentSig && isAutoAliasUpgradeCandidate(item, currentSig)
            ? { ...item, health: { ...item.health, alias: "" } }
            : item
        ));
        const fallbackAliases = suggestFallbackDistinctAliases(forFallback);
        const withEffectiveAlias = enriched.map((item) => {
          const fallbackAlias = fallbackAliases[item.key];
          if (!fallbackAlias) return item;
          const needsUpgrade = currentSig ? isAutoAliasUpgradeCandidate(item, currentSig) : !item.health?.alias;
          if (!needsUpgrade) return item;
          return {
            ...item,
            health: { ...item.health, alias: fallbackAlias },
            identityLabel: fallbackAlias,
          };
        });
        const sortedProfiles = sortProfilesByHealth(withEffectiveAlias);
        const availableCount = sortedProfiles.filter(
          (p) => p.installed && !p.health?.disabled && p.health?.status !== "unavailable",
        ).length;
        return {
          provider: {
            id: provider.id,
            label: PROVIDER_LABELS[provider.id] || provider.label,
            installed: sortedProfiles.some((p) => p.installed),
            profileCount: sortedProfiles.length,
            availableCount,
          },
          profiles: sortedProfiles,
          _rawEnriched: enriched,
        };
      }),
    );
    const allRawProfiles = profileGroups.flatMap((g) => g._rawEnriched || g.profiles);
    for (const g of profileGroups) {
      if (g._rawEnriched) {
        this.#maybeScheduleAutoAlias(g.provider.id, g._rawEnriched, allRawProfiles);
        delete g._rawEnriched;
      }
    }
    this.#cachedRawProfiles = profileGroups.flatMap((g) => g.profiles);
    this.#cachedRawProfilesAt = Date.now();
    return profileGroups;
  }

  #maybeScheduleAutoAlias(providerId, rawProfiles = [], allRawProfiles = []) {
    if (this.#closed) return;
    const installed = rawProfiles.filter((p) => p && p.installed !== false && !p.health?.disabled);
    if (installed.length < 2) return;
    const sig = computeMultiProfileSignature(installed);
    if (!sig) return;
    const pendingUnnamed = installed.filter((p) => isAutoAliasUpgradeCandidate(p, sig));
    if (!pendingUnnamed.length) return;
    const lockKey = `${providerId}:${sig}`;
    if (this.#autoAliasInFlight.has(lockKey)) return;

    this.#autoAliasInFlight.add(lockKey);
    void (async () => {
      try {
        const res = await resolveAutoProfileAliases({
          providerId,
          profiles: installed,
          allProfiles: allRawProfiles,
          env: this.#env,
          callLightweightAi: this.#callLightweightProfileAi,
        });
        const aliases = res?.aliases || {};
        let updatedAny = false;
        for (const p of pendingUnnamed) {
          const key = p.key || `${providerId}:${p.id}`;
          const latestMeta = this.#metaStore.getProfileMeta(key);
          const latestAlias = String(latestMeta?.alias || "").trim();
          const latestSource = String(latestMeta?.autoAliasSource || "").trim();
          const isAutoManaged = !latestAlias
            || (["ai", "fallback", "checked"].includes(latestSource) && latestMeta?.autoAliasSignature !== sig);
          if (!isAutoManaged) continue;
          const nextAlias = aliases[key];
          if (nextAlias) {
            await this.#metaStore.setProfileMeta(key, {
              alias: nextAlias,
              autoAliasSignature: sig,
              autoAliasSource: res.source || "fallback",
            });
            updatedAny = true;
          } else if (res.source === "ai") {
            await this.#metaStore.setProfileMeta(key, {
              autoAliasSignature: sig,
              autoAliasSource: "checked",
            });
          }
        }
        if (updatedAny && !this.#closed) {
          await this.#broadcastProfilesUpdated().catch(() => null);
        }
      } catch {
        // Ignore auto-alias background failures silently; deterministic fallback stays active.
      } finally {
        this.#autoAliasInFlight.delete(lockKey);
      }
    })();
  }

  async listProvidersAndProfiles({ refreshQuotas = false } = {}) {
    const profileGroups = await this.#collectProfileGroups();
    const providers = profileGroups.map((g) => g.provider);
    const rawProfiles = profileGroups.flatMap((g) => g.profiles);
    const quotaResult = this.#quotaService
      ? await this.#quotaService.collectAll(rawProfiles, { refresh: refreshQuotas }).catch(() => null)
      : null;
    const quotaByKey = quotaResult?.byKey || {};
    const profiles = rawProfiles.map((p) => {
      const key = p.key || `${p.provider}:${p.id}`;
      return {
        ...p,
        quota: quotaByKey[key] || null,
      };
    });
    const isUsable = (p) => Boolean(p?.installed && !p.health?.disabled && p.health?.status !== "unavailable");
    const defaultProfile = profiles.find((p) => isUsable(p) && p.provider === "antigravity" && p.id === "desktop")
      || profiles.find((p) => isUsable(p) && p.provider === "antigravity")
      || profiles.find((p) => isUsable(p))
      || profiles.find((p) => p.installed && p.provider === "antigravity" && p.id === "desktop")
      || profiles.find((p) => p.installed && p.provider === "antigravity")
      || profiles.find((p) => p.installed)
      || profiles[0]
      || null;
    if (this.#autoMaintainClis && this.#cliMaintenance) {
      this.#cliMaintenance.ensureMissingClis(profiles);
    }
    const cliStatus = this.#cliMaintenance ? this.#cliMaintenance.inspect(profiles) : {};
    return {
      providers,
      profiles,
      cliStatus,
      defaultProvider: defaultProfile?.provider || "codex",
      defaultProfileId: defaultProfile?.id || "default",
      quotasUpdatedAt: quotaResult?.updatedAt || null,
    };
  }

  async getCliStatus() {
    let rawProfiles = this.#cachedRawProfiles;
    if (!Array.isArray(rawProfiles)) {
      const groups = await this.#collectProfileGroups().catch(() => []);
      rawProfiles = groups.flatMap((g) => g.profiles);
    }
    return this.#cliMaintenance ? this.#cliMaintenance.inspect(rawProfiles) : {};
  }

  async repairCli(provider, { force = true } = {}) {
    if (!this.#cliMaintenance) throw new Error("CLI maintenance unavailable");
    return this.#cliMaintenance.installCli(provider, { force });
  }

  getExecutionStats(options = {}) {
    return this.#executionStats.snapshot(options);
  }

  async getTelemetry() {
    let rawProfiles = this.#cachedRawProfiles;
    if (!Array.isArray(rawProfiles) || (Date.now() - this.#cachedRawProfilesAt) >= 20_000) {
      await this.#collectProfileGroups().catch(() => []);
      rawProfiles = this.#cachedRawProfiles || [];
    }

    const activeTurnsByProvider = {};
    for (const threadId of this.#activeTurns.keys()) {
      try {
        const parsed = parseCompositeThreadId(threadId);
        if (!activeTurnsByProvider[parsed.provider]) {
          activeTurnsByProvider[parsed.provider] = [];
        }
        const metaTitle = this.#metaStore.get(threadId)?.customName || this.#threadTitleCache.get(threadId) || "";
        activeTurnsByProvider[parsed.provider].push({
          id: threadId,
          rawId: parsed.rawId,
          title: metaTitle,
        });
      } catch {
        // Ignore non-composite IDs.
      }
    }

    const queuedByProvider = {};
    const queuedByProfile = {};
    const seenQueuedThreadIds = new Set();
    for (const item of this.#queue.all()) {
      if (!item?.threadId) continue;
      seenQueuedThreadIds.add(item.threadId);
      try {
        const parsed = parseCompositeThreadId(item.threadId);
        const pKey = `${parsed.provider}:${parsed.profileId}`;
        queuedByProvider[parsed.provider] = (queuedByProvider[parsed.provider] || 0) + 1;
        queuedByProfile[pKey] = (queuedByProfile[pKey] || 0) + 1;
      } catch {}
    }
    for (const [threadId, nativeCount] of this.#nativeQueuedCache.entries()) {
      if (!(nativeCount > 0)) continue;
      try {
        const parsed = parseCompositeThreadId(threadId);
        const pKey = `${parsed.provider}:${parsed.profileId}`;
        queuedByProvider[parsed.provider] = (queuedByProvider[parsed.provider] || 0) + nativeCount;
        queuedByProfile[pKey] = (queuedByProfile[pKey] || 0) + nativeCount;
      } catch {}
    }

    return this.#telemetry.collectSnapshot({
      profiles: rawProfiles,
      activeTurnsByProvider,
      queuedByProvider,
      queuedByProfile,
    });
  }

  async listQuotas({ refresh = false } = {}) {
    const summary = await this.listProvidersAndProfiles({ refreshQuotas: refresh });
    if (refresh) {
      this.#broadcast("profiles_updated", summary);
    }
    const quotas = summary.profiles.map((p) => p.quota).filter(Boolean);
    const byKey = {};
    for (const q of quotas) {
      byKey[`${q.provider}:${q.profileId}`] = q;
    }
    return {
      updatedAt: summary.quotasUpdatedAt || Math.floor(Date.now() / 1000),
      quotas,
      byKey,
    };
  }

  async probeProfiles({ provider = "", profileId = "" } = {}) {
    await Promise.all(this.providerList().map((p) => p.refreshProfiles?.().catch(() => {})));
    const { profiles } = await this.listProvidersAndProfiles();
    const targets = profiles.filter((p) => {
      if (provider && p.provider !== provider) return false;
      if (profileId && p.id !== profileId) return false;
      return true;
    });
    if (!targets.length) {
      throw Object.assign(new Error("未找到匹配的智能体实例配置"), { status: 404 });
    }

    const results = await Promise.all(targets.map(async (target) => {
      const impl = this.getProvider(target.provider);
      if (!target.installed) {
        await this.#recordProfileFailure(target.provider, target.id, "未安装", { broadcast: false });
        return { provider: target.provider, profileId: target.id, key: target.key, ok: false, error: "未安装" };
      }
      try {
        const probeRes = await (impl.probeProfile
          ? impl.probeProfile(target.id)
          : impl.listModels(target.id).then((items) => ({ ok: true, latencyMs: null, modelCount: items?.length || 0 })));
        await this.#recordProfileSuccess(target.provider, target.id, {
          latencyMs: probeRes?.latencyMs ?? null,
          broadcast: false,
        });
        return {
          provider: target.provider,
          profileId: target.id,
          key: target.key,
          ok: true,
          latencyMs: probeRes?.latencyMs ?? null,
        };
      } catch (error) {
        await this.#recordProfileFailure(target.provider, target.id, error, { broadcast: false });
        return {
          provider: target.provider,
          profileId: target.id,
          key: target.key,
          ok: false,
          error: error?.message || "测通失败",
        };
      }
    }));

    const payload = await this.#broadcastProfilesUpdated();
    return { ok: true, results, ...payload };
  }

  async updateProfileMeta({ provider = "", profileId = "", disabled, alias } = {}) {
    const cleanProvider = String(provider || "").trim();
    const cleanProfileId = String(profileId || "").trim();
    if (!cleanProvider || !cleanProfileId) {
      throw Object.assign(new Error("provider 与 profileId 不能为空"), { status: 400 });
    }
    this.getProvider(cleanProvider);
    const key = formatProfileKey(cleanProvider, cleanProfileId);
    const patch = {};
    if (disabled !== undefined) patch.disabled = Boolean(disabled);
    if (alias !== undefined) {
      patch.alias = String(alias || "");
      patch.autoAliasSource = "manual";
    }
    await this.#metaStore.setProfileMeta(key, patch);
    const payload = await this.#broadcastProfilesUpdated();
    return { ok: true, key, ...payload };
  }

  async listModels({ provider = "", profileId = "" } = {}) {
    if (provider) {
      const p = this.getProvider(provider);
      const { profiles } = await this.listProvidersAndProfiles();
      const scoped = profiles.filter((item) => item.provider === provider);
      const targetProfile = profileId || scoped.find((item) => !item.health?.disabled)?.id || scoped[0]?.id || "default";
      try {
        const models = await p.listModels(targetProfile);
        return { data: models, provider, profileId: targetProfile };
      } catch (error) {
        void this.#recordProfileFailure(provider, targetProfile, error);
        throw error;
      }
    }

    const { profiles } = await this.listProvidersAndProfiles();
    const settled = await Promise.allSettled(
      this.providerList().map(async (p) => {
        const firstProfile = profiles.find((item) => item.provider === p.id && !item.health?.disabled)
          || profiles.find((item) => item.provider === p.id);
        if (!firstProfile?.installed && !firstProfile) return [];
        const items = await p.listModels(firstProfile?.id || "default");
        return items;
      }),
    );
    const data = [];
    const byProvider = {};
    this.providerList().forEach((p, idx) => {
      const res = settled[idx];
      const list = res.status === "fulfilled" ? res.value : [];
      byProvider[p.id] = list;
      data.push(...list);
    });
    return { data, byProvider };
  }

  async #readNativeQueuedTurns(threadId) {
    try {
      const parsed = parseCompositeThreadId(threadId);
      const provider = this.getProvider(parsed.provider);
      if (typeof provider.listNativeQueuedTurns !== "function") return [];
      const items = await provider.listNativeQueuedTurns(parsed.profileId, parsed.rawId);
      return Array.isArray(items) ? items : [];
    } catch {
      return [];
    }
  }

  async #canDeliverQueuedTurn(entry) {
    if (!entry?.threadId) return false;
    if (!this.#startupRecoveryReady || this.#recoveringThreads.has(entry.threadId)) return false;
    if (this.#activeTurns.has(entry.threadId)) return false;
    try {
      const parsed = parseCompositeThreadId(entry.threadId);
      const provider = this.getProvider(parsed.provider);
      if (typeof provider.getActivity === "function") {
        const act = await provider.getActivity(parsed.profileId, parsed.rawId, { cursor: null }).catch(() => null);
        if (act?.live) return false;
        if (Array.isArray(act?.nativeQueuedTurns) && act.nativeQueuedTurns.length > 0) return false;
      }
    } catch {
      // Allow deliver attempt to fail fast or retry if provider lookup fails.
    }
    return true;
  }

  #setCachedThreadTitle(threadId, title) {
    if (!threadId || !title) return;
    if (this.#threadTitleCache.has(threadId)) {
      this.#threadTitleCache.delete(threadId);
    } else if (this.#threadTitleCache.size > 400) {
      const firstKey = this.#threadTitleCache.keys().next().value;
      if (firstKey !== undefined) this.#threadTitleCache.delete(firstKey);
    }
    this.#threadTitleCache.set(threadId, title);
  }

  #applyAdaptiveTitle(applied, {
    extraUserText = "",
    isFollowUp = false,
    assistantText = "",
    broadcastIfChanged = false,
    persist = false,
  } = {}) {
    if (!applied?.id) {
      return { thread: applied, persistPromise: Promise.resolve() };
    }
    const turnsPrompts = extractUserPromptsFromTurns(applied.turns);
    const cleanExtra = String(extraUserText || "").trim();
    const userPrompts = cleanExtra && turnsPrompts[turnsPrompts.length - 1] !== cleanExtra
      ? [...turnsPrompts, cleanExtra]
      : turnsPrompts;

    const effectiveCwd = applied.cwd || this.#threadCwdCache.get(applied.id)?.cwd || "";
    const projectAlias = effectiveCwd ? (this.#metaStore.getProject(effectiveCwd)?.alias || "") : "";
    const touchedPaths = extractTouchedPathsFromTurns(applied.turns);

    const upstreamTitle = applied.upstreamTitle ?? applied.originalName ?? applied.originalTitle ?? applied.name ?? "";
    const resolved = resolveAdaptiveThreadTitle({
      customName: applied.customName || "",
      upstreamCustomTitle: applied.upstreamCustomTitle || "",
      autoTitle: applied.autoTitle || "",
      autoTitleSourceSig: applied.autoTitleSourceSig || "",
      titleLocked: Boolean(applied.titleLocked),
      titleDomainKey: applied.titleDomainKey || "",
      titleSchemaVersion: Number(applied.titleSchemaVersion) || 0,
      upstreamTitle,
      userPrompts,
      firstUserText: applied.firstUserText || "",
      lastUserText: cleanExtra || applied.lastUserText || "",
      hasFollowUpTurns: Boolean(
        isFollowUp
        || applied.hasFollowUpTurns
        || applied.largeHistory
        || (Array.isArray(applied.turns) && applied.turns.length > 1)
        || userPrompts.length > 1,
      ),
      fallbackPreview: applied.preview || "",
      assistantText,
      touchedPaths,
      cwd: effectiveCwd,
      projectAlias,
    });

    const prevCachedTitle = this.#threadTitleCache.get(applied.id) || "";
    const nextTitle = resolved.title || applied.title || "新会话";
    const nextIsDrift = Boolean(resolved.drifted || applied.autoTitleIsDrift);
    const nextLocked = Boolean(resolved.titleLocked || applied.titleLocked);
    const nextDomainKey = resolved.domainKey || applied.titleDomainKey || "";
    const out = {
      ...applied,
      title: nextTitle,
      ...(!applied.customName ? { name: nextTitle } : {}),
      titleLocked: nextLocked,
      titleDomainKey: nextDomainKey,
      ...(resolved.autoTitleToSave
        ? {
            autoTitle: resolved.autoTitleToSave,
            autoTitleSourceSig: resolved.sourceSig || "",
            autoTitleIsDrift: nextIsDrift,
            titleSchemaVersion: Number(resolved.schemaVersion) || TITLE_SCHEMA_VERSION,
          }
        : {}),
    };

    this.#setCachedThreadTitle(applied.id, nextTitle);

    let persistPromise = Promise.resolve();
    if (resolved.autoTitleToSave && !this.#closed) {
      if (persist) {
        persistPromise = this.#metaStore.setAutoTitle(applied.id, resolved.autoTitleToSave, {
          sourceSig: resolved.sourceSig || "",
          isDrift: nextIsDrift,
          locked: nextLocked,
          domainKey: nextDomainKey,
          schemaVersion: Number(resolved.schemaVersion) || TITLE_SCHEMA_VERSION,
        }).catch(() => {});
      }
      const shouldBroadcast = Boolean(
        nextTitle
        && nextTitle !== prevCachedTitle
        && (broadcastIfChanged || (resolved.drifted && prevCachedTitle)),
      );
      if (shouldBroadcast) {
        this.#broadcast("thread_renamed", { threadId: applied.id, name: nextTitle, auto: true });
      }
    }

    return { thread: out, persistPromise };
  }

  #setCachedThreadContext(threadId, { cwd = "", rolloutPath = "" } = {}) {
    if (!threadId || (!cwd && !rolloutPath)) return;
    if (this.#threadCwdCache.has(threadId)) {
      this.#threadCwdCache.delete(threadId);
    } else if (this.#threadCwdCache.size > 1000) {
      const firstKey = this.#threadCwdCache.keys().next().value;
      if (firstKey !== undefined) this.#threadCwdCache.delete(firstKey);
    }
    this.#threadCwdCache.set(threadId, {
      cwd: String(cwd || "").trim(),
      rolloutPath: String(rolloutPath || "").trim(),
    });
  }

  #enrichThread(thread, adaptiveOpts = {}) {
    const applied = this.#metaStore.applyToThread(thread);
    this.#setCachedThreadContext(applied?.id, {
      cwd: applied?.cwd || "",
      rolloutPath: applied?.rolloutPath || applied?.path || "",
    });
    const activeExtraText = (
      !adaptiveOpts.extraUserText
      && applied?.id
      && this.#activeTurns.has(applied.id)
      && this.#lastTurnUserText.get(applied.id)
    )
      ? this.#lastTurnUserText.get(applied.id)
      : (adaptiveOpts.extraUserText || "");
    const isLegacyAutoTitle = Boolean(
      applied?.autoTitle
      && !applied.customName
      && (Number(applied.titleSchemaVersion) || 0) < TITLE_SCHEMA_VERSION,
    );
    const hasTurnsToLock = Boolean(
      adaptiveOpts.fromReadThread
      && Array.isArray(applied?.turns)
      && applied.turns.length > 0
      && !applied.titleLocked
      && !applied.customName,
    );
    const shouldAutoPersist = Boolean(adaptiveOpts.persist || isLegacyAutoTitle || hasTurnsToLock);
    const { thread: titleResolved } = this.#applyAdaptiveTitle(applied, {
      ...adaptiveOpts,
      extraUserText: activeExtraText,
      persist: shouldAutoPersist,
      broadcastIfChanged: adaptiveOpts.broadcastIfChanged ?? hasTurnsToLock,
    });
    const goalState = this.#goalController.get(titleResolved.id) || titleResolved.goalState || null;
    const nativeQueuedCount = Number(titleResolved.nativeQueuedCount) || 0;
    if (titleResolved?.id) {
      if (nativeQueuedCount > 0) {
        this.#nativeQueuedCache.set(titleResolved.id, nativeQueuedCount);
      } else {
        this.#nativeQueuedCache.delete(titleResolved.id);
      }
    }
    const controlQueuedCount = this.#queue.list(titleResolved.id).length;
    const queuedCount = nativeQueuedCount + controlQueuedCount;
    const pendingCount = this.pendingRequestsForThread(titleResolved.id).length;
    return {
      ...titleResolved,
      live: Boolean(titleResolved.live || this.#activeTurns.has(titleResolved.id)),
      goalState,
      queuedCount,
      pendingCount,
    };
  }

  async listThreads({
    provider = "",
    profileId = "",
    archived = "0",
    limit = 300,
  } = {}) {
    const { profiles } = await this.listProvidersAndProfiles();
    const targetProfiles = profiles.filter((p) => {
      if (provider && p.provider !== provider) return false;
      if (profileId && p.id !== profileId) return false;
      return Boolean(p.installed || provider);
    });

    const warnings = [];
    const settled = await Promise.allSettled(
      targetProfiles.map(async (profile) => {
        const impl = this.getProvider(profile.provider);
        return impl.listThreads(profile.id, {
          limit,
          includeArchived: archived === "1" || archived === "all" || this.#metaStore.hasUnarchivedOverrides(),
        });
      }),
    );

    const allThreads = [];
    for (const forkEntry of this.#forkStore.listPending()) {
      if (provider && forkEntry.provider !== provider) continue;
      if (profileId && forkEntry.profileId !== profileId) continue;
      allThreads.push(this.#enrichThread(forkEntry));
    }
    settled.forEach((result, idx) => {
      const prof = targetProfiles[idx];
      if (result.status === "fulfilled") {
        for (const t of result.value || []) {
          allThreads.push(this.#enrichThread(t));
        }
      } else {
        warnings.push({
          provider: prof.provider,
          profileId: prof.id,
          message: result.reason?.message || "读取会话列表失败",
        });
      }
    });

    const filtered = allThreads.filter((t) => {
      if (archived === "all") return true;
      if (archived === "1") return Boolean(t.archived);
      return !t.archived;
    });

    filtered.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return {
      threads: filtered.slice(0, Math.max(1, Number(limit) || 300)),
      projectsMeta: this.#metaStore.listProjects(),
      warnings,
    };
  }

  listProjectsMeta() {
    return this.#metaStore.listProjects();
  }

  async updateProjectMeta(cwd, patch = {}) {
    const meta = await this.#metaStore.setProjectMeta(cwd, patch);
    const projectsMeta = this.#metaStore.listProjects();
    this.#broadcast("project_meta_updated", { cwd, meta, projectsMeta });
    return { ok: true, cwd, meta, projectsMeta };
  }

  async #listExplicitThreadFilePaths(compositeId, threadCwd = "", readResult = null) {
    const result = readResult || await this.readThread(compositeId, { detail: "auto", limit: 30 }).catch(() => null);
    const turns = Array.isArray(result?.thread?.turns) ? result.thread.turns : [];
    const cwd = threadCwd || result?.thread?.cwd || "";
    const resolvedSet = new Set();
    const addCandidateRef = (raw) => {
      const str = String(raw || "").trim();
      if (!str) return;
      const { cleanPath } = splitFilePathAndAnchor(str);
      if (!cleanPath || cleanPath.includes("\0")) return;
      const abs = isAbsolute(cleanPath) ? resolve(cleanPath) : (cwd ? resolve(cwd, cleanPath) : "");
      if (abs) resolvedSet.add(abs);
    };

    for (const turn of turns) {
      for (const item of Array.isArray(turn?.items) ? turn.items : []) {
        if (!item || typeof item !== "object") continue;
        if (item.type === "userMessage" && Array.isArray(item.content)) {
          for (const part of item.content) {
            if (part?.path) addCandidateRef(part.path);
            if (part?.type === "text" && part.text) {
              for (const ref of extractFileRefsFromMarkdownText(part.text)) addCandidateRef(ref);
            }
          }
        } else if (item.type === "agentMessage" && item.text) {
          for (const ref of extractFileRefsFromMarkdownText(item.text)) addCandidateRef(ref);
        } else if (item.type === "fileChange" && item.changes) {
          if (Array.isArray(item.changes)) {
            for (const ch of item.changes) {
              if (ch?.path) addCandidateRef(ch.path);
            }
          } else if (typeof item.changes === "object") {
            for (const key of Object.keys(item.changes)) addCandidateRef(key);
          }
        } else if (item.type === "mcpToolCall" && item.arguments && typeof item.arguments === "object") {
          const a = item.arguments;
          for (const k of ["Path", "path", "TargetFile", "AbsolutePath", "File", "file_path"]) {
            if (a[k]) addCandidateRef(a[k]);
          }
        }
      }
    }
    return resolvedSet;
  }

  async #resolveScopedThreadFile(compositeId, rawPath, {
    imagesOnly = false,
    maxBytes = MAX_PREVIEW_OUTPUT_FILE_BYTES,
    allowEmpty = true,
  } = {}) {
    const cleanId = String(compositeId || "").trim();
    const rawStr = String(rawPath || "").trim();
    if (!cleanId || !rawStr || rawStr.includes("\0")) {
      throw Object.assign(new Error("缺少有效的会话或文件路径"), { status: 400 });
    }
    let parsed;
    try {
      parsed = parseCompositeThreadId(cleanId);
    } catch {
      throw Object.assign(new Error("无效的会话 ID"), { status: 400 });
    }

    const { cleanPath: decodedInput, startLine, endLine } = splitFilePathAndAnchor(rawStr);
    if (!decodedInput || decodedInput.includes("\0")) {
      throw Object.assign(new Error("文件路径无效"), { status: 400 });
    }

    const ext = extname(decodedInput).toLowerCase();
    const mimeType = imagesOnly ? ALLOWED_PREVIEW_IMAGE_MIMES[ext] : "";
    if (imagesOnly && !mimeType) {
      throw Object.assign(new Error("仅支持预览 png、jpg、jpeg、webp 或 gif 本地图片"), { status: 403 });
    }
    if (isBlockedPreviewFile(decodedInput, { allowCodexGenerated: imagesOnly })) {
      throw Object.assign(new Error("禁止访问受保护或敏感文件"), { status: 403 });
    }

    let cachedCtx = this.#threadCwdCache.get(cleanId) || null;
    if (!cachedCtx?.cwd) {
      const impl = this.getProvider(parsed.provider);
      if (typeof impl.resolveThreadContext === "function") {
        const ctx = await impl.resolveThreadContext(parsed.profileId, parsed.rawId).catch(() => null);
        if (ctx?.cwd) {
          cachedCtx = ctx;
          this.#setCachedThreadContext(cleanId, ctx);
        }
      }
    }

    let readResult = null;
    if (!cachedCtx?.cwd && !isAbsolute(decodedInput)) {
      readResult = await this.readThread(cleanId, { detail: "auto", limit: 12 }).catch(() => null);
      cachedCtx = this.#threadCwdCache.get(cleanId) || (readResult?.thread?.cwd ? { cwd: readResult.thread.cwd } : null);
    }

    const homeDir = resolveUserHome();
    const isAbsInput = isAbsolute(decodedInput);
    const threadCwd = String(cachedCtx?.cwd || "").trim();
    const cwdAllowedBase = Boolean(threadCwd && threadCwd !== "/" && !isUserHomePath(threadCwd, homeDir));

    let targetPath = isAbsInput
      ? resolve(decodedInput)
      : (threadCwd ? resolve(threadCwd, decodedInput) : "");

    // If agent cited only a bare filename (e.g. `提交计划.md` or `scene-01-分镜.png`), boundedly locate inside workspace.
    if (
      !isAbsInput
      && cwdAllowedBase
      && targetPath
      && !decodedInput.includes("/")
      && !decodedInput.includes("\\")
      && decodedInput !== "."
      && decodedInput !== ".."
    ) {
      const directStat = await stat(targetPath).catch(() => null);
      if (!directStat?.isFile()) {
        const matched = await findWorkspaceFileByBasename(threadCwd, decodedInput);
        if (matched) targetPath = matched;
      }
    }

    if (!targetPath || isBlockedPreviewFile(targetPath, { allowCodexGenerated: imagesOnly })) {
      throw Object.assign(new Error("禁止访问该文件路径"), { status: 403 });
    }

    const tmpDir = resolve(os.tmpdir());
    const realTmpDir = await realpath(tmpDir).catch(() => tmpDir);
    const agyBrainDir = homeDir ? resolve(homeDir, ".gemini", "antigravity", "brain") : "";
    const realAgyBrainDir = agyBrainDir ? await realpath(agyBrainDir).catch(() => agyBrainDir) : "";

    const inWorkspaceLogical = cwdAllowedBase && isSubpathOrEqual(threadCwd, targetPath);
    const isCodexTempClip = imagesOnly && /^codex-clipboard-/i.test(basename(targetPath));
    const inTempLogical = isAbsInput
      && isCodexTempClip
      && (isSubpathOrEqual(tmpDir, targetPath) || isSubpathOrEqual(realTmpDir, targetPath));
    const inAgyBrainLogical = Boolean(isAbsInput && agyBrainDir && (
      isSubpathOrEqual(agyBrainDir, targetPath) || isSubpathOrEqual(realAgyBrainDir, targetPath)
    ));

    let explicitlyAttached = false;
    if (!isAbsInput && !inWorkspaceLogical) {
      throw Object.assign(new Error(imagesOnly ? "禁止通过相对路径越界访问工作区外图片" : "禁止通过相对路径越界访问工作区外文件"), { status: 403 });
    }
    if (!inWorkspaceLogical && !inTempLogical && !inAgyBrainLogical) {
      const explicitSet = await this.#listExplicitThreadFilePaths(cleanId, threadCwd, readResult);
      explicitlyAttached = explicitSet.has(targetPath);
      if (!explicitlyAttached) {
        throw Object.assign(new Error(imagesOnly ? "仅允许预览当前工作区或会话附件中的图片" : "仅允许预览当前工作区或本会话产出的文件"), { status: 403 });
      }
    }

    const info = await stat(targetPath).catch(() => null);
    if (!info?.isFile()) {
      throw Object.assign(new Error(imagesOnly ? "图片文件不存在" : "文件不存在"), { status: 404 });
    }
    if ((!allowEmpty && info.size <= 0) || info.size > maxBytes) {
      throw Object.assign(new Error("文件大小超出预览限制"), { status: 403 });
    }

    const realTarget = await realpath(targetPath).catch(() => targetPath);
    if (isBlockedPreviewFile(realTarget, { allowCodexGenerated: imagesOnly })) {
      throw Object.assign(new Error("禁止访问受保护或敏感文件"), { status: 403 });
    }

    if (inWorkspaceLogical && !inTempLogical && !inAgyBrainLogical && !explicitlyAttached) {
      const realCwd = await realpath(threadCwd).catch(() => threadCwd);
      if (!isSubpathOrEqual(realCwd, realTarget)) {
        const explicitSet = await this.#listExplicitThreadFilePaths(cleanId, threadCwd, readResult);
        if (!explicitSet.has(targetPath) && !explicitSet.has(realTarget)) {
          throw Object.assign(new Error("禁止通过越界符号链接访问工作区外文件"), { status: 403 });
        }
      }
    } else if ((inTempLogical || inAgyBrainLogical) && !inWorkspaceLogical && !explicitlyAttached) {
      const inRealTemp = isSubpathOrEqual(realTmpDir, realTarget);
      const inRealAgy = Boolean(realAgyBrainDir && isSubpathOrEqual(realAgyBrainDir, realTarget));
      if (!inRealTemp && !inRealAgy) {
        throw Object.assign(new Error("禁止访问目录外符号链接文件"), { status: 403 });
      }
    }

    if (imagesOnly) {
      const fh = await open(realTarget, "r");
      try {
        const header = Buffer.allocUnsafe(12);
        const { bytesRead } = await fh.read(header, 0, 12, 0);
        if (!hasValidImageMagic(header.subarray(0, bytesRead), ext)) {
          throw Object.assign(new Error("文件内容不是有效的图片格式"), { status: 403 });
        }
      } finally {
        await fh.close().catch(() => {});
      }
    }

    const displayPath = cwdAllowedBase && inWorkspaceLogical
      ? (relative(threadCwd, targetPath) || basename(targetPath))
      : targetPath;

    return {
      filePath: realTarget,
      name: basename(realTarget),
      displayPath,
      mimeType,
      size: info.size,
      mtimeMs: info.mtimeMs,
      startLine,
      endLine,
    };
  }

  async resolveThreadImageFile(compositeId, rawPath) {
    return this.#resolveScopedThreadFile(compositeId, rawPath, {
      imagesOnly: true,
      maxBytes: MAX_PREVIEW_IMAGE_BYTES,
      allowEmpty: false,
    });
  }

  async resolveThreadOutputFile(compositeId, rawPath) {
    const cleanRef = String(rawPath || "").trim();
    const { cleanPath } = splitFilePathAndAnchor(cleanRef);
    const ext = extname(cleanPath).toLowerCase();
    const isRaster = Boolean(ALLOWED_PREVIEW_IMAGE_MIMES[ext]);
    return this.#resolveScopedThreadFile(compositeId, rawPath, {
      imagesOnly: isRaster,
      maxBytes: isRaster ? MAX_PREVIEW_IMAGE_BYTES : MAX_PREVIEW_OUTPUT_FILE_BYTES,
      allowEmpty: !isRaster,
    });
  }

  async readThread(compositeId, { cursor = null, detail = "auto", limit = 20 } = {}) {
    const forkDraft = this.#forkStore.get(compositeId);
    if (forkDraft && !forkDraft.materializedThreadId) {
      const enriched = this.#enrichThread({
        ...forkDraft,
        turns: forkDraft.prefixTurns || [],
      }, { fromReadThread: true });
      const thread = detail !== "full"
        ? capOversizedThreadToolOutputs(capOversizedThreadInlineImages(enriched))
        : enriched;
      return {
        thread,
        hasMoreTurns: false,
        totalTurns: thread.turns.length,
        activityCursor: "fork:0",
        pendingRequests: [],
        queuedTurns: [],
        goalState: thread.goalState,
      };
    }
    const parsed = parseCompositeThreadId(compositeId);
    const provider = this.getProvider(parsed.provider);
    const result = await provider.readThread(parsed.profileId, parsed.rawId, { cursor, detail, limit });
    const forkParent = this.#forkStore.getByMaterialized(compositeId);
    let rawTurns = Array.isArray(result.thread?.turns) ? result.thread.turns : [];
    if (forkParent) {
      const cleanedRealTurns = rawTurns.map((turn, idx) => {
        if (idx !== 0 || !Array.isArray(turn?.items)) return turn;
        return {
          ...turn,
          items: turn.items.map((item) => {
            if (item?.type !== "userMessage" || !Array.isArray(item.content)) return item;
            return {
              ...item,
              content: item.content.map((part) => (
                part?.type === "text" && typeof part.text === "string"
                  ? { ...part, text: stripForkContextPrefix(part.text) }
                  : part
              )),
            };
          }),
        };
      });
      rawTurns = [...(forkParent.prefixTurns || []), ...cleanedRealTurns];
    }
    const nativeQueuedTurns = Array.isArray(result.nativeQueuedTurns)
      ? result.nativeQueuedTurns
      : await this.#readNativeQueuedTurns(compositeId);
    const enriched = this.#enrichThread({
      ...result.thread,
      ...(forkParent ? { turns: rawTurns } : {}),
      nativeQueuedCount: nativeQueuedTurns.length,
    }, { fromReadThread: true });
    const thread = detail !== "full"
      ? capOversizedThreadToolOutputs(capOversizedThreadInlineImages(enriched))
      : enriched;
    const controlQueued = this.#queue.list(compositeId);
    const queuedTurns = mergeQueuedTurnLists(nativeQueuedTurns, controlQueued);
    const cqSig = controlQueued.map((item) => item.id).join(",");
    const baseCursor = String(result.activityCursor || "");
    const activityCursor = cqSig ? `${baseCursor}|cq:${cqSig}` : baseCursor;
    return {
      ...result,
      thread,
      activityCursor,
      pendingRequests: this.pendingRequestsForThread(compositeId),
      queuedTurns,
      goalState: thread.goalState,
    };
  }

  async getActivity(compositeId, { cursor = null } = {}) {
    const forkDraft = this.#forkStore.get(compositeId);
    if (forkDraft && !forkDraft.materializedThreadId) {
      return {
        live: false,
        cursor: "fork:0",
        changed: Boolean(cursor && cursor !== "fork:0"),
        queuedTurns: [],
        queuedCount: 0,
      };
    }
    const parsed = parseCompositeThreadId(compositeId);
    const provider = this.getProvider(parsed.provider);
    const rawCursorIn = typeof cursor === "string" ? cursor.replace(/\|cq:.*$/, "") : cursor;
    const act = await provider.getActivity(parsed.profileId, parsed.rawId, { cursor: rawCursorIn });
    const nativeQueuedTurns = Array.isArray(act?.nativeQueuedTurns)
      ? act.nativeQueuedTurns
      : await this.#readNativeQueuedTurns(compositeId);
    const controlQueued = this.#queue.list(compositeId);
    const queuedTurns = mergeQueuedTurnLists(nativeQueuedTurns, controlQueued);
    const cqSig = controlQueued.map((item) => item.id).join(",");
    const baseCursor = String(act?.cursor || "");
    const combinedCursor = cqSig ? `${baseCursor}|cq:${cqSig}` : baseCursor;
    const changed = Boolean(act?.changed || (cursor && cursor !== combinedCursor));
    if (!act?.live && controlQueued.length > 0 && !this.#activeTurns.has(compositeId)) {
      this.#scheduleDeferredQueueDrain(0, compositeId);
    }
    return {
      ...act,
      cursor: combinedCursor,
      changed,
      queuedTurns,
      queuedCount: queuedTurns.length,
    };
  }

  async #autoApprovePendingPermissions(threadId) {
    let count = 0;
    for (const [reqId, entry] of [...this.#pendingRequests.entries()]) {
      if (entry.threadId !== threadId) continue;
      const kind = entry.publicRequest?.kind || "";
      if (kind === "userInput") continue;
      try {
        await this.respondToRequest(reqId, { decision: "acceptForSession" });
        count += 1;
      } catch {
        // Ignore stale or already-resolved request.
      }
    }
    return count;
  }

  async updateThreadPrefs(compositeId, {
    model = "",
    effort = "",
    permissionMode = "",
  } = {}) {
    const parsed = parseCompositeThreadId(compositeId);
    const provider = this.getProvider(parsed.provider);
    const cleanPerm = permissionMode ? normalizePermissionMode(permissionMode) : "";
    const prefs = await this.#metaStore.setThreadPrefs(compositeId, {
      ...(model ? { model } : {}),
      ...(typeof effort === "string" ? { reasoningEffort: effort } : {}),
      ...(cleanPerm ? { permissionMode: cleanPerm } : {}),
    });
    if (cleanPerm) {
      await provider.setPermissionMode?.(parsed.profileId, parsed.rawId, cleanPerm).catch(() => null);
    }
    let autoApprovedCount = 0;
    if (cleanPerm && isTurboPermissionMode(cleanPerm)) {
      autoApprovedCount = await this.#autoApprovePendingPermissions(compositeId);
    }
    this.#broadcast("thread_prefs_updated", {
      threadId: compositeId,
      prefs,
      autoApprovedCount,
    });
    return {
      ok: true,
      threadId: compositeId,
      prefs,
      autoApprovedCount,
    };
  }

  async startThread({
    provider = "codex",
    profileId = "default",
    cwd = "",
    text = "",
    images = [],
    model = "",
    effort = "",
    permissionMode = "workspace",
    runMode = "normal",
    goalMode = false,
  } = {}) {
    const impl = this.getProvider(provider);
    const cleanPerm = normalizePermissionMode(permissionMode);
    const useGoal = Boolean(goalMode || runMode === "goal" || /^\/goal(?:\s|$)/i.test(String(text || "").trim()));

    let res;
    try {
      res = await impl.startThread({
        profileId,
        cwd,
        text,
        images,
        model,
        effort,
        permissionMode: cleanPerm,
      });
    } catch (error) {
      void this.#recordProfileFailure(provider, profileId, error);
      throw error;
    }
    const cleanText = String(text || "").trim();
    if (cleanText) {
      this.#lastTurnUserText.set(res.thread.id, cleanText);
    }
    this.#executionStats.context(res.thread.id, res.turn?.id || "", {
      model: model || res.thread.model || "", effort: effort || res.thread.reasoningEffort || "",
      internal: isInternalVoiceCallThread({ cwd: res.thread.cwd || cwd, preview: cleanText }), goalMode: useGoal,
    });
    const appliedStart = this.#metaStore.applyToThread({
      ...res.thread,
      firstUserText: res.thread.firstUserText || cleanText,
      lastUserText: res.thread.lastUserText || cleanText,
    });
    const { thread: titleResolvedStart, persistPromise: startPersist } = this.#applyAdaptiveTitle(appliedStart, {
      extraUserText: cleanText,
      isFollowUp: false,
      broadcastIfChanged: false,
      persist: true,
    });
    await startPersist;
    await this.#metaStore.setThreadPrefs(res.thread.id, {
      ...(model || res.thread.model ? { model: model || res.thread.model } : {}),
      ...(effort ? { reasoningEffort: effort } : {}),
      permissionMode: cleanPerm,
    });
    const thread = this.#enrichThread(titleResolvedStart);
    if (useGoal) {
      const goalState = await this.#armGoal(thread.id, {
        provider,
        profileId,
        rawId: thread.rawId,
        model,
        effort,
        permissionMode: cleanPerm,
        goalPrompt: text,
      });
      thread.goalState = goalState;
    }
    if (res.turn?.id || cleanText || (Array.isArray(images) && images.length > 0)) {
      this.#inflightStore.markStarted(thread.id, {
        cwd: res.thread.cwd || cwd || "",
        model: model || res.thread.model || "",
        effort,
        permissionMode: cleanPerm,
        goalMode: useGoal,
      });
    }
    return {
      thread,
      turn: res.turn,
      goalState: thread.goalState,
    };
  }

  async #armGoal(compositeId, { provider, profileId, rawId, model, effort, permissionMode, goalPrompt } = {}) {
    if (provider === "codex") {
      const codex = this.getProvider("codex");
      const native = await codex.setNativeGoal?.(profileId, rawId, true, { goalPrompt }).catch(() => ({ supported: false }));
      if (native?.supported && native.goalState) {
        return this.#goalController.syncExternal(compositeId, { ...native.goalState, backend: "native" });
      }
    }
    return this.#goalController.arm(compositeId, {
      backend: "orchestrator",
      model,
      effort,
      permissionMode,
      goalPrompt,
    });
  }

  async setGoalMode(compositeId, {
    enabled = true,
    maxTurns,
    model = "",
    effort = "",
    permissionMode = "",
  } = {}) {
    const parsed = parseCompositeThreadId(compositeId);
    let goalState;
    if (enabled) {
      const effectivePerm = permissionMode || this.#metaStore.get(compositeId)?.permissionMode || "workspace";
      goalState = await this.#armGoal(compositeId, {
        provider: parsed.provider,
        profileId: parsed.profileId,
        rawId: parsed.rawId,
        model,
        effort,
        permissionMode: effectivePerm,
      });
    } else {
      if (parsed.provider === "codex") {
        const codex = this.getProvider("codex");
        await codex.setNativeGoal?.(parsed.profileId, parsed.rawId, false).catch(() => null);
      }
      goalState = await this.#goalController.disarm(compositeId, { status: "stopped", stopReason: "manual" });
    }
    this.#broadcast("goal_state", { threadId: compositeId, goalState });
    return { threadId: compositeId, goalState };
  }

  async forkThread({
    threadId,
    upToTurnIndex = null,
    upToTurnId = "",
    targetProvider = "",
    targetProfileId = "",
    model = "",
    effort = "",
  } = {}) {
    const cleanThreadId = String(threadId || "").trim();
    if (!cleanThreadId) {
      throw Object.assign(new Error("缺少要分叉的会话 ID"), { status: 400 });
    }
    const read = await this.readThread(cleanThreadId, { detail: "full", limit: 300 });
    const origThread = read?.thread;
    if (!origThread) {
      throw Object.assign(new Error("找不到要分叉的会话"), { status: 404 });
    }
    const turns = Array.isArray(origThread.turns) ? origThread.turns : [];
    let cutIndex = turns.length - 1;
    if (upToTurnId) {
      const idx = turns.findIndex((t) => String(t?.id || "") === String(upToTurnId));
      if (idx >= 0) cutIndex = idx;
    } else if (Number.isInteger(upToTurnIndex) && upToTurnIndex >= 0 && upToTurnIndex < turns.length) {
      cutIndex = upToTurnIndex;
    }
    const keptTurns = cutIndex >= 0 ? turns.slice(0, cutIndex + 1) : [];
    const isTruncated = cutIndex >= 0 && cutIndex < turns.length - 1;
    const lastTurnId = String(keptTurns[keptTurns.length - 1]?.id || "");
    const baseName = String(origThread.name || origThread.title || "新会话").replace(/\s*\(分叉(?:\s*\d+)?\)\s*$/i, "").trim() || "新会话";
    const parsed = parseCompositeThreadId(cleanThreadId);
    const providerId = targetProvider || parsed.provider;
    const provider = this.getProvider(providerId);
    const profileId = targetProvider ? targetProfileId : parsed.profileId;
    let profileLabel = origThread.profileLabel || "";
    if (targetProvider) {
      const profiles = await provider.listProfiles();
      const profile = profiles.find((item) => item.id === profileId);
      if (!profile || !profile.installed || this.#metaStore.getProfileMeta(formatProfileKey(providerId, profileId))?.disabled) {
        throw Object.assign(new Error("请选择已安装且启用的目标 Agent 实例"), { status: 400 });
      }
      profileLabel = profile.label || "";
    }
    const forkName = `${baseName} (${targetProvider ? `${PROVIDER_LABELS[providerId]} 接续` : "分叉"})`;

    if (
      parsed.provider === "codex"
      && !targetProvider
      && !this.#forkStore.get(cleanThreadId)
      && typeof provider.forkThread === "function"
      && (!isTruncated || lastTurnId)
    ) {
      try {
        const nativeRes = await provider.forkThread({
          profileId: parsed.profileId,
          rawId: parsed.rawId,
          lastTurnId: isTruncated ? lastTurnId : "",
          cwd: origThread.cwd || "",
          model: origThread.model || "",
          permissionMode: origThread.permissionMode || "workspace",
        });
        if (nativeRes?.thread?.id) {
          await this.#metaStore.setCustomName(nativeRes.thread.id, forkName);
          await this.#metaStore.setThreadPrefs(nativeRes.thread.id, {
            ...(origThread.model ? { model: origThread.model } : {}),
            ...(origThread.reasoningEffort ? { reasoningEffort: origThread.reasoningEffort } : {}),
            permissionMode: origThread.permissionMode || "workspace",
          });
          const enriched = this.#enrichThread({ ...nativeRes.thread, name: forkName, title: forkName });
          this.#broadcast("thread_list_changed", { action: "fork", threadId: enriched.id });
          return { ok: true, thread: enriched, native: true };
        }
      } catch {
        // Fall back to soft fork store if native fork fails.
      }
    }

    const forkEntry = await this.#forkStore.create({
      provider: providerId,
      profileId,
      profileLabel,
      cwd: origThread.cwd || "",
      name: forkName,
      model: targetProvider ? model : origThread.model || "",
      reasoningEffort: targetProvider ? effort : origThread.reasoningEffort || "",
      permissionMode: origThread.permissionMode || "workspace",
      forkedFrom: {
        threadId: cleanThreadId,
        turnIndex: cutIndex,
        turnId: lastTurnId,
      },
      turns: keptTurns,
    });
    await this.#metaStore.setCustomName(forkEntry.id, forkName);
    await this.#metaStore.setThreadPrefs(forkEntry.id, {
      ...(forkEntry.model ? { model: forkEntry.model } : {}),
      ...(forkEntry.reasoningEffort ? { reasoningEffort: forkEntry.reasoningEffort } : {}),
      permissionMode: forkEntry.permissionMode || "workspace",
    });
    const enriched = this.#enrichThread(forkEntry);
    this.#broadcast("thread_list_changed", { action: "fork", threadId: enriched.id });
    return { ok: true, thread: enriched, native: false };
  }

  async sendTurn({
    threadId,
    cwd = "",
    text = "",
    images = [],
    model = "",
    effort = "",
    permissionMode = "",
    steer = false,
    expectedTurnId = "",
    runMode = "normal",
    goalMode = false,
    writerConflictPolicy = "reject",
    isSystemResume = false,
    resumeAttempts = 0,
  } = {}) {
    const forkDraft = this.#forkStore.get(threadId);
    if (forkDraft && !forkDraft.materializedThreadId) {
      const promptWithContext = buildForkContextPrompt(forkDraft.prefixTurns || [], text);
      const started = await this.startThread({
        provider: forkDraft.provider,
        profileId: forkDraft.profileId,
        cwd: cwd || forkDraft.cwd || "",
        text: promptWithContext,
        images,
        model: model || forkDraft.model || "",
        effort: effort || forkDraft.reasoningEffort || "",
        permissionMode: permissionMode || forkDraft.permissionMode || "workspace",
        runMode,
        goalMode,
      });
      if (started?.thread?.id) {
        const displayName = this.#metaStore.get(threadId)?.customName || forkDraft.name;
        if (displayName) {
          await this.#metaStore.setCustomName(started.thread.id, displayName);
          started.thread.name = displayName;
          started.thread.title = displayName;
        }
        await this.#forkStore.markMaterialized(threadId, started.thread.id);
        this.#broadcast("thread_list_changed", { action: "fork_materialized", threadId: started.thread.id, fromId: threadId });
      }
      return {
        ...started,
        forkedFromId: threadId,
        redirectedThreadId: started?.thread?.id || "",
      };
    }
    const parsed = parseCompositeThreadId(threadId);
    const provider = this.getProvider(parsed.provider);
    const savedPrefs = this.#metaStore.get(threadId);
    const effectivePermInput = permissionMode || savedPrefs?.permissionMode || "workspace";
    const cleanPerm = normalizePermissionMode(effectivePermInput);
    const effectiveModel = model || savedPrefs?.model || "";
    const effectiveEffort = effort || savedPrefs?.reasoningEffort || "";
    const useGoal = Boolean(goalMode || runMode === "goal" || /^\/goal(?:\s|$)/i.test(String(text || "").trim()));

    const cleanText = String(text || "").trim();
    const prevCachedTitle = this.#threadTitleCache.get(threadId) || "";
    const hasPreBaseline = Boolean(
      savedPrefs?.autoTitle
      || savedPrefs?.customName
      || (prevCachedTitle && prevCachedTitle !== "新会话"),
    );
    const likelyBusy = Boolean(!steer && writerConflictPolicy === "reject" && this.#activeTurns.has(threadId));
    let preTurnPersist = Promise.resolve();
    let preTurnBroadcastTitle = "";
    let ranPreAdaptive = false;
    const cachedCtx = this.#threadCwdCache.get(threadId);
    if (!isSystemResume && !likelyBusy && hasPreBaseline && cleanText) {
      ranPreAdaptive = true;
      const preBase = this.#metaStore.applyToThread({
        id: threadId,
        rawId: parsed.rawId,
        provider: parsed.provider,
        profileId: parsed.profileId,
        cwd: cwd || cachedCtx?.cwd || "",
        ...(prevCachedTitle && prevCachedTitle !== "新会话"
          ? { upstreamTitle: prevCachedTitle, title: prevCachedTitle, name: prevCachedTitle }
          : {}),
        lastUserText: cleanText,
        hasFollowUpTurns: true,
      });
      const preRes = this.#applyAdaptiveTitle(preBase, {
        extraUserText: cleanText,
        isFollowUp: true,
        broadcastIfChanged: false,
        persist: true,
      });
      preTurnPersist = preRes.persistPromise;
      if (preRes.thread?.title && preRes.thread.title !== prevCachedTitle && !savedPrefs?.customName) {
        preTurnBroadcastTitle = preRes.thread.title;
      }
    }

    await Promise.all([
      this.#metaStore.setThreadPrefs(threadId, {
        ...(effectiveModel ? { model: effectiveModel } : {}),
        ...(effectiveEffort ? { reasoningEffort: effectiveEffort } : {}),
        permissionMode: cleanPerm,
      }),
      preTurnPersist,
    ]);
    if (isTurboPermissionMode(cleanPerm)) {
      await this.#autoApprovePendingPermissions(threadId);
    }

    if (useGoal) {
      await this.#armGoal(threadId, {
        provider: parsed.provider,
        profileId: parsed.profileId,
        rawId: parsed.rawId,
        model: effectiveModel,
        effort: effectiveEffort,
        permissionMode: cleanPerm,
        goalPrompt: text,
      });
    }

    const hadPrevUserText = this.#lastTurnUserText.has(threadId);
    const prevUserText = this.#lastTurnUserText.get(threadId);
    if (!isSystemResume && cleanText) {
      this.#lastTurnUserText.set(threadId, cleanText);
    }
    let res;
    try {
      res = await provider.sendTurn({
        profileId: parsed.profileId,
        rawId: parsed.rawId,
        cwd,
        text,
        images,
        model: effectiveModel,
        effort: effectiveEffort,
        permissionMode: cleanPerm,
        steer,
        expectedTurnId,
        writerConflictPolicy,
      });
    } catch (error) {
      if (ranPreAdaptive && prevCachedTitle) {
        this.#setCachedThreadTitle(threadId, prevCachedTitle);
      }
      if (!isSystemResume && cleanText) {
        if (hadPrevUserText) this.#lastTurnUserText.set(threadId, prevUserText);
        else this.#lastTurnUserText.delete(threadId);
      }
      void this.#recordProfileFailure(parsed.provider, parsed.profileId, error);
      throw error;
    }
    if (!res.steered) this.#executionStats.context(threadId, res.turn?.id || "", {
      model: effectiveModel || res.thread?.model || "", effort: effectiveEffort || res.thread?.reasoningEffort || "",
      internal: isInternalVoiceCallThread({ cwd: res.thread?.cwd || cwd || cachedCtx?.cwd, preview: cleanText }),
      goalMode: useGoal || this.#goalController.get(threadId)?.active,
    });
    if (res.turn?.id) {
      this.#activeTurns.set(threadId, { turnId: res.turn.id, startedAt: Date.now() });
    }
    this.#inflightStore.markStarted(threadId, {
      cwd: res.thread?.cwd || cwd || cachedCtx?.cwd || "",
      model: effectiveModel,
      effort: effectiveEffort,
      permissionMode: cleanPerm,
      goalMode: Boolean(useGoal || this.#goalController.get(threadId)?.active),
      resumeAttempts,
    });
    if (isSystemResume) {
      return {
        ...res,
        thread: res.thread ? this.#enrichThread(this.#metaStore.applyToThread(res.thread)) : null,
        goalState: this.#goalController.get(threadId),
      };
    }
    if (preTurnBroadcastTitle) {
      this.#broadcast("thread_renamed", { threadId, name: preTurnBroadcastTitle, auto: true });
    }
    const cachedTitle = this.#threadTitleCache.get(threadId) || "";
    const savedMeta = this.#metaStore.get(threadId);
    const hasBaselineTitle = Boolean(
      res.thread?.upstreamTitle
      || savedMeta?.autoTitle
      || savedMeta?.customName
      || (cachedTitle && cachedTitle !== "新会话"),
    );
    const adaptiveBase = this.#metaStore.applyToThread({
      ...(res.thread || {}),
      id: threadId,
      rawId: parsed.rawId,
      provider: parsed.provider,
      profileId: parsed.profileId,
      cwd: res.thread?.cwd || cwd || cachedCtx?.cwd || "",
      ...(hasBaselineTitle && !res.thread?.upstreamTitle && cachedTitle && cachedTitle !== "新会话"
        ? { upstreamTitle: cachedTitle }
        : {}),
      ...(!res.thread && cachedTitle ? { title: cachedTitle, name: cachedTitle } : {}),
      lastUserText: cleanText || res.thread?.lastUserText || "",
      hasFollowUpTurns: Boolean(hasBaselineTitle || res.thread?.hasFollowUpTurns),
    });
    const { thread: titleResolvedTurn, persistPromise: turnPersist } = this.#applyAdaptiveTitle(adaptiveBase, {
      extraUserText: cleanText,
      isFollowUp: hasBaselineTitle,
      broadcastIfChanged: !ranPreAdaptive,
      persist: !ranPreAdaptive,
    });
    await turnPersist;
    return {
      ...res,
      thread: res.thread ? this.#enrichThread(titleResolvedTurn, { extraUserText: cleanText, isFollowUp: hasBaselineTitle }) : null,
      goalState: this.#goalController.get(threadId),
    };
  }

  async queueTurn({
    threadId,
    text = "",
    images = [],
    model = "",
    effort = "",
    permissionMode = "workspace",
    goalMode = false,
    preferNative = false,
  } = {}) {
    const parsed = parseCompositeThreadId(threadId);
    if (preferNative && parsed.provider === "codex" && !(images && images.length)) {
      const codex = this.getProvider("codex");
      const native = await codex.queueNative({
        profileId: parsed.profileId,
        rawId: parsed.rawId,
        text,
      }).catch(() => ({ supported: false }));
      if (native?.supported) {
        return { ...native, threadId, native: true, items: await this.listQueuedTurns(threadId) };
      }
    }
    const entry = this.#queue.enqueue(threadId, {
      text: String(text || ""),
      images: Array.isArray(images) ? images : [],
      model,
      effort,
      permissionMode: normalizePermissionMode(permissionMode),
      goalMode: Boolean(goalMode),
    });
    if (!this.#activeTurns.has(threadId)) {
      this.#scheduleDeferredQueueDrain(50, threadId);
    }
    return {
      ok: true,
      threadId,
      entry: summarizeQueuedTurnEntry({
        ...entry,
        source: "control",
        sourceLabel: "控制端队列",
        canCancel: true,
      }),
      items: await this.listQueuedTurns(threadId),
    };
  }

  async listQueuedTurns(threadId) {
    parseCompositeThreadId(threadId);
    const [nativeItems, controlItems] = await Promise.all([
      this.#readNativeQueuedTurns(threadId),
      Promise.resolve(this.#queue.list(threadId)),
    ]);
    return mergeQueuedTurnLists(nativeItems, controlItems);
  }

  allQueuedTurns() {
    return this.#queue.all().map(summarizeQueuedTurnEntry);
  }

  async cancelQueuedTurn(threadId, entryId) {
    parseCompositeThreadId(threadId);
    const ok = this.#queue.cancel(threadId, entryId);
    return { ok, threadId, items: await this.listQueuedTurns(threadId) };
  }

  async getQueuedTurnEntry(threadId, entryId) {
    parseCompositeThreadId(threadId);
    const cleanId = String(entryId || "").trim();
    if (!cleanId) {
      throw Object.assign(new Error("缺少排队消息 ID"), { status: 400, code: "missing_queue_id" });
    }
    const entry = this.#queue.get(threadId, cleanId);
    if (!entry) {
      throw Object.assign(new Error("该排队消息已发送或不存在"), { status: 404, code: "queued_turn_not_found" });
    }
    const images = Array.isArray(entry.images)
      ? entry.images
          .filter(Boolean)
          .map((img, idx) => (typeof img === "string"
            ? { name: `image-${idx + 1}.jpg`, dataUrl: img }
            : {
                name: String(img.name || `image-${idx + 1}.jpg`),
                dataUrl: String(img.dataUrl || img.url || ""),
              }))
          .filter((img) => Boolean(img.dataUrl))
      : [];
    return {
      ok: true,
      threadId,
      entry: {
        ...entry,
        images,
      },
    };
  }

  async updateQueuedTurn(threadId, entryId, {
    text,
    images,
    model,
    effort,
    permissionMode,
    goalMode,
  } = {}) {
    parseCompositeThreadId(threadId);
    const cleanId = String(entryId || "").trim();
    if (!cleanId) {
      throw Object.assign(new Error("缺少排队消息 ID"), { status: 400, code: "missing_queue_id" });
    }
    const nextText = text !== undefined ? String(text || "") : undefined;
    const nextImages = images !== undefined
      ? (Array.isArray(images) ? images : []).filter((img) => Boolean(img && (typeof img === "string" || img.dataUrl || img.url)))
      : undefined;
    const existing = this.#queue.get(threadId, cleanId);
    if (!existing) {
      throw Object.assign(new Error("该排队消息已发送或不存在"), { status: 404, code: "queued_turn_not_found" });
    }
    const resolvedText = nextText !== undefined ? nextText : String(existing.text || "");
    const resolvedImages = nextImages !== undefined ? nextImages : (Array.isArray(existing.images) ? existing.images : []);
    if (!resolvedText.trim() && !resolvedImages.length) {
      throw Object.assign(new Error("排队消息内容与图片不能同时为空"), { status: 400, code: "empty_queued_turn" });
    }
    const updated = this.#queue.update(threadId, cleanId, {
      ...(nextText !== undefined ? { text: nextText } : {}),
      ...(nextImages !== undefined ? { images: nextImages } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(permissionMode !== undefined ? { permissionMode: normalizePermissionMode(permissionMode) } : {}),
      ...(goalMode !== undefined ? { goalMode: Boolean(goalMode) } : {}),
    });
    if (!updated) {
      throw Object.assign(new Error("该排队消息已进入发送中或不存在"), { status: 409, code: "queued_turn_locked" });
    }
    return {
      ok: true,
      threadId,
      entry: summarizeQueuedTurnEntry({
        ...updated,
        source: updated.source || "control",
        sourceLabel: updated.sourceLabel || (updated.source === "resume" ? "断点优先恢复" : "控制端队列"),
        canCancel: true,
      }),
      items: await this.listQueuedTurns(threadId),
    };
  }

  async steerQueuedTurn(threadId, entryId, { expectedTurnId = "" } = {}) {
    parseCompositeThreadId(threadId);
    const cleanId = String(entryId || "").trim();
    if (!cleanId) {
      throw Object.assign(new Error("缺少排队消息 ID"), { status: 400, code: "missing_queue_id" });
    }
    const entry = this.#queue.beginSteer(threadId, cleanId);
    if (!entry) {
      throw Object.assign(new Error("该排队消息已发送或不存在"), { status: 404, code: "queued_turn_not_found" });
    }
    let turnResult;
    try {
      turnResult = await this.sendTurn({
        threadId,
        text: String(entry.text || ""),
        images: Array.isArray(entry.images) ? entry.images : [],
        model: entry.model || "",
        effort: entry.effort || "",
        permissionMode: entry.permissionMode || "workspace",
        steer: true,
        expectedTurnId: expectedTurnId || this.#activeTurns.get(threadId)?.turnId || "",
        goalMode: Boolean(entry.goalMode),
        writerConflictPolicy: "reject",
      });
    } catch (error) {
      this.#queue.abortSteer(cleanId);
      throw error;
    }
    this.#queue.completeSteer(threadId, cleanId, turnResult);
    return {
      ok: true,
      threadId,
      steered: true,
      result: turnResult,
      entry: summarizeQueuedTurnEntry({
        ...entry,
        source: "control",
        sourceLabel: "控制端队列",
        canCancel: true,
      }),
      items: await this.listQueuedTurns(threadId),
    };
  }

  async interrupt({ threadId, turnId = "" } = {}) {
    const parsed = parseCompositeThreadId(threadId);
    const provider = this.getProvider(parsed.provider);
    if (this.#goalController.get(threadId)?.active) {
      const stopped = await this.#goalController.disarm(threadId, { status: "stopped", stopReason: "interrupted" });
      this.#broadcast("goal_state", { threadId, goalState: stopped });
    }
    await this.#cancelPendingRequestsForThread(threadId).catch(() => {});
    const result = await provider.interrupt({ profileId: parsed.profileId, rawId: parsed.rawId, turnId });
    this.#inflightStore.clear(threadId);
    if (this.#activeTurns.has(threadId)) {
      this.#activeTurns.delete(threadId);
    }
    if (this.#queue.has(threadId)) {
      this.#scheduleDeferredQueueDrain(80, threadId);
    }
    return result;
  }

  async renameThread(compositeId, name) {
    const parsed = parseCompositeThreadId(compositeId);
    const meta = await this.#metaStore.setCustomName(compositeId, name);
    this.#setCachedThreadTitle(compositeId, meta.customName);
    await this.#forkStore.rename(compositeId, meta.customName);
    const provider = this.getProvider(parsed.provider);
    if (!this.#forkStore.get(compositeId)) {
      await provider.renameThread?.(parsed.profileId, parsed.rawId, meta.customName).catch(() => {});
    }
    this.#broadcast("thread_renamed", { threadId: compositeId, name: meta.customName });
    return { ok: true, threadId: compositeId, name: meta.customName };
  }

  async archiveThreads(compositeIds = [], archived = true) {
    const rawList = Array.isArray(compositeIds) ? compositeIds : [compositeIds];
    const seen = new Set();
    const parsedItems = [];
    for (const raw of rawList) {
      const id = String(raw || "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      parsedItems.push({ id, parsed: parseCompositeThreadId(id) });
    }
    if (!parsedItems.length) {
      throw Object.assign(new Error("至少需要选择一个会话"), { status: 400 });
    }
    const nextArchived = Boolean(archived);
    const cleanIds = parsedItems.map((item) => item.id);
    await this.#metaStore.setArchivedMany(cleanIds, nextArchived);
    for (const id of cleanIds) {
      await this.#forkStore.archive(id, nextArchived);
    }

    const syncNative = async () => {
      const concurrency = 6;
      for (let i = 0; i < parsedItems.length; i += concurrency) {
        const slice = parsedItems.slice(i, i + concurrency);
        await Promise.allSettled(slice.map(async ({ id, parsed }) => {
          if (this.#forkStore.get(id)) return;
          const provider = this.getProvider(parsed.provider);
          if (nextArchived) {
            await provider.archiveThread?.(parsed.profileId, parsed.rawId);
          } else {
            await provider.unarchiveThread?.(parsed.profileId, parsed.rawId);
          }
        }));
      }
    };
    if (parsedItems.length <= 6) {
      await syncNative();
    } else {
      void syncNative();
    }

    if (cleanIds.length === 1) {
      this.#broadcast("thread_archived", { threadId: cleanIds[0], archived: nextArchived });
    }
    this.#broadcast("threads_archived", {
      threadIds: cleanIds,
      count: cleanIds.length,
      archived: nextArchived,
    });
    return {
      ok: true,
      count: cleanIds.length,
      threadIds: cleanIds,
      archived: nextArchived,
    };
  }

  async archiveThread(compositeId, archived = true) {
    const res = await this.archiveThreads([compositeId], archived);
    return { ok: true, threadId: compositeId, archived: res.archived };
  }

  async close() {
    this.#closed = true;
    this.#lastTurnUserText.clear();
    this.#stopTelemetryTimer();
    this.#queue.close();
    for (const timer of this.#goalContinuationTimers) {
      clearTimeout(timer);
    }
    this.#goalContinuationTimers.clear();
    for (const timer of this.#drainTimers) {
      clearTimeout(timer);
    }
    this.#drainTimers.clear();
    await Promise.all([
      this.#queue.flush(),
      this.#inflightStore.flush(),
      this.#metaStore.flush(),
      this.#goalController.flush(),
      ...this.providerList().map((p) => p.close?.().catch(() => {})),
    ]);
    await this.#executionStats.flush();
  }
}

export { GOAL_COMPLETE_MARKER };
