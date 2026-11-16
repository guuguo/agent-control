import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import { resolve } from "node:path";
import { formatCompositeThreadId } from "../composite-id.mjs";
import { isBypassPermissionMode, normalizePermissionMode } from "../permissions.mjs";
import { cleanPreviewText, displayThreadTitle, mergeActiveTurnIntoHistory } from "../thread-display.mjs";
import { visibleControlThreads } from "../thread-access.mjs";
import {
  agyExecutable,
  AntigravityAcpClient,
  createAcpPermissionResponse,
  DEFAULT_AGY_MODEL,
  listAgyModelsFromCli,
  normalizeAcpPermissionRequest,
} from "./antigravity-acp-client.mjs";
import {
  readAntigravityIndexedThreadById,
  readAntigravityIndexedThreads,
  readAntigravityLiveActivity,
  readAntigravityQueuedMessages,
  readAntigravityThreadHistory,
  resolveAntigravityRootConversationId,
} from "./antigravity-history.mjs";
import { discoverAntigravityProfiles } from "./profile-discovery.mjs";

function buildAcpPromptBlocks(text, images = []) {
  const blocks = [];
  if (String(text || "").trim() || !(images && images.length)) {
    blocks.push({ type: "text", text: String(text || "") });
  }
  for (const image of images || []) {
    const src = typeof image === "string" ? image : (image?.dataUrl || image?.url || "");
    const match = src.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      blocks.push({ type: "image", mimeType: match[1], data: match[2] });
    }
  }
  return blocks;
}

export class AntigravityProvider {
  id = "antigravity";
  label = "Antigravity";
  #env;
  #profiles = [];
  #clients = new Map();
  #activePrompts = new Map();
  #preparingSessions = new Set();
  #recentlyEndedPrompts = new Map();
  #legacyProfiles = new Map();
  #modelsCache = null;
  #modelsRefreshPromise = null;
  #knownSessions = new Map();
  #sessionPermissionModes = new Map();
  #sessionClients = new Map();
  #onEvent;
  #onServerRequest;

  constructor({
    env = process.env,
    onEvent = () => {},
    onServerRequest = () => {},
  } = {}) {
    this.#env = env;
    this.#onEvent = onEvent;
    this.#onServerRequest = onServerRequest;
  }

  setCallbacks({ onEvent, onServerRequest } = {}) {
    if (typeof onEvent === "function") this.#onEvent = onEvent;
    if (typeof onServerRequest === "function") this.#onServerRequest = onServerRequest;
  }

  async refreshProfiles() {
    const discovered = await discoverAntigravityProfiles({ env: this.#env });
    this.#profiles = discovered.map((profile) => ({
      ...profile,
      account: {
        signedIn: Boolean(profile.exists),
        label: profile.profileType === "cli" ? "本地 CLI 配置" : "桌面应用配置",
      },
      installed: Boolean(profile.exists || agyExecutable(this.#env)),
    }));
    return this.#profiles;
  }

  async listProfiles() {
    if (!this.#profiles.length) await this.refreshProfiles();
    return this.#profiles.map((profile) => ({
      ...profile,
      online: Boolean(this.#findProfileClient(profile.id, { requireConnected: true }) || profile.installed),
    }));
  }

