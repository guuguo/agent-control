import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import { formatCompositeThreadId } from "../composite-id.mjs";
import { normalizePermissionMode } from "../permissions.mjs";
import { normalizePlatform } from "../platform.mjs";
import { cleanPreviewText, displayThreadTitle, mergeActiveTurnIntoHistory } from "../thread-display.mjs";
import { GrokHistoryIndex, readGrokThreadHistory } from "./grok-history.mjs";
import {
  DEFAULT_GROK_MODELS,
  GrokTurnManager,
  grokExecutable,
  probeGrokProfile,
  readGrokModelsCatalog,
} from "./grok-runner.mjs";
import { discoverGrokProfiles, readGrokPublicAccount } from "./profile-discovery.mjs";

export class GrokProvider {
  id = "grok";
  label = "Grok";
  #env;
  #platform;
  #onEvent;
  #profiles = [];
  #historyIndex;
  #turns;
  #pendingThreads = new Map();
  #startedSessions = new Set();
  #rawToProfile = new Map();

  constructor({
    env = process.env,
    platform = process.platform,
    onEvent = () => {},
    historyIndex = null,
    turns = null,
    desktopIndexPath = null,
  } = {}) {
    this.#env = env;
    this.#platform = normalizePlatform(platform);
    this.#onEvent = onEvent;
    this.#historyIndex = historyIndex || new GrokHistoryIndex({
      env,
      platform: this.#platform,
      desktopIndexPath,
    });
    this.#turns = turns || new GrokTurnManager({ env, platform: this.#platform });

    this.#turns.on("event", (evt) => {
      const profileId = this.#rawToProfile.get(evt.rawId) || "default";
      if (evt.type === "turn_completed") {
        if (evt.status === "completed") {
          this.#startedSessions.add(evt.rawId);
        }
        const pending = this.#pendingThreads.get(evt.rawId);
        if (pending) {
          pending.updatedAt = Math.floor(Date.now() / 1000);
          if (evt.lastAgentMessage) {
            pending.preview = cleanPreviewText(evt.lastAgentMessage, 120);
          }
        }
      }
      this.#onEvent({
        ...evt,
        provider: this.id,
        profileId,
        threadId: formatCompositeThreadId(this.id, profileId, evt.rawId),
      });
    });
  }

  async refreshProfiles() {
    const discovered = await discoverGrokProfiles({ env: this.#env, platform: this.#platform });
    const hasBinary = Boolean(grokExecutable(this.#env));
    this.#profiles = await Promise.all(
      discovered.map(async (profile) => {
        const account = await readGrokPublicAccount(profile.home, profile.cockpitAccount, this.#env);
        const installed = Boolean(hasBinary || profile.exists);
        return {
          ...profile,
          grokHome: profile.home,
          account,
          installed,
          online: Boolean(installed && profile.authenticated !== false),
        };
      }),
    );
    return this.#profiles;
  }

  async listProfiles() {
    if (!this.#profiles.length) await this.refreshProfiles();
    return this.#profiles.map((p) => ({ ...p }));
  }

  async #getProfile(profileId = "default") {
    const profiles = await this.listProfiles();
    const targetId = String(profileId || "").trim() || "default";
    const found = profiles.find((p) => p.id === targetId);
    if (!found) {
      throw Object.assign(new Error(`未知的 Grok 实例配置：${profileId}`), { status: 404 });
    }
    return found;
  }

  async listModels(profileIdOrOpts = "default") {
    const profileId = typeof profileIdOrOpts === "string"
      ? profileIdOrOpts
      : (profileIdOrOpts?.profileId || "default");
    const profiles = await this.listProfiles();
    const profile = profiles.find((p) => p.id === profileId) || profiles[0] || null;
    const primaryHome = profile?.home || profile?.grokHome || "";
    const fallbackHomes = profiles
      .map((p) => p.home || p.grokHome)
      .filter((h) => h && h !== primaryHome);
    return readGrokModelsCatalog(primaryHome, fallbackHomes);
  }

  async probeProfile(profileId = "default", { timeoutMs = 10_000 } = {}) {
    const profile = await this.#getProfile(profileId);
    return probeGrokProfile(profile, { env: this.#env, platform: this.#platform, timeoutMs });
  }

  #decorateThread(profile, item) {
    const rawId = String(item.id || item.rawId || "").trim();
    const activeTurn = this.#turns.getActiveTurn(rawId);
    const title = displayThreadTitle({
      ...item,
      name: item.name || "",
      preview: item.preview || "",
    });
    const isLive = Boolean(activeTurn);
    return {
      id: formatCompositeThreadId(this.id, profile.id, rawId),
      rawId,
      provider: this.id,
      providerLabel: "Grok",
      profileId: profile.id,
      profileLabel: profile.label,
      title,
      name: item.name || "",
      upstreamTitle: item.name || "",
      firstUserText: item.firstUserText || "",
      lastUserText: item.lastUserText || "",
      hasFollowUpTurns: Boolean(item.hasFollowUpTurns),
      preview: item.preview || cleanPreviewText(title, 120),
      cwd: item.cwd || os.homedir(),
      gitInfo: item.gitInfo || null,
      createdAt: item.createdAt || Math.floor(Date.now() / 1000),
      updatedAt: isLive ? Math.max(item.updatedAt || 0, Math.floor(Date.now() / 1000)) : (item.updatedAt || 0),
      model: item.model || DEFAULT_GROK_MODELS[0].id,
      reasoningEffort: item.reasoningEffort || "high",
      turns: item.turns,
      archived: Boolean(item.archived),
      live: isLive,
      hasActiveTurn: isLive,
      filePath: item.filePath || "",
    };
  }

  async listThreads(profileIdOrOpts = "default", opts = {}) {
    const profileId = typeof profileIdOrOpts === "string"
      ? profileIdOrOpts
      : (profileIdOrOpts?.profileId || "default");
    const options = typeof profileIdOrOpts === "string" ? (opts || {}) : (profileIdOrOpts || {});
    const limit = Number(options.limit) || 300;
    const includeArchived = Boolean(options.includeArchived || options.archived);

    const profile = await this.#getProfile(profileId);
    const homeDir = profile.home || profile.grokHome || "";
    const persisted = await this.#historyIndex.listSessions(homeDir, { limit });
    const seen = new Set();
    const results = [];

    for (const item of persisted) {
      if (!includeArchived && item.archived) continue;
      seen.add(item.id);
      results.push(this.#decorateThread(profile, item));
    }

    for (const pending of this.#pendingThreads.values()) {
      if (pending.profileId !== profile.id || seen.has(pending.id)) continue;
      if (!includeArchived && pending.archived) continue;
      seen.add(pending.id);
      results.push(this.#decorateThread(profile, pending));
    }

    results.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return results.slice(0, Math.max(1, limit));
  }

  async readThread(profileIdOrOpts, rawIdArg, opts = {}) {
    let profileId = "default";
    let rawId = "";
    let options = opts || {};
    if (typeof profileIdOrOpts === "object" && profileIdOrOpts !== null) {
      profileId = profileIdOrOpts.profileId || "default";
      rawId = profileIdOrOpts.rawId || "";
      options = profileIdOrOpts;
    } else {
      profileId = profileIdOrOpts || "default";
      rawId = rawIdArg || "";
    }
    const { cursor = null, limit = 40 } = options;

    const profile = await this.#getProfile(profileId);
    const homeDir = profile.home || profile.grokHome || "";
    const cleanId = String(rawId || "").trim();
    const history = await readGrokThreadHistory(homeDir, cleanId, {
      index: this.#historyIndex,
      cursor,
      limit,
    });
    const pending = this.#pendingThreads.get(cleanId);
    if (!history && (!pending || pending.profileId !== profile.id)) {
      throw Object.assign(new Error(`未找到 Grok 会话：${cleanId}`), { status: 404 });
    }

    const activeTurn = this.#turns.getActiveTurn(cleanId);
    const baseThread = history ? history.thread : pending;
    const baseTurns = history ? history.turns : [];
    const mergedTurns = cursor ? baseTurns : mergeActiveTurnIntoHistory(baseTurns, activeTurn, { liveItemSuffix: "grok-live" });
    const thread = this.#decorateThread(profile, {
      ...baseThread,
      turns: mergedTurns,
    });

    return {
      thread,
      turns: mergedTurns,
      nextCursor: history?.nextCursor || null,
      hasMore: Boolean(history?.hasMore),
      totalTurns: history ? history.totalTurns : mergedTurns.length,
      activity: activeTurn
        ? {
            turnId: activeTurn.turnId,
            status: "running",
            phase: "Grok 执行中",
            text: (activeTurn.lastText || "").slice(-200),
            updatedAt: Math.floor(Date.now() / 1000),
          }
        : null,
      activityCursor: String(thread.updatedAt || Date.now()),
    };
  }

  async getActivity(profileIdOrOpts, rawIdArg, opts = {}) {
    let profileId = "default";
    let rawId = "";
    let options = opts || {};
    if (typeof profileIdOrOpts === "object" && profileIdOrOpts !== null) {
      profileId = profileIdOrOpts.profileId || "default";
      rawId = profileIdOrOpts.rawId || "";
      options = profileIdOrOpts;
    } else {
      profileId = profileIdOrOpts || "default";
      rawId = rawIdArg || "";
    }
    const cleanId = String(rawId || "").trim();
    const cursor = options.cursor ?? null;

    const activeTurn = this.#turns.getActiveTurn(cleanId);
    if (activeTurn) {
      const nextCursor = `active:${activeTurn.turnId}:${(activeTurn.lastText || "").length}`;
      return {
        cursor: nextCursor,
        changed: cursor ? cursor !== nextCursor : true,
        live: true,
        activity: {
          turnId: activeTurn.turnId,
          status: "running",
          phase: "Grok 执行中",
          text: (activeTurn.lastText || "").slice(-200),
          updatedAt: Math.floor(Date.now() / 1000),
        },
        streaming: {
          turnId: activeTurn.turnId,
          text: activeTurn.lastText || "",
          thought: activeTurn.reasoningText || "",
        },
      };
    }

    const profile = await this.#getProfile(profileId);
    const homeDir = profile.home || profile.grokHome || "";
    const located = await this.#historyIndex.findSession(homeDir, cleanId);
    const chatPath = located ? resolve(located.sessionDir, "chat_history.jsonl") : "";
    const sumPath = located ? resolve(located.sessionDir, "summary.json") : "";
    const fileStat = chatPath
      ? ((await stat(chatPath).catch(() => null)) || (await stat(sumPath).catch(() => null)))
      : null;
    const nextCursor = fileStat
      ? `file:${fileStat.size}:${Math.floor(fileStat.mtimeMs)}`
      : (located ? located.sessionDir : "idle");
    const recentlyActive = Boolean(fileStat && (Date.now() - fileStat.mtimeMs < 15_000));
    return {
      cursor: nextCursor,
      changed: Boolean(cursor && cursor !== nextCursor),
      live: recentlyActive,
      activity: recentlyActive
        ? {
            turnId: "",
            status: "running",
            phase: "Grok 执行中",
            text: "",
            updatedAt: Math.floor(fileStat.mtimeMs / 1000),
          }
        : null,
    };
  }

  #assertCanExecute(profile) {
    if (!profile.installed && !grokExecutable(this.#env)) {
      throw Object.assign(new Error("未检测到 grok CLI"), { status: 400 });
    }
    if (profile.authenticated === false) {
      throw Object.assign(
        new Error("当前 Grok 实例未登录，请切换至已登录的 Grok 实例后再发送消息，或在终端执行 grok login"),
        { status: 400 },
      );
    }
  }

  async startThread({
    profileId = "default",
    cwd,
    text = "",
    prompt = "",
    images = [],
    model = "",
    effort = "",
    reasoningEffort = "",
    permissionMode = "workspace",
  } = {}) {
    const profile = await this.#getProfile(profileId);
    this.#assertCanExecute(profile);

    const rawId = randomUUID();
    const workDir = String(cwd || "").trim() || os.homedir();
    const nowSec = Math.floor(Date.now() / 1000);
    const inputText = String(text || prompt || "");
    const rawEffort = effort || reasoningEffort;
    const inputEffort = (typeof rawEffort === "object" && rawEffort
      ? String(rawEffort.reasoningEffort ?? rawEffort.id ?? rawEffort.value ?? "")
      : String(rawEffort || "")
    ).trim().toLowerCase().replace(/^\[object object\]$/i, "");
    const homeDir = profile.home || profile.grokHome || "";

    const pending = {
      id: rawId,
      profileId: profile.id,
      cwd: workDir,
      gitInfo: null,
      createdAt: nowSec,
      updatedAt: nowSec,
      name: "",
      preview: cleanPreviewText(inputText.trim() || "新 Grok 会话", 120),
      model: String(model || "").trim() || DEFAULT_GROK_MODELS[0].id,
      reasoningEffort: inputEffort || "high",
      turns: [],
    };
    this.#pendingThreads.set(rawId, pending);
    this.#rawToProfile.set(rawId, profile.id);

    let turnRes = null;
    if (inputText.trim() || (Array.isArray(images) && images.length > 0)) {
      const turnId = `grok-turn-${Date.now()}`;
      this.#startedSessions.add(rawId);
      turnRes = await this.#turns.startTurn({
        rawId,
        turnId,
        cwd: workDir,
        prompt: inputText,
        images,
        model: String(model || "").trim(),
        reasoningEffort: inputEffort,
        permissionMode: normalizePermissionMode(permissionMode),
        resume: false,
        grokHome: homeDir,
        env: this.#env,
      });
    }

    return {
      thread: this.#decorateThread(profile, pending),
      turn: turnRes?.turn || null,
    };
  }

  async sendTurn({
    profileId = "default",
    rawId,
    cwd = "",
    text = "",
    prompt = "",
    images = [],
    model = "",
    effort = "",
    reasoningEffort = "",
    permissionMode = "workspace",
    steer = false,
  } = {}) {
    const profile = await this.#getProfile(profileId);
    this.#assertCanExecute(profile);

    const cleanId = String(rawId || "").trim();
    if (!cleanId) {
      throw Object.assign(new Error("缺少 Grok 会话 ID"), { status: 400 });
    }

    if (steer && this.#turns.hasActiveTurn(cleanId)) {
      await this.#turns.interrupt(cleanId);
      const waitDeadline = Date.now() + 5_000;
      while (this.#turns.hasActiveTurn(cleanId) && Date.now() < waitDeadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    const homeDir = profile.home || profile.grokHome || "";
    const located = await this.#historyIndex.findSession(homeDir, cleanId);
    const pending = this.#pendingThreads.get(cleanId);
    const historySummary = located
      ? await readGrokThreadHistory(homeDir, cleanId, { index: this.#historyIndex, limit: 1 }).catch(() => null)
      : null;

    if (!located && !pending) {
      throw Object.assign(new Error(`未找到 Grok 会话：${cleanId}`), { status: 404 });
    }

    const resume = Boolean(located || this.#startedSessions.has(cleanId));
    const inputText = String(text || prompt || "");
    const rawEffort = effort || reasoningEffort;
    const inputEffort = (typeof rawEffort === "object" && rawEffort
      ? String(rawEffort.reasoningEffort ?? rawEffort.id ?? rawEffort.value ?? "")
      : String(rawEffort || "")
    ).trim().toLowerCase().replace(/^\[object object\]$/i, "");
    const effectiveCwd = String(cwd || "").trim()
      || historySummary?.thread?.cwd
      || pending?.cwd
      || os.homedir();
    const effectiveModel = String(model || "").trim()
      || historySummary?.thread?.model
      || pending?.model
      || "";
    const effectiveEffort = inputEffort
      || historySummary?.thread?.reasoningEffort
      || pending?.reasoningEffort
      || "";

    this.#rawToProfile.set(cleanId, profile.id);
    this.#startedSessions.add(cleanId);

    const turnId = `grok-turn-${Date.now()}`;
    const turnRes = await this.#turns.startTurn({
      rawId: cleanId,
      turnId,
      cwd: effectiveCwd,
      prompt: inputText,
      images,
      model: effectiveModel,
      reasoningEffort: effectiveEffort,
      permissionMode: normalizePermissionMode(permissionMode),
      resume,
      grokHome: homeDir,
      env: this.#env,
    });

    const thread = this.#decorateThread(profile, {
      id: cleanId,
      cwd: effectiveCwd,
      updatedAt: Math.floor(Date.now() / 1000),
      model: effectiveModel || DEFAULT_GROK_MODELS[0].id,
      reasoningEffort: effectiveEffort || "high",
      preview: cleanPreviewText(inputText, 120),
    });

    return {
      turn: turnRes.turn,
      thread,
    };
  }

  async respondServerRequest() {
    throw Object.assign(
      new Error("Grok headless 模式不支持交互式工具审批弹窗，请使用工作区或完全自动权限"),
      { status: 409 },
    );
  }

  async interrupt({ rawId } = {}) {
    return this.#turns.interrupt(rawId);
  }

  async close() {
    await this.#turns.close();
  }
}