  #clientKey(resolvedProfileId, skipPermissions = false) {
    return `${resolvedProfileId}:${skipPermissions ? "skip" : "standard"}`;
  }

  #findProfileClient(resolvedProfileId, { requireConnected = false } = {}) {
    for (const candidateKey of [
      this.#clientKey(resolvedProfileId, true),
      this.#clientKey(resolvedProfileId, false),
      resolvedProfileId,
    ]) {
      const client = this.#clients.get(candidateKey);
      if (!client) continue;
      if (!requireConnected || client.isConnected) return client;
    }
    return null;
  }

  async #getProfile(profileId) {
    const profiles = await this.listProfiles();
    const requested = String(profileId || "").trim();
    if (!requested) {
      if (profiles[0]) return profiles[0];
      throw Object.assign(new Error("未找到可用的 Antigravity 实例配置"), { status: 404 });
    }
    const found = profiles.find((item) => item.id === requested);
    if (found) return found;
    if (!String(this.#env?.AGENT_CONTROL_AGY_APP_DATA_DIRS || "").trim()) {
      if (requested === "cli") {
        const cached = this.#legacyProfiles.get("cli");
        if (cached) return cached;
        const homeDir = String(this.#env?.HOME || this.#env?.USERPROFILE || os.homedir());
        const cliDir = resolve(homeDir, ".gemini", "antigravity-cli");
        if (existsSync(cliDir)) {
          const legacy = {
            id: "cli",
            provider: "antigravity",
            profileType: "cli",
            label: "Antigravity (CLI 历史)",
            home: cliDir,
            exists: true,
            installed: Boolean(existsSync(cliDir) || agyExecutable(this.#env)),
            online: true,
          };
          this.#legacyProfiles.set("cli", legacy);
          return legacy;
        }
      }
      if ((requested === "cli" || requested === "desktop" || requested === "default") && profiles[0]) {
        return profiles[0];
      }
    }
    throw Object.assign(new Error(`未知的 Antigravity 实例配置：${profileId}`), { status: 404 });
  }

  async #getClient(profileId, { skipPermissions = false } = {}) {
    const profile = await this.#getProfile(profileId);
    const resolvedProfileId = profile.id;
    const key = this.#clientKey(resolvedProfileId, Boolean(skipPermissions));
    const existing = this.#clients.get(key);
    if (existing) return existing;
    const client = new AntigravityAcpClient({
      appDataDir: profile.home,
      env: this.#env,
      skipPermissions: Boolean(skipPermissions),
    });
    client.on("sessionUpdate", (params) => this.#handleSessionUpdate(resolvedProfileId, params));
    client.on("serverRequest", (msg) => this.#handleServerRequest(profile, client, key, msg));
    client.on("exit", (info) => {
      this.#onEvent({
        type: "provider_exit",
        provider: "antigravity",
        profileId: resolvedProfileId,
        info,
      });
    });
    this.#clients.set(key, client);
    return client;
  }

  #handleSessionUpdate(profileId, params) {
    const rawId = String(params?.sessionId || "");
    const update = params?.update || {};
    const compositeId = rawId ? formatCompositeThreadId("antigravity", profileId, rawId) : "";
    const active = this.#activePrompts.get(rawId);
    const updateType = update.sessionUpdate || "";

    if (updateType === "session_info_update" && update.title && rawId) {
      const known = this.#knownSessions.get(`${profileId}:${rawId}`);
      if (known) known.title = update.title;
      this.#onEvent({
        type: "thread_updated",
        provider: "antigravity",
        profileId,
        rawId,
        threadId: compositeId,
        title: update.title,
      });
      return;
    }

    if (!active) {
      if (this.#preparingSessions.has(`${profileId}:${rawId}`)) {
        return;
      }
      let hasSameProfileActive = false;
      for (const entry of this.#activePrompts.values()) {
        if (!entry?.profileId || entry.profileId === profileId) {
          hasSameProfileActive = true;
          break;
        }
      }
      if (!hasSameProfileActive) return;
    }

    if (updateType === "agent_message_chunk") {
      const text = update.content?.text || "";
      if (text && active) {
        active.lastText = `${active.lastText || ""}${text}`;
        active.lastThought = "";
        active.phase = "正在生成回复…";
        active.detail = "";
        active.updatedAt = Math.floor(Date.now() / 1000);
        active.seq = (active.seq || 0) + 1;
      }
      this.#onEvent({
        type: "stream_delta",
        provider: "antigravity",
        profileId,
        rawId,
        threadId: compositeId,
        turnId: active?.turnId || "",
        itemId: active ? `${active.turnId}:agent` : `agy:${rawId}:agent`,
        kind: "text",
        delta: text,
      });
    } else if (updateType === "agent_thought_chunk") {
      const text = update.content?.text || "";
      if (text && active) {
        active.lastThought = `${active.lastThought || ""}${text}`.slice(-2400);
        if (!active.lastText) active.phase = "正在思考分析…";
        active.updatedAt = Math.floor(Date.now() / 1000);
        active.seq = (active.seq || 0) + 1;
      }
      this.#onEvent({
        type: "stream_delta",
        provider: "antigravity",
        profileId,
        rawId,
        threadId: compositeId,
        turnId: active?.turnId || "",
        itemId: active ? `${active.turnId}:thought` : `agy:${rawId}:thought`,
        kind: "reasoning",
        delta: text,
      });
    } else if (updateType === "tool_call" || updateType === "tool_call_update") {
      const toolCallId = String(update.toolCallId || update.id || "");
      if (active && update.title && toolCallId) {
        active.toolTitles?.set(toolCallId, update.title);
      }
      const resolvedTitle = update.title || (toolCallId && active?.toolTitles?.get(toolCallId)) || "";
      if (active) {
        if (updateType === "tool_call") {
          active.lastText = "";
          active.lastThought = "";
        }
        if (resolvedTitle) active.phase = resolvedTitle;
        active.detail = String(update.status || "");
        active.updatedAt = Math.floor(Date.now() / 1000);
        active.seq = (active.seq || 0) + 1;
      }
      const rawStatusStr = typeof update.status === "string" ? update.status : String(update.status ?? "");
      const slimUpdate = {
        ...(update.sessionUpdate ? { sessionUpdate: update.sessionUpdate } : {}),
        ...(toolCallId ? { toolCallId } : {}),
        ...(update.id ? { id: update.id } : {}),
        ...(resolvedTitle ? { title: resolvedTitle } : {}),
        ...(update.kind ? { kind: update.kind } : {}),
        ...(rawStatusStr ? { status: rawStatusStr.length > 600 ? `${rawStatusStr.slice(0, 600)}…` : rawStatusStr } : {}),
      };
      this.#onEvent({
        type: "acp_tool_update",
        provider: "antigravity",
        profileId,
        rawId,
        threadId: compositeId,
        turnId: active?.turnId || "",
        update: slimUpdate,
      });
    } else if (updateType === "plan") {
      this.#onEvent({
        type: "acp_plan_update",
        provider: "antigravity",
        profileId,
        rawId,
        threadId: compositeId,
        turnId: active?.turnId || "",
        entries: update.entries || [],
      });
    }
  }

  #getTranscriptMtimeMs(profile, rawId) {
    const cleanId = String(rawId || "").trim();
    if (!profile?.home || !cleanId) return 0;
    try {
      const st = statSync(resolve(profile.home, "brain", cleanId, ".system_generated", "logs", "transcript.jsonl"));
      return Number(st?.mtimeMs || 0);
    } catch {
      return 0;
    }
  }

  #recordEndedPrompt(profile, rawId, { interrupted = false } = {}) {
    const cleanId = String(rawId || "").trim();
    if (!profile?.id || !cleanId) return;
    this.#recentlyEndedPrompts.set(`${profile.id}:${cleanId}`, {
      endedAtMs: Date.now(),
      transcriptMtimeMs: this.#getTranscriptMtimeMs(profile, cleanId),
      interrupted: Boolean(interrupted),
    });
  }

  #isStalePostTurnDiskLive(profile, rawId) {
    const cleanId = String(rawId || "").trim();
    if (!profile?.id || !cleanId || this.#activePrompts.has(cleanId)) return false;
    const key = `${profile.id}:${cleanId}`;
    const ended = this.#recentlyEndedPrompts.get(key);
    if (!ended) return false;
    if (Date.now() - ended.endedAtMs > 120_000) {
      this.#recentlyEndedPrompts.delete(key);
      return false;
    }
    const currentMtimeMs = this.#getTranscriptMtimeMs(profile, cleanId);
    const baselineMs = Math.max(ended.transcriptMtimeMs || 0, ended.endedAtMs || 0);
    if (currentMtimeMs > baselineMs + 500) {
      this.#recentlyEndedPrompts.delete(key);
      return false;
    }
    return true;
  }

  #suppressStalePostTurnDiskLive(profile, rawId, diskLive) {
    if (!diskLive?.live) return diskLive;
    if (!this.#isStalePostTurnDiskLive(profile, rawId)) return diskLive;
    const prevCursor = String(diskLive.cursor || "idle");
    const nextCursor = prevCursor.startsWith("1:") ? `0:${prevCursor.slice(2)}` : prevCursor;
    return {
      ...diskLive,
      live: false,
      phase: "",
      detail: "",
      lastThought: "",
      cursor: nextCursor,
    };
  }

  #resolveOwnerRawId(profile, sessionRawId) {
    const cleanId = String(sessionRawId || "").trim();
    if (!cleanId) return "";
    const rootId = resolveAntigravityRootConversationId(profile?.home, cleanId);
    if (rootId && rootId !== cleanId) return rootId;
    if (!this.#activePrompts.has(cleanId)) {
      const sameProfileActive = [];
      for (const [promptRawId, entry] of this.#activePrompts.entries()) {
        if (!entry?.profileId || entry.profileId === profile?.id) {
          sameProfileActive.push(promptRawId);
        }
      }
      if (sameProfileActive.length === 1) {
        return sameProfileActive[0];
      }
    }
    return cleanId;
  }

  #handleServerRequest(profile, client, clientKey, msg) {
    if (msg.method !== "session/request_permission") return;
    const profileId = profile?.id || "desktop";
    const normalized = normalizeAcpPermissionRequest(msg);
    const rawId = normalized.threadId || "";
    const ownerRawId = this.#resolveOwnerRawId(profile, rawId) || rawId;
    const isSubagentRequest = Boolean(rawId && ownerRawId && ownerRawId !== rawId);
    const permMode = this.#sessionPermissionModes.get(`${profileId}:${rawId}`)
      || this.#sessionPermissionModes.get(`${profileId}:${ownerRawId}`)
      || this.#sessionPermissionModes.get(rawId)
      || this.#sessionPermissionModes.get(ownerRawId)
      || "";
    if (isBypassPermissionMode(permMode)) {
      if (client) {
        client.respond(normalized.rawId, createAcpPermissionResponse(normalized, { decision: "acceptForSession" }));
        return;
      }
    }
    const baseTitle = normalized.title || "Antigravity 请求授权";
    const title = isSubagentRequest && !baseTitle.startsWith("[子代理]")
      ? `[子代理] ${baseTitle}`
      : baseTitle;
    this.#onServerRequest({
      ...normalized,
      title,
      provider: "antigravity",
      profileId,
      clientKey,
      rawThreadId: ownerRawId,
      sourceSessionId: rawId,
      threadId: ownerRawId ? formatCompositeThreadId("antigravity", profileId, ownerRawId) : "",
    });
  }

  async setPermissionMode(profileId, rawId, permissionMode) {
    const profile = await this.#getProfile(profileId).catch(() => null);
    const resolvedProfileId = profile?.id || profileId;
    const cleanPerm = normalizePermissionMode(permissionMode);
    if (rawId) {
      this.#sessionPermissionModes.set(`${resolvedProfileId}:${rawId}`, cleanPerm);
    }
    const trackedKey = rawId ? this.#sessionClients.get(`${resolvedProfileId}:${rawId}`) : "";
    const client = (trackedKey && this.#clients.get(trackedKey))
      || this.#findProfileClient(resolvedProfileId, { requireConnected: true });
    if (client && client.isConnected && rawId) {
      await client.configureSession(rawId, { permissionMode: cleanPerm }).catch(() => null);
    }
    return { ok: true, permissionMode: cleanPerm };
  }

  respondServerRequest(profileId, rawRequest, input) {
    const targetProfileId = rawRequest?.profileId || profileId;
    const client = (rawRequest?.clientKey && this.#clients.get(rawRequest.clientKey))
      || this.#findProfileClient(targetProfileId, { requireConnected: true })
      || this.#findProfileClient(profileId, { requireConnected: true });
    if (!client) {
      throw Object.assign(new Error("Antigravity ACP 客户端未连接"), { status: 409 });
    }
    const payload = createAcpPermissionResponse(rawRequest, input);
    client.respond(rawRequest.rawId, payload);
    return { ok: true };
  }

  #refreshModelsCache() {
    if (!this.#modelsRefreshPromise) {
      this.#modelsRefreshPromise = listAgyModelsFromCli({ env: this.#env })
        .then((items) => {
          this.#modelsCache = { at: Date.now(), items };
          return items;
        })
        .finally(() => {
          this.#modelsRefreshPromise = null;
        });
    }
    return this.#modelsRefreshPromise;
  }

  async listModels(profileId = "desktop") {
    if (!this.#modelsCache) {
      await this.#refreshModelsCache();
    } else if (Date.now() - this.#modelsCache.at > 120_000) {
      void this.#refreshModelsCache().catch(() => {});
    }
    return this.#modelsCache.items.map((item) => ({
      ...item,
      profileId,
    }));
  }

  async probeProfile(profileId = "desktop", { timeoutMs = 8_000 } = {}) {
    await this.#getProfile(profileId);
    const started = Date.now();
    this.#modelsCache = null;
    this.#modelsRefreshPromise = null;
    let timer;
    try {
      const items = await Promise.race([
        this.listModels(profileId),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Antigravity 测通超时 (${timeoutMs}ms)`)), timeoutMs);
        }),
      ]);
      return {
        ok: true,
        latencyMs: Math.max(1, Date.now() - started),
        modelCount: Array.isArray(items) ? items.length : 0,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  #normalizeThread(profile, rawThread) {
    const rawId = String(rawThread.id || "");
    const active = this.#activePrompts.get(rawId);
    const known = this.#knownSessions.get(`${profile.id}:${rawId}`);
    const permMode = this.#sessionPermissionModes.get(`${profile.id}:${rawId}`) || rawThread.permissionMode || "";
    return {
      id: formatCompositeThreadId("antigravity", profile.id, rawId),
      rawId,
      provider: "antigravity",
      providerLabel: "Antigravity",
      profileId: profile.id,
      profileLabel: profile.label,
      name: rawThread.name || rawThread.title || "",
      upstreamTitle: rawThread.name || rawThread.title || known?.title || "",
      stepCount: Number(rawThread.stepCount) || 0,
      firstUserText: rawThread.firstUserText || "",
      lastUserText: rawThread.lastUserText || "",
      hasFollowUpTurns: Boolean(rawThread.hasFollowUpTurns),
      title: displayThreadTitle(rawThread),
      preview: cleanPreviewText(rawThread.preview || rawThread.title || "", 120),
      cwd: rawThread.cwd || os.homedir(),
      createdAt: Number(rawThread.createdAt) || 0,
      updatedAt: Number(rawThread.updatedAt) || 0,
      model: rawThread.model || known?.model || DEFAULT_AGY_MODEL,
      reasoningEffort: rawThread.reasoningEffort || known?.reasoningEffort || "high",
      ...(permMode ? { permissionMode: permMode } : {}),
      threadSource: rawThread.threadSource || "user",
      turns: rawThread.turns,
      largeHistory: Boolean(rawThread.largeHistory),
      archived: false,
      live: Boolean(active || (rawThread.live && !this.#isStalePostTurnDiskLive(profile, rawId))),
      nativeQueuedCount: Number(rawThread.nativeQueuedCount) || 0,
    };
  }

  async listThreads(profileId, { limit = 300 } = {}) {
    const profile = await this.#getProfile(profileId);
    let rows = readAntigravityIndexedThreads(profile.home, {
      profileType: profile.profileType || profile.id,
      limit,
    });
    if (!rows) {
      const client = await this.#getClient(profileId);
      const res = await client.listSessions().catch(() => ({ sessions: [] }));
      rows = (res?.sessions || []).map((s) => ({
        id: s.sessionId,
        title: s.title || "",
        name: s.title || "",
        preview: s.title || "",
        cwd: s.cwd || os.homedir(),
        updatedAt: Math.floor((Date.parse(s.updatedAt || "") || Date.now()) / 1000),
        createdAt: Math.floor((Date.parse(s.updatedAt || "") || Date.now()) / 1000),
        threadSource: "user",
      }));
    }
    const byId = new Map(rows.map((item) => [item.id, item]));
    for (const [key, known] of this.#knownSessions.entries()) {
      if (!key.startsWith(`${profile.id}:`)) continue;
      if (!byId.has(known.id)) byId.set(known.id, known);
    }
    const merged = [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
    return visibleControlThreads(merged.map((item) => this.#normalizeThread(profile, item)));
  }

  #buildActivityPayload(active, diskLive) {
    const live = Boolean(active || diskLive?.live);
    const cursor = `${active ? `acp:${active.turnId}:${active.seq || 0}` : "noacp"}|${diskLive?.cursor || "idle"}`;
    if (!live) {
      return {
        live: false,
        cursor,
        activity: null,
        streaming: null,
      };
    }
    const phase = (active?.phase && active.phase !== "Antigravity 执行中")
      ? active.phase
      : (diskLive?.phase || active?.phase || "Antigravity 执行中");
    const activeDetail = String(active?.detail || "").trim();
    const isNoiseDetail = /^(?:completed|in_progress|inprogress|pending|running|started|done|ok)$/i.test(activeDetail);
    const detail = (activeDetail && !isNoiseDetail)
      ? activeDetail
      : (diskLive?.detail || activeDetail || "");
    const updatedAt = Math.max(active?.updatedAt || 0, diskLive?.updatedAt || 0) || Math.floor(Date.now() / 1000);
    return {
      live: true,
      cursor,
      activity: {
        turnId: active?.turnId || "",
        status: "running",
        phase,
        text: detail,
        updatedAt,
      },
      streaming: {
        turnId: active?.turnId || "",
        text: active?.lastText || "",
        thought: active?.lastThought || (!active ? diskLive?.lastThought : "") || "",
      },
    };
  }

  async listNativeQueuedTurns(profileId, rawId) {
    const profile = await this.#getProfile(profileId);
    const profileType = profile.profileType || profile.id;
    const compositeId = formatCompositeThreadId("antigravity", profile.id, rawId);
    const items = await readAntigravityQueuedMessages(profile.home, rawId, { profileType });
    return items.map((item) => ({ ...item, threadId: compositeId }));
  }

  async readThread(profileId, rawId, { cursor = null, detail = "auto", limit = 30 } = {}) {
    const profile = await this.#getProfile(profileId);
    const profileType = profile.profileType || profile.id;
    const indexed = readAntigravityIndexedThreadById(profile.home, rawId, {
      profileType,
    }) || this.#knownSessions.get(`${profile.id}:${rawId}`) || null;

    const active = this.#activePrompts.get(rawId);
    const rawDiskLive = await readAntigravityLiveActivity(profile.home, rawId, {
      indexedThread: indexed,
      profileType,
    });
    const diskLive = this.#suppressStalePostTurnDiskLive(profile, rawId, rawDiskLive);
    const payload = this.#buildActivityPayload(active, diskLive);

    const { thread, nextCursor } = await readAntigravityThreadHistory(profile.home, rawId, {
      indexedThread: indexed,
      cursor,
      detail,
      limit,
      isThreadLive: payload.live,
    });

    thread.turns = mergeActiveTurnIntoHistory(thread.turns, active, { liveItemSuffix: "agent" });

    const compositeId = formatCompositeThreadId("antigravity", profile.id, rawId);
    const nativeQueuedTurns = (Array.isArray(diskLive.nativeQueuedTurns) ? diskLive.nativeQueuedTurns : [])
      .map((item) => ({ ...item, threadId: compositeId }));

    const normalized = this.#normalizeThread(profile, {
      ...indexed,
      ...thread,
      live: payload.live,
      nativeQueuedCount: nativeQueuedTurns.length,
      updatedAt: Math.max(Number(indexed?.updatedAt) || 0, Number(thread?.updatedAt) || 0, diskLive.updatedAt || 0),
    });
    return {
      thread: normalized,
      nextCursor,
      activity: payload.activity,
      activityCursor: payload.cursor,
      streaming: payload.streaming,
      nativeQueuedTurns,
    };
  }

  async getActivity(profileId, rawId, { cursor = null } = {}) {
    const profile = await this.#getProfile(profileId);
    const profileType = profile.profileType || profile.id;
    const compositeId = formatCompositeThreadId("antigravity", profile.id, rawId);
    const active = this.#activePrompts.get(rawId);
    const indexed = this.#knownSessions.get(`${profile.id}:${rawId}`) || null;
    const rawDiskLive = await readAntigravityLiveActivity(profile.home, rawId, {
      indexedThread: indexed?.live ? indexed : null,
      profileType,
    });
    const diskLive = this.#suppressStalePostTurnDiskLive(profile, rawId, rawDiskLive);
    const payload = this.#buildActivityPayload(active, diskLive);
    const nativeQueuedTurns = (Array.isArray(diskLive.nativeQueuedTurns) ? diskLive.nativeQueuedTurns : [])
      .map((item) => ({ ...item, threadId: compositeId }));
    return {
      cursor: payload.cursor,
      changed: cursor ? cursor !== payload.cursor : payload.live,
      live: payload.live,
      activity: payload.activity,
      streaming: payload.streaming,
      nativeQueuedTurns,
    };
  }

  async startThread({
    profileId = "desktop",
    cwd = os.homedir(),
    text = "",
    images = [],
    model = "",
    effort = "",
    permissionMode = "workspace",
  } = {}) {
    const profile = await this.#getProfile(profileId);
    const cleanPerm = normalizePermissionMode(permissionMode);
    const skipPermissions = isBypassPermissionMode(cleanPerm);
    const clientKey = this.#clientKey(profile.id, skipPermissions);
    const client = await this.#getClient(profile.id, { skipPermissions });
    const targetCwd = cwd && existsSync(cwd) ? cwd : os.homedir();
    const created = await client.newSession({ cwd: targetCwd });
    const rawId = String(created.sessionId || randomUUID());
    const now = Math.floor(Date.now() / 1000);
    const effectiveModel = model || DEFAULT_AGY_MODEL;
    this.#sessionPermissionModes.set(`${profile.id}:${rawId}`, cleanPerm);
    this.#sessionClients.set(`${profile.id}:${rawId}`, clientKey);
    const draft = {
      id: rawId,
      cwd: targetCwd,
      createdAt: now,
      updatedAt: now,
      model: effectiveModel,
      permissionMode: cleanPerm,
      preview: cleanPreviewText(text || "新 Antigravity 会话", 120),
      title: "",
    };
    this.#knownSessions.set(`${profile.id}:${rawId}`, draft);
    const thread = this.#normalizeThread(profile, draft);

    if (String(text || "").trim() || (images && images.length)) {
      const sent = await this.sendTurn({
        profileId: profile.id,
        rawId,
        cwd: draft.cwd,
        text,
        images,
        model: effectiveModel,
        effort,
        permissionMode: cleanPerm,
      });
      return { thread, turn: sent.turn };
    }
    return { thread, turn: null };
  }

  async sendTurn({
    profileId = "desktop",
    rawId,
    cwd = "",
    text = "",
    images = [],
    model = "",
    effort = "",
    permissionMode = "workspace",
    steer = false,
  } = {}) {
    const profile = await this.#getProfile(profileId);
    const resolvedProfileId = profile.id;
    if (steer && this.#activePrompts.has(rawId)) {
      await this.interrupt({
        profileId: resolvedProfileId,
        rawId,
        waitMs: 4_500,
        forceRelease: true,
      }).catch(() => {});
    }
    if (this.#activePrompts.has(rawId)) {
      throw Object.assign(new Error("Antigravity 会话当前正在运行，请等待完成或先中断"), {
        status: 409,
        code: "thread_busy",
      });
    }
    this.#recentlyEndedPrompts.delete(`${resolvedProfileId}:${rawId}`);
    const cleanPerm = normalizePermissionMode(permissionMode);
    const skipPermissions = isBypassPermissionMode(cleanPerm);
    const clientKey = this.#clientKey(resolvedProfileId, skipPermissions);
    const client = await this.#getClient(resolvedProfileId, { skipPermissions });
    this.#sessionClients.set(`${resolvedProfileId}:${rawId}`, clientKey);

    const indexed = (readAntigravityIndexedThreads(profile.home, {
      profileType: profile.profileType || profile.id,
      limit: 500,
    }) || []).find((item) => item.id === rawId) || this.#knownSessions.get(`${resolvedProfileId}:${rawId}`);
    const knownSession = this.#knownSessions.get(`${resolvedProfileId}:${rawId}`);
    const candidateCwd = cwd || indexed?.cwd || os.homedir();
    const resolvedCwd = candidateCwd && existsSync(candidateCwd) ? candidateCwd : os.homedir();
    const effectiveModel = model || knownSession?.model || indexed?.model || DEFAULT_AGY_MODEL;

    const prepKey = `${resolvedProfileId}:${rawId}`;
    this.#preparingSessions.add(prepKey);
    try {
      await client.ensureSessionLoaded(rawId, { cwd: resolvedCwd });
      this.#sessionPermissionModes.set(`${resolvedProfileId}:${rawId}`, cleanPerm);
      await client.configureSession(rawId, { model: effectiveModel, effort, permissionMode: cleanPerm });
      if (knownSession) {
        knownSession.model = effectiveModel;
        knownSession.permissionMode = cleanPerm;
        if (effort) knownSession.reasoningEffort = effort;
      } else {
        this.#knownSessions.set(`${resolvedProfileId}:${rawId}`, {
          id: rawId,
          cwd: resolvedCwd,
          updatedAt: Math.floor(Date.now() / 1000),
          model: effectiveModel,
          permissionMode: cleanPerm,
          ...(effort ? { reasoningEffort: effort } : {}),
        });
      }
    } finally {
      this.#preparingSessions.delete(prepKey);
    }

    const turnId = `agy-turn-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const startedAt = Math.floor(Date.now() / 1000);
    const activeEntry = {
      profileId: resolvedProfileId,
      clientKey,
      turnId,
      startedAt,
      updatedAt: startedAt,
      userText: String(text || ""),
      lastText: "",
      lastThought: "",
      phase: "Antigravity 执行中",
      detail: "",
      toolTitles: new Map(),
      seq: 0,
      interrupted: false,
      settled: false,
    };
    this.#activePrompts.set(rawId, activeEntry);
    const compositeId = formatCompositeThreadId("antigravity", resolvedProfileId, rawId);

    this.#onEvent({
      type: "turn_started",
      provider: "antigravity",
      profileId: resolvedProfileId,
      rawId,
      threadId: compositeId,
      model: effectiveModel,
      effort: effort || knownSession?.reasoningEffort || "",
      turn: {
        id: turnId,
        status: "inProgress",
        startedAt,
        items: [{
          type: "userMessage",
          id: `user-${turnId}`,
          content: [{ type: "text", text: String(text || "") }],
        }],
      },
    });

    const finalizePrompt = ({ status, stopReason = "", error = null }) => {
      if (activeEntry.settled) return;
      activeEntry.settled = true;
      if (this.#activePrompts.get(rawId) === activeEntry) {
        this.#activePrompts.delete(rawId);
      }
      this.#recordEndedPrompt(profile, rawId, { interrupted: status === "interrupted" });
      this.#onEvent({
        type: "turn_completed",
        provider: "antigravity",
        profileId: resolvedProfileId,
        rawId,
        threadId: compositeId,
        turnId,
        status,
        ...(stopReason ? { stopReason } : {}),
        lastAgentMessage: activeEntry.lastText,
        error,
      });
    };

    const promptBlocks = buildAcpPromptBlocks(text, images);
    const promptPromise = client.sendPrompt(rawId, promptBlocks).then((res) => {
      const stopReason = String(res?.stopReason || "end_turn");
      const status = activeEntry.interrupted || stopReason === "cancelled" ? "interrupted" : "completed";
      finalizePrompt({ status, stopReason, error: null });
      return res;
    }).catch((error) => {
      const status = activeEntry.interrupted || error?.aborted ? "interrupted" : "failed";
      finalizePrompt({
        status,
        error: status === "interrupted" ? null : { message: error?.message || "Antigravity 执行失败" },
      });
    });
    // Prevent unhandled rejection; completion events notify subscribers.
    promptPromise.catch(() => {});

    return {
      turn: { id: turnId, status: "inProgress", startedAt },
      thread: this.#normalizeThread(profile, indexed || { id: rawId, cwd: resolvedCwd }),
    };
  }

  async interrupt({ profileId = "desktop", rawId, waitMs = 2_000, forceRelease = true } = {}) {
    const profile = await this.#getProfile(profileId);
    const active = this.#activePrompts.get(rawId);
    const sessionKey = `${profile.id}:${rawId}`;
    const trackedKey = active?.clientKey || this.#sessionClients.get(sessionKey) || "";
    const trackedClient = trackedKey ? this.#clients.get(trackedKey) : null;
    const permMode = this.#sessionPermissionModes.get(sessionKey) || "";
    const client = trackedClient
      || this.#findProfileClient(profile.id, { requireConnected: true })
      || await this.#getClient(profile.id, { skipPermissions: isBypassPermissionMode(permMode) });
    if (active) active.interrupted = true;
    await client.cancel(rawId).catch(() => {});
    if (active && waitMs > 0) {
      const deadline = Date.now() + waitMs;
      while (this.#activePrompts.get(rawId) === active && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    let forceReleased = false;
    if (forceRelease && active && this.#activePrompts.get(rawId) === active) {
      forceReleased = client.abortSessionPrompt(rawId, "中断等待超时，已强制释放会话") > 0;
      await new Promise((r) => setTimeout(r, 10));
      if (this.#activePrompts.get(rawId) === active) {
        this.#activePrompts.delete(rawId);
      }
    }
    this.#recordEndedPrompt(profile, rawId, { interrupted: true });
    return { ok: true, turnId: active?.turnId || "", forceReleased };
  }

  async close() {
    for (const client of this.#clients.values()) {
      await client.close();
    }
    this.#clients.clear();
    this.#activePrompts.clear();
    this.#recentlyEndedPrompts.clear();
    this.#legacyProfiles.clear();
    this.#sessionClients.clear();
  }
}
