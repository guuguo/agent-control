import { apiGet, apiPost, apiUrl } from "./api-client.js?v=20261117goalcontext";
import { renderExecutionStatsHtml } from "./execution-stats.js?v=20261117goalcontext";
import {
  extractGoalDirective,
  renderQueuedTurnsPanelHtml,
  resolveComposerSubmission,
  submitComposerRequest,
} from "./composer-mode.js?v=20261117goalcontext";
import {
  closeCustomSelectMenu,
  initComposerCustomSelects,
  syncAllCustomSelects,
} from "./custom-select.js?v=20261117goalcontext";
import { hydrateDeclarativeIcons, iconSvg, providerIconSvg } from "./icons.js?v=20261117goalcontext";
import {
  compressImageFileForUpload,
  estimateDataUrlBytes,
  formatByteSize,
  validateImageBatchBudget,
} from "./image-attachment.js?v=20261117goalcontext";
import {
  abbreviateMiddleText,
  buildSelectableTelemetryItems,
  compactEffortBadgeLabel,
  compactModelBadgeLabel,
  compactProfileChipText,
  compactProfileDisplayLabel,
  ensurePreferredModelInList,
  filterProfilesByProvider,
  findFailoverCandidateProfile,
  normalizeUiPermissionMode,
  permissionModeDisplayLabel,
  permissionVisualMeta,
  pickBestAvailableProfile,
  pickDefaultModelForProvider,
  profileHealthVisualMeta,
  profileOptionLabel,
  providerDisplayName,
  providerShortBadge,
  providerVisualMeta,
  renderAgentTelemetryBarHtml,
  renderProfilePillsHtml,
  renderProviderPillsHtml,
  renderQuotaOverviewHtml,
  resolveAntigravityModelSelection,
  resolveDistinctProfileChipText,
  resolveModelsForProvider,
  resolveVisibleTelemetryKeys,
  sortProfilesByAvailability,
  summarizeTelemetryMobileBadge,
} from "./instance-switcher.js?v=20261117goalcontext";
import { bindFollowIntent, humanizeLiveActivity, mergeLiveActivity } from "./live-state.js?v=20261117goalcontext";
import {
  cleanStreamingAgentText,
  dedupeAdjacentTurns,
  escapeHtml,
  formatToolExecutionError,
  formatTurnModelBadge,
  isRecoverableToolErrorText,
  isStreamingTextAlreadyPersisted,
  isThreadImageFailed,
  markThreadImageFailed,
  renderMarkdown,
  renderMessageCopyButton,
  renderTurnHtml,
  turnEndsWithProcessGroup,
} from "./markdown.js?v=20261117goalcontext";
import {
  SIDEBAR_MANUAL_HOLD_MS,
  THREAD_EXPAND_STEP,
  buildProjectGroups,
  computeProjectGroupSelectionState,
  isSidebarManualPrefActive,
  normalizeProjectCwd,
  projectBaseName,
  renderBatchActionBarHtml,
  renderProjectBoardHtml,
  renderProjectTaskStripHtml,
  renderSidebarThreadListHtml,
  resolveProjectGroupCollapsed,
} from "./project-board.js?v=20261117goalcontext";
import { collectUserInputAnswers, syncServerRequestCards, syncUserInputQuestion } from "./server-request-ui.js?v=20261117goalcontext";
import {
  applySlashCommandSelection,
  filterSlashCommands,
  parseSlashTrigger,
  renderSlashMenuHtml,
} from "./slash-commands.js?v=20261117goalcontext";
import {
  base64ToUint8Array,
  buildVoiceLiveProgressItems,
  computeRmsLevel,
  createVadTurnDetector,
  downsampleFloat32ToInt16,
  encodePcm16SamplesToWav,
  enqueueVoiceBroadcastItem,
  estimateVoiceDurationMs,
  evaluateVoicePlaybackOutcome,
  formatCallDuration,
  humanizeVoiceDeliveryReason,
  loadVoiceConfig,
  normalizeVoiceTtsPayload,
  parseVoiceModelSelectionKey,
  renderVoiceCallTranscriptHtml,
  renderVoiceLiveProgressHtml,
  renderVoiceModelSelectOptionsHtml,
  renderVoiceUnheardBannerHtml,
  saveVoiceConfig,
  stripMarkdownForSpeech,
  uint8ArrayToBase64,
} from "./voice-copilot.js?v=20261117goalcontext";

const $ = (id) => document.getElementById(id);

const PERM_PREF_KEY = "agentControl.permissionMode.v1";
const THREAD_PREFS_KEY = "agentControl.threadPrefs.v1";
const MODELS_CACHE_KEY = "agentControl.modelsCache.v3";
const THREADS_CACHE_KEY = "agentControl.threadsCache.v1";
const SIDEBAR_FOLD_PREFS_KEY = "agentControl.sidebarFold.v1";
const TELEMETRY_VISIBLE_PREFS_KEY = "agentControl.telemetryVisibleKeys.v1";
const THREAD_READ_STATE_KEY = "agentControl.threadReadState.v1";
const SIDEBAR_WIDTH_PREF_KEY = "agentControl.sidebarWidth.v1";
const DEFAULT_SIDEBAR_WIDTH = 312;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 560;

function loadThreadReadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(THREAD_READ_STATE_KEY) || "null");
    if (!parsed || typeof parsed !== "object") {
      return { initialized: false, seenById: {}, unreadById: {} };
    }
    return {
      initialized: Boolean(parsed.initialized),
      seenById: parsed.seenById && typeof parsed.seenById === "object" ? { ...parsed.seenById } : {},
      unreadById: parsed.unreadById && typeof parsed.unreadById === "object" ? { ...parsed.unreadById } : {},
    };
  } catch {
    return { initialized: false, seenById: {}, unreadById: {} };
  }
}

const threadReadState = loadThreadReadState();

function persistThreadReadState() {
  try {
    const seenEntries = Object.entries(threadReadState.seenById || {})
      .filter(([id, ts]) => id && Number(ts) > 0)
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, 400);
    threadReadState.seenById = Object.fromEntries(seenEntries);
    const cutoffMs = Date.now() - 7 * 24 * 3600 * 1000;
    const unreadEntries = Object.entries(threadReadState.unreadById || {})
      .filter(([id, entry]) => id && entry && Number(entry.at || 0) >= cutoffMs)
      .sort((a, b) => Number(b[1]?.at || 0) - Number(a[1]?.at || 0))
      .slice(0, 120);
    threadReadState.unreadById = Object.fromEntries(unreadEntries);
    localStorage.setItem(THREAD_READ_STATE_KEY, JSON.stringify(threadReadState));
  } catch {}
}

function buildInitialRecentCompletedMap() {
  const map = new Map();
  for (const [id, entry] of Object.entries(threadReadState.unreadById || {})) {
    if (!id || !entry || typeof entry !== "object") continue;
    map.set(id, {
      status: entry.status || "completed",
      summary: String(entry.summary || ""),
      at: Number(entry.at) || Date.now(),
      updatedAt: Number(entry.updatedAt) || 0,
    });
  }
  return map;
}

function loadTelemetryVisiblePrefs() {
  try {
    const parsed = JSON.parse(localStorage.getItem(TELEMETRY_VISIBLE_PREFS_KEY) || "null");
    if (!parsed || typeof parsed !== "object") return null;
    if (!Array.isArray(parsed.selectedKeys)) return null;
    return {
      selectedKeys: parsed.selectedKeys.map((k) => String(k || "")).filter(Boolean),
      knownKeys: Array.isArray(parsed.knownKeys)
        ? parsed.knownKeys.map((k) => String(k || "")).filter(Boolean)
        : [],
    };
  } catch {
    return null;
  }
}

function saveTelemetryVisiblePrefs(prefs) {
  try {
    if (!prefs) {
      localStorage.removeItem(TELEMETRY_VISIBLE_PREFS_KEY);
    } else {
      localStorage.setItem(TELEMETRY_VISIBLE_PREFS_KEY, JSON.stringify(prefs));
    }
  } catch {
    // Ignore storage failures in private browsing.
  }
}

function loadCachedModels() {
  try {
    const parsed = JSON.parse(localStorage.getItem(MODELS_CACHE_KEY) || "null");
    if (!parsed || typeof parsed !== "object") return null;
    return {
      allModels: Array.isArray(parsed.allModels) ? parsed.allModels : [],
      modelsByProvider: parsed.modelsByProvider && typeof parsed.modelsByProvider === "object"
        ? parsed.modelsByProvider
        : {},
    };
  } catch {
    return null;
  }
}

function saveCachedModels(allModels, modelsByProvider) {
  try {
    localStorage.setItem(MODELS_CACHE_KEY, JSON.stringify({
      allModels: Array.isArray(allModels) ? allModels : [],
      modelsByProvider: modelsByProvider && typeof modelsByProvider === "object" ? modelsByProvider : {},
      updatedAt: Date.now(),
    }));
  } catch {}
}

function loadCachedThreads() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(THREADS_CACHE_KEY) || "null");
    if (!parsed || typeof parsed !== "object") return null;
    return {
      threads: Array.isArray(parsed.threads) ? parsed.threads : [],
      projectsMeta: parsed.projectsMeta && typeof parsed.projectsMeta === "object" ? parsed.projectsMeta : {},
    };
  } catch {
    return null;
  }
}

function saveCachedThreads(threads, projectsMeta) {
  try {
    const compactThreads = (Array.isArray(threads) ? threads : []).slice(0, 120).map((t) => ({
      id: t.id,
      title: t.title,
      name: t.name,
      preview: t.preview,
      cwd: t.cwd,
      provider: t.provider,
      profileId: t.profileId,
      profileLabel: t.profileLabel,
      updatedAt: t.updatedAt,
      live: Boolean(t.live),
      goalState: t.goalState || null,
      pendingCount: t.pendingCount || 0,
      queuedCount: t.queuedCount || 0,
    }));
    sessionStorage.setItem(THREADS_CACHE_KEY, JSON.stringify({
      threads: compactThreads,
      projectsMeta: projectsMeta && typeof projectsMeta === "object" ? projectsMeta : {},
      updatedAt: Date.now(),
    }));
  } catch {}
}

function loadDefaultPermissionMode() {
  try {
    return normalizeUiPermissionMode(localStorage.getItem(PERM_PREF_KEY), "turbo");
  } catch {
    return "turbo";
  }
}

function saveDefaultPermissionMode(mode) {
  const clean = normalizeUiPermissionMode(mode, "turbo");
  try {
    localStorage.setItem(PERM_PREF_KEY, clean);
  } catch {}
  return clean;
}

const NEW_THREAD_PREFS_KEY = "agentControl.newThreadPrefs.v1";

function getNewThreadPrefs(provider) {
  try {
    return JSON.parse(localStorage.getItem(NEW_THREAD_PREFS_KEY) || "{}")[provider] || {};
  } catch { return {}; }
}

function saveNewThreadPrefs(provider, patch) {
  try {
    const prefs = JSON.parse(localStorage.getItem(NEW_THREAD_PREFS_KEY) || "{}");
    prefs[provider] = { ...prefs[provider], ...patch };
    localStorage.setItem(NEW_THREAD_PREFS_KEY, JSON.stringify(prefs));
  } catch {}
}

function loadThreadPrefsMap() {
  try {
    const parsed = JSON.parse(localStorage.getItem(THREAD_PREFS_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function getLocalThreadPrefs(threadId) {
  if (!threadId) return null;
  const map = loadThreadPrefsMap();
  const raw = map[threadId];
  if (!raw || typeof raw !== "object") return null;
  if (!raw.modelExplicit && raw.model) {
    const copy = { ...raw };
    delete copy.model;
    return copy;
  }
  return raw;
}

function saveLocalThreadPrefs(threadId, patch = {}) {
  if (!threadId) return;
  try {
    const map = loadThreadPrefsMap();
    map[threadId] = {
      ...(map[threadId] || {}),
      ...patch,
      updatedAt: Date.now(),
    };
    const keys = Object.keys(map);
    if (keys.length > 200) {
      keys
        .sort((a, b) => (map[a]?.updatedAt || 0) - (map[b]?.updatedAt || 0))
        .slice(0, keys.length - 200)
        .forEach((k) => delete map[k]);
    }
    localStorage.setItem(THREAD_PREFS_KEY, JSON.stringify(map));
  } catch {}
}

function loadSidebarFoldState(nowMs = Date.now()) {
  const sidebarFoldPrefs = {};
  const expandedThreadsAt = {};
  const expandedSidebarGroups = new Map();
  let showStaleProjects = false;
  let staleProjectsOpenedAt = 0;
  try {
    const parsed = JSON.parse(localStorage.getItem(SIDEBAR_FOLD_PREFS_KEY) || "null");
    if (parsed && typeof parsed === "object") {
      if (parsed.groups && typeof parsed.groups === "object") {
        for (const [cwd, pref] of Object.entries(parsed.groups)) {
          if (cwd && isSidebarManualPrefActive(pref, nowMs, SIDEBAR_MANUAL_HOLD_MS)) {
            sidebarFoldPrefs[cwd] = {
              action: pref.action,
              updatedAt: Number(pref.updatedAt),
            };
          }
        }
      }
      if (parsed.expandedThreads && typeof parsed.expandedThreads === "object") {
        for (const [cwd, val] of Object.entries(parsed.expandedThreads)) {
          const ts = typeof val === "object" && val ? Number(val.updatedAt) : Number(val);
          const rawCount = typeof val === "object" && val ? Number(val.count) : THREAD_EXPAND_STEP;
          const count = Number.isFinite(rawCount) && rawCount > 0
            ? Math.max(THREAD_EXPAND_STEP, Math.floor(rawCount))
            : THREAD_EXPAND_STEP;
          if (cwd && Number.isFinite(ts) && ts > 0 && (nowMs < ts || (nowMs - ts) < SIDEBAR_MANUAL_HOLD_MS)) {
            expandedThreadsAt[cwd] = ts;
            expandedSidebarGroups.set(cwd, count);
          }
        }
      }
      const staleTs = Number(parsed.staleProjectsOpenedAt || 0);
      if (Number.isFinite(staleTs) && staleTs > 0 && (nowMs < staleTs || (nowMs - staleTs) < SIDEBAR_MANUAL_HOLD_MS)) {
        showStaleProjects = true;
        staleProjectsOpenedAt = staleTs;
      }
    }
  } catch {}
  return {
    sidebarFoldPrefs,
    expandedThreadsAt,
    expandedSidebarGroups,
    showStaleProjects,
    staleProjectsOpenedAt,
  };
}

function saveSidebarFoldState() {
  try {
    const trimEntries = (obj, tsSelector, limit = 120) => {
      const entries = Object.entries(obj || {});
      if (entries.length <= limit) return Object.fromEntries(entries);
      return Object.fromEntries(
        entries
          .sort((a, b) => (Number(tsSelector(b[1])) || 0) - (Number(tsSelector(a[1])) || 0))
          .slice(0, limit),
      );
    };
    const expandedThreadsPayload = {};
    for (const [cwd, ts] of Object.entries(trimEntries(state.expandedThreadsAt, (v) => v))) {
      expandedThreadsPayload[cwd] = {
        count: Math.max(THREAD_EXPAND_STEP, Math.floor(Number(state.expandedSidebarGroups?.get?.(cwd)) || THREAD_EXPAND_STEP)),
        updatedAt: Number(ts) || Date.now(),
      };
    }
    localStorage.setItem(SIDEBAR_FOLD_PREFS_KEY, JSON.stringify({
      groups: trimEntries(state.sidebarFoldPrefs, (v) => v?.updatedAt),
      expandedThreads: expandedThreadsPayload,
      staleProjectsOpenedAt: state.showStaleProjects ? (Number(state.staleProjectsOpenedAt) || Date.now()) : 0,
    }));
  } catch {}
}

function pruneExpiredSidebarPrefs(nowMs = Date.now()) {
  let changed = false;
  for (const [cwd, pref] of Object.entries(state.sidebarFoldPrefs || {})) {
    if (!isSidebarManualPrefActive(pref, nowMs, SIDEBAR_MANUAL_HOLD_MS)) {
      delete state.sidebarFoldPrefs[cwd];
      changed = true;
    }
  }
  for (const [cwd, tsRaw] of Object.entries(state.expandedThreadsAt || {})) {
    const ts = Number(tsRaw);
    if (!Number.isFinite(ts) || ts <= 0 || (nowMs >= ts && (nowMs - ts) >= SIDEBAR_MANUAL_HOLD_MS)) {
      delete state.expandedThreadsAt[cwd];
      state.expandedSidebarGroups.delete(cwd);
      changed = true;
    }
  }
  if (state.showStaleProjects) {
    const staleTs = Number(state.staleProjectsOpenedAt || 0);
    if (!Number.isFinite(staleTs) || staleTs <= 0 || (nowMs >= staleTs && (nowMs - staleTs) >= SIDEBAR_MANUAL_HOLD_MS)) {
      state.showStaleProjects = false;
      state.staleProjectsOpenedAt = 0;
      changed = true;
    }
  }
  if (changed) saveSidebarFoldState();
  return changed;
}

function setSidebarGroupManualPref(cwd, action, nowMs = Date.now()) {
  const cleanCwd = normalizeProjectCwd(cwd) || "默认工作区";
  if (action !== "expand" && action !== "collapse") return;
  state.sidebarFoldPrefs[cleanCwd] = { action, updatedAt: nowMs };
  state.collapsedGroups.delete(cleanCwd);
  if (action === "collapse") {
    state.expandedSidebarGroups.delete(cleanCwd);
    delete state.expandedThreadsAt[cleanCwd];
  }
  saveSidebarFoldState();
}

const initialModelsCache = loadCachedModels();
const initialSidebarFold = loadSidebarFoldState();

const state = {
  providers: [],
  profiles: [],
  modelsByProvider: initialModelsCache?.modelsByProvider || {},
  allModels: initialModelsCache?.allModels || [],
  defaultProvider: "antigravity",
  defaultProfileId: "cli",
  defaultPermissionMode: loadDefaultPermissionMode(),
  threads: [],
  projectsMeta: {},
  warnings: [],
  providerFilter: "all",
  profileFilter: "all",
  quotaExpanded: false,
  quotaRefreshing: false,
  telemetry: null,
  executionStats: null,
  executionStatsDays: 7,
  executionStatsProvider: "all",
  executionStatsLoading: false,
  executionStatsError: "",
  telemetryExpanded: false,
  telemetryVisiblePrefs: loadTelemetryVisiblePrefs(),
  telemetryPickerOpen: false,
  mobileTelemetryOpen: false,
  searchText: "",
  showArchived: false,
  showAllProjects: false,
  expandedProjects: new Map(),
  expandedSidebarGroups: initialSidebarFold.expandedSidebarGroups,
  sidebarFoldPrefs: initialSidebarFold.sidebarFoldPrefs,
  expandedThreadsAt: initialSidebarFold.expandedThreadsAt,
  showStaleProjects: initialSidebarFold.showStaleProjects,
  staleProjectsOpenedAt: initialSidebarFold.staleProjectsOpenedAt,
  boardOpen: true,
  initialThreadLoading: false,
  activeThreadId: "",
  activeThread: null,
  newThreadCwd: null,
  nextCursor: null,
  liveActivity: null,
  activityCursor: "",
  streamingText: "",
  streamingThought: "",
  streamingTurnId: "",
  pendingRequests: [],
  pendingRequestsSynced: false,
  queuedTurns: [],
  queuedPanelCollapsed: false,
  editingQueueItem: null,
  slashCatalogByKey: new Map(),
  slashMenuOpen: false,
  slashMenuItems: [],
  slashMenuIndex: 0,
  slashTrigger: null,
  slashManualOpen: false,
  slashFetchSeq: 0,
  images: [],
  imageProcessingCount: 0,
  composerGoal: false,
  isSubmitting: false,
  composerStatusTimer: null,
  autoFollow: true,
  sseConnected: false,
  eventSource: null,
  collapsedGroups: new Set(),
  lastModelProvider: "",
  userPickedDraftModel: false,
  topbarMenuOpen: false,
  composerConfigOpen: false,
  toastTimer: null,
  toastActive: false,
  probingProfileKeys: new Set(),
  lastFailoverContext: null,
  liveActivityByThread: new Map(),
  recentCompletedByThread: buildInitialRecentCompletedMap(),
  useHotExtension: false,
  hotExtensionRoutes: new Set(),
  remoteStatus: null,
  tunnelStatus: null,
  tunnelBusy: false,
  fixedTunnelStatus: null,
  fixedTunnelBusy: false,
  updateStatus: null,
  updateChecking: false,
  updateApplying: false,
  desktopUpdating: false,
  localApps: [],
  batchSelect: {
    active: false,
    selectedIds: new Set(),
    submitting: false,
    lastTouchedThreadId: "",
  },
  voice: {
    config: loadVoiceConfig(),
    callId: "",
    callScope: "global",
    scopedThreadId: "",
    callActive: false,
    minimized: false,
    callStartedAt: 0,
    callTimerId: null,
    isMuted: false,
    isRecording: false,
    isSpeaking: false,
    isProcessing: false,
    audioCtx: null,
    micStream: null,
    micSource: null,
    processorNode: null,
    silentGainNode: null,
    vadDetector: null,
    currentRms: 0,
    lastAudioFrameAt: 0,
    micWatchdogTimer: null,
    micRecovering: false,
    levelRafId: null,
    resumeListenTimer: null,
    audioEl: null,
    audioObjectUrl: "",
    activePlaybackAbort: null,
    activeBufferSource: null,
    playbackToken: 0,
    webAudioUnlocked: false,
    audioElUnlocked: false,
    wakeLock: null,
    transcript: [],
    broadcastQueue: [],
    broadcastDraining: false,
    unheardQueue: [],
    approvalReminderTimers: new Map(),
    remindedRequestIds: new Set(),
    pendingBatches: new Map(),
    watchedThreads: new Map(),
    progressHeartbeatTimer: null,
    processingStageTimer: null,
    processingPhaseText: "",
    lastUserActivityAt: 0,
    modelName: "自动轻量",
    dispatchProvider: "",
    modelOptions: [],
    asrAvailable: true,
    asrEngine: "mlx-whisper",
    speechRecognition: null,
    pendingVoiceTurns: [],
    backendMissing: false,
  },
  dictation: {
    active: false,
    transcribing: false,
    stream: null,
    audioCtx: null,
    source: null,
    processor: null,
    chunks: [],
    maxTimer: null,
  },
};

function toHotExtensionPath(path) {
  const clean = String(path || "").replace(/^\/+/, "");
  return clean.startsWith("apps/ac-hot/") ? clean : `apps/ac-hot/${clean}`;
}

function routeBaseOfPath(path) {
  return String(path || "").replace(/^\/+/, "").split("?")[0];
}

async function apiGetWithHotFallback(path) {
  const routeKey = routeBaseOfPath(path);
  if (state.hotExtensionRoutes.has(routeKey)) {
    try {
      return await apiGet(toHotExtensionPath(path));
    } catch (hotErr) {
      if (Number(hotErr?.status) !== 404 && Number(hotErr?.status) !== 502) throw hotErr;
      state.hotExtensionRoutes.delete(routeKey);
    }
  }
  try {
    return await apiGet(path);
  } catch (error) {
    if (Number(error?.status) !== 404) throw error;
    const res = await apiGet(toHotExtensionPath(path));
    state.hotExtensionRoutes.add(routeKey);
    return res;
  }
}

async function apiPostWithHotFallback(path, body) {
  const routeKey = routeBaseOfPath(path);
  if (state.hotExtensionRoutes.has(routeKey)) {
    try {
      return await apiPost(toHotExtensionPath(path), body);
    } catch (hotErr) {
      if (Number(hotErr?.status) !== 404 && Number(hotErr?.status) !== 502) throw hotErr;
      state.hotExtensionRoutes.delete(routeKey);
    }
  }
  try {
    return await apiPost(path, body);
  } catch (error) {
    if (Number(error?.status) !== 404) throw error;
    const res = await apiPost(toHotExtensionPath(path), body);
    state.hotExtensionRoutes.add(routeKey);
    return res;
  }
}

async function fetchThreadRead(path) {
  return apiGetWithHotFallback(path);
}

function isInternalVoiceThreadClient(thread) {
  if (!thread) return false;
  const cwd = String(thread.cwd || "").replace(/\\/g, "/");
  if (cwd.endsWith("/voice-call") || cwd.includes("/voice-call/")) return true;
  const title = String(thread.title || thread.name || "");
  const preview = String(thread.preview || "");
  return title.includes("[AC_VOICE_CALL]") || preview.includes("[AC_VOICE_CALL]");
}

function isBoardViewActive() {
  if (state.initialThreadLoading && state.activeThreadId) return false;
  return Boolean(state.boardOpen || (!state.activeThread && state.newThreadCwd === null));
}

function syncWorkspaceVisibility() {
  const onBoard = isBoardViewActive();
  $("appShell")?.classList.toggle("is-board-open", onBoard);
  const composer = $("composerArea");
  if (composer) composer.hidden = onBoard;
  if (onBoard) {
    setComposerConfigOpen(false);
    if ($("pendingRequestsDock")) $("pendingRequestsDock").hidden = true;
    if ($("queuedTurnsBar")) $("queuedTurnsBar").hidden = true;
  }
  renderBatchActionBars();
}

function formatRelativeTime(epochSeconds) {
  const ts = Number(epochSeconds || 0);
  if (!ts) return "";
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
  return `${Math.floor(diff / 86400)}天前`;
}

function getProjectGroups({ ignoreFilters = false, includeSearch = true } = {}) {
  return buildProjectGroups(state.threads, {
    pendingRequests: state.pendingRequests,
    pendingRequestsSynced: state.pendingRequestsSynced,
    projectsMeta: state.projectsMeta,
    searchText: (ignoreFilters || !includeSearch) ? "" : state.searchText,
    providerFilter: ignoreFilters ? "all" : state.providerFilter,
    profileFilter: "all",
  });
}

function syncThreadsPendingCounts() {
  const counts = new Map();
  for (const req of state.pendingRequests) {
    if (!req?.threadId) continue;
    counts.set(req.threadId, (counts.get(req.threadId) || 0) + 1);
  }
  for (const t of state.threads) {
    if (!t?.id) continue;
    t.pendingCount = counts.get(t.id) || 0;
    t.pendingCountSynced = true;
  }
  if (state.activeThread?.id) {
    state.activeThread.pendingCount = counts.get(state.activeThread.id) || 0;
    state.activeThread.pendingCountSynced = true;
  }
}

function syncThreadSummaryIntoList(thread) {
  if (!thread?.id) return;
  const target = state.threads.find((t) => t.id === thread.id);
  if (!target) return;
  if (typeof thread.live === "boolean") target.live = thread.live;
  if (typeof thread.queuedCount === "number") target.queuedCount = thread.queuedCount;
  if (thread.updatedAt) target.updatedAt = thread.updatedAt;
  if (thread.title) target.title = thread.title;
  if (thread.preview) target.preview = thread.preview;
}

function defaultProviderValue() {
  return state.defaultProvider || "antigravity";
}

function defaultNewThreadProvider() {
  if (state.providerFilter && state.providerFilter !== "all") {
    return state.providerFilter;
  }
  return state.activeThread?.provider || defaultProviderValue();
}

function setProviderFilter(nextFilter = "all") {
  state.providerFilter = nextFilter || "all";
  for (const tab of $("providerTabs")?.querySelectorAll(".provider-tab") || []) {
    tab.classList.toggle("is-active", tab.dataset.provider === state.providerFilter);
  }
  syncProfileSelectors();
  renderThreadList();
}

function defaultProfileForProvider(provider) {
  const list = filterProfilesByProvider(state.profiles, provider);
  const preferred = provider === state.defaultProvider
    ? state.defaultProfileId
    : (provider === "antigravity" ? "cli" : "");
  return pickBestAvailableProfile(list, preferred)?.id || (provider === "antigravity" ? "cli" : "default");
}

function setTopbarMenuOpen(open) {
  const next = Boolean(open);
  state.topbarMenuOpen = next;
  if (next) state.composerConfigOpen = false;
  $("topbarMoreMenu")?.classList.toggle("is-open", next);
  $("topbarMoreBtn")?.setAttribute("aria-expanded", next ? "true" : "false");
  $("composerConfigPopover")?.classList.toggle("is-open", state.composerConfigOpen);
  $("composerConfigBtn")?.setAttribute("aria-expanded", state.composerConfigOpen ? "true" : "false");
}

function setComposerConfigOpen(open) {
  const next = Boolean(open);
  state.composerConfigOpen = next;
  if (next) state.topbarMenuOpen = false;
  if (!next) closeCustomSelectMenu();
  $("composerConfigPopover")?.classList.toggle("is-open", next);
  $("composerConfigBtn")?.setAttribute("aria-expanded", next ? "true" : "false");
  $("topbarMoreMenu")?.classList.toggle("is-open", state.topbarMenuOpen);
  $("topbarMoreBtn")?.setAttribute("aria-expanded", state.topbarMenuOpen ? "true" : "false");
}

function setSidebarOpen(open) {
  if (open) {
    setTopbarMenuOpen(false);
    setComposerConfigOpen(false);
  }
  const sidebar = $("sidebar");
  const backdrop = $("sidebarBackdrop");
  sidebar.classList.toggle("is-open", open);
  backdrop.hidden = !open;
}

function syncConnectionDots(mode = "connecting") {
  const clsSuffix = mode === "connected" ? "is-connected" : mode === "error" ? "is-error" : "is-connecting";
  const sidebarDot = $("sseStatusDot");
  if (sidebarDot) sidebarDot.className = `brand-dot ${clsSuffix}`;
  const topDot = $("topbarConnDot");
  if (topDot) {
    topDot.className = `topbar-conn-dot ${clsSuffix}`;
    topDot.title = mode === "connected" ? "实时连接正常" : mode === "error" ? "连接异常或离线" : "正在连接…";
  }
}

function showToastBanner(message, { detail = "", sticky = false, error = false } = {}) {
  if (state.toastTimer) {
    clearTimeout(state.toastTimer);
    state.toastTimer = null;
  }
  state.toastActive = true;
  const banner = $("liveBanner");
  banner.classList.remove("is-ambient");
  banner.classList.toggle("is-error", Boolean(error));
  $("livePhaseText").textContent = message;
  $("liveDetailText").textContent = detail;
  banner.hidden = false;
  if (!sticky) {
    state.toastTimer = setTimeout(() => {
      state.toastTimer = null;
      state.toastActive = false;
      renderLiveBanner();
    }, 3500);
  }
}

function clearComposerStatus() {
  if (state.composerStatusTimer) {
    clearTimeout(state.composerStatusTimer);
    state.composerStatusTimer = null;
  }
  state.lastFailoverContext = null;
  const el = $("composerStatus");
  if (!el) return;
  el.hidden = true;
  el.className = "composer-status";
  el.innerHTML = "";
}

function setComposerStatus(kind, message, { autoClearMs = 0, failoverContext = null } = {}) {
  const el = $("composerStatus");
  if (!el) return;
  if (state.composerStatusTimer) {
    clearTimeout(state.composerStatusTimer);
    state.composerStatusTimer = null;
  }
  const cleanMsg = String(message || "").trim();
  if (!cleanMsg) {
    clearComposerStatus();
    return;
  }
  state.lastFailoverContext = kind === "error" ? failoverContext : null;
  const cls = ["composer-status"];
  if (kind === "error") cls.push("is-error");
  else if (kind === "success") cls.push("is-success");
  else cls.push("is-pending");
  el.className = cls.join(" ");
  let actionHtml = "";
  if (kind === "error" && failoverContext?.altProfile) {
    const altMeta = profileHealthVisualMeta(failoverContext.altProfile);
    const altLabel = failoverContext.altProfile.health?.alias
      || failoverContext.altProfile.label
      || failoverContext.altProfile.id;
    actionHtml = `<button type="button" class="status-failover-btn" data-failover-trigger><span class="profile-status-dot ${escapeHtml(altMeta.dotClass)}" aria-hidden="true"></span>切到 ${escapeHtml(altLabel)} 继续</button>`;
  }
  el.innerHTML = `<span class="composer-status-text">${escapeHtml(cleanMsg)}</span>`
    + actionHtml
    + (kind === "error" ? `<button type="button" class="composer-status-close" data-dismiss-composer-status aria-label="关闭提示">${iconSvg("close", { size: 12 })}</button>` : "");
  el.hidden = false;
  if (autoClearMs > 0) {
    state.composerStatusTimer = setTimeout(() => {
      state.composerStatusTimer = null;
      clearComposerStatus();
    }, autoClearMs);
  }
}

function formatActionError(error, fallback = "操作失败") {
  if (error?.status === 401 || error?.code === "unauthorized") {
    return "远程登录凭证已失效，请在本机控制台重新扫码配对";
  }
  return error?.message || fallback;
}

function isActiveThreadRunning() {
  if (!state.activeThread) return false;
  const actStatus = state.liveActivity?.status;
  if (actStatus === "running" || actStatus === "inProgress") return true;
  if (actStatus && actStatus !== "running" && actStatus !== "inProgress") return false;
  if (state.activeThread.live) return true;
  const turns = state.activeThread.turns || [];
  return turns[turns.length - 1]?.status === "inProgress";
}

function currentComposerProvider() {
  if (state.activeThread?.provider) return state.activeThread.provider;
  return $("composerProviderSelect").value || defaultProviderValue();
}

function currentComposerProfileId() {
  if (state.activeThread?.profileId) return state.activeThread.profileId;
  return $("composerProfileSelect").value || defaultProfileForProvider(currentComposerProvider());
}

function syncProfileSelectors() {
  state.profileFilter = "all";

  const providerSelect = $("composerProviderSelect");
  const newProviderSelect = $("newProviderSelect");
  const providerOpts = ["antigravity", "codex", "claude", "grok"].map((id) =>
    `<option value="${id}">${escapeHtml(providerDisplayName(id))}</option>`,
  ).join("");
  const prevCompProvider = providerSelect.dataset.initialized ? providerSelect.value : defaultProviderValue();
  const prevNewProvider = newProviderSelect.dataset.initialized ? newProviderSelect.value : defaultProviderValue();
  providerSelect.innerHTML = providerOpts;
  newProviderSelect.innerHTML = providerOpts;
  const hasActiveThread = Boolean(state.activeThread);
  providerSelect.value = state.activeThread?.provider || prevCompProvider || defaultProviderValue();
  providerSelect.dataset.initialized = "1";
  providerSelect.disabled = hasActiveThread;
  providerSelect.hidden = hasActiveThread;
  newProviderSelect.value = prevNewProvider || defaultProviderValue();
  newProviderSelect.dataset.initialized = "1";

  syncComposerProfileSelect();
  syncNewProviderPills();
  syncNewProfileSelect();
  syncNewModelSelect();
  syncPermissionSelectors();
  syncCfgFieldVisibility();
  renderComposerConfigChip();
  renderQuotaStrip();
  syncAllCustomSelects();
}

const CLIENT_TELEMETRY_WINDOW_MS = 6000;
const clientStreamSamplesByProvider = new Map();
const clientStreamSamplesByProfile = new Map();
let clientTelemetryDecayTimer = null;
let telemetryRefreshTimer = null;
let telemetryRenderScheduled = false;

function estimateClientTokens(text = "") {
  const s = String(text || "");
  if (!s) return 0;
  let cjk = 0;
  for (let i = 0; i < s.length; i += 1) {
    if (s.charCodeAt(i) > 0x2e80) cjk += 1;
  }
  const other = s.length - cjk;
  return Math.max(1, Math.round(cjk * 0.72 + other * 0.28));
}

function pruneClientSampleMap(sampleMap, nowMs) {
  const cutoff = nowMs - CLIENT_TELEMETRY_WINDOW_MS;
  for (const [key, arr] of sampleMap.entries()) {
    const kept = arr.filter((s) => s.at >= cutoff);
    if (kept.length) sampleMap.set(key, kept);
    else sampleMap.delete(key);
  }
}

function pruneClientStreamSamples(nowMs = Date.now()) {
  pruneClientSampleMap(clientStreamSamplesByProvider, nowMs);
  pruneClientSampleMap(clientStreamSamplesByProfile, nowMs);
  if (!clientStreamSamplesByProvider.size && !clientStreamSamplesByProfile.size && clientTelemetryDecayTimer) {
    clearInterval(clientTelemetryDecayTimer);
    clientTelemetryDecayTimer = null;
  }
}

function computeClientStreamTpsFromMap(sampleMap, key, nowMs = Date.now()) {
  const arr = sampleMap.get(key);
  if (!arr?.length) return 0;
  const cutoff = nowMs - CLIENT_TELEMETRY_WINDOW_MS;
  let tokens = 0;
  let earliest = nowMs;
  for (const s of arr) {
    if (s.at < cutoff) continue;
    tokens += s.tokens;
    if (s.at < earliest) earliest = s.at;
  }
  if (tokens <= 0) return 0;
  const elapsedSec = Math.max(1.2, (nowMs - earliest) / 1000);
  return Math.round((tokens / elapsedSec) * 10) / 10;
}

function scheduleTelemetryBarRender() {
  if (telemetryRenderScheduled) return;
  telemetryRenderScheduled = true;
  requestAnimationFrame(() => {
    telemetryRenderScheduled = false;
    renderAgentTelemetryBar();
  });
}

function pushClientSample(sampleMap, key, nowMs, tokens) {
  const arr = sampleMap.get(key) || [];
  arr.push({ at: nowMs, tokens });
  if (arr.length > 240) arr.splice(0, arr.length - 240);
  sampleMap.set(key, arr);
}

function extractProfileKeyFromThreadId(threadId = "") {
  const parts = String(threadId || "").split(":");
  if (parts.length < 2) return "";
  const prov = String(parts[0] || "").trim().toLowerCase();
  const profId = String(parts[1] || "").trim();
  if (!prov || !profId) return "";
  return `${prov}:${profId}`;
}

function recordClientStreamDelta(provider, delta, threadId = "") {
  const prov = String(provider || "").trim().toLowerCase();
  const tokens = estimateClientTokens(delta);
  if (!prov || tokens <= 0) return;
  const nowMs = Date.now();
  pushClientSample(clientStreamSamplesByProvider, prov, nowMs, tokens);
  const pKey = extractProfileKeyFromThreadId(threadId);
  if (pKey) {
    pushClientSample(clientStreamSamplesByProfile, pKey, nowMs, tokens);
  }
  if (!clientTelemetryDecayTimer) {
    clientTelemetryDecayTimer = setInterval(() => {
      pruneClientStreamSamples(Date.now());
      renderAgentTelemetryBar();
    }, 1000);
  }
  scheduleTelemetryBarRender();
}

function buildMergedTelemetrySnapshot(nowMs = Date.now()) {
  pruneClientStreamSamples(nowMs);
  const base = state.telemetry?.byProvider ? state.telemetry : null;
  const byProvider = {};
  let runningCount = 0;
  let queuedCount = 0;
  let tokensPerSec = 0;

  for (const prov of ["codex", "claude", "antigravity", "grok"]) {
    const serverStat = base?.byProvider?.[prov] || {};
    const liveThreadsFallback = base
      ? []
      : state.threads.filter((t) => t.provider === prov && t.live);
    const activeThreads = Array.isArray(serverStat.activeThreads) && serverStat.activeThreads.length
      ? serverStat.activeThreads
      : liveThreadsFallback.map((t) => ({ id: t.id, title: t.title || t.name || t.id }));
    const provRunning = base
      ? Number(serverStat.runningCount || 0)
      : liveThreadsFallback.length;
    const provQueued = base
      ? Number(serverStat.queuedCount || 0)
      : state.threads.filter((t) => t.provider === prov && Number(t.queuedCount || 0) > 0)
        .reduce((acc, t) => acc + Number(t.queuedCount || 0), 0);
    const clientTps = computeClientStreamTpsFromMap(clientStreamSamplesByProvider, prov, nowMs);
    const provTps = Math.max(Number(serverStat.tokensPerSec || 0), clientTps);

    byProvider[prov] = {
      provider: prov,
      runningCount: provRunning,
      queuedCount: provQueued,
      tokensPerSec: Math.round(provTps * 10) / 10,
      activeThreads,
    };
    runningCount += provRunning;
    queuedCount += provQueued;
    tokensPerSec += byProvider[prov].tokensPerSec;
  }

  const byProfile = {};
  const profileKeys = new Set(Object.keys(base?.byProfile || {}));
  for (const p of state.profiles || []) {
    if (p?.key) profileKeys.add(p.key);
    else if (p?.provider && p?.id) profileKeys.add(`${p.provider}:${p.id}`);
  }
  for (const pKey of clientStreamSamplesByProfile.keys()) {
    profileKeys.add(pKey);
  }
  for (const pKey of profileKeys) {
    const serverProf = base?.byProfile?.[pKey] || null;
    const [prov, profId] = pKey.split(":");
    const prefix = `${pKey}:`;
    const liveFallback = base
      ? []
      : state.threads.filter((t) => t.live && String(t.id || "").startsWith(prefix));
    const profThreads = Array.isArray(serverProf?.activeThreads) && serverProf.activeThreads.length
      ? serverProf.activeThreads
      : liveFallback.map((t) => ({ id: t.id, title: t.title || t.name || t.id }));
    const profRunning = base && serverProf
      ? Number(serverProf.runningCount || 0)
      : liveFallback.length;
    const profQueued = base && serverProf
      ? Number(serverProf.queuedCount || 0)
      : state.threads.filter((t) => Number(t.queuedCount || 0) > 0 && String(t.id || "").startsWith(prefix))
        .reduce((acc, t) => acc + Number(t.queuedCount || 0), 0);
    const clientProfTps = computeClientStreamTpsFromMap(clientStreamSamplesByProfile, pKey, nowMs);
    const profTps = Math.max(Number(serverProf?.tokensPerSec || 0), clientProfTps);
    byProfile[pKey] = {
      key: pKey,
      provider: serverProf?.provider || prov || "",
      profileId: serverProf?.profileId || profId || "",
      runningCount: profRunning,
      queuedCount: profQueued,
      tokensPerSec: Math.round(profTps * 10) / 10,
      activeThreads: profThreads,
    };
  }

  return {
    updatedAt: base?.updatedAt || nowMs,
    totals: {
      runningCount,
      queuedCount,
      tokensPerSec: Math.round(tokensPerSec * 10) / 10,
    },
    byProvider,
    byProfile,
  };
}

function applyTelemetrySnapshot(snap) {
  if (!snap || typeof snap !== "object" || !snap.byProvider) return;
  state.telemetry = snap;
  renderAgentTelemetryBar();
}

async function refreshTelemetry() {
  try {
    const res = await apiGetWithHotFallback("api/telemetry");
    if (res?.byProvider) {
      applyTelemetrySnapshot(res);
    }
  } catch {
    // Ignore transient telemetry polling failures; SSE push keeps recovering.
  }
}

function scheduleTelemetryRefresh(delayMs = 150) {
  if (telemetryRefreshTimer) clearTimeout(telemetryRefreshTimer);
  telemetryRefreshTimer = setTimeout(() => {
    telemetryRefreshTimer = null;
    void refreshTelemetry();
  }, Math.max(50, Number(delayMs) || 150));
}

async function refreshExecutionStats() {
  if (state.executionStatsLoading) return;
  state.executionStatsLoading = true;
  state.executionStatsError = "";
  renderAgentTelemetryBar();
  try {
    const params = new URLSearchParams({ days: String(state.executionStatsDays), provider: state.executionStatsProvider });
    state.executionStats = await apiGet(`api/executions?${params}`);
  } catch (error) {
    state.executionStatsError = Number(error?.status) === 404
      ? "当前后台尚未启用执行统计，重启服务后开始采样。"
      : `读取统计失败：${formatActionError(error)}`;
  } finally {
    state.executionStatsLoading = false;
    renderAgentTelemetryBar();
  }
}

let telemetryHeroAnim = null;
let telemetryClosing = false;

function cancelTelemetryHeroAnim() {
  if (telemetryHeroAnim) {
    try { telemetryHeroAnim.cancel(); } catch {}
    telemetryHeroAnim = null;
  }
  telemetryClosing = false;
}

function getTelemetryHeroAnchorEl(preferredEl = null) {
  if (typeof document === "undefined") return null;
  const desktopSlot = $("topbarTelemetrySlot");
  const isNarrow = typeof window !== "undefined" && window.innerWidth <= 960;
  const preferredPill = preferredEl?.closest?.(".telemetry-compact-items, .telemetry-compact-pill, #topbarTelemetrySlot, #telemetryTopbarBtn");
  if (preferredPill && desktopSlot?.contains(preferredPill)) return preferredPill;
  if (!isNarrow && desktopSlot && !desktopSlot.hidden) {
    return desktopSlot.querySelector(".telemetry-compact-items") || desktopSlot;
  }
  const bar = $("agentTelemetryBar");
  return bar?.querySelector(".telemetry-compact-items") || $("telemetryTopbarBtn") || desktopSlot || bar || null;
}

function syncTelemetryPopoverAnchor(el, anchorEl) {
  if (!el || !anchorEl || typeof window === "undefined") return;
  if (window.innerWidth <= 960) {
    el.style.removeProperty("--telemetry-popover-top");
    el.style.removeProperty("--telemetry-popover-right");
    return;
  }
  const rect = anchorEl.getBoundingClientRect?.();
  if (!rect || rect.width <= 0) return;
  const top = Math.max(50, Math.round(rect.bottom + 8));
  const right = Math.max(12, Math.round(window.innerWidth - rect.right));
  el.style.setProperty("--telemetry-popover-top", `${top}px`);
  el.style.setProperty("--telemetry-popover-right", `${right}px`);
}

function openTelemetryPopover(preferredAnchor = null) {
  const el = $("agentTelemetryBar");
  const anchorEl = getTelemetryHeroAnchorEl(preferredAnchor);
  const fromRect = anchorEl?.getBoundingClientRect?.() || null;
  cancelTelemetryHeroAnim();
  state.telemetryExpanded = true;
  if (typeof window !== "undefined" && window.innerWidth <= 960) {
    state.mobileTelemetryOpen = true;
  }
  syncTelemetryPopoverAnchor(el, anchorEl);
  renderAgentTelemetryBar();
  if (!el || el.hidden || typeof el.animate !== "function" || !fromRect || fromRect.width <= 0 || fromRect.height <= 0) return;
  const toRect = el.getBoundingClientRect?.();
  if (!toRect || toRect.width <= 0 || toRect.height <= 0) return;
  const dx = fromRect.left - toRect.left;
  const dy = fromRect.top - toRect.top;
  const sx = Math.max(0.16, Math.min(1, fromRect.width / toRect.width));
  const sy = Math.max(0.08, Math.min(1, fromRect.height / toRect.height));
  telemetryHeroAnim = el.animate([
    {
      transformOrigin: "top left",
      transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
      opacity: 0.35,
      borderRadius: "20px",
    },
    {
      transformOrigin: "top left",
      transform: "translate(0px, 0px) scale(1, 1)",
      opacity: 1,
      borderRadius: "14px",
    },
  ], {
    duration: 240,
    easing: "cubic-bezier(0.22, 1, 0.36, 1)",
  });
  telemetryHeroAnim.onfinish = () => {
    telemetryHeroAnim = null;
  };
}

function closeTelemetryPopover(preferredAnchor = null) {
  if (!state.telemetryExpanded && !state.telemetryPickerOpen && !state.mobileTelemetryOpen) return;
  const el = $("agentTelemetryBar");
  const backdrop = $("telemetryBackdrop");
  const anchorEl = getTelemetryHeroAnchorEl(preferredAnchor);
  const canAnimate = Boolean(
    el
    && !el.hidden
    && typeof el.animate === "function"
    && anchorEl
    && typeof window !== "undefined"
  );
  const fromRect = canAnimate ? el.getBoundingClientRect?.() : null;
  const toRect = canAnimate ? anchorEl.getBoundingClientRect?.() : null;

  cancelTelemetryHeroAnim();
  state.telemetryExpanded = false;
  state.telemetryPickerOpen = false;
  state.mobileTelemetryOpen = false;

  if (canAnimate && fromRect && toRect && fromRect.width > 0 && fromRect.height > 0 && toRect.width > 0 && toRect.height > 0) {
    telemetryClosing = true;
    if (backdrop) {
      backdrop.classList.remove("is-open");
      backdrop.hidden = true;
    }
    $("topbarTelemetrySlot")?.classList.remove("is-popover-open");
    const dx = toRect.left - fromRect.left;
    const dy = toRect.top - fromRect.top;
    const sx = Math.max(0.16, Math.min(1, toRect.width / fromRect.width));
    const sy = Math.max(0.08, Math.min(1, toRect.height / fromRect.height));
    const anim = el.animate([
      {
        transformOrigin: "top left",
        transform: "translate(0px, 0px) scale(1, 1)",
        opacity: 1,
        borderRadius: "14px",
      },
      {
        transformOrigin: "top left",
        transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
        opacity: 0,
        borderRadius: "20px",
      },
    ], {
      duration: 185,
      easing: "cubic-bezier(0.4, 0, 0.2, 1)",
      fill: "forwards",
    });
    telemetryHeroAnim = anim;
    anim.onfinish = () => {
      if (telemetryHeroAnim === anim) telemetryHeroAnim = null;
      telemetryClosing = false;
      try { anim.cancel(); } catch {}
      renderAgentTelemetryBar();
    };
    return;
  }

  renderAgentTelemetryBar();
}

function renderAgentTelemetryBar() {
  const el = $("agentTelemetryBar");
  const desktopSlot = $("topbarTelemetrySlot");
  const backdrop = $("telemetryBackdrop");
  const merged = buildMergedTelemetrySnapshot();
  const items = buildSelectableTelemetryItems(state.profiles);
  const visibleKeys = resolveVisibleTelemetryKeys(items, state.telemetryVisiblePrefs);
  summarizeTelemetryMobileBadge(state.profiles, merged, visibleKeys);

  const topbarBtn = $("telemetryTopbarBtn");
  const isDetailOpen = Boolean(state.telemetryExpanded || state.telemetryPickerOpen);
  if (isDetailOpen && !state.executionStats && !state.executionStatsError && !state.executionStatsLoading) void refreshExecutionStats();
  if (topbarBtn) {
    topbarBtn.hidden = true;
    topbarBtn.setAttribute("aria-hidden", "true");
    topbarBtn.classList.toggle("is-open", isDetailOpen || Boolean(state.mobileTelemetryOpen));
    topbarBtn.setAttribute("aria-expanded", isDetailOpen ? "true" : "false");
  }

  const activeProvider = state.activeThread?.provider || $("composerProviderSelect")?.value || "";
  const activeProfileId = state.activeThread?.profileId || $("composerProfileSelect")?.value || "";
  const compactSlotHtml = renderAgentTelemetryBarHtml(state.profiles, merged, {
    providerFilter: state.providerFilter,
    expanded: false,
    refreshing: state.quotaRefreshing,
    visibleKeys,
    pickerOpen: false,
    activeProvider,
    activeProfileId,
  });

  if (desktopSlot) {
    if (desktopSlot._acLastHtml !== compactSlotHtml) {
      desktopSlot._acLastHtml = compactSlotHtml;
      desktopSlot.innerHTML = compactSlotHtml;
    }
    desktopSlot.hidden = !compactSlotHtml;
    desktopSlot.classList.toggle("is-popover-open", isDetailOpen);
  }

  if (backdrop) {
    const showBackdrop = Boolean(isDetailOpen && !telemetryClosing);
    backdrop.hidden = !showBackdrop;
    backdrop.classList.toggle("is-open", showBackdrop);
  }

  if (telemetryClosing) return;

  let html = isDetailOpen
    ? renderAgentTelemetryBarHtml(state.profiles, merged, {
        providerFilter: state.providerFilter,
        expanded: state.telemetryExpanded,
        refreshing: state.quotaRefreshing,
        visibleKeys,
        pickerOpen: state.telemetryPickerOpen,
        activeProvider,
        activeProfileId,
      })
    : compactSlotHtml;
  if (isDetailOpen) html += renderExecutionStatsHtml(state.executionStats, {
    days: state.executionStatsDays, provider: state.executionStatsProvider,
    loading: state.executionStatsLoading, error: state.executionStatsError,
  });

  if (!el) return;
  if (el._acLastHtml !== html) {
    el._acLastHtml = html;
    el.innerHTML = html;
  }
  el.hidden = !html;
  el.classList.toggle("is-expanded", Boolean(html && isDetailOpen));
  el.classList.toggle("is-mobile-open", Boolean(html && (state.mobileTelemetryOpen || isDetailOpen)));
  if (isDetailOpen) syncTelemetryPopoverAnchor(el, getTelemetryHeroAnchorEl());
}

function renderQuotaStrip() {
  const el = $("agentQuotaStrip");
  if (el) {
    el.innerHTML = "";
    el.hidden = true;
  }
  renderAgentTelemetryBar();
}

async function refreshQuotasManual() {
  if (state.quotaRefreshing) return;
  state.quotaRefreshing = true;
  renderQuotaStrip();
  try {
    let res = await apiPost("api/quotas/refresh", {});
    if ((!Array.isArray(res?.quotas) || !res.quotas.length) && state.useHotExtension) {
      res = await apiPost("apps/ac-hot/api/quotas/refresh", {}).catch(() => res);
    }
    const byKey = res?.byKey && typeof res.byKey === "object" ? res.byKey : null;
    if (byKey && Array.isArray(state.profiles) && state.profiles.length) {
      state.profiles = state.profiles.map((p) => {
        const key = p.key || `${p.provider}:${p.id}`;
        return byKey[key] ? { ...p, quota: byKey[key] } : p;
      });
      syncProfileSelectors();
      renderTopbarAndControls();
    } else {
      await refreshProviders();
    }
  } catch (err) {
    showToastBanner("刷新额度失败", { detail: formatActionError(err), error: true });
  } finally {
    state.quotaRefreshing = false;
    renderQuotaStrip();
  }
}

function syncComposerProfileSelect() {
  const select = $("composerProfileSelect");
  const provider = currentComposerProvider();
  const rawList = filterProfilesByProvider(state.profiles, provider);
  const list = sortProfilesByAvailability(rawList);
  const prev = select.value;
  select.innerHTML = (list.length ? list : [{ id: defaultProfileForProvider(provider), label: "默认" }])
    .map((p) => `<option value="${escapeHtml(p.id)}" data-compact-label="${escapeHtml(resolveDistinctProfileChipText(p, list))}">${escapeHtml(profileOptionLabel(p))}</option>`)
    .join("");
  if (state.activeThread?.profileId) {
    select.value = state.activeThread.profileId;
  } else if ([...select.options].some((o) => o.value === prev)) {
    select.value = prev;
  } else {
    select.value = defaultProfileForProvider(provider);
  }
  const hasActiveThread = Boolean(state.activeThread);
  select.disabled = hasActiveThread;
  select.hidden = list.length === 0;

  const pillsEl = $("composerProfilePills");
  if (pillsEl) {
    pillsEl.innerHTML = renderProfilePillsHtml(list, {
      selectedId: select.value,
      probingKeys: state.probingProfileKeys,
      activeLocked: hasActiveThread,
    });
  }

  syncCfgFieldVisibility();
  renderComposerConfigChip();
  syncAllCustomSelects();
}

function syncNewProviderPills() {
  const pillsEl = $("newProviderPills");
  if (!pillsEl) return;
  const provider = $("newProviderSelect")?.value || defaultNewThreadProvider();
  pillsEl.innerHTML = renderProviderPillsHtml({
    selectedProvider: provider,
    profiles: state.profiles,
  });
}

function selectNewModalProvider(nextProvider) {
  const select = $("newProviderSelect");
  if (!select || !nextProvider) return;
  if (![...select.options].some((o) => o.value === nextProvider)) return;
  select.value = nextProvider;
  syncNewProviderPills();
  syncNewProfileSelect();
  void refreshModelsForProfile(nextProvider, $("newProfileSelect")?.value || "");
}

function syncNewProfileSelect() {
  const provider = $("newProviderSelect").value || defaultProviderValue();
  const list = sortProfilesByAvailability(filterProfilesByProvider(state.profiles, provider));
  const select = $("newProfileSelect");
  const prev = select.value;
  select.innerHTML = (list.length ? list : [{ id: defaultProfileForProvider(provider), label: "默认" }])
    .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(profileOptionLabel(p))}</option>`)
    .join("");
  if ([...select.options].some((o) => o.value === prev && !list.find((p) => p.id === prev)?.health?.disabled)) {
    select.value = prev;
  } else {
    select.value = defaultProfileForProvider(provider);
  }
  const pillsEl = $("newProfilePills");
  if (pillsEl) {
    pillsEl.innerHTML = renderProfilePillsHtml(list, {
      selectedId: select.value,
      probingKeys: state.probingProfileKeys,
      activeLocked: false,
    });
  }
  const probeBtn = $("newModalProbeProfilesBtn");
  if (probeBtn) {
    const anyProbing = list.some((p) => state.probingProfileKeys.has(p.key || `${p.provider}:${p.id}`));
    probeBtn.disabled = anyProbing || !list.length;
    probeBtn.innerHTML = anyProbing ? "测通中…" : `${iconSvg("bolt", { size: 11 })}<span>测通</span>`;
  }
  syncNewModelSelect();
}

function renderModelOptionsHtml(models = []) {
  const renderOption = (m) =>
    `<option value="${escapeHtml(m.id || m.model)}">${escapeHtml(m.displayName || m.model || m.id)}</option>`;
  const mainItems = models.filter((m) => m?.section !== "overflow");
  const overflowItems = models.filter((m) => m?.section === "overflow");
  if (mainItems.length && overflowItems.length) {
    return `<optgroup label="主力模型">${mainItems.map(renderOption).join("")}</optgroup>`
      + `<optgroup label="更多版本">${overflowItems.map(renderOption).join("")}</optgroup>`;
  }
  return models.map(renderOption).join("");
}

function syncNewModelSelect(preferredModel = "") {
  const modelSelect = $("newModelSelect");
  if (!modelSelect) return;
  const provider = $("newProviderSelect").value || defaultProviderValue();
  preferredModel ||= getNewThreadPrefs(provider).model || "";
  const rawModels = resolveModelsForProvider(state.modelsByProvider, state.allModels, provider);
  const models = ensurePreferredModelInList(rawModels, provider, preferredModel);
  if (!models.length) {
    modelSelect.innerHTML = `<option value="">默认模型</option>`;
    return;
  }
  modelSelect.innerHTML = renderModelOptionsHtml(models);
  const selected = pickDefaultModelForProvider(models, provider, preferredModel);
  if (selected) modelSelect.value = selected.id || selected.model;
}

function effectivePermissionModeForThread(threadId = state.activeThreadId, threadObj = state.activeThread) {
  const localPref = getLocalThreadPrefs(threadId);
  return normalizeUiPermissionMode(
    localPref?.permissionMode || threadObj?.permissionMode || state.defaultPermissionMode || "turbo",
    "turbo",
  );
}

function syncPermissionSelectors() {
  const permSelect = $("permissionSelect");
  if (permSelect) {
    const effective = effectivePermissionModeForThread();
    permSelect.disabled = false;
    permSelect.hidden = false;
    permSelect.value = effective;
    permSelect.classList.toggle("is-turbo", effective === "turbo");
  }
  const newPermSelect = $("newPermissionSelect");
  if (newPermSelect && !$("newThreadModal")?.open) {
    newPermSelect.value = normalizeUiPermissionMode(state.defaultPermissionMode || "turbo", "turbo");
  }
  renderComposerConfigChip();
  syncAllCustomSelects();
}

function syncModelAndEffortSelectors() {
  const provider = currentComposerProvider();
  const modelSelect = $("modelSelect");
  const effortSelect = $("effortSelect");
  const keepDraftModel = !state.activeThread && state.lastModelProvider === provider && state.userPickedDraftModel;
  const localPref = getLocalThreadPrefs(state.activeThreadId);
  const preferredModel = localPref?.model
    || state.activeThread?.model
    || (keepDraftModel ? modelSelect.value : "")
    || (!state.activeThreadId ? getNewThreadPrefs(provider).model : "")
    || "";
  const rawModels = resolveModelsForProvider(state.modelsByProvider, state.allModels, provider);
  const models = ensurePreferredModelInList(rawModels, provider, preferredModel);
  state.lastModelProvider = provider;

  modelSelect.disabled = false;
  modelSelect.hidden = false;

  if (!models.length) {
    modelSelect.innerHTML = `<option value="">默认模型</option>`;
    effortSelect.hidden = true;
    effortSelect.disabled = true;
    syncCfgFieldVisibility();
    renderComposerConfigChip();
    syncAllCustomSelects();
    return;
  }

  modelSelect.innerHTML = renderModelOptionsHtml(models);

  const selected = pickDefaultModelForProvider(models, provider, preferredModel);
  if (selected) modelSelect.value = selected.id || selected.model;

  syncEffortSelectForModel(selected);
  syncCfgFieldVisibility();
  renderComposerConfigChip();
  syncAllCustomSelects();
}

function normalizeEffortOptionValue(item) {
  if (!item) return "";
  if (typeof item === "string") {
    const trimmed = item.trim();
    return trimmed === "[object Object]" ? "" : trimmed;
  }
  if (typeof item === "object") {
    return normalizeEffortOptionValue(item.reasoningEffort ?? item.id ?? item.value ?? "");
  }
  return "";
}

function syncEffortSelectForModel(selected) {
  const effortSelect = $("effortSelect");
  const efforts = (selected?.supportedReasoningEfforts || [])
    .map(normalizeEffortOptionValue)
    .filter(Boolean);
  const effortLabels = { low: "低思考", medium: "中思考", high: "高思考", xhigh: "超高思考", max: "最高思考" };
  if (!efforts.length) {
    effortSelect.innerHTML = `<option value="">默认强度</option>`;
    effortSelect.value = "";
    effortSelect.disabled = true;
    effortSelect.hidden = true;
    syncCfgFieldVisibility();
    renderComposerConfigChip();
    syncAllCustomSelects();
    return;
  }
  effortSelect.hidden = false;
  effortSelect.disabled = false;
  effortSelect.innerHTML = efforts.map((e) =>
    `<option value="${escapeHtml(e)}">${escapeHtml(effortLabels[e] || e)}</option>`,
  ).join("");
  const localPref = getLocalThreadPrefs(state.activeThreadId);
  const legacyModelEffort = resolveAntigravityModelSelection(
    localPref?.model || state.activeThread?.model || "",
  ).effort;
  const preferredEffort = normalizeEffortOptionValue(localPref?.effort)
    || normalizeEffortOptionValue(state.activeThread?.reasoningEffort)
    || (!state.activeThreadId ? normalizeEffortOptionValue(getNewThreadPrefs(currentComposerProvider()).effort) : "")
    || normalizeEffortOptionValue(legacyModelEffort)
    || normalizeEffortOptionValue(selected?.defaultReasoningEffort)
    || "medium";
  if (efforts.includes(preferredEffort)) effortSelect.value = preferredEffort;
  syncCfgFieldVisibility();
  renderComposerConfigChip();
  syncAllCustomSelects();
}

function syncCfgFieldVisibility() {
  for (const id of ["composerProviderSelect", "effortSelect"]) {
    const el = $(id);
    const field = el?.closest(".cfg-field");
    if (field) field.hidden = Boolean(el.hidden);
  }
  const profileField = $("composerProfileField");
  if (profileField) {
    const provider = currentComposerProvider();
    const list = filterProfilesByProvider(state.profiles, provider);
    profileField.hidden = list.length === 0;
  }
}

function renderComposerConfigChip() {
  const btn = $("composerConfigBtn");
  if (!btn) return;
  const permMode = $("permissionSelect")?.value || effectivePermissionModeForThread() || "turbo";
  const permMeta = permissionVisualMeta(permMode);
  const provider = currentComposerProvider();
  const profileId = currentComposerProfileId();
  const providerProfiles = filterProfilesByProvider(state.profiles, provider);
  const activeProfile = providerProfiles.find((p) => p.id === profileId) || null;
  const profMeta = activeProfile ? profileHealthVisualMeta(activeProfile) : null;
  const hasProfileIssue = Boolean(profMeta && profMeta.status !== "unknown" && profMeta.status !== "healthy");
  const showProfileTag = Boolean(
    activeProfile && (providerProfiles.length >= 2 || hasProfileIssue || String(activeProfile.health?.alias || "").trim()),
  );
  const profileTag = showProfileTag ? resolveDistinctProfileChipText(activeProfile, providerProfiles) : "";

  const modelSelect = $("modelSelect");
  const rawModel = modelSelect?.selectedOptions?.[0]?.textContent || modelSelect?.value || "";
  const modelShort = compactModelBadgeLabel(rawModel);
  const effortSelect = $("effortSelect");
  const effortShort = (!effortSelect || effortSelect.hidden)
    ? ""
    : compactEffortBadgeLabel(effortSelect.value || "");
  const goalActive = Boolean(state.composerGoal || state.activeThread?.goalState?.active);

  btn.className = `composer-config-chip mobile-only tone-${permMeta.tone}`;
  btn.title = `权限: ${permMeta.label}${activeProfile ? ` · 实例: ${profileOptionLabel(activeProfile)}` : ""} · 模型: ${rawModel || "默认"}${effortShort ? ` · 思考: ${effortShort}` : ""}${goalActive ? " · Goal 开启" : ""}`;

  const permIconEl = $("cfgChipPermIcon");
  if (permIconEl) permIconEl.innerHTML = permMeta.icon;
  const profTextEl = $("cfgChipProfileText");
  if (profTextEl) {
    profTextEl.textContent = profileTag;
    profTextEl.hidden = !profileTag;
    profTextEl.className = `cfg-chip-profile${profMeta ? ` ${profMeta.dotClass}` : ""}`;
  }
  const modelEl = $("cfgChipModelText");
  if (modelEl) modelEl.textContent = modelShort;
  const effortEl = $("cfgChipEffortText");
  if (effortEl) {
    effortEl.textContent = effortShort;
    effortEl.hidden = !effortShort;
  }
  const goalDotEl = $("cfgChipGoalDot");
  if (goalDotEl) goalDotEl.hidden = !goalActive;
}

function autoResizePromptInput() {
  const input = $("promptInput");
  if (!input) return;
  input.style.height = "auto";
  if (!input.value) {
    input.style.height = "";
    return;
  }
  const maxHeight = window.innerWidth <= 960 ? 116 : 180;
  const nextHeight = Math.min(maxHeight, Math.max(36, input.scrollHeight));
  input.style.height = `${nextHeight}px`;
}

function syncBoardAttentionDot() {
  const dot = $("boardAttentionDot");
  if (!dot) return;
  const hasPending = state.pendingRequests.length > 0;
  const hasOtherLive = state.threads.some(
    (t) => t.id !== state.activeThreadId && (t.live || t.turns?.[t.turns.length - 1]?.status === "inProgress"),
  );
  if (hasPending) {
    dot.hidden = false;
    dot.className = "btn-attention-dot is-pending";
    dot.title = `有 ${state.pendingRequests.length} 项待确认请求`;
  } else if (hasOtherLive) {
    dot.hidden = false;
    dot.className = "btn-attention-dot is-live";
    dot.title = "有后台任务运行中";
  } else {
    dot.hidden = true;
    dot.className = "btn-attention-dot";
  }
}

function renderBatchActionBars() {
  const sidebarBar = $("sidebarBatchBar");
  const boardBar = $("boardBatchBar");
  const toggleBtn = $("sidebarBatchSelectBtn");
  if (toggleBtn) {
    toggleBtn.classList.toggle("is-active", Boolean(state.batchSelect.active));
    toggleBtn.textContent = state.batchSelect.active ? "退出" : "多选";
  }
  if (!state.batchSelect.active) {
    if (sidebarBar) {
      sidebarBar.hidden = true;
      sidebarBar.innerHTML = "";
    }
    if (boardBar) {
      boardBar.hidden = true;
      boardBar.innerHTML = "";
    }
    return;
  }
  const groups = getProjectGroups({ includeSearch: isBoardViewActive() });
  const visibleThreads = groups.flatMap((g) => g.threads || []);
  const idleVisibleCount = visibleThreads.filter((t) => !t.live && !(t.pendingCount > 0)).length;
  const barHtml = renderBatchActionBarHtml({
    selectedCount: state.batchSelect.selectedIds.size,
    totalVisibleCount: visibleThreads.length,
    idleVisibleCount,
    archivedView: Boolean(state.showArchived),
    submitting: Boolean(state.batchSelect.submitting),
  });
  if (sidebarBar) {
    sidebarBar.hidden = false;
    sidebarBar.innerHTML = barHtml;
  }
  const onBoard = isBoardViewActive();
  if (boardBar) {
    boardBar.hidden = !onBoard;
    boardBar.innerHTML = onBoard ? barHtml : "";
  }
}

function enterBatchSelectMode({ threadId = "", projectCwd = "" } = {}) {
  state.batchSelect.active = true;
  if (threadId) {
    state.batchSelect.selectedIds.add(threadId);
    state.batchSelect.lastTouchedThreadId = threadId;
  } else if (projectCwd) {
    const group = getProjectGroups().find((g) => g.cwd === projectCwd);
    for (const t of group?.threads || []) {
      if (t?.id) state.batchSelect.selectedIds.add(t.id);
    }
    state.batchSelect.lastTouchedThreadId = "";
  }
  renderThreadList();
  renderProjectBoard();
  renderBatchActionBars();
}

function exitBatchSelectMode() {
  if (!state.batchSelect.active && !state.batchSelect.selectedIds.size) return;
  state.batchSelect.active = false;
  state.batchSelect.submitting = false;
  state.batchSelect.selectedIds.clear();
  state.batchSelect.lastTouchedThreadId = "";
  renderThreadList();
  renderProjectBoard();
  renderBatchActionBars();
}

function toggleBatchThreadSelection(threadId, { shiftKey = false } = {}) {
  const cleanId = String(threadId || "").trim();
  if (!cleanId) return;
  if (shiftKey && state.batchSelect.lastTouchedThreadId) {
    const orderedIds = getProjectGroups().flatMap((g) => (g.threads || []).map((t) => t.id));
    const fromIdx = orderedIds.indexOf(state.batchSelect.lastTouchedThreadId);
    const toIdx = orderedIds.indexOf(cleanId);
    if (fromIdx >= 0 && toIdx >= 0) {
      const start = Math.min(fromIdx, toIdx);
      const end = Math.max(fromIdx, toIdx);
      for (let i = start; i <= end; i += 1) {
        if (orderedIds[i]) state.batchSelect.selectedIds.add(orderedIds[i]);
      }
      state.batchSelect.lastTouchedThreadId = cleanId;
      renderThreadList();
      renderProjectBoard();
      renderBatchActionBars();
      return;
    }
  }
  if (state.batchSelect.selectedIds.has(cleanId)) {
    state.batchSelect.selectedIds.delete(cleanId);
  } else {
    state.batchSelect.selectedIds.add(cleanId);
  }
  state.batchSelect.lastTouchedThreadId = cleanId;
  renderThreadList();
  renderProjectBoard();
  renderBatchActionBars();
}

function toggleBatchProjectSelection(cwd) {
  const group = getProjectGroups().find((g) => g.cwd === cwd);
  if (!group?.threads?.length) return;
  const selState = computeProjectGroupSelectionState(group, state.batchSelect.selectedIds);
  for (const t of group.threads) {
    if (!t?.id) continue;
    if (selState.checked) state.batchSelect.selectedIds.delete(t.id);
    else state.batchSelect.selectedIds.add(t.id);
  }
  state.batchSelect.lastTouchedThreadId = "";
  renderThreadList();
  renderProjectBoard();
  renderBatchActionBars();
}

function pruneBatchSelection() {
  if (!state.batchSelect.active || !state.batchSelect.selectedIds.size) return;
  const loadedIds = new Set((state.threads || []).map((t) => t.id).filter(Boolean));
  let changed = false;
  for (const id of [...state.batchSelect.selectedIds]) {
    if (!loadedIds.has(id)) {
      state.batchSelect.selectedIds.delete(id);
      changed = true;
    }
  }
  if (state.batchSelect.lastTouchedThreadId && !loadedIds.has(state.batchSelect.lastTouchedThreadId)) {
    state.batchSelect.lastTouchedThreadId = "";
  }
  if (changed) renderBatchActionBars();
}

async function executeBatchArchive() {
  if (state.batchSelect.submitting) return;
  const ids = [...state.batchSelect.selectedIds];
  if (!ids.length) return;
  const nextArchived = !state.showArchived;
  if (nextArchived) {
    const byId = new Map((state.threads || []).map((t) => [t.id, t]));
    const liveCount = ids.filter((id) => Boolean(byId.get(id)?.live)).length;
    if (liveCount > 0) {
      const ok = window.confirm(`所选 ${ids.length} 个会话中有 ${liveCount} 个正在运行，确定一并归档吗？`);
      if (!ok) return;
    }
  }
  state.batchSelect.submitting = true;
  renderBatchActionBars();
  try {
    await apiPostWithHotFallback("api/threads/archive", {
      threadIds: ids,
      archived: nextArchived,
    });
    if (nextArchived && !state.showArchived && ids.includes(state.activeThreadId)) {
      await selectThread("");
    }
    exitBatchSelectMode();
    await refreshThreads();
    showToastBanner(nextArchived ? `已归档 ${ids.length} 个会话` : `已恢复 ${ids.length} 个会话`);
  } catch (error) {
    state.batchSelect.submitting = false;
    renderBatchActionBars();
    const errMsg = formatActionError(error, nextArchived ? "批量归档失败" : "批量恢复失败");
    setComposerStatus("error", errMsg);
    showToastBanner("批量操作失败", { detail: errMsg, error: true });
  }
}

function handleBatchActionClick(action) {
  if (!action || state.batchSelect.submitting) return;
  if (action === "exit") {
    exitBatchSelectMode();
    return;
  }
  if (action === "clear-all") {
    state.batchSelect.selectedIds.clear();
    state.batchSelect.lastTouchedThreadId = "";
    renderThreadList();
    renderProjectBoard();
    renderBatchActionBars();
    return;
  }
  if (action === "select-all" || action === "select-idle") {
    const visibleThreads = getProjectGroups().flatMap((g) => g.threads || []);
    const targets = action === "select-idle"
      ? visibleThreads.filter((t) => !t.live && !(t.pendingCount > 0))
      : visibleThreads;
    for (const t of targets) {
      if (t?.id) state.batchSelect.selectedIds.add(t.id);
    }
    renderThreadList();
    renderProjectBoard();
    renderBatchActionBars();
    return;
  }
  if (action === "submit-archive") {
    void executeBatchArchive();
  }
}

function bindLongPressMultiSelect(containerEl, resolveTarget) {
  if (!containerEl) return;
  const LONG_PRESS_MS = 420;
  const MOVE_CANCEL_PX = 10;
  let timerId = null;
  let activePointerId = null;
  let startX = 0;
  let startY = 0;
  let suppressClickUntil = 0;

  const clearPending = () => {
    if (timerId) {
      clearTimeout(timerId);
      timerId = null;
    }
    activePointerId = null;
  };

  containerEl.addEventListener("pointerdown", (e) => {
    if (state.batchSelect.active) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (e.target.closest(
      "[data-new-in-cwd], [data-alias-cwd], [data-toggle-pin-cwd], [data-batch-fold-cwd], [data-sidebar-expand-cwd], [data-sidebar-collapse-cwd], [data-sidebar-stale-projects], [data-expand-project-cwd], [data-collapse-project-cwd], [data-board-action], input, select, textarea, a",
    )) {
      return;
    }
    const target = resolveTarget(e.target);
    if (!target) return;
    clearPending();
    activePointerId = e.pointerId;
    startX = Number(e.clientX) || 0;
    startY = Number(e.clientY) || 0;
    timerId = setTimeout(() => {
      timerId = null;
      activePointerId = null;
      suppressClickUntil = Date.now() + 850;
      try { navigator.vibrate?.(18); } catch {}
      enterBatchSelectMode(target);
    }, LONG_PRESS_MS);
  }, { passive: true });

  containerEl.addEventListener("pointermove", (e) => {
    if (!timerId || (activePointerId !== null && e.pointerId !== activePointerId)) return;
    const dx = Math.abs((Number(e.clientX) || 0) - startX);
    const dy = Math.abs((Number(e.clientY) || 0) - startY);
    if (dx > MOVE_CANCEL_PX || dy > MOVE_CANCEL_PX) {
      clearPending();
    }
  }, { passive: true });

  containerEl.addEventListener("pointerup", clearPending, { passive: true });
  containerEl.addEventListener("pointercancel", clearPending, { passive: true });
  containerEl.addEventListener("wheel", clearPending, { passive: true });
  containerEl.addEventListener("scroll", clearPending, { passive: true, capture: true });

  containerEl.addEventListener("click", (e) => {
    if (Date.now() < suppressClickUntil) {
      e.preventDefault();
      e.stopPropagation();
      suppressClickUntil = 0;
    }
  }, true);

  containerEl.addEventListener("contextmenu", (e) => {
    if ((state.batchSelect.active || timerId || Date.now() < suppressClickUntil) && resolveTarget(e.target)) {
      e.preventDefault();
    }
  });
}

function toggleSidebarGroupCollapse(cwd) {
  if (!cwd) return;
  const nowMs = Date.now();
  pruneExpiredSidebarPrefs(nowMs);
  const group = getProjectGroups().find((g) => g.cwd === cwd);
  const currentlyCollapsed = group
    ? resolveProjectGroupCollapsed(group, {
      activeThreadId: state.activeThreadId,
      hasQuery: Boolean(String(state.searchText || "").trim()),
      collapsedGroups: state.collapsedGroups,
      sidebarFoldPrefs: state.sidebarFoldPrefs,
      nowMs,
      liveActivityByThread: state.liveActivityByThread,
    })
    : state.collapsedGroups.has(cwd);
  state.collapsedGroups.delete(cwd);
  setSidebarGroupManualPref(cwd, currentlyCollapsed ? "expand" : "collapse", nowMs);
  renderThreadList();
}

let activeThreadContextMenu = null;

function closeThreadContextMenu() {
  if (activeThreadContextMenu) {
    activeThreadContextMenu.remove();
    activeThreadContextMenu = null;
  }
}

async function forkThreadAction(threadId, { upToTurnIndex = null, upToTurnId = "" } = {}) {
  if (!threadId) return;
  try {
    setComposerStatus("pending", "正在分叉会话…");
    const res = await apiPost("api/thread/fork", {
      threadId,
      ...(Number.isInteger(upToTurnIndex) && upToTurnIndex >= 0 ? { upToTurnIndex } : {}),
      ...(upToTurnId ? { upToTurnId } : {}),
    });
    await refreshThreads();
    if (res?.thread?.id) {
      await selectThread(res.thread.id);
    }
    setComposerStatus("success", "已分叉为新会话", { autoClearMs: 2600 });
    showToastBanner("已创建分叉会话", {
      detail: Number.isInteger(upToTurnIndex) && upToTurnIndex >= 0
        ? "已保留至当前轮次，后续对话已舍弃"
        : (res?.thread?.title || res?.thread?.name || "新会话"),
    });
  } catch (error) {
    const errMsg = formatActionError(error, "分叉会话失败");
    setComposerStatus("error", `分叉失败：${errMsg}`);
    showToastBanner("分叉失败", { detail: errMsg, error: true });
  }
}

function openThreadContextMenu(threadId, clientX = 0, clientY = 0) {
  closeThreadContextMenu();
  const thread = state.threads.find((t) => t.id === threadId);
  if (!thread) return;

  const menu = document.createElement("div");
  menu.className = "thread-context-menu";
  menu.setAttribute("role", "menu");
  menu.innerHTML = `
    <button type="button" class="thread-context-menu-item" data-menu-action="fork">${iconSvg("fork", { size: 14 })}<span>分叉会话</span></button>
    <button type="button" class="thread-context-menu-item" data-menu-action="rename">${iconSvg("edit", { size: 14 })}<span>重命名</span></button>
    <button type="button" class="thread-context-menu-item" data-menu-action="archive">${iconSvg("archive", { size: 14 })}<span>${thread.archived ? "取消归档" : "归档会话"}</span></button>
  `;
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  const maxX = Math.max(8, window.innerWidth - rect.width - 8);
  const maxY = Math.max(8, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.min(Math.max(8, clientX), maxX)}px`;
  menu.style.top = `${Math.min(Math.max(8, clientY), maxY)}px`;
  activeThreadContextMenu = menu;

  const onDismiss = (ev) => {
    if (ev.type === "keydown" && ev.key !== "Escape") return;
    if (ev.type === "pointerdown" && menu.contains(ev.target)) return;
    closeThreadContextMenu();
    document.removeEventListener("pointerdown", onDismiss, true);
    document.removeEventListener("keydown", onDismiss, true);
    window.removeEventListener("scroll", onDismiss, true);
  };
  document.addEventListener("pointerdown", onDismiss, true);
  document.addEventListener("keydown", onDismiss, true);
  window.addEventListener("scroll", onDismiss, true);

  menu.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-menu-action]");
    if (!btn) return;
    const action = btn.dataset.menuAction;
    closeThreadContextMenu();
    document.removeEventListener("pointerdown", onDismiss, true);
    document.removeEventListener("keydown", onDismiss, true);
    window.removeEventListener("scroll", onDismiss, true);

    if (action === "fork") {
      await forkThreadAction(threadId);
    } else if (action === "rename") {
      const next = prompt("输入新的会话标题：", thread.title || thread.name || "");
      if (!next || !next.trim()) return;
      try {
        await apiPost("api/thread/name", { threadId, name: next.trim() });
        await refreshThreads();
        if (state.activeThreadId === threadId) await selectThread(threadId, { focusScroll: false });
      } catch (error) {
        showToastBanner("重命名失败", { detail: formatActionError(error), error: true });
      }
    } else if (action === "archive") {
      const nextArchived = !thread.archived;
      try {
        await apiPost("api/thread/archive", { threadId, archived: nextArchived });
        await refreshThreads();
        if (state.activeThreadId === threadId && nextArchived && !state.showArchived) {
          await selectThread("");
        }
      } catch (error) {
        showToastBanner("归档失败", { detail: formatActionError(error), error: true });
      }
    }
  });
}

function renderThreadList() {
  const listEl = $("threadList");
  const warningsEl = $("threadWarnings");
  if (state.warnings.length) {
    warningsEl.hidden = false;
    warningsEl.textContent = state.warnings.map((w) => `${w.provider}/${w.profileId}: ${w.message}`).join("；");
  } else {
    warningsEl.hidden = true;
  }

  const nowMs = Date.now();
  pruneExpiredSidebarPrefs(nowMs);
  const groups = getProjectGroups({ includeSearch: false });
  const sidebarHtml = renderSidebarThreadListHtml(groups, {
    activeThreadId: state.activeThreadId,
    collapsedGroups: state.collapsedGroups,
    expandedSidebarGroups: state.expandedSidebarGroups,
    sidebarFoldPrefs: state.sidebarFoldPrefs,
    showStaleProjects: state.showStaleProjects,
    nowMs,
    providerFilter: state.providerFilter,
    profileFilter: "all",
    profiles: state.profiles,
    liveActivityByThread: state.liveActivityByThread,
    recentCompletedByThread: state.recentCompletedByThread,
    searchText: "",
    selectionMode: state.batchSelect.active,
    selectedThreadIds: state.batchSelect.selectedIds,
  });
  if (listEl._acLastHtml !== sidebarHtml) {
    listEl._acLastHtml = sidebarHtml;
    listEl.innerHTML = sidebarHtml;
  }

  // Populate recent CWDs datalist for modal.
  const cwds = groups.map((g) => g.cwd).filter(Boolean).slice(0, 24);
  const cwdsHtml = cwds.map((c) => `<option value="${escapeHtml(c)}"></option>`).join("");
  const datalistEl = $("recentCwdsList");
  if (datalistEl && datalistEl._acLastHtml !== cwdsHtml) {
    datalistEl._acLastHtml = cwdsHtml;
    datalistEl.innerHTML = cwdsHtml;
  }
  syncBoardAttentionDot();
  renderBatchActionBars();
}

function renderProjectBoard() {
  const boardEl = $("projectBoard");
  if (!boardEl) return;
  const shouldShowBoard = isBoardViewActive();
  if (!shouldShowBoard) {
    boardEl.hidden = true;
    boardEl.innerHTML = "";
    renderBatchActionBars();
    return;
  }

  const activeInput = document.activeElement?.id === "boardSearchInput" ? document.activeElement : null;
  const selStart = activeInput ? activeInput.selectionStart : null;
  const selEnd = activeInput ? activeInput.selectionEnd : null;

  const groups = getProjectGroups();
  const allGroups = getProjectGroups({ ignoreFilters: true });
  boardEl.hidden = false;
  boardEl.innerHTML = renderProjectBoardHtml({
    groups,
    allGroups,
    pendingRequests: state.pendingRequests,
    showAllProjects: state.showAllProjects,
    expandedProjects: state.expandedProjects,
    activeThreadId: state.activeThreadId,
    searchText: state.searchText,
    selectionMode: state.batchSelect.active,
    selectedThreadIds: state.batchSelect.selectedIds,
    profiles: state.profiles,
  });

  if (activeInput) {
    const nextInput = $("boardSearchInput");
    if (nextInput) {
      nextInput.focus({ preventScroll: true });
      if (typeof selStart === "number" && typeof selEnd === "number") {
        nextInput.setSelectionRange(selStart, selEnd);
      }
    }
  }
  renderBatchActionBars();
}

function renderProjectTaskStrip() {
  const stripEl = $("projectTaskStrip");
  if (!stripEl) return;
  stripEl.hidden = true;
  stripEl.classList.remove("is-single-task");
  stripEl.innerHTML = "";
}

function renderActiveHeading(title, cwd) {
  const titleEl = $("activeTitle");
  titleEl.textContent = title;
  titleEl.title = title;
  const cwdEl = $("activeCwd");
  const splitAt = Math.max(cwd.lastIndexOf("/"), cwd.lastIndexOf("\\"));
  cwdEl.title = cwd;
  cwdEl.setAttribute("aria-label", cwd);
  cwdEl.innerHTML = splitAt >= 0 && splitAt < cwd.length - 1
    ? `<span class="active-cwd-prefix">${escapeHtml(cwd.slice(0, splitAt + 1))}</span><span class="active-cwd-leaf">${escapeHtml(cwd.slice(splitAt + 1))}</span>`
    : escapeHtml(cwd);
}

function renderTopbarAndControls() {
  const thread = state.activeThread || (state.initialThreadLoading && state.activeThreadId
    ? (state.threads.find((t) => t.id === state.activeThreadId) || null)
    : null);
  const topbar = $("topbar");
  const provBadge = $("activeProviderBadge");
  const profBadge = $("activeProfileBadge");
  const projectCrumb = $("activeProjectCrumb");
  const goalBadge = $("activeGoalBadge");
  const goalBtn = $("goalToggleBtn");
  const interruptBtn = $("interruptBtn");
  const renameBtn = $("renameThreadBtn");
  const toggleImgBtn = $("toggleThreadImagesBtn");
  const archiveBtn = $("archiveThreadBtn");
  const boardBtn = $("boardToggleBtn");
  const moreDot = $("topbarMoreDot");
  const moreProjCard = $("topbarMoreProjectCard");

  boardBtn?.setAttribute("aria-pressed", isBoardViewActive() ? "true" : "false");

  if (!thread) {
    topbar?.classList.remove("is-running");
    provBadge.hidden = true;
    profBadge.hidden = true;
    if (projectCrumb) projectCrumb.hidden = true;
    goalBadge.hidden = true;
    goalBtn.hidden = true;
    interruptBtn.hidden = true;
    renameBtn.hidden = true;
    if (toggleImgBtn) toggleImgBtn.hidden = true;
    archiveBtn.hidden = true;
    if (moreDot) moreDot.hidden = !state.updateStatus?.hasUpdate;
    if (moreProjCard) moreProjCard.hidden = true;
    renderActiveHeading(state.newThreadCwd !== null && !state.boardOpen ? "新会话" : "项目与多任务总控",
      state.newThreadCwd !== null && !state.boardOpen ? state.newThreadCwd : "选择关注项目或点击语音说话直达对话");
    syncBoardAttentionDot();
    syncWorkspaceVisibility();
    renderLiveBanner();
    renderProjectTaskStrip();
    renderComposerControls();
    return;
  }

  const running = isActiveThreadRunning();
  topbar?.classList.toggle("is-running", running);

  const meta = providerVisualMeta(thread.provider);
  const activeProfile = state.profiles.find((p) => p.provider === thread.provider && p.id === thread.profileId) || null;
  const scopedProfiles = filterProfilesByProvider(state.profiles, thread.provider).filter((p) => p?.installed !== false);
  const profVisual = activeProfile ? profileHealthVisualMeta(activeProfile) : null;
  const profileLabel = activeProfile
    ? profileOptionLabel(activeProfile)
    : compactProfileDisplayLabel(thread.profileLabel || thread.profileId || "", thread.provider);
  const compactProfileText = activeProfile
    ? resolveDistinctProfileChipText(activeProfile, scopedProfiles)
    : abbreviateMiddleText(
        String(thread.profileLabel || thread.profileId || "")
          .replace(/^(Antigravity|Codex|Claude\s*Code|Claude|Grok)\s*[·:/\-]?\s*/i, "")
          .trim(),
        { head: 3, tail: 3, maxLen: 8 },
      );
  provBadge.hidden = false;
  provBadge.className = `provider-badge is-${thread.provider}`;
  provBadge.innerHTML = `<span class="provider-glyph" aria-hidden="true">${providerIconSvg(thread.provider, { size: 12 })}</span><span class="provider-text">${escapeHtml(meta.short)}</span>`;
  provBadge.title = `${meta.label}${profileLabel ? ` · ${profileLabel}` : ""}`;

  const hasProfAlert = Boolean(profVisual && profVisual.status !== "unknown" && profVisual.status !== "healthy");
  const hasProfAlias = Boolean(String(activeProfile?.health?.alias || "").trim());
  const hideRedundantProfBadge = scopedProfiles.length <= 1 && !hasProfAlert && !hasProfAlias;
  if (hideRedundantProfBadge || !compactProfileText) {
    profBadge.hidden = true;
    profBadge.textContent = "";
    profBadge.className = "profile-badge";
  } else {
    profBadge.hidden = false;
    profBadge.textContent = compactProfileText;
    profBadge.className = `profile-badge${profVisual ? ` ${profVisual.dotClass}` : ""}`;
    profBadge.title = `当前实例：${profileLabel}（点击查看全部实例健康状态、手动测通或同目录接力）`;
  }

  const cwdKey = normalizeProjectCwd(thread.cwd);
  const projMeta = state.projectsMeta[cwdKey] || {};
  const isPinned = Boolean(projMeta.pinned);
  if (projectCrumb) {
    projectCrumb.hidden = true;
    projectCrumb.setAttribute("aria-hidden", "true");
    projectCrumb.textContent = "";
    projectCrumb.classList.remove("is-pinned");
  }

  renderActiveHeading(thread.title || "新会话", thread.cwd || "");

  const goalActive = Boolean(thread.goalState?.active);
  goalBadge.hidden = !goalActive;
  goalBadge.classList.remove("is-active", "is-done");
  if (goalActive) {
    const turnCount = thread.goalState?.turnCount || 1;
    const maxTurns = thread.goalState?.maxTurns || 20;
    goalBadge.innerHTML = `${iconSvg("target", { size: 11 })}<span>${turnCount}/${maxTurns}</span>`;
    goalBadge.classList.add("is-active");
    goalBadge.title = `Goal 自动推进中 (${turnCount}/${maxTurns})，点击可切换`;
  } else if (thread.goalState?.status === "completed") {
    goalBadge.hidden = false;
    goalBadge.innerHTML = `${iconSvg("target", { size: 11 })}${iconSvg("check", { size: 11 })}`;
    goalBadge.classList.add("is-done");
    goalBadge.title = "Goal 已达成";
  }

  if (moreDot) moreDot.hidden = !(goalActive || state.updateStatus?.hasUpdate);

  if (moreProjCard) {
    moreProjCard.hidden = !thread.cwd;
    const pinBtn = $("topbarPinProjectBtn");
    if (pinBtn) {
      pinBtn.innerHTML = `${isPinned ? iconSvg("star-filled", { size: 12 }) : iconSvg("star", { size: 12 })}<span>${isPinned ? "已关注" : "关注项目"}</span>`;
      pinBtn.classList.toggle("is-pinned", isPinned);
    }
    const cwdEl = $("topbarMoreCwd");
    if (cwdEl) cwdEl.textContent = thread.cwd || "";
  }

  goalBtn.hidden = false;
  goalBtn.textContent = goalActive ? "关闭 Goal" : "开启 Goal";

  interruptBtn.hidden = !running;
  renameBtn.hidden = false;
  if (toggleImgBtn) {
    toggleImgBtn.hidden = false;
    toggleImgBtn.textContent = isThreadImagesUnlocked(thread.id) ? "收起本会话预览图" : "加载本会话预览图";
  }
  archiveBtn.hidden = false;
  archiveBtn.textContent = thread.archived ? "取消归档" : "归档";

  syncBoardAttentionDot();
  syncWorkspaceVisibility();
  renderLiveBanner();
  renderProjectTaskStrip();
  renderComposerControls();
}

function renderLiveBanner() {
  const banner = $("liveBanner");
  if (state.toastActive) {
    banner.classList.remove("is-ambient");
    return;
  }
  const running = isActiveThreadRunning();
  if (!running) {
    banner.classList.remove("is-error", "is-ambient");
    banner.hidden = true;
    return;
  }
  // When actively following an open chat thread, live streaming progress is already shown inline below messages.
  if (!state.boardOpen && state.autoFollow && state.activeThread) {
    banner.classList.remove("is-error", "is-ambient");
    banner.hidden = true;
    return;
  }
  banner.classList.remove("is-error");
  banner.hidden = false;
  const { phase, detail } = humanizeLiveActivity(state.liveActivity, {
    isStreamingText: Boolean(state.streamingText),
  });
  const isAmbient = !detail && (/执行中$/.test(phase) || (Boolean(state.streamingText) && phase === "正在生成回复…"));
  banner.classList.toggle("is-ambient", isAmbient);
  $("livePhaseText").textContent = phase;
  $("liveDetailText").textContent = detail;
}

function currentInlineLivePhase() {
  if (!isActiveThreadRunning()) return "";
  const { phase, detail } = humanizeLiveActivity(state.liveActivity, {
    isStreamingText: Boolean(state.streamingText),
  });
  if (!phase && !detail) return "";
  return detail && detail !== phase ? `${phase} · ${detail}` : (phase || detail || "");
}

function captureTurnListOpenKeys(blocks, startIdx = 0) {
  const keys = new Set();
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (!block) continue;
    const turnKey = block.getAttribute("data-turn-id") || `idx:${startIdx + i}`;
    const boxes = block.querySelectorAll(".process-summary-box, .heartbeat-disclosure");
    for (let b = 0; b < boxes.length; b += 1) {
      if (boxes[b].open) keys.add(`${turnKey}:${b}`);
    }
  }
  return keys;
}

function restoreTurnListOpenKeys(blocks, openKeys, startIdx = 0) {
  if (!openKeys || !openKeys.size) return;
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (!block) continue;
    const turnKey = block.getAttribute("data-turn-id") || `idx:${startIdx + i}`;
    const boxes = block.querySelectorAll(".process-summary-box, .heartbeat-disclosure");
    for (let b = 0; b < boxes.length; b += 1) {
      if (openKeys.has(`${turnKey}:${b}`)) boxes[b].open = true;
    }
  }
}

function activeDisplayTurns() {
  if (!state.activeThread || state.boardOpen) return [];
  return dedupeAdjacentTurns(Array.isArray(state.activeThread.turns) ? state.activeThread.turns : []);
}

let deferredImageObserver = null;
let renderedTurnHtmlCache = [];
let renderedThreadCacheId = "";
let deferredObserveRafId = 0;
const REVEALED_IMAGE_CACHE_LIMIT = 600;
const revealedDeferredImageSrcs = new Set();
const unlockedImageThreadIds = new Set();

function rememberRevealedImageSrc(src = "") {
  const clean = String(src || "").trim();
  if (!clean) return;
  if (revealedDeferredImageSrcs.has(clean)) {
    revealedDeferredImageSrcs.delete(clean);
  } else if (revealedDeferredImageSrcs.size >= REVEALED_IMAGE_CACHE_LIMIT) {
    const oldest = revealedDeferredImageSrcs.values().next().value;
    if (oldest !== undefined) revealedDeferredImageSrcs.delete(oldest);
  }
  revealedDeferredImageSrcs.add(clean);
}

function isThreadImagesUnlocked(threadId = state.activeThread?.id || state.activeThreadId || "") {
  const clean = String(threadId || "").trim();
  return Boolean(clean && unlockedImageThreadIds.has(clean));
}

function syncThreadImagesUnlockedClass() {
  const unlocked = isThreadImagesUnlocked();
  $("turnList")?.classList.toggle("is-images-unlocked", unlocked);
  $("streamingTurn")?.classList.toggle("is-images-unlocked", unlocked);
}

function setThreadImagesUnlocked(threadId, unlocked) {
  const cleanTid = String(threadId || "").trim();
  if (!cleanTid) return;
  if (unlocked) {
    unlockedImageThreadIds.add(cleanTid);
    syncThreadImagesUnlockedClass();
    renderTopbarAndControls();
    scheduleDeferredImagesObservation($("messagesViewport"));
    return;
  }
  unlockedImageThreadIds.delete(cleanTid);
  const encodedTid = encodeURIComponent(cleanTid);
  for (const src of [...revealedDeferredImageSrcs]) {
    if (src.includes(`threadId=${encodedTid}`) || src.includes(cleanTid)) {
      revealedDeferredImageSrcs.delete(src);
    }
  }
  resetDeferredImageObserver({ resetRevealed: false });
  resetTurnListRenderCache();
  renderTopbarAndControls();
  renderActiveMessages();
}

function resetTurnListRenderCache() {
  renderedTurnHtmlCache = [];
  renderedThreadCacheId = "";
}

function resetDeferredImageObserver({ resetRevealed = true } = {}) {
  if (deferredObserveRafId) {
    cancelAnimationFrame(deferredObserveRafId);
    deferredObserveRafId = 0;
  }
  if (deferredImageObserver) {
    deferredImageObserver.disconnect();
    deferredImageObserver = null;
  }
  if (resetRevealed) {
    revealedDeferredImageSrcs.clear();
  }
}

function markCardImageDeferredState(img, { deferred = false } = {}) {
  img.classList.toggle("is-deferred-image", deferred);
  const card = img.closest(".msg-image-card");
  if (card) {
    card.classList.toggle("is-deferred", deferred);
    if (!deferred) {
      const btn = card.querySelector(".msg-image-btn");
      if (btn?.dataset.previewCaption) {
        btn.title = `点击放大预览：${btn.dataset.previewCaption}`;
      }
    }
  }
  const inlineWrap = img.closest(".md-inline-img-wrap");
  if (inlineWrap) {
    inlineWrap.classList.toggle("is-deferred", deferred);
  }
}

function markCardImageBroken(img) {
  markCardImageDeferredState(img, { deferred: false });
  const inlineWrap = img.closest(".md-inline-img-wrap");
  const targetInline = inlineWrap || (img.classList.contains("md-inline-img") ? img : null);
  if (targetInline) {
    const replacement = document.createElement("span");
    replacement.className = "msg-file-chip";
    replacement.title = img.dataset.previewCaption || img.getAttribute("alt") || "";
    replacement.innerHTML = `${iconSvg("image", { size: 12 })}<span>${escapeHtml(img.getAttribute("alt") || "图片")}</span>`;
    targetInline.replaceWith(replacement);
    return;
  }
  const card = img.closest(".msg-image-card");
  if (!card) return;
  card.classList.add("is-broken");
  const fallback = card.querySelector(".msg-file-chip.is-fallback");
  if (fallback) fallback.hidden = false;
}

function hydrateRevealedDeferredImages(containerEl) {
  if (!containerEl) return;
  const imgs = containerEl.querySelectorAll("img[data-lazy-src]");
  for (const img of imgs) {
    const lazySrc = img.dataset.lazySrc || "";
    if (!lazySrc) continue;
    if (isThreadImageFailed(lazySrc)) {
      delete img.dataset.lazySrc;
      revealedDeferredImageSrcs.delete(lazySrc);
      markCardImageBroken(img);
      continue;
    }
    if (!revealedDeferredImageSrcs.has(lazySrc)) continue;
    delete img.dataset.lazySrc;
    img.src = lazySrc;
    markCardImageDeferredState(img, { deferred: false });
  }
}

function activateDeferredImage(img) {
  if (!(img instanceof HTMLImageElement)) return;
  const lazySrc = img.dataset.lazySrc || "";
  if (!lazySrc) return;
  delete img.dataset.lazySrc;
  deferredImageObserver?.unobserve(img);
  if (isThreadImageFailed(lazySrc)) {
    revealedDeferredImageSrcs.delete(lazySrc);
    markCardImageBroken(img);
    return;
  }
  rememberRevealedImageSrc(lazySrc);

  const vp = $("messagesViewport");
  const beforeRect = vp ? img.getBoundingClientRect() : null;
  const finishLoad = () => {
    img.removeEventListener("load", onLoad);
    img.removeEventListener("error", onError);
    markCardImageDeferredState(img, { deferred: false });
    if (!vp) return;
    if (state.autoFollow) {
      scrollViewportIfFollowing();
    } else if (beforeRect) {
      const vpRect = vp.getBoundingClientRect();
      if (beforeRect.bottom <= vpRect.top + 8) {
        const afterHeight = img.getBoundingClientRect().height;
        const delta = afterHeight - beforeRect.height;
        if (Math.abs(delta) >= 1) {
          vp.scrollTop += delta;
        }
      }
    }
  };
  const onLoad = () => finishLoad();
  const onError = () => {
    img.removeEventListener("load", onLoad);
    img.removeEventListener("error", onError);
    markThreadImageFailed(lazySrc);
    revealedDeferredImageSrcs.delete(lazySrc);
    markCardImageBroken(img);
  };
  img.addEventListener("load", onLoad, { once: true });
  img.addEventListener("error", onError, { once: true });
  img.src = lazySrc;
  if (img.complete && img.naturalWidth > 0) {
    finishLoad();
  }
}

function isImageWithinViewport(img, vp) {
  if (!img || !vp) return false;
  const vpRect = vp.getBoundingClientRect();
  const rect = img.getBoundingClientRect();
  if (vpRect.width <= 0 || vpRect.height <= 0 || (rect.width <= 0 && rect.height <= 0)) {
    return false;
  }
  return rect.bottom > vpRect.top && rect.top < vpRect.bottom && rect.right > vpRect.left && rect.left < vpRect.right;
}

function ensureDeferredImageObserver() {
  const vp = $("messagesViewport");
  if (!vp || typeof IntersectionObserver !== "function") return null;
  if (!deferredImageObserver) {
    deferredImageObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting && entry.intersectionRatio <= 0) continue;
          activateDeferredImage(entry.target);
        }
      },
      {
        root: vp,
        rootMargin: "0px",
        threshold: 0.01,
      },
    );
  }
  return deferredImageObserver;
}

function scheduleDeferredImagesObservation(rootEl = $("messagesViewport")) {
  if (!rootEl) return;
  syncThreadImagesUnlockedClass();
  hydrateRevealedDeferredImages(rootEl);
  if (!isThreadImagesUnlocked()) return;
  if (deferredObserveRafId) {
    cancelAnimationFrame(deferredObserveRafId);
  }
  deferredObserveRafId = requestAnimationFrame(() => {
    deferredObserveRafId = 0;
    if (!isThreadImagesUnlocked()) return;
    const vp = $("messagesViewport");
    const imgs = rootEl.querySelectorAll("img[data-lazy-src]");
    if (!imgs.length) return;
    const observer = ensureDeferredImageObserver();
    if (!observer) {
      for (const img of imgs) {
        if (isImageWithinViewport(img, vp)) {
          activateDeferredImage(img);
        }
      }
      return;
    }
    for (const img of imgs) {
      if (revealedDeferredImageSrcs.has(img.dataset.lazySrc || "")) {
        activateDeferredImage(img);
        continue;
      }
      if (img.dataset.lazyObserved === "1") continue;
      img.dataset.lazyObserved = "1";
      observer.observe(img);
    }
  });
}

function captureViewportAnchor(vp) {
  if (!vp || state.autoFollow) return null;
  const turnListEl = $("turnList");
  if (!turnListEl || turnListEl.hidden || !turnListEl.children.length) return null;
  const vpRect = vp.getBoundingClientRect();
  if (vpRect.height <= 0) return null;
  const blocks = turnListEl.children;
  for (let i = 0; i < blocks.length; i += 1) {
    const el = blocks[i];
    const rect = el.getBoundingClientRect();
    if (rect.height <= 0) continue;
    const turnId = el.getAttribute("data-turn-id") || "";
    if (!turnId || rect.bottom <= vpRect.top + 4) continue;
    let childIdx = -1;
    let offsetTop = rect.top - vpRect.top;
    if (rect.top < vpRect.top - 24 && el.children.length > 0) {
      for (let c = 0; c < el.children.length; c += 1) {
        const cRect = el.children[c].getBoundingClientRect();
        if (cRect.height > 0 && cRect.bottom > vpRect.top + 4) {
          childIdx = c;
          offsetTop = cRect.top - vpRect.top;
          break;
        }
      }
    }
    return { turnId, childIdx, offsetTop };
  }
  return null;
}

function restoreViewportAnchor(vp, anchor) {
  if (!vp || !anchor || state.autoFollow) return;
  const turnListEl = $("turnList");
  if (!turnListEl || turnListEl.hidden) return;
  const vpRect = vp.getBoundingClientRect();
  let target = null;
  for (const el of turnListEl.children) {
    if ((el.getAttribute("data-turn-id") || "") === anchor.turnId) {
      target = el;
      break;
    }
  }
  if (!target) return;
  const anchorEl = (anchor.childIdx >= 0 && target.children[anchor.childIdx]) ? target.children[anchor.childIdx] : target;
  const nextOffsetTop = anchorEl.getBoundingClientRect().top - vpRect.top;
  const delta = nextOffsetTop - anchor.offsetTop;
  if (Math.abs(delta) >= 1) {
    vp.scrollTop += delta;
  }
}

function parseTurnBlockElement(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = String(html || "").trim();
  const block = tpl.content.firstElementChild;
  if (block) {
    for (const child of block.children) {
      child._acRawHtml = child.outerHTML;
    }
    hydrateRevealedDeferredImages(block);
  }
  return block;
}

function stampRawChildHtmls(containerEl) {
  if (!containerEl) return;
  for (const child of containerEl.children) {
    child._acRawHtml = child.outerHTML;
  }
}

function patchNodeWithSameClassOrTag(existingNode, nextNode) {
  const rawNext = nextNode._acRawHtml || nextNode.outerHTML;
  if (existingNode._acRawHtml === rawNext) return false;
  if (
    existingNode.classList.contains("process-card")
    && nextNode.classList.contains("process-card")
  ) {
    existingNode.className = nextNode.className;
    const prevSummary = existingNode.querySelector(":scope > .process-summary-box");
    const nextSummary = nextNode.querySelector(":scope > .process-summary-box");
    const prevFeed = existingNode.querySelector(":scope > .live-progress-feed");
    const nextFeed = nextNode.querySelector(":scope > .live-progress-feed");
    if (prevSummary && nextSummary) {
      const nextSumRaw = nextSummary.outerHTML;
      if (prevSummary._acRawHtml !== nextSumRaw) {
        const wasOpen = prevSummary.open;
        nextSummary._acRawHtml = nextSumRaw;
        hydrateRevealedDeferredImages(nextSummary);
        prevSummary.replaceWith(nextSummary);
        if (wasOpen) nextSummary.open = true;
      }
      if (prevFeed && nextFeed) {
        const nextFeedRaw = nextFeed.outerHTML;
        if (prevFeed._acRawHtml !== nextFeedRaw) {
          nextFeed._acRawHtml = nextFeedRaw;
          prevFeed.replaceWith(nextFeed);
        }
      } else if (!prevFeed && nextFeed) {
        nextFeed._acRawHtml = nextFeed.outerHTML;
        existingNode.appendChild(nextFeed);
      } else if (prevFeed && !nextFeed) {
        prevFeed.remove();
      }
      existingNode._acRawHtml = rawNext;
      return true;
    }
  }
  nextNode._acRawHtml = rawNext;
  hydrateRevealedDeferredImages(nextNode);
  existingNode.replaceWith(nextNode);
  return true;
}

function patchTurnBlockInPlace(existingBlock, nextHtml, turnIndex = 0) {
  const nextBlock = parseTurnBlockElement(nextHtml);
  if (!existingBlock || !nextBlock) return false;
  existingBlock.className = nextBlock.className;
  const nextTurnId = nextBlock.getAttribute("data-turn-id") || "";
  if (nextTurnId) existingBlock.setAttribute("data-turn-id", nextTurnId);

  const openKeys = captureTurnListOpenKeys([existingBlock], turnIndex);
  const existingChildren = Array.from(existingBlock.children);
  const nextChildren = Array.from(nextBlock.children);
  const common = Math.min(existingChildren.length, nextChildren.length);
  for (let i = 0; i < common; i += 1) {
    patchNodeWithSameClassOrTag(existingChildren[i], nextChildren[i]);
  }
  for (let i = common; i < nextChildren.length; i += 1) {
    hydrateRevealedDeferredImages(nextChildren[i]);
    existingBlock.appendChild(nextChildren[i]);
  }
  for (let i = existingChildren.length - 1; i >= nextChildren.length; i -= 1) {
    existingChildren[i].remove();
  }
  restoreTurnListOpenKeys([existingBlock], openKeys, turnIndex);
  return true;
}

function syncTurnListIncremental(turnListEl, threadId, turns) {
  const nextHtmls = turns.map((turn, idx) => renderTurnHtml(turn, buildTurnRenderOptions(turns, idx)));
  const sameThread = renderedThreadCacheId === threadId;
  const prevLen = renderedTurnHtmlCache.length;
  const nextLen = nextHtmls.length;

  // 头部加载更早历史时，若现有尾部序列与新列表末尾一致，仅在顶部前置新增回合，不重建下方可见节点与图片。
  if (
    sameThread
    && prevLen > 0
    && nextLen > prevLen
    && turnListEl.children.length === prevLen
  ) {
    const prependCount = nextLen - prevLen;
    let suffixMatches = true;
    for (let i = 0; i < prevLen; i += 1) {
      if (renderedTurnHtmlCache[i] !== nextHtmls[prependCount + i]) {
        suffixMatches = false;
        break;
      }
    }
    if (suffixMatches) {
      const frag = document.createDocumentFragment();
      for (let i = 0; i < prependCount; i += 1) {
        const el = parseTurnBlockElement(nextHtmls[i]);
        if (el) frag.appendChild(el);
      }
      turnListEl.insertBefore(frag, turnListEl.firstChild);
      renderedTurnHtmlCache = nextHtmls;
      return;
    }
  }

  if (
    !sameThread
    || prevLen === 0
    || turnListEl.children.length !== prevLen
  ) {
    const openKeys = sameThread ? captureTurnListOpenKeys(turnListEl.querySelectorAll(":scope > .turn-block"), 0) : null;
    turnListEl.innerHTML = nextHtmls.join("");
    for (const block of turnListEl.children) {
      stampRawChildHtmls(block);
    }
    hydrateRevealedDeferredImages(turnListEl);
    if (openKeys && openKeys.size) {
      restoreTurnListOpenKeys(turnListEl.querySelectorAll(":scope > .turn-block"), openKeys, 0);
    }
    renderedThreadCacheId = threadId;
    renderedTurnHtmlCache = nextHtmls;
    return;
  }

  const commonLen = Math.min(prevLen, nextLen);
  for (let i = 0; i < commonLen; i += 1) {
    if (renderedTurnHtmlCache[i] === nextHtmls[i]) continue;
    const existingEl = turnListEl.children[i];
    if (!patchTurnBlockInPlace(existingEl, nextHtmls[i], i)) {
      const openKeys = captureTurnListOpenKeys([existingEl], i);
      const replacement = parseTurnBlockElement(nextHtmls[i]);
      if (existingEl && replacement) {
        existingEl.replaceWith(replacement);
        restoreTurnListOpenKeys([replacement], openKeys, i);
      }
    }
  }

  if (nextLen > prevLen) {
    const frag = document.createDocumentFragment();
    for (let i = prevLen; i < nextLen; i += 1) {
      const el = parseTurnBlockElement(nextHtmls[i]);
      if (el) frag.appendChild(el);
    }
    turnListEl.appendChild(frag);
  } else if (prevLen > nextLen) {
    while (turnListEl.children.length > nextLen) {
      turnListEl.lastElementChild?.remove();
    }
  }

  renderedThreadCacheId = threadId;
  renderedTurnHtmlCache = nextHtmls;
}

function buildTurnRenderOptions(turns, idx) {
  const agentLabel = providerDisplayName(state.activeThread?.provider);
  const running = isActiveThreadRunning();
  const isLastTurn = idx === turns.length - 1;
  const hasStreamingReply = Boolean(state.streamingText);
  const turnRunning = isLastTurn && running && !hasStreamingReply;
  const targetTurn = turns[idx];
  const foldCompletedThoughtIntoLastProcess = Boolean(
    isLastTurn
    && hasStreamingReply
    && state.streamingThought
    && turnEndsWithProcessGroup(targetTurn),
  );
  return {
    agentLabel,
    threadId: state.activeThread?.id || state.activeThreadId || "",
    turnIndex: idx,
    forceRunning: turnRunning,
    suppressRunning: !turnRunning,
    liveThought: turnRunning ? state.streamingThought : "",
    livePhase: turnRunning ? currentInlineLivePhase() : "",
    trailingThought: foldCompletedThoughtIntoLastProcess ? state.streamingThought : "",
    hideSyntheticLiveReply: Boolean(isLastTurn && hasStreamingReply),
    showIncompleteSummaryHint: true,
    supersededByNextTurn: !isLastTurn,
    hasExternalStreamingReply: Boolean(isLastTurn && hasStreamingReply),
    fallbackModel: state.activeThread?.model || "",
    fallbackEffort: state.activeThread?.reasoningEffort || "",
    goalSuspended: Boolean(isLastTurn && state.activeThread?.goalState?.active),
    deferImages: true,
  };
}

function syncLiveTurnFrontier() {
  if (state.streamingText || !isActiveThreadRunning()) {
    renderStreamingTurn();
    return;
  }
  const turns = activeDisplayTurns();
  const turnListEl = $("turnList");
  if (!turns.length || !turnListEl || turnListEl.hidden || turnListEl.children.length !== turns.length) {
    if (turns.length) {
      renderActiveMessages();
    } else {
      renderStreamingTurn();
    }
    return;
  }
  const vp = $("messagesViewport");
  const anchor = captureViewportAnchor(vp);
  const lastIdx = turns.length - 1;
  const lastBlock = turnListEl.lastElementChild;
  if (!lastBlock) {
    renderActiveMessages();
    return;
  }
  const nextLastHtml = renderTurnHtml(turns[lastIdx], buildTurnRenderOptions(turns, lastIdx));
  if (renderedTurnHtmlCache[lastIdx] !== nextLastHtml) {
    if (!patchTurnBlockInPlace(lastBlock, nextLastHtml, lastIdx)) {
      const openKeys = captureTurnListOpenKeys([lastBlock], lastIdx);
      const replacement = parseTurnBlockElement(nextLastHtml);
      if (replacement) {
        lastBlock.replaceWith(replacement);
        restoreTurnListOpenKeys([replacement], openKeys, lastIdx);
      } else {
        lastBlock.outerHTML = nextLastHtml;
        if (turnListEl.lastElementChild) {
          restoreTurnListOpenKeys([turnListEl.lastElementChild], openKeys, lastIdx);
        }
      }
    }
    if (renderedTurnHtmlCache.length === turns.length) {
      renderedTurnHtmlCache[lastIdx] = nextLastHtml;
    }
  }
  renderStreamingTurn({ preserveAnchor: false });
  if (state.autoFollow) {
    scrollViewportIfFollowing();
  } else {
    restoreViewportAnchor(vp, anchor);
  }
  scheduleDeferredImagesObservation(vp);
}

function renderStreamingTurn({ preserveAnchor = true } = {}) {
  const el = $("streamingTurn");
  const vp = $("messagesViewport");
  const anchor = preserveAnchor ? captureViewportAnchor(vp) : null;
  const turns = activeDisplayTurns();
  if (!state.streamingText && turns.length > 0 && isActiveThreadRunning()) {
    el.hidden = true;
    el._acLastHtml = "";
    el.innerHTML = "";
    if (anchor) restoreViewportAnchor(vp, anchor);
    return;
  }
  if (!state.streamingText && !state.streamingThought) {
    el.hidden = true;
    el._acLastHtml = "";
    el.innerHTML = "";
    if (anchor) restoreViewportAnchor(vp, anchor);
    return;
  }
  el.hidden = false;
  const agentLabel = providerDisplayName(state.activeThread?.provider || currentComposerProvider());
  const streamBadge = formatTurnModelBadge({
    model: state.activeThread?.model || $("modelSelect")?.value || "",
    effort: state.activeThread?.reasoningEffort || ($("effortSelect")?.hidden ? "" : $("effortSelect")?.value || ""),
  });
  const streamModelPillHtml = streamBadge?.label
    ? `<span class="process-model-pill" title="${escapeHtml(streamBadge.title || streamBadge.label)}">${escapeHtml(streamBadge.label)}</span>`
    : "";
  const parts = [];
  const hasStreamingReply = Boolean(state.streamingText);
  const thoughtAlreadyFolded = Boolean(
    hasStreamingReply
    && state.streamingThought
    && turns.length > 0
    && turnEndsWithProcessGroup(turns[turns.length - 1]),
  );
  if (state.streamingThought && !thoughtAlreadyFolded) {
    const thoughtLabel = hasStreamingReply ? "已完成思考分析" : "执行过程 · 正在思考分析";
    const compactThought = state.streamingThought.replace(/\s+/g, " ").trim();
    const thoughtTail = compactThought.length > 180 ? `…${compactThought.slice(-180).trim()}` : compactThought;
    if (hasStreamingReply) {
      parts.push(`
        <div class="process-card">
          <details class="process-summary-box">
            <summary>
              <span class="process-summary-dot"></span>
              <span class="process-summary-text">${thoughtLabel}</span>
              ${streamModelPillHtml}
              <span class="process-summary-hint">查看推理</span>
            </summary>
            <div class="process-summary-body">
              <div class="tool-body md-body">${renderMarkdown(state.streamingThought, { deferImages: true })}</div>
            </div>
          </details>
        </div>
      `);
    } else {
      const liveThoughtPreviewHtml = thoughtTail
        ? `<div class="live-progress-feed" aria-live="polite"><div class="live-thought-preview" data-live-frontier="1"><span class="live-frontier-dot" aria-hidden="true"></span><span class="tool-kind">思考中</span><span class="live-thought-text">${escapeHtml(thoughtTail)}</span></div></div>`
        : "";
      parts.push(`
        <div class="process-card is-live">
          <details class="process-summary-box is-live">
            <summary>
              <span class="process-summary-dot"></span>
              <span class="process-summary-text">${thoughtLabel}</span>
              ${streamModelPillHtml}
              <span class="process-summary-hint">查看推理</span>
            </summary>
            <div class="process-summary-body">
              <div class="tool-body md-body">${renderMarkdown(state.streamingThought, { deferImages: true })}</div>
            </div>
          </details>
          ${liveThoughtPreviewHtml}
        </div>
      `);
    }
  }
  if (state.streamingText) {
    const streamThreadId = state.activeThread?.id || state.activeThreadId || "";
    const cleanStreamText = cleanStreamingAgentText(state.streamingText);
    parts.push(`
      <div class="msg-row msg-agent">
        <div class="msg-meta">
          <span class="msg-role">${escapeHtml(agentLabel)}</span>
          ${streamBadge?.label ? `<span class="turn-model-tag" title="${escapeHtml(streamBadge.title || streamBadge.label)}">${escapeHtml(streamBadge.label)}</span>` : ""}
          <span class="phase-tag is-streaming"><span class="live-frontier-dot" aria-hidden="true"></span>正在回复…</span>
          ${renderMessageCopyButton(cleanStreamText)}
        </div>
        <div class="msg-bubble agent-bubble md-body">${renderMarkdown(cleanStreamText, { threadId: streamThreadId, deferImages: true })}</div>
      </div>
    `);
  }
  const streamHtml = parts.join("");
  if (el._acLastHtml !== streamHtml) {
    el._acLastHtml = streamHtml;
    el.innerHTML = streamHtml;
    hydrateRevealedDeferredImages(el);
  }
  if (state.autoFollow) {
    scrollViewportIfFollowing();
  } else if (anchor) {
    restoreViewportAnchor(vp, anchor);
  }
  scheduleDeferredImagesObservation(el);
}

function renderActiveMessages() {
  const thread = state.activeThread;
  const turnListEl = $("turnList");
  const loadOlderWrap = $("loadOlderWrap");
  const vp = $("messagesViewport");

  syncWorkspaceVisibility();
  renderProjectBoard();
  renderProjectTaskStrip();

  if (state.initialThreadLoading && state.activeThreadId && !thread) {
    turnListEl.hidden = false;
    loadOlderWrap.hidden = true;
    $("streamingTurn").hidden = true;
    return;
  }

  if (!thread || state.boardOpen) {
    turnListEl.hidden = true;
    turnListEl.innerHTML = "";
    resetTurnListRenderCache();
    resetDeferredImageObserver({ resetRevealed: false });
    loadOlderWrap.hidden = true;
    $("streamingTurn").hidden = true;
    $("streamingTurn")._acLastHtml = "";
    if (!state.boardOpen && !thread) {
      renderStreamingTurn();
    }
    return;
  }

  const anchor = captureViewportAnchor(vp);
  turnListEl.hidden = false;
  loadOlderWrap.hidden = !state.nextCursor;
  const turns = dedupeAdjacentTurns(Array.isArray(thread.turns) ? thread.turns : []);
  syncTurnListIncremental(turnListEl, thread.id || state.activeThreadId || "", turns);
  renderStreamingTurn({ preserveAnchor: false });
  if (state.autoFollow) {
    scrollViewportIfFollowing();
  } else {
    restoreViewportAnchor(vp, anchor);
  }
  scheduleDeferredImagesObservation(vp);
}

function renderPendingRequests() {
  const dock = $("pendingRequestsDock");
  const list = state.pendingRequests.filter((r) => !state.activeThreadId || r.threadId === state.activeThreadId);
  syncBoardAttentionDot();
  if (isBoardViewActive() || !list.length) {
    dock.hidden = true;
    dock.innerHTML = "";
    return;
  }
  dock.hidden = false;
  syncServerRequestCards(dock, list);
}

function activeEditingQueueItem() {
  const edit = state.editingQueueItem;
  if (!edit || !state.activeThreadId || edit.threadId !== state.activeThreadId) return null;
  return edit;
}

function renderComposerEditBanner() {
  const banner = $("composerEditBanner");
  if (!banner) return;
  const edit = activeEditingQueueItem();
  if (!edit) {
    banner.hidden = true;
    banner.innerHTML = "";
    return;
  }
  const pos = Math.max(1, Number(edit.position) || 1);
  banner.hidden = false;
  banner.innerHTML = `
    <span class="composer-edit-banner-label">正在编辑排队 #${pos}</span>
    <span class="composer-edit-banner-tip">保存后保留原排位</span>
    <button type="button" class="composer-edit-banner-cancel" data-cancel-queue-edit="1">取消编辑</button>
  `;
}

function clearQueueEditState({ restoreDraft = false } = {}) {
  const prev = state.editingQueueItem;
  state.editingQueueItem = null;
  if (restoreDraft && prev && prev.threadId === state.activeThreadId) {
    const input = $("promptInput");
    if (input) input.value = String(prev.prevDraftText || "");
    state.images = Array.isArray(prev.prevImages) ? [...prev.prevImages] : [];
    state.composerGoal = Boolean(prev.prevGoal);
    renderComposerImages();
  }
  renderComposerEditBanner();
  renderQueuedTurns();
  renderComposerControls();
}

function renderQueuedTurns() {
  const bar = $("queuedTurnsBar");
  const items = state.queuedTurns || [];
  if (isBoardViewActive() || !items.length) {
    bar.hidden = true;
    bar._acLastHtml = "";
    bar.innerHTML = "";
    return;
  }
  bar.hidden = false;
  const queuedHtml = renderQueuedTurnsPanelHtml(items, {
    collapsed: state.queuedPanelCollapsed,
    editingId: activeEditingQueueItem()?.id || "",
  });
  if (bar._acLastHtml !== queuedHtml) {
    bar._acLastHtml = queuedHtml;
    bar.innerHTML = queuedHtml;
  }
}

function applyActiveQueuedTurns(threadId, items = []) {
  if (!threadId) return;
  const next = Array.isArray(items) ? items : [];
  const target = state.threads.find((t) => t.id === threadId);
  const countChanged = target ? (target.queuedCount || 0) !== next.length : false;
  syncThreadSummaryIntoList({ id: threadId, queuedCount: next.length });

  if (threadId === state.activeThreadId) {
    const activeEdit = activeEditingQueueItem();
    const matchedEditEntry = activeEdit ? next.find((q) => q.id === activeEdit.id) : null;
    if (activeEdit && !matchedEditEntry) {
      state.editingQueueItem = null;
      renderComposerEditBanner();
      renderComposerControls();
      setComposerStatus("info", "原排队消息已自动发送或取消，当前编辑内容保留在输入框", { autoClearMs: 4500 });
    } else if (activeEdit && matchedEditEntry && matchedEditEntry.position && matchedEditEntry.position !== activeEdit.position) {
      activeEdit.position = matchedEditEntry.position;
      renderComposerEditBanner();
    }

    const editingIdNow = activeEditingQueueItem()?.id || "";
    const prevSig = (state.queuedTurns || [])
      .map((q) => `${q.id}:${q.text || ""}:${q.imageCount || 0}:${q.source || ""}:${q.goalMode ? 1 : 0}:${q.updatedAt || ""}`)
      .join("|") + `#${editingIdNow}`;
    const nextSig = next
      .map((q) => `${q.id}:${q.text || ""}:${q.imageCount || 0}:${q.source || ""}:${q.goalMode ? 1 : 0}:${q.updatedAt || ""}`)
      .join("|") + `#${editingIdNow}`;
    if (state.activeThread) {
      state.activeThread.queuedCount = next.length;
    }
    state.queuedTurns = next;
    if (prevSig !== nextSig) {
      renderQueuedTurns();
    }
  }
  if (countChanged) {
    renderThreadList();
    renderProjectTaskStrip();
    renderProjectBoard();
  }
}

function renderComposerImages() {
  const wrap = $("composerImages");
  if (!state.images.length) {
    wrap.hidden = true;
    wrap.innerHTML = "";
    return;
  }
  wrap.hidden = false;
  wrap.innerHTML = state.images.map((img, idx) => {
    const caption = img?.name || `图片 ${idx + 1}`;
    return `
      <div class="composer-img-chip" title="${escapeHtml(caption)}">
        <button type="button" class="composer-img-thumb" data-preview-src="${escapeHtml(img.dataUrl)}" data-preview-caption="${escapeHtml(caption)}" aria-label="预览图片 ${escapeHtml(caption)}">
          <img src="${escapeHtml(img.dataUrl)}" alt="${escapeHtml(caption)}" />
          <span class="composer-img-name">${escapeHtml(caption)}</span>
        </button>
        <button type="button" class="composer-img-remove" data-remove-img="${idx}" aria-label="移除图片">${iconSvg("close", { size: 11 })}</button>
      </div>
    `;
  }).join("");
}

const PREVIEW_RASTER_RE = /\.(?:png|jpe?g|webp|gif)$/i;

function resolveImagePreviewLocalPath(src) {
  try {
    const url = new URL(src, location.href);
    const imageEndpoint = new URL("./api/thread/image", location.href);
    const fileEndpoint = new URL("./api/thread/file", location.href);
    if (url.origin !== imageEndpoint.origin || ![imageEndpoint.pathname, fileEndpoint.pathname].includes(url.pathname)) return "";
    const path = url.searchParams.get("path") || "";
    if (path.startsWith("/")) return path.startsWith("//") ? "" : path;
    if (!path || path.startsWith("~") || /^[a-z][a-z0-9+.-]*:/i.test(path)) return "";
    const threadId = url.searchParams.get("threadId");
    const thread = state.activeThread?.id === threadId
      ? state.activeThread
      : state.threads.find((item) => item.id === threadId);
    return thread?.cwd?.startsWith("/") ? `${thread.cwd.replace(/\/$/, "")}/${path}` : "";
  } catch { return ""; }
}

function openImagePreviewModal(src, caption = "", rawSrc = "") {
  const modal = $("imagePreviewModal");
  const img = $("imagePreviewImg");
  const capEl = $("imagePreviewCaption");
  const metaEl = $("imagePreviewMeta");
  const loadRawBtn = $("imagePreviewLoadRawBtn");
  const rawLink = $("imagePreviewOpenRaw");
  if (!modal || !img || !src) return;

  const isCompressedUrl = !src.startsWith("data:") && /[?&]w=\d+/i.test(src) && !/[?&]raw=1/i.test(src);
  const resolvedRaw = rawSrc || "";
  state.imagePreview = { src, rawSrc: resolvedRaw, caption, showingRaw: !isCompressedUrl, scale: 1, tx: 0, ty: 0 };

  const localPath = resolveImagePreviewLocalPath(resolvedRaw || src);
  for (const target of [img, capEl]) {
    if (!target) continue;
    if (localPath) target.dataset.localFilePath = localPath;
    else delete target.dataset.localFilePath;
  }
  img.src = src;
  img.alt = caption || "图片预览";
  img.style.transform = "";
  img.classList.remove("is-zoomed", "is-dragging");
  const zoomBtn = $("imagePreviewZoomBtn");
  if (zoomBtn) {
    zoomBtn.hidden = true;
    zoomBtn.textContent = "100%";
  }
  if (capEl) capEl.textContent = caption || "图片预览";
  if (metaEl) {
    metaEl.hidden = src.startsWith("data:");
    metaEl.textContent = isCompressedUrl ? "省流压缩" : "原图";
  }
  if (loadRawBtn) {
    const canUpgradeRaw = Boolean(isCompressedUrl && resolvedRaw && resolvedRaw !== src);
    loadRawBtn.hidden = !canUpgradeRaw;
    loadRawBtn.disabled = false;
    loadRawBtn.textContent = "加载原图";
  }
  if (rawLink) {
    const targetHref = resolvedRaw || src;
    if (targetHref.startsWith("data:")) {
      rawLink.hidden = true;
      rawLink.setAttribute("href", "#");
    } else {
      rawLink.hidden = false;
      rawLink.setAttribute("href", targetHref);
    }
  }
  if (!modal.open && typeof modal.showModal === "function") {
    modal.showModal();
  }
}

function renderFileCodeLinesHtml(content = "", { startLine = null, endLine = null } = {}) {
  const lines = String(content || "").replace(/\r\n?/g, "\n").split("\n");
  if (lines.length > 4000) {
    return `<pre class="file-preview-pre">${escapeHtml(content)}</pre>`;
  }
  const hiStart = Number(startLine) > 0 ? Number(startLine) : 0;
  const hiEnd = Number(endLine) >= hiStart && hiStart > 0 ? Number(endLine) : hiStart;
  return `
    <div class="file-code-lines">
      ${lines.map((ln, idx) => {
        const lineNo = idx + 1;
        const isHi = hiStart > 0 && lineNo >= hiStart && lineNo <= hiEnd;
        return `<div class="file-code-row${isHi ? " is-highlight" : ""}" data-line-no="${lineNo}"><span class="file-line-no">${lineNo}</span><span class="file-line-code">${escapeHtml(ln || " ")}</span></div>`;
      }).join("")}
    </div>
  `;
}

function renderFilePreviewBody(meta, { threadId = "", rawMode = false } = {}) {
  const bodyEl = $("filePreviewBody");
  if (!bodyEl || !meta) return;
  const targetLine = meta.startLine || 0;
  if (meta.kind === "markdown" && !rawMode) {
    bodyEl.innerHTML = `<div class="file-preview-md md-body">${renderMarkdown(meta.content || "", { threadId })}</div>`;
    return;
  }
  if (meta.kind === "video") {
    const src = `./api/thread/file?threadId=${encodeURIComponent(threadId)}&path=${encodeURIComponent(meta.requestPath || meta.displayPath || meta.name)}&mode=raw`;
    bodyEl.innerHTML = `<div class="file-preview-media-wrap"><video class="file-preview-video" controls playsinline preload="metadata" src="${escapeHtml(src)}"></video></div>`;
    return;
  }
  if (meta.kind === "audio") {
    const src = `./api/thread/file?threadId=${encodeURIComponent(threadId)}&path=${encodeURIComponent(meta.requestPath || meta.displayPath || meta.name)}&mode=raw`;
    bodyEl.innerHTML = `<div class="file-preview-media-wrap"><audio class="file-preview-audio" controls preload="metadata" src="${escapeHtml(src)}"></audio></div>`;
    return;
  }
  if (meta.kind === "pdf") {
    const src = `./api/thread/file?threadId=${encodeURIComponent(threadId)}&path=${encodeURIComponent(meta.requestPath || meta.displayPath || meta.name)}&mode=raw`;
    bodyEl.innerHTML = `
      <div class="file-preview-media-wrap is-pdf">
        <div class="file-preview-pdf-bar"><a class="btn-secondary btn-xs" href="${escapeHtml(src)}" target="_blank" rel="noopener noreferrer">在新标签页查看完整 PDF</a></div>
        <iframe class="file-preview-pdf" src="${escapeHtml(src)}" title="${escapeHtml(meta.name || "PDF 预览")}"></iframe>
      </div>
    `;
    return;
  }
  if (meta.kind === "binary") {
    bodyEl.innerHTML = `<div class="file-preview-empty">二进制文件（${escapeHtml(formatByteSize(meta.size || 0))}），请点击右上角「下载」到本地查看。</div>`;
    return;
  }
  const truncBanner = meta.truncated
    ? `<div class="file-preview-trunc-note">文件较大，仅展示前 ${escapeHtml(formatByteSize(256 * 1024))} 内容（完整文件请点右上角下载）。</div>`
    : "";
  bodyEl.innerHTML = `${truncBanner}${renderFileCodeLinesHtml(meta.content || "", { startLine: meta.startLine, endLine: meta.endLine })}`;
  if (targetLine > 0) {
    const targetRow = bodyEl.querySelector(`[data-line-no="${targetLine}"]`);
    targetRow?.scrollIntoView?.({ block: "center" });
  }
}

async function openFilePreviewModal(threadId, filePath, lineAnchor = null) {
  const cleanThreadId = String(threadId || "").trim();
  const cleanPath = String(filePath || "").trim();
  if (!cleanThreadId || !cleanPath) return;

  if (PREVIEW_RASTER_RE.test(cleanPath)) {
    const base = `./api/thread/image?threadId=${encodeURIComponent(cleanThreadId)}&path=${encodeURIComponent(cleanPath)}`;
    openImagePreviewModal(`${base}&w=1280&q=75`, cleanPath, `${base}&raw=1`);
    return;
  }

  const modal = $("filePreviewModal");
  const nameEl = $("filePreviewName");
  const pathEl = $("filePreviewPath");
  const metaEl = $("filePreviewMeta");
  const toggleBtn = $("filePreviewToggleRawBtn");
  const copyBtn = $("filePreviewCopyBtn");
  const dlBtn = $("filePreviewDownloadBtn");
  const bodyEl = $("filePreviewBody");
  if (!modal || !bodyEl) return;

  const baseName = cleanPath.split(/[\\/]/).filter(Boolean).pop() || cleanPath;
  if (nameEl) nameEl.textContent = baseName;
  if (pathEl) pathEl.textContent = lineAnchor ? `${cleanPath}#L${lineAnchor}` : cleanPath;
  if (metaEl) metaEl.hidden = true;
  if (toggleBtn) toggleBtn.hidden = true;
  if (copyBtn) copyBtn.hidden = true;
  if (dlBtn) {
    dlBtn.hidden = false;
    dlBtn.setAttribute("href", `./api/thread/file?threadId=${encodeURIComponent(cleanThreadId)}&path=${encodeURIComponent(cleanPath)}&mode=raw&download=1`);
  }
  bodyEl.innerHTML = `<div class="file-preview-empty">正在读取文件内容…</div>`;
  state.filePreview = { threadId: cleanThreadId, path: cleanPath, meta: null, rawMode: false };
  if (!modal.open && typeof modal.showModal === "function") {
    modal.showModal();
  }

  try {
    const refWithLine = lineAnchor ? `${cleanPath}#L${lineAnchor}` : cleanPath;
    const res = await apiGet(`api/thread/file?threadId=${encodeURIComponent(cleanThreadId)}&path=${encodeURIComponent(refWithLine)}`);
    const meta = {
      ...res,
      requestPath: cleanPath,
      startLine: Number(res?.startLine) || (Number(lineAnchor) || null),
      endLine: Number(res?.endLine) || (Number(lineAnchor) || null),
    };
    state.filePreview = { threadId: cleanThreadId, path: cleanPath, meta, rawMode: false };
    if (nameEl && meta.name) nameEl.textContent = meta.name;
    if (pathEl) {
      const shown = meta.displayPath || cleanPath;
      pathEl.textContent = meta.startLine ? `${shown}#L${meta.startLine}` : shown;
    }
    if (metaEl) {
      const parts = [String(meta.language || meta.kind || "").toUpperCase(), formatByteSize(meta.size || 0)];
      if (meta.lineCount) parts.push(`${meta.lineCount} 行`);
      metaEl.textContent = parts.filter(Boolean).join(" · ");
      metaEl.hidden = false;
    }
    if (toggleBtn) {
      toggleBtn.hidden = meta.kind !== "markdown";
      toggleBtn.textContent = "源码";
    }
    if (copyBtn) {
      copyBtn.hidden = !meta.content;
      copyBtn.textContent = "复制";
    }
    renderFilePreviewBody(meta, { threadId: cleanThreadId, rawMode: false });
  } catch (error) {
    const msg = formatActionError(error, "读取文件失败");
    bodyEl.innerHTML = `<div class="file-preview-error">无法预览该文件：${escapeHtml(msg)}</div>`;
  }
}

function renderComposerControls() {
  const running = isActiveThreadRunning();
  const modeSelect = $("runningSubmitMode");
  modeSelect.hidden = !running;
  const sub = resolveComposerSubmission({
    hasActiveThread: Boolean(state.activeThreadId),
    isRunning: running,
    isSubmitting: state.isSubmitting,
    isEditingQueue: Boolean(activeEditingQueueItem()),
    mode: modeSelect.value,
    text: $("promptInput").value,
    imageCount: state.images.length,
  });
  const sendBtn = $("sendBtn");
  if (state.imageProcessingCount > 0 && !state.isSubmitting) {
    sendBtn.textContent = "处理图片…";
    sendBtn.disabled = true;
    sendBtn.setAttribute("aria-busy", "true");
  } else {
    sendBtn.textContent = sub.buttonLabel;
    sendBtn.disabled = !sub.canSubmit;
    sendBtn.setAttribute("aria-busy", state.isSubmitting ? "true" : "false");
  }
  $("promptInput").readOnly = state.isSubmitting;
  $("composerGoalBtn").setAttribute("aria-pressed", state.composerGoal ? "true" : "false");
  const imgBadge = $("imageCountBadge");
  if (imgBadge) {
    imgBadge.textContent = String(state.images.length || "");
    imgBadge.hidden = state.images.length === 0;
  }
  renderComposerConfigChip();
  autoResizePromptInput();
  syncAllCustomSelects();
}

function closeSlashCommandMenu() {
  state.slashMenuOpen = false;
  state.slashManualOpen = false;
  state.slashTrigger = null;
  state.slashMenuItems = [];
  state.slashMenuIndex = 0;
  const menu = $("slashCommandMenu");
  if (menu) {
    menu.hidden = true;
    menu.innerHTML = "";
  }
  $("composerSlashBtn")?.setAttribute("aria-expanded", "false");
}

function renderSlashCommandMenu() {
  const menu = $("slashCommandMenu");
  if (!menu) return;
  if (!state.slashMenuOpen || !state.slashMenuItems.length) {
    menu.hidden = true;
    menu.innerHTML = "";
    $("composerSlashBtn")?.setAttribute("aria-expanded", "false");
    return;
  }
  menu.hidden = false;
  menu.innerHTML = renderSlashMenuHtml(state.slashMenuItems, state.slashMenuIndex);
  $("composerSlashBtn")?.setAttribute("aria-expanded", "true");
  const activeEl = menu.querySelector(".slash-command-item.is-active");
  activeEl?.scrollIntoView({ block: "nearest" });
}

async function fetchSlashCatalogForContext({ provider = "", cwd = "", query = "" } = {}) {
  const cleanProvider = String(provider || currentComposerProvider() || "antigravity").trim().toLowerCase();
  const cleanCwd = String(cwd || state.activeThread?.cwd || "").trim();
  const cleanQuery = String(query || "").trim();
  const key = `${cleanProvider}::${cleanCwd}::${cleanQuery}`;
  const cached = state.slashCatalogByKey.get(key);
  if (cached && (Date.now() - cached.at) < 15_000) {
    return cached.items;
  }
  const params = new URLSearchParams({ provider: cleanProvider });
  if (cleanCwd) params.set("cwd", cleanCwd);
  if (cleanQuery) params.set("q", cleanQuery);
  const res = await apiGet(`api/slash-commands?${params.toString()}`).catch(() => null);
  const items = Array.isArray(res?.items) ? res.items : [];
  if (items.length || !cleanQuery) {
    state.slashCatalogByKey.set(key, { at: Date.now(), items });
  }
  return items;
}

async function updateSlashCommandMenu({ manual = false } = {}) {
  const input = $("promptInput");
  if (!input) return;
  const text = input.value || "";
  const cursor = input.selectionStart ?? text.length;
  const trigger = parseSlashTrigger(text, cursor);

  if (!trigger && !manual && !state.slashManualOpen) {
    if (state.slashMenuOpen) closeSlashCommandMenu();
    return;
  }
  if (!trigger && state.slashManualOpen && text.trim()) {
    // Manual open while user continues typing non-slash text: close if cursor is not on a slash token.
    closeSlashCommandMenu();
    return;
  }

  state.slashTrigger = trigger;
  if (manual) state.slashManualOpen = true;
  const query = trigger?.query || "";
  const provider = currentComposerProvider();
  const cwd = state.activeThread?.cwd || "";
  const seq = ++state.slashFetchSeq;

  // Immediate render from pinned cache when available
  const pinnedCached = state.slashCatalogByKey.get(`${provider}::${cwd}::`)?.items;
  if (pinnedCached && pinnedCached.length) {
    const quick = filterSlashCommands(pinnedCached, query);
    if (quick.length) {
      state.slashMenuItems = quick;
      state.slashMenuIndex = 0;
      state.slashMenuOpen = true;
      renderSlashCommandMenu();
    }
  }

  const fetched = await fetchSlashCatalogForContext({ provider, cwd, query });
  if (seq !== state.slashFetchSeq) return;
  const finalItems = filterSlashCommands(fetched, query);
  if (!finalItems.length) {
    closeSlashCommandMenu();
    return;
  }
  state.slashMenuItems = finalItems;
  state.slashMenuIndex = 0;
  state.slashMenuOpen = true;
  renderSlashCommandMenu();
}

function applySlashMenuChoice(index) {
  const item = state.slashMenuItems[index];
  const input = $("promptInput");
  if (!item || !input) return;
  const applied = applySlashCommandSelection(input.value || "", item, state.slashTrigger);
  input.value = applied.text;
  closeSlashCommandMenu();
  renderComposerControls();
  input.focus();
  if (typeof input.setSelectionRange === "function") {
    input.setSelectionRange(applied.cursorPos, applied.cursorPos);
  }
}

function scrollViewportIfFollowing() {
  if (!state.autoFollow) return;
  const vp = $("messagesViewport");
  vp.scrollTop = vp.scrollHeight;
}

async function refreshProviders() {
  let resolvedProv = await apiGet("api/providers");
  let hasHealthMeta = Array.isArray(resolvedProv?.profiles)
    && resolvedProv.profiles.some((p) => p?.health && typeof p.health.status === "string");
  if (!hasHealthMeta) {
    try {
      const hotProv = await apiGet("apps/ac-hot/api/providers");
      if (Array.isArray(hotProv?.profiles) && hotProv.profiles.length) {
        resolvedProv = hotProv;
        state.useHotExtension = true;
        hasHealthMeta = resolvedProv.profiles.some((p) => p?.health && typeof p.health.status === "string");
      }
    } catch {
      // Main server already serves providers natively.
    }
  }
  state.providers = resolvedProv.providers || [];
  state.profiles = resolvedProv.profiles || [];
  const agyAvailable = state.profiles.find((p) => p.installed && !p.health?.disabled && p.provider === "antigravity" && p.id === "desktop")
    || state.profiles.find((p) => p.installed && !p.health?.disabled && p.provider === "antigravity");
  state.defaultProvider = resolvedProv.defaultProvider || "antigravity";
  if (!hasHealthMeta && agyAvailable) {
    state.defaultProvider = "antigravity";
    state.defaultProfileId = agyAvailable.id || "desktop";
  } else {
    state.defaultProfileId = resolvedProv.defaultProfileId || (state.defaultProvider === "antigravity" ? (agyAvailable?.id || "desktop") : "default");
  }
  if (resolvedProv.label) $("hostBadge").textContent = resolvedProv.label;
  syncProfileSelectors();
}

async function refreshModels() {
  const modelsRes = await apiGetWithHotFallback("api/models");
  state.allModels = modelsRes?.data || [];
  state.modelsByProvider = modelsRes?.byProvider || {};
  saveCachedModels(state.allModels, state.modelsByProvider);
  syncModelAndEffortSelectors();
  renderComposerControls();
}

async function refreshModelsForProfile(provider, profileId) {
  if (provider !== "claude" || !profileId) return;
  try {
    const res = await apiGetWithHotFallback(
      `api/models?provider=${encodeURIComponent(provider)}&profileId=${encodeURIComponent(profileId)}`,
    );
    const items = Array.isArray(res?.data) ? res.data : [];
    if (!items.length) return;
    state.modelsByProvider = {
      ...(state.modelsByProvider || {}),
      [provider]: items,
    };
    state.allModels = [
      ...(Array.isArray(state.allModels) ? state.allModels.filter((m) => m.provider !== provider) : []),
      ...items,
    ];
    saveCachedModels(state.allModels, state.modelsByProvider);
    syncModelAndEffortSelectors();
    syncNewModelSelect($("newModelSelect")?.value || "");
    renderComposerControls();
  } catch {
    // Preserve existing model list if profile refresh fails.
  }
}

async function refreshProvidersAndModels() {
  await Promise.all([
    refreshProviders(),
    refreshModels(),
  ]);
}

function markThreadUnread(threadId, { status = "completed", summary = "", updatedAt = 0 } = {}) {
  if (!threadId) return;
  const entry = {
    status: status || "completed",
    summary: stripMarkdownForSpeech(summary || "", 80),
    at: Date.now(),
    updatedAt: Number(updatedAt) || Math.floor(Date.now() / 1000),
  };
  state.recentCompletedByThread.set(threadId, entry);
  threadReadState.unreadById[threadId] = entry;
  persistThreadReadState();
}

function markThreadRead(threadId, updatedAtSec = 0) {
  if (!threadId) return;
  const hadUnread = state.recentCompletedByThread.has(threadId) || Boolean(threadReadState.unreadById[threadId]);
  state.recentCompletedByThread.delete(threadId);
  delete threadReadState.unreadById[threadId];
  const prevSeen = Number(threadReadState.seenById[threadId] || 0);
  const nextSeen = Math.max(Math.floor(Date.now() / 1000), Number(updatedAtSec) || 0, prevSeen);
  if (hadUnread || nextSeen > prevSeen) {
    threadReadState.seenById[threadId] = nextSeen;
    persistThreadReadState();
  }
}

function reconcileThreadStatusTrackers(prevThreads = [], nextThreads = []) {
  const prevById = new Map((Array.isArray(prevThreads) ? prevThreads : []).map((t) => [t.id, t]));
  const nowSec = Math.floor(Date.now() / 1000);
  const isForegroundActive = (tid) => (
    tid === state.activeThreadId
    && !state.boardOpen
    && (typeof document === "undefined" || document.visibilityState !== "hidden")
  );
  let touched = false;

  for (const t of Array.isArray(nextThreads) ? nextThreads : []) {
    if (!t?.id) continue;
    const updatedAt = Number(t.updatedAt || 0);
    if (t.live) {
      if (state.recentCompletedByThread.delete(t.id) || threadReadState.unreadById[t.id]) {
        delete threadReadState.unreadById[t.id];
        touched = true;
      }
      const prevAct = state.liveActivityByThread.get(t.id) || {};
      if (t.livePhase || t.liveDetail) {
        const nextAct = mergeLiveActivity(prevAct, {
          status: "running",
          phase: t.livePhase || prevAct.phase || "",
          text: t.liveDetail ?? prevAct.text ?? "",
        });
        nextAct.isStreamingText = Boolean(prevAct.isStreamingText);
        state.liveActivityByThread.set(t.id, nextAct);
      } else if (!prevAct.status) {
        state.liveActivityByThread.set(t.id, { status: "running", phase: `${providerDisplayName(t.provider)} 执行中` });
      }
      continue;
    }

    state.liveActivityByThread.delete(t.id);
    const prev = prevById.get(t.id);
    const seenAt = Number(threadReadState.seenById[t.id] || 0);
    const finishedFromLive = Boolean(prev?.live);
    const updatedSincePrev = Boolean(prev && updatedAt > Number(prev.updatedAt || 0));
    const updatedSinceSeen = Boolean(seenAt > 0 && updatedAt > seenAt);
    const freshOnInitialLoad = Boolean(
      !threadReadState.initialized
      && !seenAt
      && updatedAt > 0
      && (nowSec - updatedAt) <= 10 * 60,
    );

    if (finishedFromLive || updatedSincePrev || updatedSinceSeen || freshOnInitialLoad) {
      if (isForegroundActive(t.id)) {
        markThreadRead(t.id, updatedAt);
      } else {
        const entry = {
          status: "completed",
          summary: stripMarkdownForSpeech(t.preview || "", 80),
          at: Date.now(),
          updatedAt: updatedAt || nowSec,
        };
        state.recentCompletedByThread.set(t.id, entry);
        threadReadState.unreadById[t.id] = entry;
        touched = true;
      }
    } else if (!seenAt && updatedAt > 0) {
      threadReadState.seenById[t.id] = updatedAt;
      touched = true;
    }
  }

  if (!threadReadState.initialized && Array.isArray(nextThreads) && nextThreads.length > 0) {
    threadReadState.initialized = true;
    touched = true;
  }
  if (touched) {
    persistThreadReadState();
  }
}

let refreshThreadsPromise = null;
let refreshThreadsArchivedKey = "";

async function refreshThreads() {
  const archivedKey = state.showArchived ? "1" : "0";
  if (refreshThreadsPromise && refreshThreadsArchivedKey === archivedKey) {
    return refreshThreadsPromise;
  }
  const runPromise = (async () => {
    const res = await apiGet(`api/threads?archived=${archivedKey}`);
    if ((state.showArchived ? "1" : "0") !== archivedKey) return;
    const prevThreads = state.threads;
    state.threads = (res.threads || []).filter((t) => !isInternalVoiceThreadClient(t));
    if (!state.showArchived) {
      reconcileThreadStatusTrackers(prevThreads, state.threads);
    }
    if (state.pendingRequestsSynced) {
      syncThreadsPendingCounts();
    }
    state.projectsMeta = res.projectsMeta || state.projectsMeta || {};
    state.warnings = res.warnings || [];
    if (!state.showArchived) {
      saveCachedThreads(state.threads, state.projectsMeta);
    }
    pruneBatchSelection();
    renderThreadList();
    renderProjectBoard();
    renderProjectTaskStrip();
    renderVoiceLiveProgressIfOpen();
  })();
  refreshThreadsPromise = runPromise;
  refreshThreadsArchivedKey = archivedKey;
  try {
    return await runPromise;
  } finally {
    if (refreshThreadsPromise === runPromise) {
      refreshThreadsPromise = null;
      refreshThreadsArchivedKey = "";
    }
  }
}

function activeThreadLastTurnHasMatchingThought(thread, liveThought = "") {
  const cleanLive = String(liveThought || "").replace(/\s+/g, " ").trim();
  if (!cleanLive) return false;
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const lastTurn = turns[turns.length - 1];
  const items = Array.isArray(lastTurn?.items) ? lastTurn.items : [];
  const tail = cleanLive.slice(-60);
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i];
    if (it?.type !== "reasoning") continue;
    const raw = (
      (Array.isArray(it.content) && it.content.length ? it.content.join(" ") : "")
      || (Array.isArray(it.summary) && it.summary.length ? it.summary.join(" ") : "")
      || it.text
      || ""
    ).replace(/\s+/g, " ").trim();
    if (raw && (raw === cleanLive || (tail.length >= 16 && raw.includes(tail)))) return true;
  }
  return false;
}

function activeThreadLastTurnHasReasoning(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const lastTurn = turns[turns.length - 1];
  if (!lastTurn || !Array.isArray(lastTurn.items)) return false;
  return lastTurn.items.some((it) => (
    it?.type === "reasoning"
    && Boolean(
      (Array.isArray(it.content) ? it.content.join("") : "")
      || (Array.isArray(it.summary) ? it.summary.join("") : "")
      || it.text
      || ""
    )
  ));
}

function activeThreadLastTurnHasFinalReply(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const lastTurn = turns[turns.length - 1];
  const items = Array.isArray(lastTurn?.items) ? lastTurn.items : [];
  if (!items.length) return false;
  const lastItem = items[items.length - 1];
  return lastItem?.type === "agentMessage"
    && lastItem?.phase !== "commentary"
    && Boolean(String(lastItem?.text || "").trim());
}

function reconcileStreamingStateWithThread(thread, streamingPayload = null, activityPayload = null) {
  if (!thread?.live) {
    state.streamingText = "";
    state.streamingThought = "";
    state.streamingTurnId = "";
    return;
  }

  const incomingTurnId = String(streamingPayload?.turnId || activityPayload?.turnId || "").trim();
  if (incomingTurnId && state.streamingTurnId && incomingTurnId !== state.streamingTurnId) {
    state.streamingText = "";
    state.streamingThought = "";
  }
  if (incomingTurnId) {
    state.streamingTurnId = incomingTurnId;
  }

  if (streamingPayload && typeof streamingPayload === "object") {
    const serverText = String(streamingPayload.text || "");
    if (!serverText) {
      state.streamingText = "";
    } else if (!state.streamingText || incomingTurnId) {
      state.streamingText = serverText;
    }

    const lastTurnDone = activeThreadLastTurnHasFinalReply(thread);
    if (lastTurnDone) {
      state.streamingThought = "";
    } else if (!streamingPayload.thought && state.streamingThought && activeThreadLastTurnHasMatchingThought(thread, state.streamingThought)) {
      state.streamingThought = "";
    } else if (!state.streamingThought && streamingPayload.thought && !activeThreadLastTurnHasReasoning(thread)) {
      state.streamingThought = String(streamingPayload.thought);
    }
  }

  if (state.streamingText && isStreamingTextAlreadyPersisted(thread.turns, state.streamingText)) {
    state.streamingText = "";
  }
}

function mergeReloadedTurns(existingTurns, latestTurns) {
  const existing = Array.isArray(existingTurns) ? existingTurns : [];
  const latest = Array.isArray(latestTurns) ? latestTurns : [];
  if (!existing.length) return latest;
  if (!latest.length) return existing;
  const latestIds = new Set(latest.map((t) => t?.id).filter(Boolean));
  const firstMatchIdx = existing.findIndex((t) => t?.id && latestIds.has(t.id));
  if (firstMatchIdx > 0) {
    return [...existing.slice(0, firstMatchIdx), ...latest];
  }
  return latest;
}

let activeThreadReloadInFlight = false;
let activeThreadReloadPromise = null;
let activeThreadReloadTimer = null;
let pendingReloadCompositeId = "";
let lastActiveThreadReloadDoneAt = 0;

function scheduleActiveThreadReload(compositeId, delayMs = 900) {
  if (!compositeId || compositeId !== state.activeThreadId) return;
  if (activeThreadReloadTimer) clearTimeout(activeThreadReloadTimer);
  activeThreadReloadTimer = setTimeout(() => {
    activeThreadReloadTimer = null;
    if (state.activeThreadId === compositeId) {
      void reloadActiveThreadProgress(compositeId);
    }
  }, delayMs);
}

async function reloadActiveThreadProgress(compositeId) {
  if (!compositeId || state.activeThreadId !== compositeId) return;
  if (activeThreadReloadInFlight) {
    pendingReloadCompositeId = compositeId;
    return activeThreadReloadPromise;
  }
  if (activeThreadReloadTimer) {
    clearTimeout(activeThreadReloadTimer);
    activeThreadReloadTimer = null;
  }
  pendingReloadCompositeId = "";
  activeThreadReloadInFlight = true;
  const runPromise = (async () => {
    try {
      const prevTurns = Array.isArray(state.activeThread?.turns) ? state.activeThread.turns : [];
      const prevTail = prevTurns.length ? prevTurns[prevTurns.length - 1] : null;
      const preserveFailedTail = state.liveActivity?.status === "failed" && prevTail?.status === "failed";
      const persistedPrevCount = prevTurns.filter((t) => t?.id && !String(t.id).startsWith("optimistic-turn-")).length;
      const useTailLimit = persistedPrevCount >= 2;
      let res = await fetchThreadRead(
        `api/thread?id=${encodeURIComponent(compositeId)}&limit=${useTailLimit ? 2 : 12}`,
        compositeId,
      );
      if (state.activeThreadId !== compositeId || !res?.thread) return;

      const prevIds = new Set(prevTurns.map((t) => t?.id).filter(Boolean));
      let latestTurns = Array.isArray(res.thread.turns) ? res.thread.turns : [];
      let hasIdOverlap = latestTurns.some((t) => t?.id && prevIds.has(t.id));
      if (useTailLimit && !hasIdOverlap && res.nextCursor) {
        res = await fetchThreadRead(
          `api/thread?id=${encodeURIComponent(compositeId)}&limit=12`,
          compositeId,
        );
        if (state.activeThreadId !== compositeId || !res?.thread) return;
        latestTurns = Array.isArray(res.thread.turns) ? res.thread.turns : [];
        hasIdOverlap = latestTurns.some((t) => t?.id && prevIds.has(t.id));
      }

      let mergedTurns = mergeReloadedTurns(state.activeThread?.turns, latestTurns);
      if (!res.thread.live && preserveFailedTail && prevTail) {
        const hasSameOrFailedTail = mergedTurns.some((t) => t?.id && t.id === prevTail.id)
          || mergedTurns[mergedTurns.length - 1]?.status === "failed";
        if (!hasSameOrFailedTail) {
          mergedTurns = [...mergedTurns, prevTail];
        }
      }
      state.activeThread = {
        ...res.thread,
        turns: mergedTurns,
      };
      if (!hasIdOverlap) {
        state.nextCursor = res.nextCursor || null;
      }
      if (res.activityCursor) state.activityCursor = res.activityCursor;
      state.queuedTurns = Array.isArray(res.queuedTurns) ? res.queuedTurns : (state.queuedTurns || []);
      if (state.activeThread) {
        state.activeThread.queuedCount = state.queuedTurns.length;
      }

      if (res.thread.live) {
        state.liveActivity = res.activity
          ? mergeLiveActivity(state.liveActivity, res.activity)
          : (state.liveActivity?.status === "running" ? state.liveActivity : { status: "running" });
        reconcileStreamingStateWithThread(state.activeThread, res.streaming || null, res.activity || null);
      } else {
        if (!preserveFailedTail) {
          state.liveActivity = { status: "completed" };
        }
        reconcileStreamingStateWithThread(state.activeThread, null, null);
      }

      const other = state.pendingRequests.filter((r) => r.threadId !== compositeId);
      state.pendingRequests = [...other, ...(res.pendingRequests || [])];
      state.pendingRequestsSynced = true;
      syncThreadsPendingCounts();
      syncThreadSummaryIntoList(state.activeThread);
      lastActiveThreadReloadDoneAt = Date.now();

      if (effectivePermissionModeForThread(compositeId, state.activeThread) === "turbo") {
        void autoApproveTurboRequestsForThread(compositeId);
      }

      renderThreadList();
      renderProjectBoard();
      renderProjectTaskStrip();
      renderTopbarAndControls();
      renderActiveMessages();
      renderPendingRequests();
      renderQueuedTurns();
    } catch {
      // Ignore transient polling/reload errors so background polling stays resilient.
    } finally {
      activeThreadReloadInFlight = false;
      activeThreadReloadPromise = null;
      const nextPendingId = pendingReloadCompositeId;
      pendingReloadCompositeId = "";
      if (nextPendingId && nextPendingId === state.activeThreadId) {
        scheduleActiveThreadReload(nextPendingId, 60);
      }
    }
  })();
  activeThreadReloadPromise = runPromise;
  return runPromise;
}

async function reloadActiveThreadAfterTurnCompletion({
  threadId = "",
  turnId = "",
  turnStatus = "completed",
  errorMessage = "",
} = {}) {
  if (!threadId || state.activeThreadId !== threadId) return;
  const isFailed = turnStatus === "failed";
  const existingTurns = Array.isArray(state.activeThread?.turns) ? state.activeThread.turns : [];
  const tailTurn = existingTurns.length ? existingTurns[existingTurns.length - 1] : null;
  const matchingTurn = turnId
    ? [...existingTurns].reverse().find((t) => t?.id === turnId)
    : null;
  const failedTurnSnapshot = isFailed
    ? (matchingTurn || ((tailTurn && (tailTurn.status === "inProgress" || tailTurn.status === "running")) ? tailTurn : null))
    : null;

  const persistedCount = existingTurns.filter((t) => t?.id && !String(t.id).startsWith("optimistic-turn-")).length;
  if (state.activeThread?.id === threadId && persistedCount >= 2) {
    if (!isFailed) {
      clearComposerStatus();
    }
    if (activeThreadReloadPromise) {
      await activeThreadReloadPromise.catch(() => {});
    }
    if (state.activeThreadId !== threadId) return;
    await reloadActiveThreadProgress(threadId).catch(() => {});
    renderAgentTelemetryBar();
  } else {
    await selectThread(threadId, {
      focusScroll: state.autoFollow,
      preserveStatus: isFailed,
    }).catch(() => {});
  }

  if (!isFailed || state.activeThreadId !== threadId || !state.activeThread) return;
  state.liveActivity = { status: "failed", ...(turnId ? { turnId } : {}) };
  const turns = Array.isArray(state.activeThread.turns) ? state.activeThread.turns : [];
  const reloadedTail = turns.length ? turns[turns.length - 1] : null;
  if (failedTurnSnapshot) {
    const alreadySaved = turns.some((t) => t?.id && t.id === failedTurnSnapshot.id)
      || reloadedTail?.status === "failed";
    if (!alreadySaved) {
      state.activeThread.turns = [
        ...turns,
        {
          ...failedTurnSnapshot,
          status: "failed",
          error: { message: errorMessage || "执行失败" },
        },
      ];
      renderActiveMessages();
    }
  }
  renderLiveBanner();
}

async function selectThread(compositeId, { focusScroll = true, preserveStatus = false, newThreadCwd = null } = {}) {
  closeCustomSelectMenu();
  if (!preserveStatus) {
    clearComposerStatus();
  }
  if (activeThreadReloadTimer) {
    clearTimeout(activeThreadReloadTimer);
    activeThreadReloadTimer = null;
  }
  const prevThreadId = state.activeThreadId;
  if (compositeId !== prevThreadId && state.editingQueueItem) {
    clearQueueEditState({ restoreDraft: state.editingQueueItem.threadId === prevThreadId });
  }
  if (compositeId !== prevThreadId) {
    closeSlashCommandMenu();
  }
  state.activeThreadId = compositeId;
  if (compositeId !== prevThreadId) {
    state.queuedPanelCollapsed = false;
  }
  state.newThreadCwd = compositeId ? null : newThreadCwd;
  state.boardOpen = !compositeId && newThreadCwd === null;
  state.autoFollow = focusScroll;
  state.userPickedDraftModel = false;
  state.activityCursor = "";
  state.streamingText = "";
  state.streamingThought = "";
  state.streamingTurnId = "";
  lastActiveThreadReloadDoneAt = 0;

  const url = new URL(location.href);
  if (compositeId) url.searchParams.set("thread", compositeId);
  else url.searchParams.delete("thread");
  history.replaceState(null, "", url.toString());

  if (!compositeId) {
    state.initialThreadLoading = false;
    state.activeThread = null;
    state.nextCursor = null;
    state.liveActivity = null;
    state.queuedTurns = [];
    syncProfileSelectors();
    syncModelAndEffortSelectors();
    renderThreadList();
    renderTopbarAndControls();
    renderAgentTelemetryBar();
    renderActiveMessages();
    renderPendingRequests();
    renderQueuedTurns();
    return;
  }

  const cachedSummary = state.threads.find((t) => t.id === compositeId);
  markThreadRead(compositeId, cachedSummary?.updatedAt || 0);
  if (cachedSummary?.cwd) {
    setSidebarGroupManualPref(cachedSummary.cwd, "expand");
  }

  const isSwitchingThread = compositeId !== prevThreadId || !state.activeThread;
  if (isSwitchingThread) {
    resetTurnListRenderCache();
    resetDeferredImageObserver({ resetRevealed: false });
    state.activeThread = null;
    state.nextCursor = null;
    state.queuedTurns = [];
    state.liveActivity = cachedSummary?.live ? { status: "running" } : null;
    state.initialThreadLoading = true;
    const turnListEl = $("turnList");
    if (turnListEl) {
      turnListEl.hidden = false;
      turnListEl.innerHTML = `<div class="empty-state" style="text-align:center;color:var(--text-muted);">正在加载会话…</div>`;
    }
    syncProfileSelectors();
    syncModelAndEffortSelectors();
    renderThreadList();
    renderTopbarAndControls();
    renderActiveMessages();
    renderPendingRequests();
    renderQueuedTurns();
    setSidebarOpen(false);
  }

  let res;
  try {
    res = await fetchThreadRead(
      `api/thread?id=${encodeURIComponent(compositeId)}&limit=12`,
      compositeId,
    );
  } finally {
    if (state.activeThreadId === compositeId && isSwitchingThread) {
      state.initialThreadLoading = false;
    }
  }
  if (state.activeThreadId !== compositeId) return;
  lastActiveThreadReloadDoneAt = Date.now();
  state.activeThread = res.thread;
  state.nextCursor = res.nextCursor || null;
  state.activityCursor = res.activityCursor || "";
  state.liveActivity = res.activity || (res.thread?.live ? { status: "running" } : null);
  state.queuedTurns = Array.isArray(res.queuedTurns) ? res.queuedTurns : [];
  if (state.activeThread) {
    state.activeThread.queuedCount = state.queuedTurns.length;
  }

  reconcileStreamingStateWithThread(state.activeThread, res.streaming || null, res.activity || null);

  // Merge thread-level pending requests into global state.
  const other = state.pendingRequests.filter((r) => r.threadId !== compositeId);
  state.pendingRequests = [...other, ...(res.pendingRequests || [])];
  state.pendingRequestsSynced = true;
  syncThreadsPendingCounts();
  syncThreadSummaryIntoList(res.thread);
  markThreadRead(compositeId, res.thread?.updatedAt || 0);
  if (res.thread?.cwd) {
    setSidebarGroupManualPref(res.thread.cwd, "expand");
  }

  syncProfileSelectors();
  syncModelAndEffortSelectors();
  if (effectivePermissionModeForThread(compositeId, state.activeThread) === "turbo") {
    void autoApproveTurboRequestsForThread(compositeId).then((count) => {
      if (count > 0) {
        setComposerStatus("success", "已按 Turbo 模式自动批准待确认操作", { autoClearMs: 3000 });
      }
    });
  }
  renderThreadList();
  renderProjectBoard();
  renderProjectTaskStrip();
  renderTopbarAndControls();
  renderAgentTelemetryBar();
  renderActiveMessages();
  renderPendingRequests();
  renderQueuedTurns();
  setSidebarOpen(false);
}

async function loadOlderMessages() {
  if (!state.activeThreadId || !state.nextCursor) return;
  const vp = $("messagesViewport");
  const prevHeight = vp.scrollHeight;
  const res = await fetchThreadRead(
    `api/thread?id=${encodeURIComponent(state.activeThreadId)}&cursor=${encodeURIComponent(state.nextCursor)}&limit=25`,
    state.activeThreadId,
  );
  const olderTurns = res.thread?.turns || [];
  state.activeThread.turns = [...olderTurns, ...(state.activeThread.turns || [])];
  state.nextCursor = res.nextCursor || null;
  state.autoFollow = false;
  renderActiveMessages();
  vp.scrollTop = vp.scrollHeight - prevHeight;
}

async function copyTextToClipboard(text) {
  const value = String(text || "");
  if (!value) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {}
  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

async function handleSend({ overrideText = null, clearDraft = true, forceGoal = false } = {}) {
  if (state.isSubmitting) return;
  if (state.imageProcessingCount > 0) {
    setComposerStatus("error", "图片正在压缩处理中，请稍候再发送", { autoClearMs: 2500 });
    return;
  }
  const input = $("promptInput");
  const isOverride = typeof overrideText === "string";
  const rawText = isOverride ? overrideText : input.value;
  const { hasDirective, cleanedText } = extractGoalDirective(rawText);
  const goalMode = Boolean(forceGoal || state.composerGoal || hasDirective);
  const text = hasDirective && cleanedText ? rawText : rawText;

  const running = isActiveThreadRunning();
  const editingQueue = !isOverride ? activeEditingQueueItem() : null;
  const sub = resolveComposerSubmission({
    hasActiveThread: Boolean(state.activeThreadId),
    isRunning: running,
    isSubmitting: false,
    isEditingQueue: Boolean(editingQueue),
    mode: $("runningSubmitMode").value,
    text,
    imageCount: isOverride ? 0 : state.images.length,
  });
  if (!sub.canSubmit) {
    setComposerStatus("error", "请输入指令或添加图片后再发送", { autoClearMs: 2500 });
    return;
  }

  const savedImages = isOverride ? [] : [...state.images];
  const cleanImages = savedImages.map((img, idx) => ({
    name: img?.name || `image-${idx + 1}.jpg`,
    dataUrl: img?.dataUrl || "",
  })).filter((img) => Boolean(img.dataUrl));
  const requestTimeoutMs = cleanImages.length ? 60_000 : 35_000;
  const model = $("modelSelect").value || "";
  const effort = $("effortSelect").hidden ? "" : ($("effortSelect").value || "");
  const permissionMode = normalizeUiPermissionMode($("permissionSelect").value || state.defaultPermissionMode || "turbo", "turbo");
  state.defaultPermissionMode = saveDefaultPermissionMode(permissionMode);
  if (state.activeThreadId) {
    saveLocalThreadPrefs(state.activeThreadId, { model, effort, permissionMode });
  }

  const resetDraftIfNeeded = () => {
    if (!clearDraft) return;
    input.value = "";
    state.images = [];
    renderComposerImages();
  };

  state.isSubmitting = true;
  state.autoFollow = true;
  setComposerConfigOpen(false);
  setTopbarMenuOpen(false);
  setComposerStatus(
    "pending",
    sub.action === "new"
      ? "正在创建会话并发送指令…"
      : (sub.action === "update_queue" ? "正在保存排队消息…" : "正在发送指令…"),
  );
  renderComposerControls();

  try {
    if (sub.action === "new") {
      const provider = currentComposerProvider();
      const profileId = currentComposerProfileId();
      const created = await apiPost("api/thread/new", {
        provider,
        profileId,
        text,
        images: cleanImages,
        cwd: state.newThreadCwd || "",
        model,
        effort,
        permissionMode,
        goalMode,
      }, { timeoutMs: requestTimeoutMs });
      saveNewThreadPrefs(provider, { model, effort });
      resetDraftIfNeeded();
      await refreshThreads();
      if (created?.thread?.id) {
        saveLocalThreadPrefs(created.thread.id, { model, effort, permissionMode });
        await selectThread(created.thread.id);
      }
      setComposerStatus("success", "会话已创建并发送指令", { autoClearMs: 3000 });
      return;
    }

    if (sub.action === "update_queue" && editingQueue) {
      const updated = await apiPost("api/thread/queue/update", {
        threadId: state.activeThreadId,
        id: editingQueue.id,
        text,
        images: cleanImages,
        model,
        effort,
        permissionMode,
        goalMode,
      }, { timeoutMs: requestTimeoutMs });
      state.editingQueueItem = null;
      resetDraftIfNeeded();
      state.composerGoal = false;
      renderComposerEditBanner();
      applyActiveQueuedTurns(state.activeThreadId, updated.items || state.queuedTurns);
      renderQueuedTurns();
      renderComposerControls();
      setComposerStatus("success", "已更新排队消息（保留原排位）", { autoClearMs: 3000 });
      showToastBanner("已更新排队消息", { detail: text ? text.slice(0, 60) : `${cleanImages.length} 张图片` });
      return;
    }

    const submitted = await submitComposerRequest(apiPost, {
      action: sub.action,
      payload: {
        threadId: state.activeThreadId,
        text,
        images: cleanImages,
        model,
        effort,
        permissionMode,
        goalMode,
        expectedTurnId: state.liveActivity?.turnId || "",
      },
      options: { timeoutMs: requestTimeoutMs },
    });
    if (submitted.action === "queue") {
      const qRes = submitted.result;
      resetDraftIfNeeded();
      applyActiveQueuedTurns(state.activeThreadId, qRes.items || state.queuedTurns);
      renderQueuedTurns();
      setComposerStatus("success", "已加入排队，等待当前轮次完成后发送", { autoClearMs: 3000 });
      showToastBanner("已加入排队", { detail: text.slice(0, 60) });
      return;
    }

    const turnRes = submitted.result;
    resetDraftIfNeeded();
    if (turnRes?.redirectedThreadId && turnRes.redirectedThreadId !== state.activeThreadId) {
      const nextThreadId = turnRes.redirectedThreadId;
      saveLocalThreadPrefs(nextThreadId, { model, effort, permissionMode });
      state.threads = state.threads.filter((t) => t.id !== state.activeThreadId);
      state.activeThreadId = nextThreadId;
      if (state.activeThread) {
        state.activeThread.id = nextThreadId;
        state.activeThread.isForkDraft = false;
      }
      if (turnRes.thread) syncThreadSummaryIntoList(turnRes.thread);
    }
    if (state.activeThread) {
      const optimisticTurnId = turnRes?.turn?.id || turnRes?.turnId || `optimistic-turn-${Date.now()}`;
      const userContent = [
        ...cleanImages.map((img) => ({ type: "image", name: img.name || "", url: img.dataUrl })),
        ...(String(text || "").trim() ? [{ type: "text", text }] : []),
      ];
      if (!Array.isArray(state.activeThread.turns)) state.activeThread.turns = [];
      const tailTurn = state.activeThread.turns[state.activeThread.turns.length - 1];
      if (sub.action === "steer" && tailTurn && (tailTurn.status === "inProgress" || tailTurn.status === "running")) {
        tailTurn.items = [
          ...(Array.isArray(tailTurn.items) ? tailTurn.items : []),
          { type: "userMessage", id: `user-steer-${Date.now()}`, content: userContent },
        ];
      } else {
        state.streamingText = "";
        state.streamingThought = "";
        state.streamingTurnId = optimisticTurnId;
        if (tailTurn?.id !== optimisticTurnId) {
          state.activeThread.turns.push({
            id: optimisticTurnId,
            status: "inProgress",
            startedAt: Math.floor(Date.now() / 1000),
            items: [{ type: "userMessage", id: `user-${optimisticTurnId}`, content: userContent }],
          });
        }
      }
      if (turnRes?.thread?.title) {
        state.activeThread.title = turnRes.thread.title;
        state.activeThread.name = turnRes.thread.name || turnRes.thread.title;
      }
      state.activeThread.live = true;
      syncThreadSummaryIntoList({
        id: state.activeThreadId,
        live: true,
        ...(turnRes?.thread?.title ? { title: turnRes.thread.title, name: turnRes.thread.name || turnRes.thread.title } : {}),
      });
      state.liveActivity = mergeLiveActivity(state.liveActivity, {
        turnId: optimisticTurnId,
        status: "running",
        phase: `${providerDisplayName(state.activeThread.provider)} 执行中`,
      });
      renderThreadList();
      renderTopbarAndControls();
      renderActiveMessages();
    }
    scheduleActiveThreadReload(state.activeThreadId, 450);
    setComposerStatus(
      "success",
      sub.action === "steer" ? "插话引导已发送" : "指令已发送，等待响应…",
      { autoClearMs: 2800 },
    );
  } catch (error) {
    input.value = rawText;
    state.images = savedImages;
    renderComposerImages();
    const errMsg = formatActionError(error, "请求发送失败");
    const errStatus = Number(error?.status || 0);
    const errCode = String(error?.code || "");
    if (sub.action === "update_queue" && (errStatus === 404 || errCode === "queued_turn_not_found")) {
      state.editingQueueItem = null;
      renderComposerEditBanner();
      renderQueuedTurns();
      setComposerStatus("info", "原排队消息已自动发送或取消，当前编辑内容已保留在输入框", { autoClearMs: 5000 });
      return;
    }
    const isBusyConflict = errStatus === 409
      || errCode === "thread_busy"
      || errCode === "writer_conflict"
      || errCode === "codex_app_running"
      || /already has an active writer|\bactive writer\b|正在运行|占用/.test(errMsg);
    const failedProvider = state.activeThread?.provider || currentComposerProvider();
    const failedProfileId = state.activeThread?.profileId || currentComposerProfileId();
    const altProfile = !isBusyConflict ? findFailoverCandidateProfile(state.profiles, failedProvider, failedProfileId) : null;
    const failoverContext = altProfile ? {
      provider: failedProvider,
      altProfile,
      cwd: state.activeThread?.cwd || state.newThreadCwd || "",
      text,
      images: savedImages,
      model,
      effort,
      permissionMode,
      goalMode,
    } : null;
    setComposerStatus("error", `发送失败：${errMsg}`, { failoverContext });
    showToastBanner("发送失败", { detail: errMsg, error: true });
    void refreshProvidersAndModels().catch(() => {});
  } finally {
    state.isSubmitting = false;
    renderComposerControls();
  }
}

function buildFailoverContextForProvider(provider, failedProfileId, overrideText = "") {
  const altProfile = findFailoverCandidateProfile(state.profiles, provider, failedProfileId);
  if (!altProfile) return null;
  return {
    provider,
    altProfile,
    cwd: state.activeThread?.cwd || "",
    text: overrideText || $("promptInput")?.value || "",
    images: [...(state.images || [])],
    model: $("modelSelect")?.value || "",
    effort: $("effortSelect")?.hidden ? "" : ($("effortSelect")?.value || ""),
    permissionMode: normalizeUiPermissionMode($("permissionSelect")?.value || state.defaultPermissionMode || "turbo", "turbo"),
    goalMode: Boolean(state.composerGoal),
  };
}

function applyProfileSnapshotPayload(payload = {}) {
  if (Array.isArray(payload.providers)) state.providers = payload.providers;
  if (Array.isArray(payload.profiles)) state.profiles = payload.profiles;
  if (payload.defaultProvider) state.defaultProvider = payload.defaultProvider;
  if (payload.defaultProfileId) state.defaultProfileId = payload.defaultProfileId;
  syncProfileSelectors();
  renderTopbarAndControls();
  renderThreadList();
}

async function relayThreadWithProfile(altProfile, context = {}) {
  if (!altProfile?.id || !altProfile?.provider) return;
  const text = String(context.text ?? $("promptInput")?.value ?? "");
  const savedImages = Array.isArray(context.images) ? context.images : [...state.images];
  const cleanImages = savedImages.map((img, idx) => ({
    name: img?.name || `image-${idx + 1}.jpg`,
    dataUrl: img?.dataUrl || "",
  })).filter((img) => Boolean(img.dataUrl));
  const model = context.model ?? ($("modelSelect")?.value || "");
  const effort = context.effort ?? ($("effortSelect")?.hidden ? "" : ($("effortSelect")?.value || ""));
  const permissionMode = normalizeUiPermissionMode(
    context.permissionMode || $("permissionSelect")?.value || state.defaultPermissionMode || "turbo",
    "turbo",
  );
  const goalMode = Boolean(context.goalMode ?? state.composerGoal);
  const cwd = context.cwd || state.activeThread?.cwd || state.newThreadCwd || "";

  setComposerConfigOpen(false);
  if (!text.trim() && !cleanImages.length) {
    await openNewThreadModal({
      cwd,
      provider: altProfile.provider,
      model,
    });
    const newSelect = $("composerProfileSelect");
    if (newSelect && [...newSelect.options].some((o) => o.value === altProfile.id)) {
      newSelect.value = altProfile.id;
      syncComposerProfileSelect();
    }
    setComposerStatus("success", `已切换到 ${altProfile.label || altProfile.id}，输入指令即可在同目录开始`, { autoClearMs: 3200 });
    return;
  }

  state.isSubmitting = true;
  setComposerStatus("pending", `正在切到 ${altProfile.label || altProfile.id} 继续执行…`);
  renderComposerControls();
  try {
    const created = await apiPost("api/thread/new", {
      provider: altProfile.provider,
      profileId: altProfile.id,
      cwd,
      text,
      images: cleanImages,
      model,
      effort,
      permissionMode,
      goalMode,
    }, { timeoutMs: cleanImages.length ? 60_000 : 35_000 });
    if ($("promptInput")) $("promptInput").value = "";
    state.images = [];
    renderComposerImages();
    await refreshThreads();
    if (created?.thread?.id) {
      saveLocalThreadPrefs(created.thread.id, { model, effort, permissionMode });
      await selectThread(created.thread.id);
    }
    setComposerStatus("success", `已切到 ${altProfile.label || altProfile.id} 继续执行`, { autoClearMs: 3200 });
  } catch (error) {
    const errMsg = formatActionError(error, "切换实例继续失败");
    setComposerStatus("error", `切换失败：${errMsg}`);
    showToastBanner("切换实例失败", { detail: errMsg, error: true });
  } finally {
    state.isSubmitting = false;
    renderComposerControls();
  }
}

async function triggerProfileProbe({ provider, profileId = "" } = {}) {
  const cleanProvider = String(provider || "").trim();
  if (!cleanProvider) return;
  const targets = filterProfilesByProvider(state.profiles, cleanProvider)
    .filter((p) => !profileId || p.id === profileId);
  const addedKeys = targets.map((p) => p.key || `${cleanProvider}:${p.id}`);
  if (!addedKeys.length && profileId) addedKeys.push(`${cleanProvider}:${profileId}`);
  for (const key of addedKeys) state.probingProfileKeys.add(key);
  syncComposerProfileSelect();
  syncNewProviderPills();
  syncNewProfileSelect();

  try {
    const res = await apiPostWithHotFallback("api/profile/probe", {
      provider: cleanProvider,
      profileId,
    });
    applyProfileSnapshotPayload(res);
    const results = Array.isArray(res.results) ? res.results : [];
    const okCount = results.filter((r) => r.ok).length;
    const summary = results.length === 1
      ? (results[0].ok
        ? `测通成功 (${results[0].latencyMs ? `${results[0].latencyMs}ms` : "可用"})`
        : `测通失败：${results[0].error || "暂不可用"}`)
      : `${providerDisplayName(cleanProvider)} 测通完成：${okCount}/${results.length} 个可用`;
    setComposerStatus(okCount > 0 ? "success" : "error", summary, { autoClearMs: 3500 });
  } catch (error) {
    // 兼容尚未重启的旧版本地守护进程（/api/profile/probe 返回 404 时降级用 GET /api/models 探测）。
    if (error?.status === 404) {
      let okCount = 0;
      const nowSec = Math.floor(Date.now() / 1000);
      for (const target of targets) {
        const started = Date.now();
        try {
          await apiGet(`api/models?provider=${encodeURIComponent(cleanProvider)}&profileId=${encodeURIComponent(target.id)}`);
          okCount += 1;
          target.health = {
            ...(target.health || {}),
            status: "healthy",
            shortReason: "",
            detail: "",
            latencyMs: Math.max(1, Date.now() - started),
            checkedAt: nowSec,
          };
        } catch (err) {
          target.health = {
            ...(target.health || {}),
            status: "unavailable",
            shortReason: /429|limit|quota/i.test(err?.message || "") ? "限额冷却" : "暂不可用",
            detail: err?.message || "检测失败",
            latencyMs: null,
            checkedAt: nowSec,
          };
        }
      }
      syncProfileSelectors();
      setComposerStatus(
        okCount > 0 ? "success" : "error",
        `已实时校验模型列表 (${okCount}/${targets.length} 可用)；重载 Mac 守护进程后可启用完整 Claude 测通与状态持久化`,
        { autoClearMs: 4200 },
      );
      return;
    }
    const errMsg = formatActionError(error, "测通失败");
    setComposerStatus("error", `测通失败：${errMsg}`);
  } finally {
    for (const key of addedKeys) state.probingProfileKeys.delete(key);
    syncComposerProfileSelect();
    syncNewProfileSelect();
  }
}

async function toggleProfileDisabled({ provider, profileId, disabled } = {}) {
  try {
    const res = await apiPostWithHotFallback("api/profile/meta", {
      provider,
      profileId,
      disabled: Boolean(disabled),
    });
    applyProfileSnapshotPayload(res);
    setComposerStatus("success", disabled ? "已停用该实例" : "已重新启用该实例", { autoClearMs: 2200 });
  } catch (error) {
    setComposerStatus("error", `更新实例状态失败：${formatActionError(error)}`);
  }
}

function removePendingRequestById(reqId) {
  if (!reqId) return;
  clearApprovalVoiceReminder(reqId);
  state.pendingRequests = state.pendingRequests.filter((r) => r.id !== reqId);
  state.pendingRequestsSynced = true;
  syncThreadsPendingCounts();
  renderPendingRequests();
  renderThreadList();
  renderProjectBoard();
  renderProjectTaskStrip();
  renderVoiceLiveProgressIfOpen();
}

async function autoApprovePendingRequest(req) {
  if (!req?.id || req.kind === "userInput") return false;
  try {
    if (req.kind === "acpPermission") {
      const opt = (req.options || []).find((o) => o.kind === "allow_always")
        || (req.options || []).find((o) => o.kind === "allow_once")
        || req.options?.[0];
      await apiPost("api/server-request", {
        requestId: req.id,
        ...(opt?.optionId ? { optionId: opt.optionId } : { decision: "acceptForSession" }),
      });
    } else {
      await apiPost("api/approval", { requestId: req.id, decision: "acceptForSession" });
    }
    removePendingRequestById(req.id);
    return true;
  } catch (err) {
    if (Number(err?.status) === 404) {
      removePendingRequestById(req.id);
    }
    return false;
  }
}

async function autoApproveTurboRequestsForThread(threadId) {
  if (!threadId) return 0;
  const targets = state.pendingRequests.filter((r) => r.threadId === threadId && r.kind !== "userInput");
  let count = 0;
  for (const req of targets) {
    const ok = await autoApprovePendingRequest(req);
    if (ok) count += 1;
  }
  return count;
}

let sseReconnectTimer = null;
let sseReconnectAttempt = 0;
let sseNeedsResync = false;

function clearSseReconnectTimer() {
  if (sseReconnectTimer) {
    clearTimeout(sseReconnectTimer);
    sseReconnectTimer = null;
  }
}

function scheduleSseReconnect() {
  if (sseReconnectTimer) return;
  const delayMs = Math.min(12_000, 1_200 * Math.pow(1.6, Math.min(sseReconnectAttempt, 5)));
  sseReconnectAttempt += 1;
  sseReconnectTimer = setTimeout(() => {
    sseReconnectTimer = null;
    if (document.visibilityState !== "hidden") {
      connectEvents();
    }
  }, delayMs);
}

function resyncStateAfterSseReconnect() {
  if (!sseNeedsResync) return;
  sseNeedsResync = false;
  void refreshThreads().catch(() => {});
  if (state.activeThreadId && !isBoardViewActive() && !state.initialThreadLoading) {
    scheduleActiveThreadReload(state.activeThreadId, 80);
  }
}

function connectEvents() {
  clearSseReconnectTimer();
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  syncConnectionDots("connecting");
  const es = new EventSource(apiUrl("api/events"));
  state.eventSource = es;

  es.addEventListener("open", () => {
    state.sseConnected = true;
    sseReconnectAttempt = 0;
    clearSseReconnectTimer();
    syncConnectionDots("connected");
    if (state.toastActive && !state.toastTimer && $("liveBanner")?.classList.contains("is-error")) {
      state.toastActive = false;
      renderLiveBanner();
    }
    resyncStateAfterSseReconnect();
  });

  es.addEventListener("ready", (ev) => {
    state.sseConnected = true;
    sseReconnectAttempt = 0;
    clearSseReconnectTimer();
    syncConnectionDots("connected");
    if (state.toastActive && !state.toastTimer && $("liveBanner")?.classList.contains("is-error")) {
      state.toastActive = false;
      renderLiveBanner();
    }
    resyncStateAfterSseReconnect();
    const data = JSON.parse(ev.data || "{}");
    if (Array.isArray(data.pendingRequests)) {
      state.pendingRequests = data.pendingRequests;
      state.pendingRequestsSynced = true;
      syncThreadsPendingCounts();
      renderPendingRequests();
      renderThreadList();
      renderProjectBoard();
      renderProjectTaskStrip();
      renderVoiceLiveProgressIfOpen();
      const turboThreadIds = new Set(
        data.pendingRequests
          .filter((req) => req?.threadId && req.kind !== "userInput")
          .map((req) => req.threadId),
      );
      for (const tid of turboThreadIds) {
        const threadObj = state.threads.find((t) => t.id === tid)
          || (state.activeThreadId === tid ? state.activeThread : null);
        if (effectivePermissionModeForThread(tid, threadObj) === "turbo") {
          void autoApproveTurboRequestsForThread(tid);
        }
      }
    }
    if (data.telemetry) applyTelemetrySnapshot(data.telemetry);
    if (data.remote) state.remoteStatus = data.remote;
    if (data.tunnel) state.tunnelStatus = data.tunnel;
    if (data.update) applyUpdateStatusSnapshot(data.update, { fromReconnectReady: true });
    syncRemoteButtonIndicator();
  });

  es.addEventListener("update_status", (ev) => {
    try {
      const snap = JSON.parse(ev.data || "{}");
      applyUpdateStatusSnapshot(snap);
    } catch {}
  });

  es.addEventListener("automation_status", (ev) => {
    try {
      const snap = JSON.parse(ev.data || "{}");
      state.automationsSnapshot = snap;
      renderAutomationsModal(snap);
    } catch {}
  });

  es.addEventListener("automation_run", (ev) => {
    try {
      const info = JSON.parse(ev.data || "{}");
      if (info.reason === "scheduled" && info.name && !info.error) {
        showToastBanner(`定时任务已自动唤起：${info.name}`);
      }
      if ($("automationsModal")?.open) {
        void refreshAutomations().catch(() => {});
      }
    } catch {}
  });

  es.addEventListener("remote_status", (ev) => {
    try {
      const snap = JSON.parse(ev.data || "{}");
      state.remoteStatus = snap;
      syncRemoteButtonIndicator();
      if ($("remoteModal")?.open) {
        void openRemoteModal({ silentOpen: true });
      }
    } catch {}
  });

  es.addEventListener("tunnel_status", (ev) => {
    try {
      const snap = JSON.parse(ev.data || "{}");
      state.tunnelStatus = snap;
      syncRemoteButtonIndicator();
      if ($("remoteModal")?.open) {
        void openRemoteModal({ silentOpen: true });
      }
    } catch {}
  });

  es.addEventListener("host_offline", () => {
    state.sseConnected = false;
    syncConnectionDots("error");
    showToastBanner("控制主机暂时离线", { detail: "正在等待重连…", sticky: true, error: true });
    setComposerStatus("error", "控制主机暂时离线，请稍候重试");
  });

  const updateThreadLiveTracker = (threadId, patch) => {
    if (!threadId) return;
    const prev = state.liveActivityByThread.get(threadId) || {};
    const merged = mergeLiveActivity(prev, patch);
    merged.isStreamingText = Boolean(patch.isStreamingText ?? prev.isStreamingText);
    state.liveActivityByThread.set(threadId, merged);
    state.recentCompletedByThread.delete(threadId);
    if (threadReadState.unreadById[threadId]) {
      delete threadReadState.unreadById[threadId];
      persistThreadReadState();
    }
  };

  const markThreadLiveCompleted = (threadId, status, summary = "") => {
    if (!threadId) return;
    state.liveActivityByThread.delete(threadId);
    const isVisibleActive = threadId === state.activeThreadId && !state.boardOpen && document.visibilityState !== "hidden";
    if (isVisibleActive) {
      markThreadRead(threadId);
    } else {
      markThreadUnread(threadId, { status, summary });
    }
  };

  es.addEventListener("server_request", (ev) => {
    const { request } = JSON.parse(ev.data || "{}");
    if (!request?.id) return;
    const threadObj = state.threads.find((t) => t.id === request.threadId)
      || (state.activeThreadId === request.threadId ? state.activeThread : null);
    if (request.threadId && request.kind !== "userInput" && effectivePermissionModeForThread(request.threadId, threadObj) === "turbo") {
      void autoApprovePendingRequest(request);
      return;
    }
    if (!state.pendingRequests.some((r) => r.id === request.id)) {
      state.pendingRequests.push(request);
    }
    state.pendingRequestsSynced = true;
    syncThreadsPendingCounts();
    renderPendingRequests();
    renderThreadList();
    renderProjectBoard();
    renderProjectTaskStrip();
    renderVoiceLiveProgressIfOpen();
    if (state.voice.callActive && state.voice.config.autoBroadcastEvents) {
      if (effectiveVoiceScope() === "thread" && request.threadId && request.threadId !== effectiveVoiceThreadId()) {
        return;
      }
      const targetThread = state.threads.find((t) => t.id === request.threadId);
      const projLabel = targetThread ? (state.projectsMeta[normalizeProjectCwd(targetThread.cwd)]?.alias || projectBaseName(targetThread.cwd)) : "有任务";
      const detail = stripMarkdownForSpeech(request.title || request.command || "请确认", 80);
      enqueueOrPlayVoiceBroadcast({
        id: `req-${request.id}`,
        text: `${projLabel} 请求授权：${detail}`,
        priority: "critical",
        source: "approval",
        actionTag: "待审批",
        dedupeKey: `req:${request.id}`,
      });
      scheduleApprovalVoiceReminder(request, projLabel);
    }
  });

  es.addEventListener("thread_prefs_updated", (ev) => {
    const { threadId, prefs } = JSON.parse(ev.data || "{}");
    if (!threadId || !prefs) return;
    const target = state.threads.find((t) => t.id === threadId);
    if (target) {
      if (prefs.model) target.model = prefs.model;
      if (prefs.reasoningEffort) target.reasoningEffort = prefs.reasoningEffort;
      if (prefs.permissionMode) target.permissionMode = prefs.permissionMode;
    }
    if (threadId === state.activeThreadId && state.activeThread) {
      if (prefs.model) state.activeThread.model = prefs.model;
      if (prefs.reasoningEffort) state.activeThread.reasoningEffort = prefs.reasoningEffort;
      if (prefs.permissionMode) state.activeThread.permissionMode = prefs.permissionMode;
      syncModelAndEffortSelectors();
      syncPermissionSelectors();
    }
  });

  es.addEventListener("server_request_resolved", (ev) => {
    const { requestId } = JSON.parse(ev.data || "{}");
    removePendingRequestById(requestId);
  });

  es.addEventListener("voice_dispatch", (ev) => {
    const batch = JSON.parse(ev.data || "{}");
    if (!state.voice.callActive || (batch?.callId && batch.callId !== state.voice.callId)) return;
    if (batch?.batchId) {
      handleVoiceDispatchBatchUpdate(batch);
    }
  });

  es.addEventListener("voice_subagent_progress", (ev) => {
    const prog = JSON.parse(ev.data || "{}");
    if (!state.voice.callActive || (prog?.callId && prog.callId !== state.voice.callId)) return;
    if (!prog?.batchId) return;
    if (prog.utteranceId && prog.summaryTag) {
      updateVoiceTranscriptEntry(prog.utteranceId, { actionTag: prog.summaryTag });
    }
    if (prog.shouldSpeak && prog.spokenFeedback && state.voice.callActive && state.voice.config.autoBroadcastEvents) {
      enqueueOrPlayVoiceBroadcast({
        text: prog.spokenFeedback,
        priority: prog.priority || "normal",
        source: "voice_subagent_progress",
        actionTag: prog.summaryTag || "子代理进展",
        dedupeKey: `subagent:${prog.batchId}:${prog.step || 0}`,
      });
    }
    renderVoiceCallUi();
  });

  es.addEventListener("voice_external_milestone", (ev) => {
    const milestone = JSON.parse(ev.data || "{}");
    if (!state.voice.callActive || (milestone?.callId && milestone.callId !== state.voice.callId)) return;
    if (milestone?.threadId) {
      unwatchVoiceThread(milestone.threadId);
    }
    if (milestone?.shouldSpeak && milestone?.spokenFeedback && state.voice.callActive && state.voice.config.autoBroadcastEvents) {
      if (effectiveVoiceScope() !== "thread" || !milestone.threadId || milestone.threadId === effectiveVoiceThreadId()) {
        enqueueOrPlayVoiceBroadcast({
          text: milestone.spokenFeedback,
          priority: milestone.priority || "normal",
          source: "voice_external_milestone",
          actionTag: milestone.summaryTag || "任务进展",
          dedupeKey: milestone.dedupeKey || `milestone:${milestone.threadId || ""}:${milestone.turnId || ""}`,
        });
      }
    }
    renderVoiceCallUi();
  });

  es.addEventListener("project_meta_updated", (ev) => {
    const data = JSON.parse(ev.data || "{}");
    if (data.projectsMeta && typeof data.projectsMeta === "object") {
      state.projectsMeta = data.projectsMeta;
      renderThreadList();
      renderTopbarAndControls();
      renderProjectBoard();
      renderProjectTaskStrip();
      renderVoiceLiveProgressIfOpen();
    }
  });

  es.addEventListener("goal_state", (ev) => {
    const { threadId, goalState } = JSON.parse(ev.data || "{}");
    if (threadId === state.activeThreadId && state.activeThread) {
      state.activeThread.goalState = goalState;
      renderTopbarAndControls();
    }
    const target = state.threads.find((t) => t.id === threadId);
    if (target) {
      target.goalState = goalState;
      renderThreadList();
    }
    renderVoiceLiveProgressIfOpen();
  });

  es.addEventListener("queued_turn_event", (ev) => {
    const data = JSON.parse(ev.data || "{}");
    if (!data.threadId) return;
    const nextItems = Array.isArray(data.queuedTurns) ? data.queuedTurns : [];
    if (data.threadId === state.activeThreadId) {
      applyActiveQueuedTurns(data.threadId, nextItems);
      renderQueuedTurns();
      if (data.eventType === "failed") {
        const msg = data.error?.message || "排队消息执行失败";
        setComposerStatus("error", `排队发送失败：${msg}`);
        showToastBanner("排队发送失败", { detail: msg, error: true });
        if (data.entry?.text && !$("promptInput").value.trim()) {
          $("promptInput").value = data.entry.text;
          renderComposerControls();
        }
      } else if (data.eventType === "started") {
        state.streamingText = "";
        state.streamingThought = "";
        state.streamingTurnId = "";
        void selectThread(state.activeThreadId, { focusScroll: state.autoFollow }).catch(() => {});
      }
    } else {
      applyActiveQueuedTurns(data.threadId, nextItems);
    }
  });

  es.addEventListener("thread_renamed", (ev) => {
    const { threadId, name } = JSON.parse(ev.data || "{}");
    const target = state.threads.find((t) => t.id === threadId);
    if (target) {
      target.name = name;
      target.title = name;
    }
    if (state.activeThreadId === threadId && state.activeThread) {
      state.activeThread.name = name;
      state.activeThread.title = name;
      renderTopbarAndControls();
    }
    renderThreadList();
    renderProjectBoard();
    renderProjectTaskStrip();
    renderVoiceLiveProgressIfOpen();
  });

  es.addEventListener("thread_archived", () => {
    void refreshThreads();
  });

  es.addEventListener("threads_archived", () => {
    void refreshThreads();
  });

  es.addEventListener("agent_telemetry", (ev) => {
    try {
      const snap = JSON.parse(ev.data || "{}");
      if (snap?.byProvider) applyTelemetrySnapshot(snap);
    } catch {}
  });

  es.addEventListener("profiles_updated", (ev) => {
    try {
      const data = JSON.parse(ev.data || "{}");
      applyProfileSnapshotPayload(data);
    } catch {}
  });

  es.addEventListener("provider_event", (ev) => {
    const evt = JSON.parse(ev.data || "{}");
    if (!evt.threadId) return;

    if (evt.type === "codex_notification") {
      const { method, params } = evt;
      if (method === "turn/started") {
        updateThreadLiveTracker(evt.threadId, {
          turnId: params?.turn?.id || "",
          status: "running",
          phase: "Codex 执行中",
          isStreamingText: false,
        });
      } else if (method === "item/agentMessage/delta" || method === "codex/event/agent_message_content_delta") {
        updateThreadLiveTracker(evt.threadId, { status: "running", isStreamingText: true });
      } else if (method === "turn/completed") {
        markThreadLiveCompleted(evt.threadId, params?.turn?.status || "completed", params?.turn?.lastAgentMessage || "");
      }
    } else if (evt.type === "turn_started") {
      updateThreadLiveTracker(evt.threadId, {
        turnId: evt.turn?.id || "",
        status: "running",
        phase: `${providerDisplayName(evt.provider)} 执行中`,
        isStreamingText: false,
      });
    } else if (evt.type === "stream_delta") {
      if (evt.kind === "text") {
        updateThreadLiveTracker(evt.threadId, { status: "running", isStreamingText: true });
      } else if (evt.kind === "toolInput") {
        updateThreadLiveTracker(evt.threadId, { status: "running", phase: `准备工具 ${evt.toolName || ""}` });
      }
    } else if (evt.type === "acp_tool_update") {
      const rawToolText = String(evt.update?.status || "");
      const friendlyToolText = isRecoverableToolErrorText(rawToolText)
        ? formatToolExecutionError(rawToolText, { filePath: evt.update?.title || "" })
        : rawToolText;
      const prevPhase = state.liveActivityByThread.get(evt.threadId)?.phase || "";
      updateThreadLiveTracker(evt.threadId, {
        status: "running",
        phase: evt.update?.title || prevPhase || "正在执行工具…",
        text: friendlyToolText,
      });
    } else if (evt.type === "turn_completed") {
      const recoverableTurnErr = evt.status === "failed" && isRecoverableToolErrorText(evt.error);
      markThreadLiveCompleted(
        evt.threadId,
        recoverableTurnErr ? "completed" : (evt.status || "completed"),
        evt.lastAgentMessage || "",
      );
    }
    renderVoiceLiveProgressIfOpen();

    if (evt.threadId === state.activeThreadId) {
      if (evt.type === "codex_notification") {
        const { method, params } = evt;
        if (method === "turn/started") {
          state.streamingText = "";
          state.streamingThought = "";
          state.streamingTurnId = params?.turn?.id || "";
          state.liveActivity = mergeLiveActivity(state.liveActivity, {
            turnId: state.streamingTurnId,
            status: "running",
            phase: "Codex 执行中",
          });
          renderTopbarAndControls();
          renderStreamingTurn();
        } else if (method === "item/agentMessage/delta" || method === "codex/event/agent_message_content_delta") {
          clearComposerStatus();
          const deltaTurnId = String(params?.turnId || params?.msg?.turn_id || "").trim();
          if (deltaTurnId && state.streamingTurnId && deltaTurnId !== state.streamingTurnId) {
            state.streamingText = "";
            state.streamingThought = "";
          }
          if (deltaTurnId) state.streamingTurnId = deltaTurnId;
          const wasEmpty = !state.streamingText;
          state.streamingText += String(params?.delta || params?.msg?.delta || "");
          if (wasEmpty) {
            renderLiveBanner();
            renderActiveMessages();
          } else renderStreamingTurn();
        } else if (method === "item/reasoning/summaryTextDelta") {
          clearComposerStatus();
          state.streamingThought += String(params?.delta || "");
          syncLiveTurnFrontier();
        } else if (method === "turn/completed") {
          unwatchVoiceThread(evt.threadId);
          state.streamingText = "";
          state.streamingThought = "";
          if (state.activeThread) state.activeThread.live = false;
          syncThreadSummaryIntoList({ id: evt.threadId, live: false });
          const rawErrMsg = params?.turn?.error?.message || "";
          const recoverableErr = isRecoverableToolErrorText(params?.turn?.error || rawErrMsg);
          const turnStatus = recoverableErr && params?.turn?.status === "failed"
            ? "completed"
            : (params?.turn?.status || "completed");
          state.liveActivity = { status: turnStatus };
          if (turnStatus === "failed") {
            const msg = rawErrMsg || "执行失败";
            const failoverContext = buildFailoverContextForProvider(evt.provider, evt.profileId);
            setComposerStatus("error", `执行失败：${msg}`, { failoverContext });
            showToastBanner("执行失败", { detail: msg, error: true });
          }
          void reloadActiveThreadAfterTurnCompletion({
            threadId: evt.threadId || state.activeThreadId,
            turnId: params?.turn?.id || "",
            turnStatus,
            errorMessage: rawErrMsg || "执行失败",
          });
          void refreshThreads().catch(() => {});
        }
      } else {
        if (evt.type === "turn_started") {
          state.streamingText = "";
          state.streamingThought = "";
          state.streamingTurnId = evt.turn?.id || "";
          state.liveActivity = mergeLiveActivity(state.liveActivity, {
            turnId: state.streamingTurnId,
            status: "running",
            phase: `${providerDisplayName(evt.provider)} 执行中`,
          });
          renderTopbarAndControls();
          renderStreamingTurn();
          scheduleActiveThreadReload(state.activeThreadId, 450);
          scheduleTelemetryRefresh(150);
        } else if (evt.type === "stream_delta") {
          clearComposerStatus();
          if (evt.turnId && state.streamingTurnId && evt.turnId !== state.streamingTurnId) {
            state.streamingText = "";
            state.streamingThought = "";
          }
          if (evt.turnId) {
            state.streamingTurnId = evt.turnId;
          }
          if (evt.provider && evt.delta) {
            recordClientStreamDelta(evt.provider, evt.delta, evt.threadId || "");
          }
          if (evt.kind === "text") {
            const wasEmpty = !state.streamingText;
            state.streamingText += String(evt.delta || "");
            if (wasEmpty) {
              renderLiveBanner();
              renderActiveMessages();
            } else {
              renderStreamingTurn();
            }
          } else if (evt.kind === "reasoning") {
            state.streamingThought += String(evt.delta || "");
            syncLiveTurnFrontier();
          } else if (evt.kind === "toolInput") {
            const hadStreamingText = Boolean(state.streamingText);
            state.streamingText = "";
            state.streamingThought = "";
            state.liveActivity = mergeLiveActivity(state.liveActivity, {
              status: "running",
              phase: `准备工具 ${evt.toolName || ""}`,
            });
            renderLiveBanner();
            if (hadStreamingText) renderActiveMessages();
            else syncLiveTurnFrontier();
            scheduleActiveThreadReload(state.activeThreadId, 500);
          } else {
            renderStreamingTurn();
          }
        } else if (evt.type === "acp_tool_update") {
          const rawToolText = String(evt.update?.status || "");
          const friendlyToolText = isRecoverableToolErrorText(rawToolText)
            ? formatToolExecutionError(rawToolText, { filePath: evt.update?.title || "" })
            : rawToolText;
          const prevPhase = state.liveActivity?.phase || "";
          const hadStreamingText = Boolean(state.streamingText);
          state.streamingText = "";
          state.streamingThought = "";
          state.liveActivity = mergeLiveActivity(state.liveActivity, {
            status: "running",
            phase: evt.update?.title || prevPhase || "正在执行工具…",
            text: friendlyToolText,
          });
          renderLiveBanner();
          if (hadStreamingText) renderActiveMessages();
          else syncLiveTurnFrontier();
          scheduleActiveThreadReload(state.activeThreadId, 750);
        } else if (evt.type === "turn_completed") {
          unwatchVoiceThread(evt.threadId);
          state.streamingText = "";
          state.streamingThought = "";
          if (state.activeThread) state.activeThread.live = false;
          syncThreadSummaryIntoList({ id: evt.threadId, live: false });
          const rawErrMsg = evt.error?.message || "";
          const recoverableErr = isRecoverableToolErrorText(evt.error || rawErrMsg);
          const turnStatus = recoverableErr && evt.status === "failed"
            ? "completed"
            : (evt.status || "completed");
          state.liveActivity = { status: turnStatus };
          if (turnStatus === "failed") {
            const msg = rawErrMsg || "执行失败";
            const failoverContext = buildFailoverContextForProvider(evt.provider, evt.profileId);
            setComposerStatus("error", `执行失败：${msg}`, { failoverContext });
            showToastBanner("执行失败", { detail: msg, error: true });
          }
          void reloadActiveThreadAfterTurnCompletion({
            threadId: evt.threadId || state.activeThreadId,
            turnId: evt.turnId || "",
            turnStatus,
            errorMessage: rawErrMsg || "执行失败",
          });
          void refreshThreads().catch(() => {});
          scheduleTelemetryRefresh(200);
        }
      }
    } else if (evt.type === "turn_started" || evt.type === "turn_completed" || evt.method === "turn/started" || evt.method === "turn/completed") {
      if (evt.type === "turn_completed" || evt.method === "turn/completed") {
        unwatchVoiceThread(evt.threadId);
      }
      void refreshThreads();
      scheduleTelemetryRefresh(150);
    }
  });

  es.addEventListener("error", () => {
    if (state.eventSource !== es) return;
    state.sseConnected = false;
    sseNeedsResync = true;
    syncConnectionDots("error");
    if (es.readyState === EventSource.CLOSED) {
      es.close();
      state.eventSource = null;
      scheduleSseReconnect();
    }
  });
}

const UPDATE_RESTART_FLAG_KEY = "agentControl.restartingForUpdate";

function formatUpdateTimestamp(msOrSec) {
  const num = Number(msOrSec);
  if (!Number.isFinite(num) || num <= 0) return "尚未检查";
  const ms = num > 1e12 ? num : num * 1000;
  try {
    return new Date(ms).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "刚刚";
  }
}

function updateStateLabel(snap) {
  if (!snap) return "待检查";
  if (snap.updating || snap.restartPending || snap.phase === "pulling" || snap.phase === "installing" || snap.phase === "building_desktop" || snap.phase === "restarting") {
    if (snap.phase === "restarting") return "重启中";
    if (snap.phase === "building_desktop") return "编桌面";
    if (snap.phase === "installing") return "装依赖";
    return "更新中";
  }
  if (snap.desktopUpdating || state.desktopUpdating) return "更新壳子";
  if (snap.checking || snap.phase === "checking") return "检查中";
  if (snap.updateState === "available") return `有 ${snap.behindCount || 1} 个更新`;
  if (snap.updateState === "diverged") return "分支分叉";
  if (snap.desktopApp?.installed && snap.desktopApp?.needsUpdate) return "壳子待更新";
  if (snap.updateState === "up_to_date") return "已是最新";
  return "本地模式";
}

function renderUpdateIndicators() {
  const snap = state.updateStatus;
  const desktopNeedsUpdate = Boolean(snap?.desktopApp?.installed && snap?.desktopApp?.needsUpdate);
  const hasRepoUpdate = Boolean(snap?.hasUpdate);
  const hasUpdate = hasRepoUpdate || desktopNeedsUpdate;
  const isBusy = Boolean(
    state.updateChecking
    || state.updateApplying
    || state.desktopUpdating
    || snap?.checking
    || snap?.updating
    || snap?.desktopUpdating
    || snap?.restartPending,
  );
  const verText = snap
    ? `v${snap.packageVersion || "0.1.0"}${snap.localShortSha ? ` · ${snap.localShortSha}` : ""}`
    : "v0.1.0";

  const sidebarBtn = $("sidebarUpdateBtn");
  const sidebarDot = $("sidebarUpdateDot");
  const sidebarVer = $("sidebarUpdateVersion");
  const sidebarBadge = $("sidebarUpdateBadge");
  const sidebarAuto = $("sidebarAutoUpdateTag");
  const menuBadge = $("topbarMenuUpdateBadge");
  const moreDot = $("topbarMoreDot");

  if (sidebarVer) sidebarVer.textContent = verText;
  if (sidebarBtn) {
    sidebarBtn.classList.toggle("has-update", hasUpdate);
    if (hasRepoUpdate) {
      sidebarBtn.title = `发现新版本 (${snap.behindCount || 1} 个提交)，点击查看详情并一键更新`;
    } else if (desktopNeedsUpdate) {
      sidebarBtn.title = snap.desktopApp?.reason || "检测到桌面 App 壳子待更新，点击查看并同步";
    } else {
      sidebarBtn.title = `当前版本 ${verText}，点击检查或配置自动更新`;
    }
  }
  if (sidebarDot) {
    const dotState = desktopNeedsUpdate && !hasRepoUpdate ? "available" : (snap?.updateState || "unknown");
    const stateCls = isBusy ? "is-busy" : `is-${dotState}`;
    sidebarDot.className = `update-indicator-dot ${stateCls}`;
  }
  if (sidebarBadge) {
    sidebarBadge.hidden = !hasUpdate && !isBusy;
    if (isBusy) {
      sidebarBadge.textContent = state.desktopUpdating || snap?.desktopUpdating ? "编桌面" : "更新中";
    } else if (hasRepoUpdate) {
      sidebarBadge.textContent = snap?.behindCount > 1 ? `更新 ${snap.behindCount}` : "有更新";
    } else if (desktopNeedsUpdate) {
      sidebarBadge.textContent = "壳待更";
    }
  }
  if (sidebarAuto) {
    sidebarAuto.hidden = !snap?.autoUpdateEnabled;
  }
  if (menuBadge) {
    menuBadge.hidden = !hasUpdate;
    menuBadge.textContent = hasRepoUpdate ? (snap?.behindCount > 1 ? String(snap.behindCount) : "新") : "壳";
  }
  if (moreDot) {
    const goalActive = Boolean(!state.boardOpen && state.activeThread?.goalState?.active);
    moreDot.hidden = !(goalActive || hasUpdate);
  }
}

function renderUpdateModal() {
  const snap = state.updateStatus;
  const pill = $("updateStatePill");
  const currentEl = $("updateCurrentInfo");
  const remoteEl = $("updateRemoteInfo");
  const desktopEl = $("updateDesktopInfo");
  const statusEl = $("updateActionStatus");
  const dirtyEl = $("updateDirtyWarning");
  const autoCheckEl = $("autoCheckUpdateToggle");
  const autoUpdateEl = $("autoUpdateToggle");
  const autoDesktopEl = $("autoUpdateDesktopToggle");
  const pendingSec = $("updatePendingSection");
  const pendingCountEl = $("updatePendingCount");
  const pendingListEl = $("updatePendingList");
  const desktopBtn = $("applyDesktopUpdateBtn");
  const restartBtn = $("restartServiceBtn");
  const checkBtn = $("checkUpdateBtn");
  const applyBtn = $("applyUpdateBtn");

  const desktopInfo = snap?.desktopApp || null;
  const desktopNeedsUpdate = Boolean(desktopInfo?.installed && desktopInfo?.needsUpdate);
  const label = updateStateLabel(snap);
  const isBusy = Boolean(
    state.updateChecking
    || state.updateApplying
    || state.desktopUpdating
    || snap?.checking
    || snap?.updating
    || snap?.desktopUpdating
    || snap?.restartPending,
  );
  if (pill) {
    pill.textContent = label;
    pill.className = `tunnel-state-pill${(snap?.hasUpdate || desktopNeedsUpdate) ? " is-warn" : (snap?.updateState === "up_to_date" ? " is-ok" : "")}`;
  }

  if (currentEl) {
    if (!snap) {
      currentEl.innerHTML = `<span>正在读取本地版本与仓库状态…</span>`;
    } else {
      const shaPart = snap.localShortSha ? `${escapeHtml(snap.branch || "main")} @ <code>${escapeHtml(snap.localShortSha)}</code>` : "非 Git 部署";
      const timePart = snap.lastCheckedAt ? formatUpdateTimestamp(snap.lastCheckedAt) : "尚未检查";
      currentEl.innerHTML = `
        <div class="update-meta-row">
          <span>服务版本 <strong>v${escapeHtml(snap.packageVersion || "0.1.0")}</strong>${snap.uiVersion ? ` · UI ${escapeHtml(snap.uiVersion)}` : ""}</span>
          <span>${shaPart}</span>
        </div>
        ${snap.localCommitSubject ? `<div class="update-meta-row"><span>最近提交：${escapeHtml(snap.localCommitSubject)}</span></div>` : ""}
        <div class="update-meta-row">
          <span>上次检查：${escapeHtml(timePart)}</span>
          <span>${snap.managedService ? "后台常驻服务已托管（支持重启自恢复）" : "命令行直启模式"}</span>
        </div>
      `;
    }
  }

  if (remoteEl) {
    if (snap?.isGitRepo && snap?.remoteUrl) {
      remoteEl.hidden = false;
      const remoteVer = snap.remoteVersion ? `v${escapeHtml(snap.remoteVersion)} · ` : "";
      const remoteSha = snap.remoteShortSha ? `<code>${escapeHtml(snap.remoteShortSha)}</code>` : "待同步";
      remoteEl.innerHTML = `
        <div class="update-meta-row">
          <span>远端最新：${remoteVer}${remoteSha}</span>
          <span>${snap.hasUpdate ? `落后 ${snap.behindCount} 个提交` : (snap.updateState === "up_to_date" ? "已与远端同步" : "")}</span>
        </div>
        ${snap.remoteCommitSubject ? `<div class="update-meta-row"><span>${escapeHtml(snap.remoteCommitSubject)}</span></div>` : ""}
      `;
    } else {
      remoteEl.hidden = true;
      remoteEl.innerHTML = "";
    }
  }

  if (desktopEl) {
    if (desktopInfo?.supported) {
      desktopEl.hidden = false;
      if (desktopInfo.installed) {
        const tagClass = desktopInfo.needsUpdate ? "is-warn" : "is-ok";
        const tagText = desktopInfo.needsUpdate ? "壳子待更新" : "壳子已同步";
        const verStr = `v${escapeHtml(desktopInfo.installedVersion || "未知")}${desktopInfo.installedBuildNumber ? ` (#${escapeHtml(desktopInfo.installedBuildNumber)})` : ""}`;
        const hashStr = desktopInfo.installedHash
          ? `<code>${escapeHtml(desktopInfo.installedHash)}</code>${desktopInfo.expectedHash && desktopInfo.installedHash !== desktopInfo.expectedHash ? ` → <code>${escapeHtml(desktopInfo.expectedHash)}</code>` : ""}`
          : "无指纹（旧壳）";
        desktopEl.innerHTML = `
          <div class="update-meta-row">
            <span>桌面 App <strong>${verStr}</strong> · ${hashStr}</span>
            <span class="update-desktop-tag ${tagClass}">${tagText}</span>
          </div>
          ${desktopInfo.reason ? `<div class="update-meta-row"><span>${escapeHtml(desktopInfo.reason)}</span></div>` : ""}
        `;
      } else {
        desktopEl.innerHTML = `
          <div class="update-meta-row">
            <span>桌面 App <strong>尚未安装</strong></span>
            <span class="update-desktop-tag">未安装</span>
          </div>
          <div class="update-meta-row"><span>${escapeHtml(desktopInfo.reason || "可在 Mac 上点击“构建桌面 App”或运行 agent-control desktop 安装")}</span></div>
        `;
      }
    } else {
      desktopEl.hidden = true;
      desktopEl.innerHTML = "";
    }
  }

  if (autoCheckEl && snap) autoCheckEl.checked = Boolean(snap.autoCheckEnabled);
  if (autoUpdateEl && snap) autoUpdateEl.checked = Boolean(snap.autoUpdateEnabled);
  if (autoDesktopEl && snap) {
    autoDesktopEl.checked = snap.autoUpdateDesktopApp !== false;
    autoDesktopEl.disabled = Boolean(desktopInfo && !desktopInfo.supported);
  }

  if (statusEl) {
    const desktopActive = Boolean(state.desktopUpdating || snap?.desktopUpdating || snap?.desktopPhase === "error");
    const msg = (desktopActive && snap?.desktopMessage)
      ? snap.desktopMessage
      : (snap?.phaseMessage || snap?.lastError || (snap?.desktopPhase === "done" ? snap?.desktopMessage : "") || "");
    if (msg) {
      const isErr = (desktopActive && snap?.desktopPhase === "error")
        || snap?.phase === "error"
        || (snap?.lastError && !snap?.hasUpdate);
      statusEl.hidden = false;
      statusEl.className = `composer-status ${isErr ? "is-error" : (snap?.restartPending || snap?.desktopPhase === "done" ? "is-success" : "is-pending")}`;
      statusEl.textContent = msg;
    } else {
      statusEl.hidden = true;
      statusEl.textContent = "";
    }
  }

  if (dirtyEl) {
    if (snap?.dirty) {
      dirtyEl.hidden = false;
      const sample = Array.isArray(snap.dirtySample) && snap.dirtySample.length
        ? `（例如：<code>${escapeHtml(snap.dirtySample.slice(0, 3).join("、"))}</code>）`
        : "";
      dirtyEl.innerHTML = `检测到本地有 ${snap.dirtyCount || 1} 项未提交修改${sample}。为保护你的修改不被覆盖，在线拉取更新已锁定；请在本机提交或暂存修改后再更新。`;
    } else if (snap?.desktopRebuildSuggested && !desktopInfo?.needsUpdate) {
      dirtyEl.hidden = false;
      dirtyEl.innerHTML = `本次更新包含 macOS 桌面外壳改动，可点击下方「更新桌面 App」同步重建。`;
    } else {
      dirtyEl.hidden = true;
      dirtyEl.innerHTML = "";
    }
  }

  if (pendingSec && pendingCountEl && pendingListEl) {
    const commits = Array.isArray(snap?.pendingCommits) ? snap.pendingCommits : [];
    pendingSec.hidden = commits.length === 0;
    pendingCountEl.textContent = `${commits.length} 条提交`;
    pendingListEl.innerHTML = commits.map((c) => `
      <li class="update-pending-item">
        <span class="update-pending-sha">${escapeHtml(c.sha || "")}</span>
        <span class="update-pending-subject">${escapeHtml(c.subject || "")}</span>
      </li>
    `).join("");
  }

  if (desktopBtn) {
    const showDesktopBtn = Boolean(desktopInfo?.supported && (desktopInfo?.installed || desktopInfo?.canBuild));
    desktopBtn.hidden = !showDesktopBtn;
    desktopBtn.disabled = !showDesktopBtn || !desktopInfo?.canBuild || isBusy;
    if (state.desktopUpdating || snap?.desktopUpdating) desktopBtn.textContent = "编译 App 中…";
    else if (!desktopInfo?.installed) desktopBtn.textContent = "构建桌面 App";
    else if (desktopInfo?.needsUpdate) desktopBtn.textContent = "更新桌面 App";
    else desktopBtn.textContent = "重编桌面 App";
  }

  if (restartBtn) {
    restartBtn.disabled = isBusy;
    restartBtn.textContent = snap?.restartPending ? "重启服务中…" : "重启服务";
  }
  if (checkBtn) {
    checkBtn.disabled = isBusy;
    checkBtn.textContent = state.updateChecking || snap?.checking ? "检查中…" : "立即检查";
  }
  if (applyBtn) {
    const canApply = Boolean(snap?.canApply) && !isBusy;
    applyBtn.disabled = !canApply;
    if (snap?.updating || state.updateApplying) applyBtn.textContent = "正在更新…";
    else if (snap?.restartPending) applyBtn.textContent = "重启服务中…";
    else if (snap?.hasUpdate) applyBtn.textContent = `一键更新并重启 (${snap.behindCount || 1})`;
    else applyBtn.textContent = "已是最新";
  }
}

function applyUpdateStatusSnapshot(snap, { fromReconnectReady = false } = {}) {
  if (!snap || typeof snap !== "object") return;
  const prevHasUpdate = Boolean(state.updateStatus?.hasUpdate);
  state.updateStatus = snap;
  renderUpdateIndicators();
  if ($("updateModal")?.open) {
    renderUpdateModal();
  }

  if (fromReconnectReady) {
    try {
      const rawPending = sessionStorage.getItem(UPDATE_RESTART_FLAG_KEY);
      if (rawPending) {
        const parsed = JSON.parse(rawPending);
        const currentMeta = document.querySelector('meta[name="ac-ui-version"]')?.getAttribute("content") || "";
        const shaChanged = parsed?.prevSha && snap.localSha && parsed.prevSha !== snap.localSha;
        const uiChanged = snap.uiVersion && currentMeta && snap.uiVersion !== currentMeta;
        const manualRestart = Boolean(parsed?.manualRestart);
        if (!snap.updating && !snap.restartPending && (shaChanged || uiChanged || manualRestart)) {
          sessionStorage.removeItem(UPDATE_RESTART_FLAG_KEY);
          if (uiChanged && !($("promptInput")?.value || "").trim()) {
            location.reload();
            return;
          }
          showToastBanner(manualRestart ? "后台服务已重启完成" : "Agent Control 已更新完成", {
            detail: snap.localShortSha ? `当前版本 ${snap.localShortSha}` : "服务已重新启动",
          });
        }
      }
    } catch {
      try { sessionStorage.removeItem(UPDATE_RESTART_FLAG_KEY); } catch {}
    }
  } else if (!prevHasUpdate && snap.hasUpdate && snap.behindCount > 0) {
    showToastBanner("发现 Agent Control 新版本", {
      detail: `领先 ${snap.behindCount} 个提交，点击右上角菜单或侧栏底部即可一键更新`,
    });
  } else if (!state.updateStatus?.desktopApp?.needsUpdate && snap.desktopApp?.installed && snap.desktopApp?.needsUpdate) {
    showToastBanner("检测到桌面 App 壳子待更新", {
      detail: snap.desktopApp?.reason || "点击侧栏版本或右上角菜单可一键同步编译",
    });
  }
}

async function refreshUpdateStatus() {
  const snap = await apiGet("api/update");
  applyUpdateStatusSnapshot(snap);
  return snap;
}

async function triggerCheckUpdates() {
  if (state.updateChecking || state.updateApplying) return;
  state.updateChecking = true;
  renderUpdateIndicators();
  if ($("updateModal")?.open) renderUpdateModal();
  try {
    const snap = await apiPost("api/update/check", {}, { timeoutMs: 30_000 });
    applyUpdateStatusSnapshot(snap);
    if (snap.hasUpdate) {
      showToastBanner("检测到新版本", { detail: `共 ${snap.behindCount || 1} 条更新可用` });
    } else if (snap.updateState === "up_to_date") {
      showToastBanner("当前已是最新版本", { detail: snap.localShortSha ? `Commit ${snap.localShortSha}` : "" });
    }
  } catch (error) {
    const errMsg = formatActionError(error, "检查更新失败");
    showToastBanner("检查更新失败", { detail: errMsg, error: true });
    if (state.updateStatus) {
      state.updateStatus = { ...state.updateStatus, lastError: errMsg, phase: "error", phaseMessage: errMsg };
    }
  } finally {
    state.updateChecking = false;
    renderUpdateIndicators();
    if ($("updateModal")?.open) renderUpdateModal();
  }
}

async function saveUpdateConfig(patch) {
  try {
    const snap = await apiPost("api/update/config", patch);
    applyUpdateStatusSnapshot(snap);
    showToastBanner("更新设置已保存", {
      detail: snap.autoUpdateEnabled ? "已开启闲时自动更新" : (snap.autoCheckEnabled ? "已开启定期自动检测" : "已关闭自动检查"),
    });
  } catch (error) {
    showToastBanner("保存更新设置失败", { detail: formatActionError(error), error: true });
    renderUpdateModal();
  }
}

async function triggerApplyUpdate() {
  if (state.updateApplying || state.desktopUpdating || state.updateStatus?.restartPending) return;
  const anyRunning = Number(state.telemetry?.totals?.runningCount || 0) > 0;
  if (anyRunning && !window.confirm("当前仍有智能体正在运行，立即更新并重启服务会中断活跃流式输出。确定现在更新吗？")) {
    return;
  }
  state.updateApplying = true;
  if (state.updateStatus) {
    try {
      sessionStorage.setItem(UPDATE_RESTART_FLAG_KEY, JSON.stringify({
        prevSha: state.updateStatus.localSha || "",
        prevUiVersion: document.querySelector('meta[name="ac-ui-version"]')?.getAttribute("content") || "",
      }));
    } catch {}
  }
  renderUpdateIndicators();
  renderUpdateModal();
  try {
    const res = await apiPost("api/update/apply", { reason: "manual" }, { timeoutMs: 240_000 });
    if (res?.status) applyUpdateStatusSnapshot(res.status);
    showToastBanner(res?.updated ? "正在更新并重启服务" : "当前已是最新版本", {
      detail: res?.message || "",
    });
  } catch (error) {
    try { sessionStorage.removeItem(UPDATE_RESTART_FLAG_KEY); } catch {}
    const errMsg = formatActionError(error, "一键更新失败");
    showToastBanner("更新失败", { detail: errMsg, error: true });
    if (state.updateStatus) {
      state.updateStatus = { ...state.updateStatus, phase: "error", phaseMessage: errMsg, lastError: errMsg };
    }
  } finally {
    state.updateApplying = false;
    renderUpdateIndicators();
    if ($("updateModal")?.open) renderUpdateModal();
  }
}

async function triggerRestartService() {
  if (state.updateApplying || state.desktopUpdating || state.updateStatus?.restartPending) return;
  const anyRunning = Number(state.telemetry?.totals?.runningCount || 0) > 0;
  if (anyRunning && !window.confirm("当前仍有智能体正在运行，立即重启服务会中断活跃流式输出。确定现在重启吗？")) {
    return;
  }
  try {
    sessionStorage.setItem(UPDATE_RESTART_FLAG_KEY, JSON.stringify({
      manualRestart: true,
      prevSha: state.updateStatus?.localSha || "",
      prevUiVersion: document.querySelector('meta[name="ac-ui-version"]')?.getAttribute("content") || "",
    }));
  } catch {}
  try {
    const res = await apiPost("api/update/restart", { reason: "manual" }, { timeoutMs: 15_000 });
    if (res?.status) applyUpdateStatusSnapshot(res.status);
    showToastBanner("正在重启后台服务", {
      detail: res?.message || "页面将在服务恢复后自动重连",
    });
  } catch (error) {
    try { sessionStorage.removeItem(UPDATE_RESTART_FLAG_KEY); } catch {}
    showToastBanner("重启服务失败", { detail: formatActionError(error, "重启失败"), error: true });
  } finally {
    renderUpdateIndicators();
    if ($("updateModal")?.open) renderUpdateModal();
  }
}

async function triggerDesktopAppUpdate() {
  if (state.desktopUpdating || state.updateApplying || state.updateStatus?.restartPending) return;
  state.desktopUpdating = true;
  renderUpdateIndicators();
  if ($("updateModal")?.open) renderUpdateModal();
  try {
    const res = await apiPost("api/update/desktop", { reason: "manual", relaunchIfRunning: true }, { timeoutMs: 240_000 });
    if (res?.status) applyUpdateStatusSnapshot(res.status);
    showToastBanner("桌面 App 壳子已更新", {
      detail: res?.message || "Agent Control.app 已重新编译安装",
    });
  } catch (error) {
    const errMsg = formatActionError(error, "更新桌面 App 失败");
    showToastBanner("桌面 App 更新失败", { detail: errMsg, error: true });
    if (state.updateStatus) {
      state.updateStatus = { ...state.updateStatus, desktopPhase: "error", desktopMessage: errMsg };
    }
  } finally {
    state.desktopUpdating = false;
    renderUpdateIndicators();
    if ($("updateModal")?.open) renderUpdateModal();
  }
}

function formatAutomationTimeLabel(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "—";
  try {
    return new Date(n).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return "—";
  }
}

function renderAutomationsModal(snapshot = state.automationsSnapshot) {
  const badge = $("automationsSummaryBadge");
  const toggle = $("automationsGlobalToggle");
  const listEl = $("automationsList");
  const menuBadge = $("topbarMenuAutomationsBadge");
  const snap = snapshot || { enabled: true, tasks: [], summary: { total: 0, managedCount: 0 } };
  const managedCount = Number(snap.summary?.managedCount || 0);
  if (menuBadge) {
    menuBadge.hidden = managedCount <= 0;
    menuBadge.textContent = String(managedCount);
  }
  if (toggle) toggle.checked = snap.enabled !== false;
  if (badge) {
    badge.textContent = snap.enabled === false
      ? "后台托管已暂停"
      : `已托管 ${managedCount} / ${snap.summary?.total || 0}`;
  }
  if (!listEl) return;
  const tasks = Array.isArray(snap.tasks) ? snap.tasks : [];
  if (!tasks.length) {
    listEl.innerHTML = `<div class="empty-state">暂未在本机发现定时任务，可点击上方「+ 新建通用定时任务」创建。</div>`;
    return;
  }
  listEl.innerHTML = tasks.map((task) => {
    const pv = providerVisualMeta(task.provider);
    const sourceBadge = task.source === "agent-control" ? "自建托管" : `${pv.short} 原生`;
    const statusPill = task.running
      ? `<span class="board-status-pill is-live">执行中</span>`
      : task.managed
        ? `<span class="board-status-pill is-live">托管中</span>`
        : `<span class="board-status-pill">未托管</span>`;
    const lastRunHtml = task.effectiveLastRunAtMs
      ? `<span>上次：${escapeHtml(formatAutomationTimeLabel(task.effectiveLastRunAtMs))}${task.lastStatus === "error" ? ` (失败: ${escapeHtml(task.lastError || "")})` : ""}</span>`
      : "";
    const nextRunHtml = task.nextRunAtMs
      ? `<span>下次：${escapeHtml(formatAutomationTimeLabel(task.nextRunAtMs))}</span>`
      : "";
    const threadBtn = task.lastThreadId
      ? `<button type="button" class="btn-secondary btn-xs" data-auto-open-thread="${escapeHtml(task.lastThreadId)}">查看会话</button>`
      : "";
    const delBtn = task.source === "agent-control"
      ? `<button type="button" class="btn-secondary btn-xs" data-auto-delete="${escapeHtml(task.id)}">删除</button>`
      : "";
    return `
      <div class="automation-item">
        <div class="automation-item-top">
          <div class="automation-item-title-wrap">
            <span class="thread-micro-tag is-${escapeHtml(pv.tone)}">${pv.iconSvg || ""}${escapeHtml(sourceBadge)}</span>
            <strong class="automation-item-name">${escapeHtml(task.name || task.id)}</strong>
            ${statusPill}
          </div>
          <div class="automation-item-actions">
            ${threadBtn}
            <button type="button" class="btn-primary btn-xs" data-auto-run="${escapeHtml(task.taskKey)}"${task.running ? " disabled" : ""}>立即执行</button>
            <button type="button" class="btn-secondary btn-xs" data-auto-toggle="${escapeHtml(task.taskKey)}" data-auto-next-managed="${task.managed ? "0" : "1"}">${task.managed ? "暂停托管" : "开启托管"}</button>
            ${delBtn}
          </div>
        </div>
        <div class="automation-item-meta">
          <span>周期：${escapeHtml(task.scheduleLabel || "手动触发")}</span>
          ${nextRunHtml}
          ${lastRunHtml}
          ${task.cwds?.[0] ? `<span title="${escapeHtml(task.cwds[0])}">目录：${escapeHtml(projectBaseName(task.cwds[0]))}</span>` : ""}
        </div>
        ${task.prompt ? `<div class="automation-item-prompt">${escapeHtml(task.prompt)}</div>` : ""}
      </div>
    `;
  }).join("");
}

async function refreshAutomations() {
  const snap = await apiGet("api/automations");
  state.automationsSnapshot = snap;
  renderAutomationsModal(snap);
  return snap;
}

async function openAutomationsModal() {
  setTopbarMenuOpen(false);
  setComposerConfigOpen(false);
  const modal = $("automationsModal");
  if (!modal) return;
  renderAutomationsModal();
  if (!modal.open) modal.showModal();
  try {
    await refreshAutomations();
  } catch (error) {
    const bar = $("automationsStatusBar");
    if (bar) {
      bar.hidden = false;
      bar.className = "composer-status is-error";
      bar.textContent = formatActionError(error, "加载定时任务失败");
    }
  }
}

async function openUpdateModal() {
  setTopbarMenuOpen(false);
  setComposerConfigOpen(false);
  const modal = $("updateModal");
  if (!modal) return;
  renderUpdateModal();
  if (!modal.open) modal.showModal();
  try {
    await refreshUpdateStatus();
  } catch {
    // Keep existing modal content when status check is transient.
  }
}

function localAppLaunchUrl(app) {
  const id = String(app?.id || "").trim();
  if (!id) return "#";
  return `./apps/${encodeURIComponent(id)}/`;
}

function renderLocalApps() {
  const apps = Array.isArray(state.localApps) ? state.localApps : [];
  const hasApps = apps.length > 0;

  const strip = $("localAppsStrip");
  if (strip) {
    strip.hidden = !hasApps;
    strip.innerHTML = hasApps
      ? apps.map((app) => {
        const href = escapeHtml(localAppLaunchUrl(app));
        const name = escapeHtml(app.name || app.id);
        const desc = escapeHtml(app.description || "");
        const tip = desc ? `${name} · ${desc}` : name;
        return `<a class="local-app-chip" href="${href}" title="${tip}">`
          + `<span class="local-app-chip-name">${name}</span>`
          + `<span class="local-app-open-mark" aria-hidden="true">↗</span>`
          + `</a>`;
      }).join("")
      : "";
    if (hasApps) hydrateDeclarativeIcons(strip);
  }

  const menuBox = $("topbarLocalAppsBox");
  if (menuBox) {
    menuBox.hidden = !hasApps;
    menuBox.innerHTML = hasApps
      ? apps.map((app) => {
        const href = escapeHtml(localAppLaunchUrl(app));
        const name = escapeHtml(app.name || app.id);
        return `<a class="btn-secondary btn-sm topbar-local-app-link" href="${href}">`
          + `<span class="btn-icon-glyph" data-icon="film" data-icon-size="13" aria-hidden="true"></span>`
          + `<span>打开${name}</span>`
          + `<span class="btn-icon-glyph local-app-chip-arrow" data-icon="external-link" data-icon-size="11" aria-hidden="true"></span>`
          + `</a>`;
      }).join("")
      : "";
    if (hasApps) hydrateDeclarativeIcons(menuBox);
  }

  const remoteSec = $("remoteLocalAppsSection");
  const remoteList = $("remoteLocalAppsList");
  if (remoteSec && remoteList) {
    remoteSec.hidden = !hasApps;
    remoteList.innerHTML = hasApps
      ? apps.map((app) => {
        const href = escapeHtml(localAppLaunchUrl(app));
        const name = escapeHtml(app.name || app.id);
        const desc = escapeHtml(app.description || "复用当前安全通道访问本机工作台");
        return `<div class="remote-local-app-item">`
          + `<div class="remote-local-app-meta">`
          + `<strong>${name}</strong>`
          + `<span>${desc}</span>`
          + `</div>`
          + `<a class="btn-primary btn-xs remote-local-app-open" href="${href}">`
          + `<span class="btn-icon-glyph" data-icon="external-link" data-icon-size="12" aria-hidden="true"></span>`
          + `<span>直接进入</span>`
          + `</a>`
          + `</div>`;
      }).join("")
      : "";
    if (hasApps) hydrateDeclarativeIcons(remoteList);
  }
}

async function refreshLocalApps() {
  try {
    const res = await apiGet("api/apps");
    state.localApps = Array.isArray(res?.apps) ? res.apps : [];
  } catch {
    state.localApps = [];
  }
  renderLocalApps();
  return state.localApps;
}

function syncRemoteButtonIndicator() {
  const active = state.tunnelStatus?.state === "running" || Boolean(state.remoteStatus?.connected);
  const dot = $("remoteActiveDot");
  if (dot) dot.hidden = !active;
  $("remoteModalBtn")?.classList.toggle("is-online", active);
}

async function openRemoteModal({ silentOpen = false } = {}) {
  if (!silentOpen) {
    setTopbarMenuOpen(false);
    setComposerConfigOpen(false);
  }
  const modal = $("remoteModal");
  const [status] = await Promise.all([
    apiGet("api/remote").catch(() => null),
    refreshLocalApps().catch(() => null),
  ]);
  if (status) {
    renderRemoteStatus(status);
  }
  if (!silentOpen && !modal.open) {
    modal.showModal();
  }
}

function renderTunnelStatus(tunnel) {
  if (!tunnel || typeof tunnel !== "object") return;
  state.tunnelStatus = tunnel;
  syncRemoteButtonIndicator();

  const textMap = {
    stopped: "未开启",
    starting: "正在启动…",
    running: "运行中（可扫码连接）",
    missing_binary: "未安装 cloudflared",
    error: "启动失败",
    disabled: "已禁用",
  };
  const pill = $("tunnelStateText");
  if (pill) {
    pill.textContent = textMap[tunnel.state] || tunnel.state || "未开启";
    pill.className = `tunnel-state-pill${
      tunnel.state === "running" ? " is-running"
        : tunnel.state === "starting" ? " is-starting"
          : (tunnel.state === "error" || tunnel.state === "missing_binary") ? " is-error"
            : ""
    }`;
  }

  const canManage = tunnel.canManage !== false;
  if ($("tunnelReadonlyNotice")) $("tunnelReadonlyNotice").hidden = canManage;
  if ($("tunnelManageWrap")) $("tunnelManageWrap").hidden = !canManage;

  const missingBox = $("tunnelMissingBox");
  if (missingBox) {
    missingBox.hidden = !(canManage && (tunnel.state === "missing_binary" || tunnel.installed === false));
  }
  const installCmdCode = $("tunnelInstallCmdCode");
  if (installCmdCode && tunnel.installHint) {
    installCmdCode.textContent = tunnel.installHint;
  }

  const errEl = $("tunnelErrorText");
  if (errEl) {
    const showErr = canManage && tunnel.state === "error" && Boolean(tunnel.lastError);
    errEl.hidden = !showErr;
    errEl.textContent = showErr ? tunnel.lastError : "";
  }

  const isRunning = tunnel.state === "running";
  const isStarting = tunnel.state === "starting";
  const startBtn = $("startTunnelBtn");
  if (startBtn) {
    startBtn.hidden = isRunning;
    startBtn.disabled = state.tunnelBusy || isStarting || tunnel.state === "disabled";
    startBtn.innerHTML = (state.tunnelBusy || isStarting)
      ? `${iconSvg("clock", { size: 13 })}<span>正在分配公网加密地址…</span>`
      : `${iconSvg("bolt", { size: 13 })}<span>一键开启并生成二维码</span>`;
  }
  if ($("rotateTunnelBtn")) {
    $("rotateTunnelBtn").hidden = !isRunning;
    $("rotateTunnelBtn").disabled = state.tunnelBusy;
  }
  if ($("stopTunnelBtn")) {
    $("stopTunnelBtn").hidden = !(isRunning || isStarting);
    $("stopTunnelBtn").disabled = state.tunnelBusy;
  }

  const qrWrap = $("tunnelQrWrap");
  if (qrWrap) {
    if (canManage && isRunning && tunnel.qrDataUrl && tunnel.pairUrl) {
      qrWrap.hidden = false;
      $("tunnelQrImg").src = tunnel.qrDataUrl;
      $("tunnelPairUrlInput").value = tunnel.pairUrl;
    } else {
      qrWrap.hidden = true;
    }
  }
}

function renderRemoteStatus(status) {
  if (!status || typeof status !== "object") return;
  state.remoteStatus = status;
  syncRemoteButtonIndicator();

  const textMap = {
    unpaired: "未配对",
    connecting: "正在连接中继…",
    connected: "已连接中继（手机可随时访问）",
    disconnected: "连接断开，自动重连中…",
    revoked: "凭证已被撤销，请重新配对",
    disabled: "已禁用远程中继",
  };
  $("remoteStateText").textContent = textMap[status.state] || status.state || "未知";
  if (status.relayUrl) $("relayUrlInput").value = status.relayUrl;
  if (status.label) $("hostLabelInput").value = status.label;

  const canManage = status.canManage !== false;
  $("unpairBtn").hidden = !canManage || !status.paired;
  if ($("remotePairSubmitBtn")) $("remotePairSubmitBtn").hidden = !canManage;
  if ($("remoteReadonlyNotice")) $("remoteReadonlyNotice").hidden = canManage;
  for (const el of $("remotePairForm")?.querySelectorAll("input") || []) {
    el.disabled = !canManage;
  }

  const qrWrap = $("remoteQrWrap");
  if (canManage && status.paired && status.qrDataUrl) {
    qrWrap.hidden = false;
    $("remoteQrImg").src = status.qrDataUrl;
    $("remotePairUrlInput").value = status.pairUrl || "";
  } else {
    qrWrap.hidden = true;
  }

  if ($("relayAdvancedSection") && status.paired) {
    $("relayAdvancedSection").open = true;
  }
  if (status.tunnel) {
    renderTunnelStatus(status.tunnel);
  }
  if (status.fixedTunnel) {
    renderFixedTunnelStatus(status.fixedTunnel);
  }
}

function renderFixedTunnelStatus(fixed) {
  if (!fixed || typeof fixed !== "object") return;
  state.fixedTunnelStatus = fixed;

  const canManage = fixed.canManage !== false;
  const pill = $("tsFunnelStateText");
  if (pill) {
    if (!fixed.installed) {
      pill.textContent = "未安装";
      pill.className = "tunnel-state-pill";
    } else if (fixed.active) {
      pill.textContent = "Funnel 运行中";
      pill.className = "tunnel-state-pill is-running";
    } else if (fixed.dnsName) {
      pill.textContent = "已就绪（未开启）";
      pill.className = "tunnel-state-pill";
    } else {
      pill.textContent = "未登录 / 未启用 MagicDNS";
      pill.className = "tunnel-state-pill is-error";
    }
  }

  if ($("tsMissingBox")) {
    $("tsMissingBox").hidden = !(canManage && fixed.installed === false);
  }
  if ($("tsInstallCmdCode") && fixed.installHint) {
    $("tsInstallCmdCode").textContent = fixed.installHint;
  }
  if ($("tsErrorText")) {
    const showErr = canManage && Boolean(fixed.lastError);
    $("tsErrorText").hidden = !showErr;
    $("tsErrorText").textContent = showErr ? fixed.lastError : "";
  }
  if ($("startTsFunnelBtn")) {
    $("startTsFunnelBtn").disabled = !canManage || state.fixedTunnelBusy || !fixed.installed;
    $("startTsFunnelBtn").textContent = state.fixedTunnelBusy
      ? "正在处理…"
      : fixed.active
        ? "刷新 Tailscale Funnel 二维码"
        : "一键开启 Tailscale Funnel";
  }
  if ($("stopTsFunnelBtn")) {
    $("stopTsFunnelBtn").hidden = !(canManage && fixed.active);
    $("stopTsFunnelBtn").disabled = state.fixedTunnelBusy;
  }

  const input = $("fixedPublicUrlInput");
  if (input && document.activeElement !== input) {
    if (fixed.fixedPublicUrl) {
      input.value = fixed.fixedPublicUrl;
    } else if (!input.value && fixed.publicUrl) {
      input.value = fixed.publicUrl;
    }
  }
  if ($("saveFixedPairBtn")) {
    $("saveFixedPairBtn").disabled = !canManage || state.fixedTunnelBusy;
  }
  const hasPairedFixed = Boolean(canManage && fixed.fixedPublicUrl && fixed.pairUrl);
  if ($("rotateFixedPairBtn")) {
    $("rotateFixedPairBtn").hidden = !hasPairedFixed;
    $("rotateFixedPairBtn").disabled = state.fixedTunnelBusy;
  }
  if ($("clearFixedPairBtn")) {
    $("clearFixedPairBtn").hidden = !(canManage && fixed.fixedPublicUrl);
    $("clearFixedPairBtn").disabled = state.fixedTunnelBusy;
  }
  const qrWrap = $("fixedQrWrap");
  if (qrWrap) {
    if (hasPairedFixed && fixed.qrDataUrl) {
      qrWrap.hidden = false;
      $("fixedQrImg").src = fixed.qrDataUrl;
      $("fixedPairUrlInput").value = fixed.pairUrl;
    } else {
      qrWrap.hidden = true;
    }
  }
}

async function toggleProjectPin(cwd) {
  const key = normalizeProjectCwd(cwd);
  if (!key) return;
  const currentPinned = Boolean(state.projectsMeta[key]?.pinned);
  try {
    const res = await apiPost("api/project/meta", { cwd: key, pinned: !currentPinned });
    state.projectsMeta = res.projectsMeta || state.projectsMeta;
    renderThreadList();
    renderTopbarAndControls();
    renderProjectBoard();
    renderProjectTaskStrip();
    showToastBanner(!currentPinned ? "已关注置顶该项目" : "已取消关注", {
      detail: state.projectsMeta[key]?.alias || projectBaseName(key),
    });
  } catch (error) {
    showToastBanner("更新项目关注失败", { detail: formatActionError(error), error: true });
  }
}

async function promptProjectAlias(cwd) {
  const key = normalizeProjectCwd(cwd);
  if (!key) return;
  const currentAlias = state.projectsMeta[key]?.alias || "";
  const next = prompt(`为「${projectBaseName(key)}」设置简称（方便搜索与语音匹配，留空清除）：`, currentAlias);
  if (next === null) return;
  try {
    const res = await apiPost("api/project/meta", { cwd: key, alias: next.trim() });
    state.projectsMeta = res.projectsMeta || state.projectsMeta;
    renderThreadList();
    renderTopbarAndControls();
    renderProjectBoard();
    renderProjectTaskStrip();
  } catch (error) {
    showToastBanner("保存项目简称失败", { detail: formatActionError(error), error: true });
  }
}

async function openNewThreadModal({ cwd = "", provider = "", model = "", promptText = "" } = {}) {
  setTopbarMenuOpen(false);
  setComposerConfigOpen(false);
  const chosenProvider = provider || defaultNewThreadProvider();
  await selectThread("", { newThreadCwd: cwd });
  $("composerProviderSelect").value = chosenProvider;
  syncComposerProfileSelect();
  if (model) saveNewThreadPrefs(chosenProvider, { model });
  syncModelAndEffortSelectors();
  state.composerGoal = false;
  state.images = [];
  renderComposerImages();
  $("promptInput").value = promptText;
  renderTopbarAndControls();
  setSidebarOpen(false);
  $("promptInput").focus();
}

function openProjectBoardView() {
  setTopbarMenuOpen(false);
  setComposerConfigOpen(false);
  state.boardOpen = true;
  renderTopbarAndControls();
  renderActiveMessages();
  setSidebarOpen(false);
}

// =========================================================================
// AI 语音实时通话总控（Mac 多模态 Hydrogen + Edge TTS + 实时任务动态）
// =========================================================================

let cachedSilentWavDataUri = "";

function getSilentWavDataUri() {
  if (!cachedSilentWavDataUri) {
    const wavBytes = encodePcm16SamplesToWav(new Int16Array(640), 16000);
    cachedSilentWavDataUri = `data:audio/wav;base64,${uint8ArrayToBase64(wavBytes)}`;
  }
  return cachedSilentWavDataUri;
}

function ensureVoiceAudioUnlocked() {
  try {
    if (typeof navigator !== "undefined" && navigator.audioSession) {
      navigator.audioSession.type = "play-and-record";
    }
  } catch {}
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (AudioCtx) {
    if (!state.voice.audioCtx || state.voice.audioCtx.state === "closed") {
      try {
        state.voice.audioCtx = new AudioCtx();
        state.voice.webAudioUnlocked = false;
      } catch {}
    }
    if (state.voice.audioCtx?.state === "suspended") {
      void state.voice.audioCtx.resume().catch(() => {});
    }
    if (state.voice.audioCtx && !state.voice.webAudioUnlocked) {
      try {
        const ctx = state.voice.audioCtx;
        const buf = ctx.createBuffer(1, 1, 22050);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start(0);
        state.voice.webAudioUnlocked = true;
      } catch {}
    }
  }
  if (!state.voice.audioEl) {
    const audio = new Audio();
    audio.playsInline = true;
    audio.preload = "auto";
    state.voice.audioEl = audio;
  }
  if (!state.voice.audioElUnlocked && !state.voice.isSpeaking && !state.voice.activePlaybackAbort) {
    state.voice.audioElUnlocked = true;
    try {
      const audio = state.voice.audioEl;
      audio.src = getSilentWavDataUri();
      audio.play().catch(() => {
        state.voice.audioElUnlocked = false;
      });
    } catch {
      state.voice.audioElUnlocked = false;
    }
  }
}

function clearVoiceResumeTimer() {
  if (state.voice.resumeListenTimer) {
    clearTimeout(state.voice.resumeListenTimer);
    state.voice.resumeListenTimer = null;
  }
}

function resumeVoiceAudioContextIfNeeded() {
  try {
    const ctx = state.voice.audioCtx;
    if (ctx && ctx.state === "suspended") {
      void ctx.resume().catch(() => {});
    }
  } catch {}
}

function scheduleVoiceListenResume() {
  clearVoiceResumeTimer();
  resumeVoiceAudioContextIfNeeded();
  state.voice.resumeListenTimer = setTimeout(() => {
    state.voice.resumeListenTimer = null;
    if (!state.voice.callActive) return;
    resumeVoiceAudioContextIfNeeded();
    if (!state.voice.isProcessing && !state.voice.isSpeaking && !state.voice.isRecording && state.voice.pendingVoiceTurns.length) {
      void sendVoiceTurnToMac();
      return;
    }
    if (!state.voice.isRecording) state.voice.vadDetector?.reset?.();
    renderVoiceCallUi();
  }, 240);
}

function stopVoicePlayback({ scheduleResume = false, abortReason = "superseded" } = {}) {
  clearVoiceResumeTimer();
  state.voice.playbackToken = (state.voice.playbackToken || 0) + 1;
  const abort = state.voice.activePlaybackAbort;
  state.voice.activePlaybackAbort = null;
  if (typeof abort === "function") {
    try { abort(abortReason); } catch {}
  }
  if (state.voice.activeBufferSource) {
    try {
      state.voice.activeBufferSource.onended = null;
      state.voice.activeBufferSource.stop();
      state.voice.activeBufferSource.disconnect();
    } catch {}
    state.voice.activeBufferSource = null;
  }
  state.voice.isSpeaking = false;
  if (state.voice.audioEl) {
    try {
      state.voice.audioEl.onplaying = null;
      state.voice.audioEl.ontimeupdate = null;
      state.voice.audioEl.onended = null;
      state.voice.audioEl.onerror = null;
      state.voice.audioEl.onstalled = null;
      state.voice.audioEl.pause();
      state.voice.audioEl.currentTime = 0;
    } catch {}
  }
  if (state.voice.audioObjectUrl) {
    try {
      URL.revokeObjectURL(state.voice.audioObjectUrl);
    } catch {}
    state.voice.audioObjectUrl = "";
  }
  if (scheduleResume) {
    scheduleVoiceListenResume();
  } else {
    renderVoiceCallUi();
  }
}

function nextVoiceUtteranceId(prefix = "utt") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function effectiveVoiceThreadId() {
  return String(state.voice.scopedThreadId || state.activeThreadId || "").trim();
}

function effectiveVoiceScope() {
  if (state.voice.callScope === "thread" && effectiveVoiceThreadId()) {
    return "thread";
  }
  return "global";
}

function renderVoiceScopeBar() {
  const threadBtn = $("voiceScopeThreadBtn");
  const globalBtn = $("voiceScopeGlobalBtn");
  const threadLbl = $("voiceScopeThreadLabel");
  if (!threadBtn || !globalBtn) return;
  const targetTid = effectiveVoiceThreadId();
  const targetThread = targetTid
    ? (state.threads.find((t) => t.id === targetTid) || (state.activeThread?.id === targetTid ? state.activeThread : null))
    : null;
  const scope = effectiveVoiceScope();
  const hasThread = Boolean(targetTid);
  threadBtn.disabled = !hasThread;
  threadBtn.classList.toggle("is-active", scope === "thread");
  globalBtn.classList.toggle("is-active", scope !== "thread");
  if (threadLbl) {
    const rawTitle = String(targetThread?.title || targetThread?.name || "").trim();
    const shortTitle = rawTitle.length > 12 ? `${rawTitle.slice(0, 12)}…` : rawTitle;
    threadLbl.textContent = shortTitle ? `当前对话 · ${shortTitle}` : (hasThread ? "当前对话" : "当前对话（未选）");
  }
}

function setVoiceCallScope(nextScope = "global") {
  const wantThread = nextScope === "thread";
  if (wantThread) {
    const tid = state.activeThreadId || state.voice.scopedThreadId || "";
    if (!tid) return;
    state.voice.callScope = "thread";
    state.voice.scopedThreadId = tid;
  } else {
    state.voice.callScope = "global";
  }
  renderVoiceScopeBar();
  renderVoiceLiveProgress();
  renderVoiceCallUi();
  if (state.voice.callActive && state.voice.callId && !state.voice.backendMissing) {
    void apiPostWithHotFallback("api/voice/call/start", {
      callId: state.voice.callId,
      callScope: effectiveVoiceScope(),
      activeThreadId: effectiveVoiceThreadId(),
      ...voiceSelectionPayload(),
    }).catch(() => {});
  }
}

function renderVoiceLiveProgress() {
  const listEl = $("voiceLiveProgressList");
  const badgeEl = $("voiceLiveSummaryBadge");
  const headingEl = $("voiceProgressHeadingText");
  if (!listEl) return;
  const scope = effectiveVoiceScope();
  const scopedTid = effectiveVoiceThreadId();
  const groups = getProjectGroups({ ignoreFilters: true });
  const filteredThreads = scope === "thread" && scopedTid
    ? state.threads.filter((t) => t.id === scopedTid)
    : state.threads;
  const filteredRequests = scope === "thread" && scopedTid
    ? state.pendingRequests.filter((r) => r.threadId === scopedTid)
    : state.pendingRequests;
  const items = buildVoiceLiveProgressItems({
    groups,
    threads: filteredThreads,
    pendingRequests: filteredRequests,
    liveActivityByThread: state.liveActivityByThread,
    recentCompletedByThread: state.recentCompletedByThread,
    activeThreadId: scopedTid || state.activeThreadId,
  });
  listEl.innerHTML = renderVoiceLiveProgressHtml(items);
  if (headingEl) {
    headingEl.textContent = scope === "thread" ? "当前对话动态" : "实时任务动态";
  }
  if (badgeEl) {
    const liveCount = filteredThreads.filter((t) => t.live || state.liveActivityByThread.get(t.id)?.status === "running").length;
    const pendingCount = filteredRequests.length;
    const parts = [];
    if (pendingCount > 0) parts.push(`${pendingCount} 待审批`);
    if (liveCount > 0) parts.push(`${liveCount} 运行中`);
    badgeEl.textContent = parts.length ? parts.join(" · ") : (scope === "thread" ? "当前对话就绪" : "实时同步");
  }
}

function renderVoiceLiveProgressIfOpen() {
  if ($("voiceCopilotModal")?.open) {
    renderVoiceLiveProgress();
  }
}

function renderVoiceUnheardBanner() {
  const banner = $("voiceUnheardBanner");
  if (!banner) return;
  const html = renderVoiceUnheardBannerHtml(state.voice.unheardQueue);
  banner.innerHTML = html;
  banner.hidden = !html;
}

function renderVoiceTranscript() {
  const el = $("voiceCallTranscript");
  if (!el) return;
  el.innerHTML = renderVoiceCallTranscriptHtml(state.voice.transcript);
  el.scrollTop = el.scrollHeight;
}

function appendVoiceTranscriptEntry(entry) {
  if (!entry || (!entry.heardText && !entry.spokenReply)) return null;
  const id = String(entry.id || nextVoiceUtteranceId()).trim();
  const normalized = {
    ...entry,
    id,
    deliveryStatus: entry.spokenReply ? (entry.deliveryStatus || "pending") : "",
    heard: Boolean(entry.heard),
    deliveryReason: String(entry.deliveryReason || ""),
    priority: entry.priority === "critical" ? "critical" : "normal",
    ttsCache: entry.ttsCache || null,
  };
  const existingIdx = state.voice.transcript.findIndex((item) => item.id === id);
  if (existingIdx >= 0) {
    state.voice.transcript[existingIdx] = { ...state.voice.transcript[existingIdx], ...normalized };
  } else {
    state.voice.transcript.push(normalized);
  }
  if (state.voice.transcript.length > 20) {
    state.voice.transcript = state.voice.transcript.slice(-20);
  }
  renderVoiceTranscript();
  return normalized;
}

function updateVoiceTranscriptEntry(utteranceId, patch = {}) {
  if (!utteranceId) return;
  const idx = state.voice.transcript.findIndex((item) => item.id === utteranceId);
  if (idx < 0) return;
  state.voice.transcript[idx] = { ...state.voice.transcript[idx], ...patch };
  renderVoiceTranscript();
}

function renderVoiceCallUi() {
  if (typeof renderVoiceScopeBar === "function") renderVoiceScopeBar();
  const orb = $("voiceOrbBtn");
  const dot = $("voiceCallDot");
  const stateEl = $("voiceStateText");
  const hintEl = $("voiceSubHintText");
  const modelBadge = $("voiceModelBadge");
  const muteBtn = $("voiceMuteBtn");
  const muteLabel = $("voiceMuteLabel");
  const talkBtn = $("voiceTalkBtn");
  const talkTitle = $("voiceTalkBtnTitle");
  const readLabel = $("voiceReadLabel");
  const announceBtn = $("voiceAutoAnnounceBtn");
  const launchBtn = $("voiceModeBtn");
  const attnDot = $("voiceAttentionDot");

  const v = state.voice;
  const unheardCount = v.unheardQueue.length;
  let phaseClass = "";
  let statusText = "免提聆听中…";
  let hintText = "自然说话停顿约 1 秒自动发送，或轻点光球立即发送";

  if (!v.callActive) {
    statusText = "通话已结束";
    hintText = "点击顶部语音按钮可随时重新拨通语音总控";
  } else if (v.isProcessing) {
    phaseClass = "is-busy";
    statusText = v.processingPhaseText || "正在理解刚才的话…";
    hintText = v.pendingVoiceTurns.length
      ? `已收到后续 ${v.pendingVoiceTurns.length} 段语音，会依次处理`
      : "仍在聆听，后续语音会保留并依次处理";
  } else if (v.isSpeaking) {
    phaseClass = "is-speaking";
    statusText = "正在语音回复";
    hintText = "轻点光球或【打断】可立即开口说话";
  } else if (v.isRecording) {
    phaseClass = "is-recording";
    statusText = "正在聆听你说话…";
    hintText = "说完停顿自动发送 · 轻点光球立即发送";
  } else if (v.isMuted) {
    phaseClass = "is-muted";
    statusText = "麦克风已静音";
    hintText = "点下方【恢复麦】开启免提通话，或用键盘输入文字";
  } else if (unheardCount > 0) {
    hintText = `有 ${unheardCount} 条语音未播成功，点上方【立即补播】或说“再说一遍”`;
  } else if (v.pendingBatches.size > 0) {
    hintText = "后台正在分批派发执行，稍后会持续播报进度…";
  }

  if (orb) {
    orb.classList.remove("is-recording", "is-busy", "is-speaking", "is-muted");
    if (phaseClass) orb.classList.add(phaseClass);
    const core = orb.querySelector(".voice-orb-core");
    if (core) {
      const activeProv = v.dispatchProvider && v.dispatchProvider !== "local" ? v.dispatchProvider : "";
      core.innerHTML = v.isProcessing
        ? (activeProv ? providerIconSvg(activeProv, { size: 28 }) : iconSvg("bolt", { size: 28 }))
        : v.isSpeaking
          ? iconSvg("speaker", { size: 28 })
          : v.isMuted
            ? iconSvg("speaker-off", { size: 28 })
            : iconSvg("mic", { size: 28 });
    }
  }
  if (dot) {
    dot.classList.remove("is-connecting", "is-connected", "is-error");
    dot.classList.add(v.backendMissing ? "is-error" : v.callActive ? "is-connected" : "is-connecting");
  }
  if (stateEl && !v.backendMissing) stateEl.textContent = statusText;
  if (hintEl && !v.backendMissing) hintEl.textContent = hintText;
  if (modelBadge) {
    const shortModel = String(v.modelName || "").includes("hydrogen")
      ? "Hydrogen"
      : (compactModelBadgeLabel(v.modelName) || v.modelName || "自动轻量");
    const lockText = v.wakeLock ? " · 常亮" : "";
    const statusLabel = `${v.isMuted ? "已静音" : "免提"}${lockText}`;
    modelBadge.textContent = `${shortModel} · ${statusLabel}`;
    modelBadge.title = `本轮处理：${v.modelName || "尚未处理"} · 语音识别：${v.asrEngine}`;
  }
  if (muteBtn && muteLabel) {
    muteBtn.classList.toggle("is-muted", v.isMuted);
    muteLabel.textContent = v.isMuted ? "恢复麦" : "静音";
  }
  if (talkBtn && talkTitle) {
    talkTitle.textContent = v.isSpeaking ? "打断说话" : v.isRecording ? "立即发送" : v.isProcessing ? "调度中…" : "播报/唤醒";
    talkBtn.disabled = v.isProcessing;
  }
  if (readLabel) {
    readLabel.textContent = v.isSpeaking ? "停止播报" : "播报进度";
  }
  if (announceBtn) {
    announceBtn.classList.toggle("is-on", Boolean(v.config.autoBroadcastEvents));
  }
  if (launchBtn) {
    launchBtn.classList.toggle("is-active-voice", Boolean(v.callActive || v.isRecording || v.isSpeaking));
    launchBtn.classList.toggle("has-unheard", unheardCount > 0);
    const lbl = launchBtn.querySelector(".btn-label-desktop");
    if (lbl) {
      lbl.textContent = v.callActive
        ? (unheardCount > 0 && v.minimized ? `通话中 · ${unheardCount}未播` : "通话中")
        : (unheardCount > 0 ? `${unheardCount}未播` : "通话");
    }
    launchBtn.title = unheardCount > 0
      ? `有 ${unheardCount} 条语音回复未出声（点击展开并补播）`
      : v.callActive
        ? "语音通话正在进行（点击展开面板）"
        : "AI 语音通话总控";
  }
  if (attnDot) {
    attnDot.hidden = !(unheardCount > 0 || v.callActive);
    attnDot.className = unheardCount > 0
      ? "btn-attention-dot is-pending"
      : v.callActive
        ? "btn-attention-dot is-live"
        : "btn-attention-dot";
  }
  renderVoiceUnheardBanner();
}

function updateVoiceCallTimerLabel() {
  const timerEl = $("voiceCallTimer");
  if (!timerEl || !state.voice.callActive) return;
  const elapsed = Math.floor((Date.now() - state.voice.callStartedAt) / 1000);
  timerEl.textContent = formatCallDuration(elapsed);
}

function stopVoiceLevelAnimation() {
  if (state.voice.levelRafId) {
    cancelAnimationFrame(state.voice.levelRafId);
    state.voice.levelRafId = null;
  }
  $("voiceOrbBtn")?.style?.setProperty("--voice-level", "0");
}

function startVoiceLevelAnimation() {
  stopVoiceLevelAnimation();
  const tick = () => {
    if (!state.voice.callActive) return;
    const nowMs = Date.now();
    if (state.voice.lastAudioFrameAt > 0 && nowMs - state.voice.lastAudioFrameAt > 180 && state.voice.currentRms > 0) {
      state.voice.currentRms *= 0.82;
      if (state.voice.currentRms < 0.001) state.voice.currentRms = 0;
    }
    const orb = $("voiceOrbBtn");
    if (orb) {
      const safeRms = Number.isFinite(state.voice.currentRms) ? Math.max(0, Math.min(1, state.voice.currentRms)) : 0;
      let level = 0;
      if (state.voice.isRecording) {
        level = Math.min(1, safeRms * 12);
      } else if (state.voice.isSpeaking) {
        level = 0.28 + Math.sin(nowMs / 160) * 0.14;
      } else if (state.voice.isProcessing) {
        level = 0.22 + Math.sin(nowMs / 220) * 0.12;
      } else if (!state.voice.isMuted) {
        level = Math.min(0.45, safeRms * 7);
      }
      orb.style.setProperty("--voice-level", level.toFixed(3));
    }
    state.voice.levelRafId = requestAnimationFrame(tick);
  };
  state.voice.levelRafId = requestAnimationFrame(tick);
}

function voiceSelectionPayload() {
  const parsed = parseVoiceModelSelectionKey(state.voice.config?.preferredModelKey || "auto");
  return {
    voiceProvider: parsed.voiceProvider || "",
    voiceProfileId: parsed.voiceProfileId || "",
    voiceModel: parsed.voiceModel || "",
  };
}

function renderVoiceModelSelector() {
  const sel = $("voiceModelSelect");
  if (!sel) return;
  const preferredKey = state.voice.config?.preferredModelKey || "auto";
  sel.innerHTML = renderVoiceModelSelectOptionsHtml(state.voice.modelOptions, preferredKey);
  if ([...sel.options].some((o) => o.value === preferredKey)) {
    sel.value = preferredKey;
  }
}

function stopVoiceCallMicPipeline() {
  if (state.voice.micWatchdogTimer) {
    clearInterval(state.voice.micWatchdogTimer);
    state.voice.micWatchdogTimer = null;
  }
  if (state.voice.speechRecognition) {
    try {
      state.voice.speechRecognition.onresult = null;
      state.voice.speechRecognition.onerror = null;
      state.voice.speechRecognition.onend = null;
      state.voice.speechRecognition.stop();
    } catch {}
    state.voice.speechRecognition = null;
  }
  if (state.voice.processorNode) {
    try {
      state.voice.processorNode.onaudioprocess = null;
      state.voice.processorNode.disconnect();
    } catch {}
    state.voice.processorNode = null;
  }
  if (state.voice.silentGainNode) {
    try {
      state.voice.silentGainNode.disconnect();
    } catch {}
    state.voice.silentGainNode = null;
  }
  if (Array.isArray(state.voice.filterNodes)) {
    for (const node of state.voice.filterNodes) {
      try { node.disconnect(); } catch {}
    }
    state.voice.filterNodes = [];
  }
  if (state.voice.micSource) {
    try {
      state.voice.micSource.disconnect();
    } catch {}
    state.voice.micSource = null;
  }
  if (state.voice.micStream) {
    for (const track of state.voice.micStream.getTracks()) {
      try {
        track.onended = null;
        track.stop();
      } catch {}
    }
    state.voice.micStream = null;
  }
  state.voice.vadDetector = null;
  state.voice.isRecording = false;
  state.voice.currentRms = 0;
  state.voice.lastAudioFrameAt = 0;
}

function startBrowserSpeechRecognitionPipeline() {
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) return false;
  const rec = new SpeechRec();
  rec.lang = "zh-CN";
  rec.continuous = true;
  rec.interimResults = true;
  rec.onresult = (event) => {
    if (!state.voice.callActive || state.voice.isMuted || state.voice.isSpeaking) return;
    let finalText = "";
    let hasInterim = false;
    for (let i = event.resultIndex || 0; i < event.results.length; i += 1) {
      const res = event.results[i];
      if (res?.isFinal) {
        finalText += res[0]?.transcript || "";
      } else if (res?.[0]?.transcript) {
        hasInterim = true;
      }
    }
    state.voice.isRecording = Boolean(hasInterim && !finalText.trim());
    renderVoiceCallUi();
    if (finalText.trim()) {
      state.voice.isRecording = false;
      void sendVoiceTurnToMac({ transcriptText: finalText.trim() });
    }
  };
  rec.onerror = (event) => {
    state.voice.isRecording = false;
    const code = event?.error || "unknown";
    if (code === "no-speech" || code === "aborted") return;
    state.voice.isMuted = true;
    renderVoiceCallUi();
    const reasons = {
      "not-allowed": "麦克风或语音识别权限被拒绝，请检查浏览器权限",
      "service-not-allowed": "浏览器不允许使用语音识别服务",
      "audio-capture": "无法读取麦克风，请检查设备是否被占用",
      network: "浏览器语音识别服务连接失败，可改用主机 Whisper",
    };
    $("voiceStateText").textContent = reasons[code] || `语音识别失败（${code}）`;
  };
  rec.onend = () => {
    if (state.voice.callActive && !state.voice.isMuted && !state.voice.asrAvailable && state.voice.speechRecognition === rec) {
      setTimeout(() => {
        if (state.voice.callActive && !state.voice.isMuted && state.voice.speechRecognition === rec) {
          try { rec.start(); } catch {}
        }
      }, 300);
    }
  };
  try {
    rec.start();
    state.voice.speechRecognition = rec;
    state.voice.isMuted = false;
    renderVoiceCallUi();
    return true;
  } catch {
    return false;
  }
}

async function startVoiceCallMicPipeline() {
  stopVoiceCallMicPipeline();
  if (state.voice.asrAvailable === false) {
    if (startBrowserSpeechRecognitionPipeline()) {
      return;
    }
    state.voice.isMuted = true;
    renderVoiceCallUi();
    $("voiceSubHintText").textContent = "当前环境未配置本地 Whisper，可展开右上角键盘输入或连接 Mac Whisper";
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !state.voice.audioCtx) {
    if (startBrowserSpeechRecognitionPipeline()) {
      return;
    }
    state.voice.isMuted = true;
    renderVoiceCallUi();
    $("voiceStateText").textContent = "浏览器不支持网页麦克风（可用文字输入控制）";
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    if (!state.voice.callActive) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }

    const ctx = state.voice.audioCtx;
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(2048, 1, 1);
    const silentGain = ctx.createGain();
    silentGain.gain.value = 0;

    const detector = createVadTurnDetector({
      sampleRate: 16000,
      preRollMs: 320,
      silenceMs: 760,
      minSpeechMs: 260,
      maxSpeechMs: 14000,
      rmsThreshold: 0.013,
      adaptive: true,
      requireSustainedOnset: true,
      minPeakRms: 0.015,
      minSnrRatio: 1.8,
    });

    processor.onaudioprocess = (ev) => {
      state.voice.lastAudioFrameAt = Date.now();
      if (!state.voice.callActive || state.voice.isMuted || state.voice.isSpeaking) {
        state.voice.currentRms = 0;
        return;
      }
      try {
        const input = ev.inputBuffer?.getChannelData?.(0);
        if (!input?.length) return;
        let hasCorruptSample = false;
        for (let i = 0; i < input.length; i += 64) {
          if (!Number.isFinite(input[i])) {
            hasCorruptSample = true;
            break;
          }
        }
        if (hasCorruptSample) {
          state.voice.currentRms = 0;
          if (!state.voice.micRecovering) {
            state.voice.micRecovering = true;
            setTimeout(() => {
              state.voice.micRecovering = false;
              if (state.voice.callActive && !state.voice.isMuted) {
                void startVoiceCallMicPipeline();
              }
            }, 60);
          }
          return;
        }
        const rms = computeRmsLevel(input);
        state.voice.currentRms = rms;
        const int16 = downsampleFloat32ToInt16(input, ctx.sampleRate || 48000, 16000);
        const evt = detector.pushSamples(int16, rms);
        if (evt.type === "speech_start") {
          state.voice.isRecording = true;
          renderVoiceCallUi();
        } else if (evt.type === "utterance") {
          state.voice.isRecording = false;
          state.voice.currentRms = 0;
          const wavBytes = encodePcm16SamplesToWav(evt.samples, 16000);
          void sendVoiceTurnToMac({ wavUint8Array: wavBytes });
        } else if (evt.type === "discarded_short" || evt.type === "discarded_noise") {
          state.voice.isRecording = false;
          state.voice.currentRms = 0;
          renderVoiceCallUi();
        }
      } catch {
        state.voice.currentRms = 0;
        state.voice.isRecording = false;
        detector.reset();
      }
    };

    const filterNodes = [];
    if (typeof ctx.createBiquadFilter === "function") {
      const sr = Number(ctx.sampleRate) || 48000;
      const nyquist = sr * 0.5;
      const highpass = ctx.createBiquadFilter();
      highpass.type = "highpass";
      highpass.frequency.value = Math.min(100, Math.max(40, nyquist * 0.08));
      highpass.Q.value = 0.707;
      const lowpass = ctx.createBiquadFilter();
      lowpass.type = "lowpass";
      lowpass.frequency.value = Math.min(3800, Math.max(1200, Math.floor(nyquist * 0.82)));
      lowpass.Q.value = 0.707;
      source.connect(highpass);
      highpass.connect(lowpass);
      lowpass.connect(processor);
      filterNodes.push(highpass, lowpass);
    } else {
      source.connect(processor);
    }
    processor.connect(silentGain);
    silentGain.connect(ctx.destination);

    const primaryTrack = stream.getAudioTracks?.()?.[0];
    if (primaryTrack) {
      primaryTrack.onended = () => {
        if (state.voice.callActive && !state.voice.isMuted && !state.voice.micRecovering) {
          state.voice.micRecovering = true;
          setTimeout(() => {
            state.voice.micRecovering = false;
            if (state.voice.callActive && !state.voice.isMuted) {
              void startVoiceCallMicPipeline();
            }
          }, 200);
        }
      };
    }

    state.voice.lastAudioFrameAt = Date.now();
    state.voice.micWatchdogTimer = setInterval(() => {
      if (!state.voice.callActive || state.voice.isMuted || state.voice.asrAvailable === false) return;
      const activeCtx = state.voice.audioCtx;
      if (activeCtx && (activeCtx.state === "suspended" || activeCtx.state === "interrupted")) {
        void activeCtx.resume().catch(() => {});
      }
      if (state.voice.isSpeaking || state.voice.micRecovering) return;
      const idleMs = state.voice.lastAudioFrameAt > 0 ? Date.now() - state.voice.lastAudioFrameAt : 0;
      const trackDead = stream.getAudioTracks?.().some((t) => t.readyState === "ended");
      if (trackDead || idleMs > 1600) {
        if (state.voice.isRecording) {
          const flushed = state.voice.vadDetector?.flush?.();
          state.voice.isRecording = false;
          state.voice.currentRms = 0;
          if (flushed?.type === "utterance" && flushed.samples?.length) {
            const wavBytes = encodePcm16SamplesToWav(flushed.samples, 16000);
            void sendVoiceTurnToMac({ wavUint8Array: wavBytes });
          } else {
            renderVoiceCallUi();
          }
        }
        state.voice.micRecovering = true;
        Promise.resolve(activeCtx?.state !== "running" ? activeCtx?.resume?.().catch(() => {}) : null)
          .finally(() => {
            setTimeout(() => {
              const recovered = Date.now() - state.voice.lastAudioFrameAt < 600 && !trackDead;
              state.voice.micRecovering = false;
              if (!recovered && state.voice.callActive && !state.voice.isMuted) {
                void startVoiceCallMicPipeline();
              }
            }, 350);
          });
      }
    }, 1000);

    state.voice.micStream = stream;
    state.voice.micSource = source;
    state.voice.filterNodes = filterNodes;
    state.voice.processorNode = processor;
    state.voice.silentGainNode = silentGain;
    state.voice.vadDetector = detector;
    state.voice.isMuted = false;
    renderVoiceCallUi();
  } catch (error) {
    state.voice.isMuted = true;
    renderVoiceCallUi();
    $("voiceStateText").textContent = `麦克风未授权（${error?.message || "请检查权限"}），可用文字打字控制`;
  }
}

async function requestVoiceWakeLock() {
  try {
    if ("wakeLock" in navigator && !state.voice.wakeLock) {
      state.voice.wakeLock = await navigator.wakeLock.request("screen");
      state.voice.wakeLock.addEventListener?.("release", () => {
        state.voice.wakeLock = null;
        renderVoiceCallUi();
      });
    }
  } catch {
    state.voice.wakeLock = null;
  }
  renderVoiceCallUi();
}

async function releaseVoiceWakeLock() {
  try {
    await state.voice.wakeLock?.release?.();
  } catch {}
  state.voice.wakeLock = null;
}

async function reportVoicePlaybackAck({
  callId = "",
  utteranceId = "",
  status = "",
  heard = false,
  playedMs = 0,
  expectedMs = 0,
  reason = "",
  provider = "",
  text = "",
} = {}) {
  const effectiveCallId = callId || state.voice.callId;
  if (!effectiveCallId || !utteranceId || state.voice.backendMissing) return null;
  try {
    return await apiPostWithHotFallback("api/voice/call/ack", {
      callId: effectiveCallId,
      utteranceId,
      status,
      heard: Boolean(heard),
      playedMs: Math.max(0, Math.round(Number(playedMs) || 0)),
      expectedMs: Math.max(0, Math.round(Number(expectedMs) || 0)),
      reason: String(reason || ""),
      provider: String(provider || ""),
      spokenText: String(text || ""),
      text: String(text || ""),
    });
  } catch {
    return null;
  }
}

function playFallbackAlertChime() {
  try {
    const ctx = state.voice.audioCtx;
    if (!ctx || ctx.state !== "running") return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(587.33, now);
    osc.frequency.setValueAtTime(880, now + 0.08);
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.04, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.21);
  } catch {}
}

function markUtteranceUnheard({
  id = "",
  text = "",
  actionTag = "",
  reason = "playback_failed",
  status = "unheard",
  priority = "normal",
  expectedMs = 0,
  ttsCache = null,
} = {}) {
  const cleanText = stripMarkdownForSpeech(text, 360);
  if (!id || !cleanText) return;
  const effStatus = status === "interrupted" ? "interrupted" : "unheard";
  updateVoiceTranscriptEntry(id, {
    deliveryStatus: effStatus,
    heard: false,
    deliveryReason: reason,
    ...(ttsCache ? { ttsCache } : {}),
  });
  if (reason === "hangup" || reason === "superseded") return;

  const entry = {
    id,
    text: cleanText,
    actionTag,
    reason,
    priority: priority === "critical" ? "critical" : "normal",
    expectedMs: Number(expectedMs) || estimateVoiceDurationMs(cleanText),
    ttsCache,
    at: Date.now(),
  };
  const existingIdx = state.voice.unheardQueue.findIndex((item) => item.id === id);
  if (existingIdx >= 0) {
    state.voice.unheardQueue[existingIdx] = { ...state.voice.unheardQueue[existingIdx], ...entry };
  } else {
    state.voice.unheardQueue.push(entry);
    if (state.voice.unheardQueue.length > 8) {
      state.voice.unheardQueue = state.voice.unheardQueue.slice(-8);
    }
  }
  renderVoiceCallUi();

  if (reason !== "user_barge_in") {
    try { navigator.vibrate?.([80, 45, 80]); } catch {}
    playFallbackAlertChime();
    if (state.voice.minimized || !$("voiceCopilotModal")?.open || reason === "autoplay_blocked") {
      showToastBanner("语音未出声（点击顶部“通话”重播）", {
        detail: `${humanizeVoiceDeliveryReason(reason)}：${stripMarkdownForSpeech(cleanText, 72)}`,
        error: reason === "speech_unavailable",
      });
    }
  }
}

function markUtteranceHeard(id, { status = "played" } = {}) {
  if (!id) return;
  state.voice.unheardQueue = state.voice.unheardQueue.filter((item) => item.id !== id);
  updateVoiceTranscriptEntry(id, {
    deliveryStatus: status === "interrupted" ? "interrupted" : "played",
    heard: true,
    deliveryReason: "",
  });
  renderVoiceCallUi();
}

function clearUnheardVoiceQueue() {
  if (!state.voice.unheardQueue.length) return;
  state.voice.unheardQueue = [];
  renderVoiceCallUi();
}

async function fetchVoiceTtsAudio({ text = "", utteranceId = "", preferOffline = false, register = false } = {}) {
  const clean = stripMarkdownForSpeech(text, 360);
  if (!clean || state.voice.backendMissing) return null;
  try {
    const res = await apiPostWithHotFallback("api/voice/tts", {
      text: clean,
      callId: state.voice.callId,
      utteranceId,
      preferOffline: Boolean(preferOffline),
      register: Boolean(register),
    });
    return normalizeVoiceTtsPayload({
      ...res,
      utteranceId: res?.utteranceId || utteranceId,
      text: res?.text || clean,
    });
  } catch {
    return null;
  }
}

async function playAudioBufferViaWebAudio(tts, text, expectedMs = 0, playbackToken = state.voice.playbackToken) {
  const effExpected = Math.max(Number(expectedMs) || 0, estimateVoiceDurationMs(text));
  const ctx = state.voice.audioCtx;
  if (!ctx || ctx.state === "closed" || typeof ctx.decodeAudioData !== "function") {
    return null;
  }

  let audioBuffer = null;
  try {
    if (ctx.state === "suspended") {
      await ctx.resume().catch(() => {});
    }
    if (ctx.state !== "running" || playbackToken !== state.voice.playbackToken) {
      return null;
    }
    const bytes = base64ToUint8Array(tts.audioBase64);
    const rawCopy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    audioBuffer = await ctx.decodeAudioData(rawCopy);
  } catch {
    return null;
  }

  if (!audioBuffer || !(audioBuffer.duration > 0)) {
    return null;
  }
  if (!state.voice.callActive || !state.voice.isSpeaking || playbackToken !== state.voice.playbackToken) {
    return {
      engine: tts.provider || "edge-tts",
      outcome: "interrupted",
      reason: playbackToken !== state.voice.playbackToken ? "superseded" : (state.voice.callActive ? "user_barge_in" : "hangup"),
      started: false,
      playedMs: 0,
      expectedMs: effExpected,
      muted: false,
      volume: 1,
    };
  }

  return new Promise((resolve) => {
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.playbackRate.value = 1;
    source.connect(ctx.destination);
    state.voice.activeBufferSource = source;

    let settled = false;
    let started = false;
    let startedAt = 0;
    let endTimer = null;
    let abortHandler = null;
    const bufferDurationMs = Math.round(audioBuffer.duration * 1000);
    const maxExpectedMs = Math.max(effExpected, bufferDurationMs);

    const finish = ({ outcome = "ended", reason = "" } = {}) => {
      if (settled) return;
      settled = true;
      if (endTimer) clearTimeout(endTimer);
      source.onended = null;
      if (state.voice.activeBufferSource === source) {
        state.voice.activeBufferSource = null;
      }
      try { source.disconnect(); } catch {}
      if (state.voice.activePlaybackAbort === abortHandler) {
        state.voice.activePlaybackAbort = null;
      }
      state.voice.isSpeaking = false;
      const wallPlayed = started && startedAt > 0 ? Math.max(0, Date.now() - startedAt) : 0;
      const playedMs = outcome === "ended"
        ? Math.max(bufferDurationMs, wallPlayed)
        : wallPlayed;
      resolve({
        engine: tts.provider || "edge-tts",
        outcome,
        reason,
        started,
        playedMs,
        expectedMs: maxExpectedMs,
        muted: false,
        volume: 1,
      });
    };

    abortHandler = (abortReason = "superseded") => {
      try { source.stop(); } catch {}
      finish({ outcome: "interrupted", reason: abortReason });
    };
    state.voice.activePlaybackAbort = abortHandler;

    source.onended = () => finish({ outcome: "ended", reason: "" });
    endTimer = setTimeout(() => {
      if (!settled) {
        try { source.stop(); } catch {}
        finish({ outcome: "error", reason: "speech_timeout" });
      }
    }, Math.max(8000, maxExpectedMs + 8000));

    try {
      started = true;
      startedAt = Date.now();
      source.start(0);
    } catch {
      started = false;
      finish({ outcome: "error", reason: "playback_failed" });
    }
  });
}

function playAudioBufferViaElement(tts, text, expectedMs = 0, playbackToken = state.voice.playbackToken) {
  return new Promise((resolve) => {
    const effExpected = Math.max(Number(expectedMs) || 0, estimateVoiceDurationMs(text));
    if (!state.voice.callActive || playbackToken !== state.voice.playbackToken) {
      resolve({
        engine: tts.provider || "audio",
        outcome: "interrupted",
        reason: "superseded",
        started: false,
        playedMs: 0,
        expectedMs: effExpected,
        muted: false,
        volume: 1,
      });
      return;
    }
    let url = "";
    try {
      const bytes = base64ToUint8Array(tts.audioBase64);
      const blob = new Blob([bytes], { type: tts.mimeType || "audio/mpeg" });
      url = URL.createObjectURL(blob);
    } catch {
      resolve({
        engine: tts.provider || "audio",
        outcome: "error",
        reason: "playback_failed",
        started: false,
        playedMs: 0,
        expectedMs: effExpected,
        muted: false,
        volume: 1,
      });
      return;
    }

    state.voice.audioObjectUrl = url;
    const audio = state.voice.audioEl || new Audio();
    audio.playsInline = true;
    audio.playbackRate = 1;
    audio.defaultPlaybackRate = 1;
    state.voice.audioEl = audio;

    let settled = false;
    let started = false;
    let startedAt = 0;
    let maxCurrentTimeMs = 0;
    let startTimer = null;
    let endTimer = null;
    let abortHandler = null;

    const finish = ({ outcome = "ended", reason = "" } = {}) => {
      if (settled) return;
      settled = true;
      if (startTimer) clearTimeout(startTimer);
      if (endTimer) clearTimeout(endTimer);
      audio.onplaying = null;
      audio.ontimeupdate = null;
      audio.onended = null;
      audio.onerror = null;
      audio.onstalled = null;
      if (state.voice.activePlaybackAbort === abortHandler) {
        state.voice.activePlaybackAbort = null;
      }
      if (state.voice.audioObjectUrl === url) {
        try { URL.revokeObjectURL(url); } catch {}
        state.voice.audioObjectUrl = "";
      }
      state.voice.isSpeaking = false;
      const wallPlayed = started && startedAt > 0 ? Math.max(0, Date.now() - startedAt) : 0;
      const playedMs = Math.max(maxCurrentTimeMs, wallPlayed);
      resolve({
        engine: tts.provider || "edge-tts",
        outcome,
        reason,
        started,
        playedMs,
        expectedMs: effExpected,
        muted: Boolean(audio.muted),
        volume: Number.isFinite(audio.volume) ? audio.volume : 1,
      });
    };

    const markPlaying = () => {
      if (!started) {
        started = true;
        startedAt = Date.now();
      }
      if (startTimer) {
        clearTimeout(startTimer);
        startTimer = null;
      }
    };

    abortHandler = (abortReason = "superseded") => {
      try { audio.pause(); } catch {}
      finish({ outcome: "interrupted", reason: abortReason });
    };
    state.voice.activePlaybackAbort = abortHandler;

    audio.onplaying = markPlaying;
    audio.ontimeupdate = () => {
      const curMs = Math.round((Number(audio.currentTime) || 0) * 1000);
      if (curMs > maxCurrentTimeMs) maxCurrentTimeMs = curMs;
      if (curMs > 20) markPlaying();
    };
    audio.onended = () => {
      const curMs = Math.round((Number(audio.currentTime) || 0) * 1000);
      if (curMs > maxCurrentTimeMs) maxCurrentTimeMs = curMs;
      finish({ outcome: "ended", reason: "" });
    };
    audio.onerror = () => finish({ outcome: "error", reason: "playback_failed" });

    startTimer = setTimeout(() => {
      if (!started && !settled) {
        try { audio.pause(); } catch {}
        finish({ outcome: "error", reason: "stalled" });
      }
    }, 3000);

    endTimer = setTimeout(() => {
      if (!settled) {
        try { audio.pause(); } catch {}
        finish({ outcome: "error", reason: "speech_timeout" });
      }
    }, Math.max(8000, effExpected + 8000));

    audio.src = url;
    audio.play().catch((err) => {
      const msg = `${err?.name || ""} ${err?.message || ""}`;
      const isAutoplay = /NotAllowedError|autoplay|gesture|interact/i.test(msg);
      finish({ outcome: "error", reason: isAutoplay ? "autoplay_blocked" : "playback_failed" });
    });
  });
}

async function playVoiceTtsResult({
  utteranceId = "",
  spokenReply = "",
  tts = null,
  actionTag = "",
  priority = "normal",
  allowOfflineRetry = true,
  resumeAfter = true,
} = {}) {
  const clean = stripMarkdownForSpeech(spokenReply, 360);
  if (!clean) {
    if (resumeAfter && state.voice.callActive) scheduleVoiceListenResume();
    return { status: "played", heard: true, reason: "", playedMs: 0, expectedMs: 0, skipped: true };
  }

  if (state.voice.activePlaybackAbort || state.voice.activeBufferSource) {
    stopVoicePlayback({ scheduleResume: false, abortReason: "superseded" });
  }
  const myToken = (state.voice.playbackToken || 0) + 1;
  state.voice.playbackToken = myToken;
  const norm = normalizeVoiceTtsPayload(tts ? { ...tts, utteranceId: utteranceId || tts.utteranceId, text: tts.text || clean } : { utteranceId, text: clean });
  const effUtteranceId = utteranceId || norm.utteranceId || nextVoiceUtteranceId();

  updateVoiceTranscriptEntry(effUtteranceId, { deliveryStatus: "playing", deliveryReason: "" });
  state.voice.isSpeaking = true;
  state.voice.vadDetector?.reset?.();
  renderVoiceCallUi();

  let primaryEval = null;
  let lastProvider = norm.provider || "none";

  if (norm.hasAudio) {
    const rawAudio = (await playAudioBufferViaWebAudio(norm, clean, norm.expectedMs, myToken))
      || (await playAudioBufferViaElement(norm, clean, norm.expectedMs, myToken));
    if (myToken !== state.voice.playbackToken) {
      return { status: "interrupted", heard: false, reason: "superseded", playedMs: 0, expectedMs: norm.expectedMs, utteranceId: effUtteranceId };
    }
    primaryEval = evaluateVoicePlaybackOutcome({ ...rawAudio, text: clean, expectedMs: norm.expectedMs, priority });
    lastProvider = norm.provider || "edge-tts";
    if (primaryEval.heard) {
      markUtteranceHeard(effUtteranceId, { status: primaryEval.status });
      void reportVoicePlaybackAck({ utteranceId: effUtteranceId, ...primaryEval, provider: lastProvider, text: clean });
      if (resumeAfter && state.voice.callActive) scheduleVoiceListenResume();
      else renderVoiceCallUi();
      return { ...primaryEval, utteranceId: effUtteranceId };
    }
    if (rawAudio.outcome === "interrupted") {
      if (primaryEval.reason !== "hangup" && primaryEval.reason !== "superseded") {
        markUtteranceUnheard({ id: effUtteranceId, text: clean, actionTag, reason: primaryEval.reason, status: "interrupted", priority, expectedMs: norm.expectedMs, ttsCache: norm });
      }
      void reportVoicePlaybackAck({ utteranceId: effUtteranceId, ...primaryEval, provider: lastProvider, text: clean });
      if (resumeAfter && state.voice.callActive) scheduleVoiceListenResume();
      else renderVoiceCallUi();
      return { ...primaryEval, utteranceId: effUtteranceId };
    }
  }

  const primaryReason = primaryEval?.reason || "";
  if (
    allowOfflineRetry
    && !state.voice.backendMissing
    && state.voice.callActive
    && myToken === state.voice.playbackToken
    && norm.provider !== "macos-say"
    && primaryReason !== "autoplay_blocked"
    && primaryReason !== "muted_output"
  ) {
    const offlineTts = await fetchVoiceTtsAudio({ text: clean, utteranceId: effUtteranceId, preferOffline: true, register: false });
    if (myToken !== state.voice.playbackToken || !state.voice.callActive) {
      return { status: "interrupted", heard: false, reason: "superseded", playedMs: 0, expectedMs: norm.expectedMs, utteranceId: effUtteranceId };
    }
    if (offlineTts?.hasAudio) {
      if (!norm.hasAudio) updateVoiceTranscriptEntry(effUtteranceId, { ttsCache: offlineTts });
      lastProvider = offlineTts.provider || "macos-say";
      const rawOffline = (await playAudioBufferViaWebAudio(offlineTts, clean, offlineTts.expectedMs || norm.expectedMs, myToken))
        || (await playAudioBufferViaElement(offlineTts, clean, offlineTts.expectedMs || norm.expectedMs, myToken));
      if (myToken !== state.voice.playbackToken) {
        return { status: "interrupted", heard: false, reason: "superseded", playedMs: 0, expectedMs: norm.expectedMs, utteranceId: effUtteranceId };
      }
      const offEval = evaluateVoicePlaybackOutcome({ ...rawOffline, text: clean, expectedMs: offlineTts.expectedMs || norm.expectedMs, priority });
      if (offEval.heard) {
        markUtteranceHeard(effUtteranceId, { status: offEval.status });
        void reportVoicePlaybackAck({ utteranceId: effUtteranceId, ...offEval, provider: lastProvider, text: clean });
        if (resumeAfter && state.voice.callActive) scheduleVoiceListenResume();
        else renderVoiceCallUi();
        return { ...offEval, utteranceId: effUtteranceId };
      }
      if (rawOffline.outcome === "interrupted") {
        if (offEval.reason !== "hangup" && offEval.reason !== "superseded") {
          markUtteranceUnheard({ id: effUtteranceId, text: clean, actionTag, reason: offEval.reason, status: "interrupted", priority, expectedMs: norm.expectedMs, ttsCache: offlineTts });
        }
        void reportVoicePlaybackAck({ utteranceId: effUtteranceId, ...offEval, provider: lastProvider, text: clean });
        if (resumeAfter && state.voice.callActive) scheduleVoiceListenResume();
        else renderVoiceCallUi();
        return { ...offEval, utteranceId: effUtteranceId };
      }
    }
  }

  state.voice.isSpeaking = false;
  const preservedReason = (primaryReason === "autoplay_blocked" || primaryReason === "muted_output" || primaryReason === "fake_short_end")
    ? primaryReason
    : (primaryReason || "speech_unavailable");
  const finalPlayedMs = primaryEval?.playedMs || 0;
  markUtteranceUnheard({
    id: effUtteranceId,
    text: clean,
    actionTag,
    reason: preservedReason,
    status: "unheard",
    priority,
    expectedMs: norm.expectedMs,
    ttsCache: norm.hasAudio ? norm : null,
  });
  void reportVoicePlaybackAck({
    utteranceId: effUtteranceId,
    status: "unheard",
    heard: false,
    playedMs: finalPlayedMs,
    expectedMs: norm.expectedMs,
    reason: preservedReason,
    provider: lastProvider,
    text: clean,
  });
  if (resumeAfter && state.voice.callActive) scheduleVoiceListenResume();
  else renderVoiceCallUi();
  return {
    status: "unheard",
    heard: false,
    reason: preservedReason,
    playedMs: finalPlayedMs,
    expectedMs: norm.expectedMs,
    utteranceId: effUtteranceId,
  };
}

async function replayVoiceTranscriptEntryById(entryId, { resumeAfter = true } = {}) {
  const transcriptItem = state.voice.transcript.find((item) => item.id === entryId);
  const unheardItem = state.voice.unheardQueue.find((item) => item.id === entryId);
  const text = stripMarkdownForSpeech(transcriptItem?.spokenReply || unheardItem?.text || "", 360);
  if (!text) return { status: "unheard", heard: false, reason: "empty" };
  let tts = transcriptItem?.ttsCache || unheardItem?.ttsCache || null;
  if (!tts?.hasAudio && !state.voice.backendMissing) {
    tts = await fetchVoiceTtsAudio({ text, utteranceId: entryId, register: false });
    if (tts) updateVoiceTranscriptEntry(entryId, { ttsCache: tts });
  }
  return playVoiceTtsResult({
    utteranceId: entryId,
    spokenReply: text,
    tts,
    actionTag: transcriptItem?.actionTag || unheardItem?.actionTag || "",
    priority: transcriptItem?.priority || unheardItem?.priority || "normal",
    resumeAfter,
  });
}

async function replayUnheardVoiceItems({ onlyBlocked = false } = {}) {
  if (!state.voice.unheardQueue.length || !state.voice.callActive) return;
  if (state.voice.isProcessing || state.voice.isRecording) return;
  const candidates = state.voice.unheardQueue.filter((item) => !onlyBlocked || item.reason === "autoplay_blocked" || item.reason === "muted_output" || item.reason === "fake_short_end");
  if (!candidates.length) return;
  for (let i = 0; i < candidates.length; i += 1) {
    if (!state.voice.callActive || state.voice.isProcessing || state.voice.isRecording) break;
    const res = await replayVoiceTranscriptEntryById(candidates[i].id, { resumeAfter: i === candidates.length - 1 });
    if (!res?.heard || res?.reason === "user_barge_in" || res?.reason === "hangup") {
      break;
    }
  }
}

async function announceVoiceNoticeViaMac(text, meta = {}) {
  const clean = stripMarkdownForSpeech(text, 240);
  if (!clean || !state.voice.callActive) return null;
  const utteranceId = String(meta?.id || "").trim() || nextVoiceUtteranceId("notice");
  const actionTag = String(meta?.actionTag || "实时提醒").trim() || "实时提醒";
  const priority = meta?.priority === "critical" ? "critical" : "normal";
  appendVoiceTranscriptEntry({
    id: utteranceId,
    heardText: "",
    spokenReply: clean,
    actionTag,
    priority,
    deliveryStatus: "queued",
  });
  const tts = await fetchVoiceTtsAudio({ text: clean, utteranceId, register: meta?.register !== false });
  if (tts) updateVoiceTranscriptEntry(utteranceId, { ttsCache: tts });
  return playVoiceTtsResult({
    utteranceId,
    spokenReply: tts?.text || clean,
    tts,
    actionTag,
    priority,
    resumeAfter: meta?.resumeAfter !== false,
  });
}

async function drainVoiceBroadcastQueue() {
  if (state.voice.broadcastDraining) return;
  state.voice.broadcastDraining = true;
  try {
    while (
      state.voice.callActive
      && state.voice.broadcastQueue.length > 0
      && !state.voice.isProcessing
      && !state.voice.isRecording
      && !state.voice.isSpeaking
    ) {
      const nextItem = state.voice.broadcastQueue.shift();
      if (!nextItem) continue;
      const playRes = await announceVoiceNoticeViaMac(nextItem.text, {
        ...nextItem,
        register: true,
        resumeAfter: state.voice.broadcastQueue.length === 0,
      });
      if (playRes?.reason === "user_barge_in" || playRes?.reason === "hangup" || !state.voice.callActive) {
        break;
      }
    }
  } finally {
    state.voice.broadcastDraining = false;
  }
}

function enqueueOrPlayVoiceBroadcast(item = {}) {
  if (!state.voice.callActive || !state.voice.config.autoBroadcastEvents) return;
  state.voice.broadcastQueue = enqueueVoiceBroadcastItem(state.voice.broadcastQueue, item, 8);
  if (!state.voice.isProcessing && !state.voice.isRecording && !state.voice.isSpeaking && !state.voice.broadcastDraining) {
    void drainVoiceBroadcastQueue();
  }
}

function clearApprovalVoiceReminder(reqId = "") {
  if (reqId) {
    const timer = state.voice.approvalReminderTimers.get(reqId);
    if (timer) {
      clearTimeout(timer);
      state.voice.approvalReminderTimers.delete(reqId);
    }
    state.voice.remindedRequestIds.delete(reqId);
    return;
  }
  for (const timer of state.voice.approvalReminderTimers.values()) {
    clearTimeout(timer);
  }
  state.voice.approvalReminderTimers.clear();
}

function scheduleApprovalVoiceReminder(request, projLabel = "有任务") {
  const reqId = String(request?.id || "").trim();
  if (!reqId || state.voice.remindedRequestIds.has(reqId)) return;
  const prevTimer = state.voice.approvalReminderTimers.get(reqId);
  if (prevTimer) clearTimeout(prevTimer);
  const timer = setTimeout(() => {
    state.voice.approvalReminderTimers.delete(reqId);
    if (!state.voice.callActive || !state.voice.config.autoBroadcastEvents) return;
    if (state.voice.remindedRequestIds.has(reqId)) return;
    if (!state.pendingRequests.some((r) => r.id === reqId)) return;
    if (Date.now() - state.voice.lastUserActivityAt < 18_000) return;
    state.voice.remindedRequestIds.add(reqId);
    const detail = stripMarkdownForSpeech(request.title || request.command || "请确认", 60);
    enqueueOrPlayVoiceBroadcast({
      text: `${projLabel} 仍在等待你的确认：${detail}。你可以直接说批准或拒绝。`,
      priority: "critical",
      source: "approval_reminder",
      actionTag: "审批提醒",
      dedupeKey: `req-remind:${reqId}`,
    });
  }, 22_000);
  state.voice.approvalReminderTimers.set(reqId, timer);
}

function clearVoiceProcessingStageTimer() {
  if (state.voice.processingStageTimer) {
    clearTimeout(state.voice.processingStageTimer);
    state.voice.processingStageTimer = null;
  }
  state.voice.processingPhaseText = "";
}

function clearVoiceBatchAndHeartbeatTimers() {
  clearVoiceProcessingStageTimer();
  for (const item of state.voice.pendingBatches.values()) {
    for (const timer of item?.timers || []) clearTimeout(timer);
  }
  state.voice.pendingBatches.clear();
  state.voice.watchedThreads.clear();
  state.voice.settledBatchIds?.clear?.();
  if (state.voice.progressHeartbeatTimer) {
    clearInterval(state.voice.progressHeartbeatTimer);
    state.voice.progressHeartbeatTimer = null;
  }
}

function unwatchVoiceThread(threadId) {
  if (!threadId) return;
  state.voice.watchedThreads.delete(threadId);
  if (state.voice.watchedThreads.size === 0 && state.voice.progressHeartbeatTimer) {
    clearInterval(state.voice.progressHeartbeatTimer);
    state.voice.progressHeartbeatTimer = null;
  }
}

function watchVoiceDispatchedThread(threadId, projectName = "") {
  if (!threadId || !state.voice.callActive) return;
  if (state.voice.progressHeartbeatTimer) {
    clearInterval(state.voice.progressHeartbeatTimer);
    state.voice.progressHeartbeatTimer = null;
  }
}

function handleVoiceDispatchBatchUpdate(batch) {
  if (!batch?.batchId || batch.status === "dispatching") return;
  const settled = (state.voice.settledBatchIds ||= new Set());
  if (settled.has(batch.batchId)) return;
  settled.add(batch.batchId);
  if (settled.size > 60) {
    const oldest = settled.values().next().value;
    if (oldest) settled.delete(oldest);
  }
  const pending = state.voice.pendingBatches.get(batch.batchId);
  if (pending) {
    for (const timer of pending.timers || []) clearTimeout(timer);
    state.voice.pendingBatches.delete(batch.batchId);
  }
  if (batch.utteranceId && batch.summaryTag) {
    updateVoiceTranscriptEntry(batch.utteranceId, { actionTag: batch.summaryTag });
  }
  if (batch.model) {
    state.voice.modelName = batch.model;
  }
  if (batch.focusThreadId && batch.status !== "failed" && batch.executionTier !== "subagent_hydrogen") {
    void applyVoiceExecutionEffect({
      ok: true,
      action: batch.action,
      focusThreadId: batch.focusThreadId,
      focusProjectCwd: batch.focusProjectCwd,
      summaryTag: batch.summaryTag,
    });
  }
  if (batch.shouldSpeak && batch.spokenFeedback && state.voice.callActive && state.voice.config.autoBroadcastEvents) {
    enqueueOrPlayVoiceBroadcast({
      text: batch.spokenFeedback,
      priority: batch.priority || (batch.status === "failed" ? "critical" : "normal"),
      source: "voice_dispatch",
      actionTag: batch.summaryTag || "派发结果",
      dedupeKey: `dispatch:${batch.batchId}`,
    });
  }
  renderVoiceCallUi();
}

function trackVoicePendingDispatchBatch({
  batchId = "",
  utteranceId = "",
  action = "",
  focusThreadId = "",
  projectCwd = "",
} = {}) {
  if (!batchId || !state.voice.callActive) return;
  if (state.voice.settledBatchIds?.has(batchId)) return;
  const entry = {
    batchId,
    utteranceId,
    action,
    focusThreadId,
    projectCwd,
    timers: [],
  };
  state.voice.pendingBatches.set(batchId, entry);
  for (const delayMs of [900, 2600]) {
    const timer = setTimeout(() => {
      if (!state.voice.callActive || !state.voice.pendingBatches.has(batchId)) return;
      const qs = state.voice.callId ? `?callId=${encodeURIComponent(state.voice.callId)}` : "";
      void apiGetWithHotFallback(`api/voice/call/status${qs}`)
        .then((status) => {
          const list = Array.isArray(status?.dispatchBatches) ? status.dispatchBatches : [];
          const matched = list.find((item) => item?.batchId === batchId && item.status !== "dispatching");
          if (matched) handleVoiceDispatchBatchUpdate(matched);
        })
        .catch(() => {});
    }, delayMs);
    entry.timers.push(timer);
  }
}

async function applyVoiceExecutionEffect(executed = {}) {
  if (!executed || !executed.ok) return;
  if (!executed.pending && executed.action === "open_project" && executed.focusProjectCwd && !executed.focusThreadId) {
    state.searchText = projectBaseName(executed.focusProjectCwd);
    openProjectBoardView();
    minimizeVoiceModal();
    renderVoiceLiveProgressIfOpen();
    return;
  }
  await refreshThreads().catch(() => null);
  if (executed.focusThreadId && executed.focusThreadId !== state.activeThreadId) {
    await selectThread(executed.focusThreadId, { focusScroll: true }).catch(() => null);
  } else if (executed.focusThreadId && executed.focusThreadId === state.activeThreadId) {
    await selectThread(executed.focusThreadId, { focusScroll: false }).catch(() => null);
  }
  if (!executed.pending && (executed.action === "open_thread" || executed.action === "open_project") && executed.focusThreadId) {
    minimizeVoiceModal();
  }
  renderVoiceLiveProgressIfOpen();
}

async function sendVoiceTurnToMac({ wavUint8Array = null, transcriptText = "", mode = "turn" } = {}) {
  if (!state.voice.callActive) return;
  if (wavUint8Array?.length || String(transcriptText || "").trim() || mode === "briefing") {
    state.voice.pendingVoiceTurns.push({ wavUint8Array, transcriptText, mode });
    while (state.voice.pendingVoiceTurns.length > 2) {
      state.voice.pendingVoiceTurns.shift();
    }
  }
  if (state.voice.isProcessing || state.voice.isSpeaking || !state.voice.pendingVoiceTurns.length) return;
  ({ wavUint8Array, transcriptText, mode } = state.voice.pendingVoiceTurns.shift());
  if (mode === "briefing" || String(transcriptText || "").trim()) {
    state.voice.lastUserActivityAt = Date.now();
    clearApprovalVoiceReminder();
  }
  if (state.voice.backendMissing) {
    appendVoiceTranscriptEntry({
      id: nextVoiceUtteranceId("unavailable"),
      heardText: transcriptText,
      spokenReply: "语音理解服务暂不可用，未执行任何操作，请检查本机服务。",
      actionTag: "模型未处理",
    });
    return;
  }

  state.voice.isProcessing = true;
  state.voice.isRecording = false;
  clearVoiceProcessingStageTimer();
  state.voice.processingStageTimer = setTimeout(() => {
    state.voice.processingStageTimer = null;
    if (state.voice.callActive && state.voice.isProcessing) {
      state.voice.processingPhaseText = "正在加快识别与准备语音回复…";
      renderVoiceCallUi();
    }
  }, 1500);
  state.voice.vadDetector?.reset?.();
  renderVoiceCallUi();

  try {
    const audioBase64 = wavUint8Array?.length ? uint8ArrayToBase64(wavUint8Array) : "";
    const resolvedTid = String(state.voice.scopedThreadId || state.activeThreadId || "").trim();
    const resolvedScope = state.voice.callScope === "thread" && resolvedTid ? "thread" : "global";
    const res = await apiPostWithHotFallback("api/voice/call", {
      callId: state.voice.callId,
      callScope: resolvedScope,
      audioBase64,
      audioMimeType: audioBase64 ? "audio/wav" : "",
      transcriptText: String(transcriptText || "").trim(),
      activeThreadId: resolvedTid,
      ...voiceSelectionPayload(),
      mode,
      autoExecute: true,
      asyncDispatch: true,
      tts: true,
    });
    clearVoiceProcessingStageTimer();
    if (res?.asrEngine) state.voice.asrEngine = res.asrEngine;
    if (res?.noSpeech) {
      state.voice.isProcessing = false;
      if (res.ignoredText && typeof $ === "function" && $("voiceSubHintText")) {
        $("voiceSubHintText").textContent = "已自动过滤背景杂音，请直接说话";
      }
      renderVoiceCallUi();
      if (state.voice.pendingVoiceTurns.length > 0) {
        void sendVoiceTurnToMac();
      } else {
        scheduleVoiceListenResume();
      }
      return;
    }
    if (res?.executed?.model || res?.dispatchModel || res?.model) {
      state.voice.modelName = res?.executed?.model || res?.dispatchModel || res.model;
    }
    if (res?.executed?.provider) {
      state.voice.dispatchProvider = res.executed.provider;
    }
    state.voice.lastUserActivityAt = Date.now();
    clearApprovalVoiceReminder();
    const spokenReply = String(res?.spokenReply || "").trim();
    const utteranceId = String(res?.utteranceId || "").trim() || nextVoiceUtteranceId("turn");
    const actionTag = res?.executed?.summaryTag || "";
    const normTurnTts = normalizeVoiceTtsPayload(res);

    if (spokenReply && state.voice.callActive && !state.voice.isRecording) {
      state.voice.isSpeaking = true;
    }
    state.voice.isProcessing = false;

    if (Array.isArray(res?.replayedUnheardIds) && res.replayedUnheardIds.length) {
      for (const oldId of res.replayedUnheardIds) {
        state.voice.unheardQueue = state.voice.unheardQueue.filter((item) => item.id !== oldId);
      }
    }

    appendVoiceTranscriptEntry({
      id: utteranceId,
      heardText: res?.heardText || transcriptText || "",
      spokenReply,
      actionTag,
      deliveryStatus: spokenReply ? (state.voice.callActive ? "queued" : "unheard") : "",
      ttsCache: normTurnTts.hasAudio ? normTurnTts : null,
    });
    if (res?.dispatchPending && res?.batchId) {
      trackVoicePendingDispatchBatch({
        batchId: res.batchId,
        utteranceId,
        action: res?.executed?.action || res?.plan?.action || "",
        focusThreadId: res?.executed?.focusThreadId || "",
        projectCwd: res?.executed?.focusProjectCwd || "",
      });
    }
    if (res?.executed) {
      void applyVoiceExecutionEffect(res.executed);
    }
    renderVoiceCallUi();

    if (spokenReply && state.voice.callActive) {
      let ttsPayload = normTurnTts.hasAudio ? normTurnTts : null;
      if (!ttsPayload && state.voice.isSpeaking) {
        ttsPayload = await fetchVoiceTtsAudio({ text: spokenReply, utteranceId, register: false });
        if (ttsPayload) updateVoiceTranscriptEntry(utteranceId, { ttsCache: ttsPayload });
      }
      if (state.voice.callActive && state.voice.isSpeaking) {
        await playVoiceTtsResult({
          utteranceId,
          spokenReply,
          tts: ttsPayload,
          actionTag,
          priority: res?.executed?.action === "request_pending" ? "critical" : "normal",
        });
        if (state.voice.callActive && !state.voice.isRecording && !state.voice.isProcessing && state.voice.broadcastQueue.length > 0) {
          void drainVoiceBroadcastQueue();
        }
      } else if (state.voice.callActive) {
        state.voice.isSpeaking = false;
        markUtteranceUnheard({
          id: utteranceId,
          text: spokenReply,
          actionTag,
          reason: "user_barge_in",
          status: "interrupted",
          expectedMs: res?.expectedMs || estimateVoiceDurationMs(spokenReply),
          ttsCache: ttsPayload,
        });
        void reportVoicePlaybackAck({
          utteranceId,
          status: "interrupted",
          heard: false,
          playedMs: 0,
          expectedMs: res?.expectedMs || estimateVoiceDurationMs(spokenReply),
          reason: "user_barge_in",
          provider: ttsPayload?.provider || "none",
          text: spokenReply,
        });
        scheduleVoiceListenResume();
      }
    } else {
      state.voice.isSpeaking = false;
      scheduleVoiceListenResume();
    }
  } catch (error) {
    clearVoiceProcessingStageTimer();
    state.voice.isProcessing = false;
    const is404 = Number(error?.status) === 404;
    if (is404) {
      state.voice.backendMissing = true;
      $("voiceStateText").textContent = "本机守护进程尚未加载新通话接口，请重启服务后重试";
      $("voiceSubHintText").textContent = "更新后端服务后即可用多模态 Hydrogen 直接听音协调";
    } else {
      const msg = formatActionError(error, "语音协调失败");
      appendVoiceTranscriptEntry({ id: nextVoiceUtteranceId("err"), heardText: transcriptText || "", spokenReply: msg, actionTag: "出错", deliveryStatus: "unheard", deliveryReason: "playback_failed" });
      $("voiceStateText").textContent = `连接异常：${msg}`;
    }
    renderVoiceCallUi();
    scheduleVoiceListenResume();
  }
}

function triggerVoiceOrbAction() {
  ensureVoiceAudioUnlocked();
  if (!state.voice.callActive || state.voice.isProcessing) return;
  state.voice.lastUserActivityAt = Date.now();
  clearApprovalVoiceReminder();
  if (state.voice.isSpeaking) {
    stopVoicePlayback({ scheduleResume: false, abortReason: "user_barge_in" });
    state.voice.vadDetector?.reset?.();
    renderVoiceCallUi();
    return;
  }
  if (state.voice.isMuted) {
    state.voice.isMuted = false;
    if (!state.voice.micStream) {
      void startVoiceCallMicPipeline();
    } else {
      state.voice.vadDetector?.reset?.();
      renderVoiceCallUi();
    }
    return;
  }
  const flushed = state.voice.vadDetector?.flush?.();
  state.voice.isRecording = false;
  if (flushed?.type === "utterance" && flushed.samples?.length) {
    const wavBytes = encodePcm16SamplesToWav(flushed.samples, 16000);
    void sendVoiceTurnToMac({ wavUint8Array: wavBytes });
  } else {
    void sendVoiceTurnToMac({ mode: "briefing", transcriptText: "播报最新任务进度" });
  }
}

function minimizeVoiceModal() {
  const modal = $("voiceCopilotModal");
  if (!state.voice.callActive) {
    if (modal?.open) modal.close();
    return;
  }
  state.voice.minimized = true;
  if (modal?.open) modal.close();
  renderVoiceCallUi();
  showToastBanner("语音通话在后台继续", { detail: "点击顶部语音按钮可随时回到通话界面" });
}

function renderComposerDictationUi() {
  const btn = $("composerVoiceBtn");
  const iconEl = $("composerVoiceIcon");
  const labelEl = $("composerVoiceLabel");
  if (!btn) return;
  const { active, transcribing } = state.dictation;
  btn.classList.toggle("is-recording", active);
  btn.classList.toggle("is-transcribing", transcribing);
  btn.setAttribute("aria-pressed", active ? "true" : "false");
  btn.disabled = transcribing;
  if (iconEl) {
    iconEl.innerHTML = active
      ? iconSvg("stop", { size: 13 })
      : transcribing
        ? iconSvg("clock", { size: 13 })
        : iconSvg("mic", { size: 14 });
  }
  if (labelEl) {
    labelEl.textContent = active ? "停止" : transcribing ? "识别中" : "语音";
  }
}

function teardownComposerDictationAudio() {
  if (state.dictation.maxTimer) {
    clearTimeout(state.dictation.maxTimer);
    state.dictation.maxTimer = null;
  }
  try { state.dictation.processor?.disconnect?.(); } catch {}
  try { state.dictation.source?.disconnect?.(); } catch {}
  if (state.dictation.micStream) {
    for (const track of state.dictation.micStream.getTracks()) {
      try { track.stop(); } catch {}
    }
  }
  if (state.dictation.audioCtx) {
    try { void state.dictation.audioCtx.close?.(); } catch {}
  }
  state.dictation.processor = null;
  state.dictation.source = null;
  state.dictation.micStream = null;
  state.dictation.audioCtx = null;
}

async function stopComposerDictation({ submit = true } = {}) {
  if (!state.dictation.active) return;
  state.dictation.active = false;
  const chunks = state.dictation.chunks;
  state.dictation.chunks = [];
  teardownComposerDictationAudio();

  const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
  if (!submit || totalLen < 1600) {
    renderComposerDictationUi();
    if (submit && totalLen > 0) {
      setComposerStatus("error", "录音时间太短，请再说一次", { autoClearMs: 2200 });
    }
    return;
  }

  const merged = new Int16Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  state.dictation.transcribing = true;
  renderComposerDictationUi();
  setComposerStatus("pending", "正在本地语音识别…");

  try {
    const wavBytes = encodePcm16SamplesToWav(merged, 16000);
    const res = await apiPostWithHotFallback("api/voice/transcribe", {
      audioBase64: uint8ArrayToBase64(wavBytes),
      audioMimeType: "audio/wav",
    });
    const text = String(res?.text || "").trim();
    if (text) {
      const input = $("promptInput");
      if (input) {
        const cur = input.value;
        input.value = cur && !/\s$/.test(cur) ? `${cur} ${text}` : `${cur}${text}`;
        autoResizePromptInput();
        renderComposerControls();
        input.focus();
      }
      clearComposerStatus();
    } else {
      setComposerStatus("error", "未识别到清晰语音，请重试", { autoClearMs: 2400 });
    }
  } catch (error) {
    setComposerStatus("error", `语音转文字失败：${formatActionError(error)}`, { autoClearMs: 3600 });
  } finally {
    state.dictation.transcribing = false;
    renderComposerDictationUi();
  }
}

async function toggleComposerDictation() {
  if (state.dictation.transcribing) return;
  if (state.dictation.active) {
    await stopComposerDictation({ submit: true });
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    setComposerStatus("error", "当前浏览器不支持网页麦克风录音", { autoClearMs: 3000 });
    return;
  }
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) throw new Error("不支持 AudioContext");
    const ctx = new AudioCtx();
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(2048, 1, 1);
    const silentGain = ctx.createGain();
    silentGain.gain.value = 0;

    state.dictation.chunks = [];
    processor.onaudioprocess = (ev) => {
      if (!state.dictation.active) return;
      const input = ev.inputBuffer?.getChannelData?.(0);
      if (!input?.length) return;
      state.dictation.chunks.push(downsampleFloat32ToInt16(input, ctx.sampleRate || 48000, 16000));
    };

    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(ctx.destination);

    state.dictation.audioCtx = ctx;
    state.dictation.micStream = stream;
    state.dictation.source = source;
    state.dictation.processor = processor;
    state.dictation.active = true;
    state.dictation.maxTimer = setTimeout(() => {
      void stopComposerDictation({ submit: true });
    }, 30000);
    renderComposerDictationUi();
    setComposerStatus("pending", "正在录音… 再次点击麦克风结束并识别");
  } catch (error) {
    teardownComposerDictationAudio();
    state.dictation.active = false;
    renderComposerDictationUi();
    setComposerStatus("error", `麦克风启动失败：${error?.message || "请检查权限"}`, { autoClearMs: 3200 });
  }
}

async function openVoiceModal() {
  setTopbarMenuOpen(false);
  setComposerConfigOpen(false);
  ensureVoiceAudioUnlocked();

  if (state.voice.callActive) {
    state.voice.minimized = false;
    if (state.voice.callScope === "thread" && state.activeThreadId) {
      state.voice.scopedThreadId = state.activeThreadId;
    }
    renderVoiceTranscript();
    renderVoiceLiveProgress();
    renderVoiceCallUi();
    const modal = $("voiceCopilotModal");
    if (modal && !modal.open) modal.showModal();
    if (state.voice.unheardQueue.some((u) => u.reason === "autoplay_blocked" || u.reason === "muted_output" || u.reason === "fake_short_end")) {
      void replayUnheardVoiceItems({ onlyBlocked: true });
    }
    return;
  }

  state.voice.callId = `call-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  state.voice.callScope = state.activeThreadId ? "thread" : "global";
  state.voice.scopedThreadId = state.activeThreadId || "";
  state.voice.callActive = true;
  state.voice.minimized = false;
  state.voice.callStartedAt = Date.now();
  state.voice.lastUserActivityAt = Date.now();
  state.voice.backendMissing = false;
  state.voice.isProcessing = false;
  state.voice.isSpeaking = false;
  state.voice.isRecording = false;
  state.voice.pendingVoiceTurns = [];
  state.voice.broadcastQueue = [];
  state.voice.unheardQueue = [];
  state.voice.remindedRequestIds.clear();
  clearApprovalVoiceReminder();

  if (state.voice.callTimerId) clearInterval(state.voice.callTimerId);
  state.voice.callTimerId = setInterval(updateVoiceCallTimerLabel, 1000);
  updateVoiceCallTimerLabel();

  renderVoiceModelSelector();
  renderVoiceTranscript();
  renderVoiceLiveProgress();
  renderVoiceCallUi();

  const modal = $("voiceCopilotModal");
  if (modal && !modal.open) modal.showModal();

  void requestVoiceWakeLock();
  startVoiceLevelAnimation();

  const warmPromise = apiPostWithHotFallback("api/voice/call/start", {
    callId: state.voice.callId,
    callScope: effectiveVoiceScope(),
    activeThreadId: effectiveVoiceThreadId(),
    ...voiceSelectionPayload(),
  })
    .then((res) => {
      if (res?.dispatchModel || res?.model) {
        state.voice.modelName = res?.dispatchModel || res.model;
      }
      if (res?.dispatchProvider) {
        state.voice.dispatchProvider = res.dispatchProvider;
      }
      if (Array.isArray(res?.modelOptions)) {
        state.voice.modelOptions = res.modelOptions;
      }
      const prevAsrAvailable = state.voice.asrAvailable;
      state.voice.asrAvailable = res?.asrAvailable !== false;
      state.voice.asrEngine = res?.asrEngine || (state.voice.asrAvailable ? "mlx-whisper" : "browser");
      state.voice.backendMissing = false;
      renderVoiceModelSelector();
      renderVoiceCallUi();
      if (prevAsrAvailable && state.voice.asrAvailable === false && state.voice.callActive && !state.voice.speechRecognition) {
        void startVoiceCallMicPipeline();
      }
    })
    .catch((err) => {
      if (Number(err?.status) === 404 || Number(err?.status) === 502) {
        state.voice.backendMissing = true;
        $("voiceStateText").textContent = "本机语音服务尚未连上（/api/voice/call）";
        $("voiceSubHintText").textContent = "下方仍可实时查看任务动态，重启本地服务或热扩展后即可使用语音总控";
        renderVoiceCallUi();
      }
    });

  await Promise.allSettled([warmPromise, startVoiceCallMicPipeline()]);
}

function hangupVoiceCall({ closeModal = true } = {}) {
  const oldCallId = state.voice.callId;
  state.voice.callActive = false;
  state.voice.minimized = false;
  state.voice.callId = "";
  state.voice.pendingVoiceTurns = [];
  state.voice.broadcastQueue = [];
  state.voice.unheardQueue = [];
  state.voice.remindedRequestIds.clear();
  clearApprovalVoiceReminder();
  clearVoiceBatchAndHeartbeatTimers();
  if (state.voice.callTimerId) {
    clearInterval(state.voice.callTimerId);
    state.voice.callTimerId = null;
  }
  stopVoiceLevelAnimation();
  stopVoiceCallMicPipeline();
  stopVoicePlayback({ scheduleResume: false, abortReason: "hangup" });
  void releaseVoiceWakeLock();
  if (oldCallId && !state.voice.backendMissing) {
    void apiPostWithHotFallback("api/voice/call/end", { callId: oldCallId }).catch(() => {});
  }
  renderVoiceCallUi();
  if (closeModal && $("voiceCopilotModal")?.open) {
    $("voiceCopilotModal").close();
  }
}

function clampSidebarWidth(width, viewportWidth = window.innerWidth) {
  const numeric = Number(width);
  if (!Number.isFinite(numeric)) return DEFAULT_SIDEBAR_WIDTH;
  const viewportMax =
    Number.isFinite(viewportWidth) && viewportWidth > 0
      ? Math.max(MIN_SIDEBAR_WIDTH, Math.floor(viewportWidth * 0.48))
      : MAX_SIDEBAR_WIDTH;
  const maxAllowed = Math.min(MAX_SIDEBAR_WIDTH, viewportMax);
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(maxAllowed, Math.round(numeric)));
}

function loadSavedSidebarWidth() {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_PREF_KEY);
    if (!raw) return DEFAULT_SIDEBAR_WIDTH;
    return clampSidebarWidth(Number(raw));
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

function saveSidebarWidth(width) {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_PREF_KEY, String(clampSidebarWidth(width)));
  } catch {
    // Ignore storage write errors in restricted webviews.
  }
}

function applySidebarWidth(width, { persist = false } = {}) {
  const clamped = clampSidebarWidth(width);
  document.documentElement.style.setProperty("--sidebar-width", `${clamped}px`);
  const resizer = $("sidebarResizer");
  if (resizer) {
    resizer.setAttribute("aria-valuenow", String(clamped));
    resizer.setAttribute("aria-valuemin", String(MIN_SIDEBAR_WIDTH));
    resizer.setAttribute("aria-valuemax", String(clampSidebarWidth(MAX_SIDEBAR_WIDTH)));
  }
  if (persist) {
    saveSidebarWidth(clamped);
  }
  return clamped;
}

function bindSidebarResizer() {
  const resizer = $("sidebarResizer");
  const sidebar = $("sidebar");
  if (!resizer || !sidebar) return;

  applySidebarWidth(loadSavedSidebarWidth());

  let activePointerId = null;
  let startX = 0;
  let startWidth = DEFAULT_SIDEBAR_WIDTH;
  let currentWidth = loadSavedSidebarWidth();

  const finishDrag = ({ persist = true } = {}) => {
    if (activePointerId === null) return;
    activePointerId = null;
    resizer.classList.remove("is-resizing");
    document.body.classList.remove("is-resizing-sidebar");
    if (persist) {
      applySidebarWidth(currentWidth, { persist: true });
    }
  };

  resizer.addEventListener("pointerdown", (e) => {
    if (window.matchMedia?.("(max-width: 960px)")?.matches) return;
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.preventDefault();
    activePointerId = e.pointerId;
    startX = e.clientX;
    startWidth = sidebar.getBoundingClientRect().width || loadSavedSidebarWidth();
    currentWidth = clampSidebarWidth(startWidth);
    resizer.classList.add("is-resizing");
    document.body.classList.add("is-resizing-sidebar");
    try {
      resizer.setPointerCapture?.(e.pointerId);
    } catch {
      // Ignore unsupported capture errors.
    }
  });

  resizer.addEventListener("pointermove", (e) => {
    if (activePointerId === null || e.pointerId !== activePointerId) return;
    const delta = e.clientX - startX;
    currentWidth = applySidebarWidth(startWidth + delta);
  });

  resizer.addEventListener("pointerup", (e) => {
    if (e.pointerId !== activePointerId) return;
    finishDrag({ persist: true });
  });

  resizer.addEventListener("pointercancel", (e) => {
    if (e.pointerId !== activePointerId) return;
    finishDrag({ persist: false });
  });

  resizer.addEventListener("lostpointercapture", () => {
    finishDrag({ persist: true });
  });

  resizer.addEventListener("dblclick", () => {
    if (window.matchMedia?.("(max-width: 960px)")?.matches) return;
    currentWidth = applySidebarWidth(DEFAULT_SIDEBAR_WIDTH, { persist: true });
  });

  resizer.addEventListener("keydown", (e) => {
    if (window.matchMedia?.("(max-width: 960px)")?.matches) return;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home") return;
    e.preventDefault();
    const step = e.shiftKey ? 24 : 12;
    if (e.key === "Home") {
      currentWidth = applySidebarWidth(DEFAULT_SIDEBAR_WIDTH, { persist: true });
      return;
    }
    const base = sidebar.getBoundingClientRect().width || loadSavedSidebarWidth();
    const next = e.key === "ArrowLeft" ? base - step : base + step;
    currentWidth = applySidebarWidth(next, { persist: true });
  });

  window.addEventListener("resize", () => {
    if (window.matchMedia?.("(max-width: 960px)")?.matches) return;
    currentWidth = applySidebarWidth(loadSavedSidebarWidth());
  });
}

function bindEvents() {
  bindSidebarResizer();
  initComposerCustomSelects([
    "composerProviderSelect",
    "composerProfileSelect",
    "modelSelect",
    "effortSelect",
    "permissionSelect",
    "runningSubmitMode",
  ]);
  $("menuBtn").addEventListener("click", () => setSidebarOpen(true));
  $("sidebarBackdrop").addEventListener("click", () => setSidebarOpen(false));

  $("providerTabs").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-provider]");
    if (!btn) return;
    setProviderFilter(btn.dataset.provider);
  });

  $("agentQuotaStrip")?.addEventListener("click", (e) => {
    if (e.target.closest("[data-quota-refresh]")) {
      e.stopPropagation();
      void refreshQuotasManual();
      return;
    }
    if (e.target.closest("[data-quota-toggle]") || e.target.closest("[data-quota-filter-provider]")) {
      state.quotaExpanded = !state.quotaExpanded;
      renderQuotaStrip();
    }
  });

  $("telemetryTopbarBtn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const nextOpen = !(state.telemetryExpanded || state.mobileTelemetryOpen);
    state.mobileTelemetryOpen = nextOpen;
    state.telemetryExpanded = nextOpen;
    if (!nextOpen) {
      state.telemetryPickerOpen = false;
    }
    renderAgentTelemetryBar();
  });

  const handleTelemetryBarClick = (e) => {
    if (e.target.closest("[data-execution-refresh]")) {
      void refreshExecutionStats();
      return;
    }
    const executionThread = e.target.closest("[data-execution-thread]");
    if (executionThread) {
      void selectThread(executionThread.dataset.executionThread, { focusScroll: true }).catch((error) => showToastBanner("打开会话失败", { detail: formatActionError(error), error: true }));
      return;
    }
    if (e.target.closest("[data-telemetry-mobile-close]")) {
      e.stopPropagation();
      state.mobileTelemetryOpen = false;
      state.telemetryExpanded = false;
      state.telemetryPickerOpen = false;
      renderAgentTelemetryBar();
      return;
    }
    if (e.target.closest("[data-telemetry-picker-toggle]")) {
      e.stopPropagation();
      state.telemetryPickerOpen = !state.telemetryPickerOpen;
      renderAgentTelemetryBar();
      return;
    }
    const pickKeyBtn = e.target.closest("[data-telemetry-pick-key]");
    if (pickKeyBtn) {
      e.stopPropagation();
      const targetKey = String(pickKeyBtn.dataset.telemetryPickKey || "").trim();
      if (targetKey) {
        const items = buildSelectableTelemetryItems(state.profiles);
        const currentSet = new Set(resolveVisibleTelemetryKeys(items, state.telemetryVisiblePrefs));
        if (currentSet.has(targetKey)) currentSet.delete(targetKey);
        else currentSet.add(targetKey);
        const prefs = {
          selectedKeys: items.filter((item) => currentSet.has(item.key)).map((item) => item.key),
          knownKeys: items.map((item) => item.key),
        };
        state.telemetryVisiblePrefs = prefs;
        saveTelemetryVisiblePrefs(prefs);
        renderAgentTelemetryBar();
      }
      return;
    }
    const pickActionBtn = e.target.closest("[data-telemetry-pick-action]");
    if (pickActionBtn) {
      e.stopPropagation();
      const action = String(pickActionBtn.dataset.telemetryPickAction || "").trim();
      const items = buildSelectableTelemetryItems(state.profiles);
      if (action === "all") {
        const prefs = {
          selectedKeys: items.map((item) => item.key),
          knownKeys: items.map((item) => item.key),
        };
        state.telemetryVisiblePrefs = prefs;
        saveTelemetryVisiblePrefs(prefs);
      } else if (action === "default") {
        state.telemetryVisiblePrefs = null;
        saveTelemetryVisiblePrefs(null);
      }
      renderAgentTelemetryBar();
      return;
    }
    if (e.target.closest("[data-telemetry-refresh]")) {
      e.stopPropagation();
      void Promise.allSettled([refreshTelemetry(), refreshQuotasManual()]);
      return;
    }
    const jumpBtn = e.target.closest("[data-telemetry-jump-thread]");
    if (jumpBtn) {
      e.stopPropagation();
      const tid = jumpBtn.dataset.telemetryJumpThread;
      if (tid) {
        closeTelemetryPopover();
        void selectThread(tid).catch((error) => {
          showToastBanner("切换会话失败", { detail: formatActionError(error), error: true });
        });
      }
      return;
    }
    const filterBtn = e.target.closest("[data-telemetry-filter-provider]");
    if (filterBtn) {
      e.stopPropagation();
      const nextProv = filterBtn.dataset.telemetryFilterProvider || "all";
      setProviderFilter(state.providerFilter === nextProv ? "all" : nextProv);
      return;
    }
    if (e.target.closest("[data-telemetry-toggle]")) {
      e.stopPropagation();
      if (state.telemetryExpanded || state.telemetryPickerOpen) {
        closeTelemetryPopover(e.target);
      } else {
        openTelemetryPopover(e.target);
      }
    }
  };
  $("topbarTelemetrySlot")?.addEventListener("click", handleTelemetryBarClick);
  $("agentTelemetryBar")?.addEventListener("click", handleTelemetryBarClick);
  $("telemetryBackdrop")?.addEventListener("click", () => closeTelemetryPopover());
  $("agentTelemetryBar")?.addEventListener("change", (e) => {
    if (e.target.matches("[data-execution-days]")) state.executionStatsDays = Number(e.target.value);
    else if (e.target.matches("[data-execution-provider]")) state.executionStatsProvider = e.target.value;
    else return;
    state.executionStats = null;
    void refreshExecutionStats();
  });

  $("sidebarBatchSelectBtn")?.addEventListener("click", () => {
    if (state.batchSelect.active) exitBatchSelectMode();
    else enterBatchSelectMode();
  });

  const handleBatchBarClick = (e) => {
    const btn = e.target.closest("[data-batch-action]");
    if (btn) handleBatchActionClick(btn.dataset.batchAction);
  };
  $("sidebarBatchBar")?.addEventListener("click", handleBatchBarClick);
  $("boardBatchBar")?.addEventListener("click", handleBatchBarClick);

  $("boardToggleBtn").addEventListener("click", () => openProjectBoardView());

  $("voiceModeBtn").addEventListener("click", () => void openVoiceModal());

  $("activeProfileBadge")?.addEventListener("click", () => {
    const provider = state.activeThread?.provider || defaultProviderValue();
    openNewThreadModal({
      cwd: state.activeThread?.cwd || "",
      provider,
    });
  });

  $("activeProjectCrumb")?.addEventListener("click", () => openProjectBoardView());
  $("activeGoalBadge")?.addEventListener("click", () => $("goalToggleBtn")?.click());

  $("topbarMoreBtn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    setTopbarMenuOpen(!state.topbarMenuOpen);
  });

  $("topbarMoreMenu")?.addEventListener("click", (e) => {
    const hit = e.target.closest("button, a");
    if (hit && !hit.disabled) {
      setTopbarMenuOpen(false);
    }
  });

  $("topbarPinProjectBtn")?.addEventListener("click", () => {
    if (state.activeThread?.cwd) {
      void toggleProjectPin(state.activeThread.cwd);
    }
  });

  $("topbarNewInProjectBtn")?.addEventListener("click", () => {
    openNewThreadModal({
      cwd: state.activeThread?.cwd || state.newThreadCwd || "",
      provider: defaultNewThreadProvider(),
    });
  });

  $("composerConfigBtn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    setComposerConfigOpen(!state.composerConfigOpen);
  });

  $("composerConfigCloseBtn")?.addEventListener("click", () => setComposerConfigOpen(false));

  document.addEventListener("click", (e) => {
    if (state.topbarMenuOpen && !e.target.closest(".topbar-more-wrap")) {
      setTopbarMenuOpen(false);
    }
    if (
      state.composerConfigOpen
      && !e.target.closest("#composerConfigPopover")
      && !e.target.closest("#composerConfigBtn")
      && !e.target.closest("#acCustomSelectPopover")
    ) {
      setComposerConfigOpen(false);
    }
    if (
      (state.telemetryExpanded || state.mobileTelemetryOpen)
      && !e.target.closest("#agentTelemetryBar")
      && !e.target.closest("#topbarTelemetrySlot")
      && !e.target.closest("#telemetryTopbarBtn")
    ) {
      closeTelemetryPopover();
    } else if (state.telemetryPickerOpen && !e.target.closest(".telemetry-picker-panel") && !e.target.closest("[data-telemetry-picker-toggle]")) {
      state.telemetryPickerOpen = false;
      renderAgentTelemetryBar();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (state.batchSelect.active) exitBatchSelectMode();
      if (state.topbarMenuOpen) setTopbarMenuOpen(false);
      if (state.composerConfigOpen) setComposerConfigOpen(false);
      if (state.telemetryPickerOpen || state.mobileTelemetryOpen || state.telemetryExpanded) {
        closeTelemetryPopover();
      }
    }
  });

  $("projectTaskStrip").addEventListener("click", (e) => {
    if (e.target.closest("[data-strip-board]")) {
      openProjectBoardView();
      return;
    }
    const pinBtn = e.target.closest("[data-toggle-pin-cwd]");
    if (pinBtn) {
      void toggleProjectPin(pinBtn.dataset.togglePinCwd);
      return;
    }
    const newBtn = e.target.closest("[data-new-in-cwd]");
    if (newBtn) {
      void openNewThreadModal({ cwd: newBtn.dataset.newInCwd, provider: defaultNewThreadProvider() });
      return;
    }
    const pill = e.target.closest("[data-strip-thread-id]");
    if (pill) {
      void selectThread(pill.dataset.stripThreadId).catch((error) => {
        showToastBanner("切换任务失败", { detail: formatActionError(error), error: true });
      });
    }
  });

  $("projectBoard").addEventListener("input", (e) => {
    if (e.target.id === "boardSearchInput") {
      state.searchText = e.target.value;
      renderProjectBoard();
    }
  });

  $("projectBoard").addEventListener("click", (e) => {
    const actionBtn = e.target.closest("[data-board-action]");
    if (actionBtn) {
      const act = actionBtn.dataset.boardAction;
      if (act === "toggle-batch-select") {
        if (state.batchSelect.active) exitBatchSelectMode();
        else enterBatchSelectMode();
      } else if (act === "voice") void openVoiceModal();
      else if (act === "new") openNewThreadModal({ provider: defaultNewThreadProvider() });
      else if (act === "resume" && state.activeThread) {
        state.boardOpen = false;
        renderTopbarAndControls();
        renderActiveMessages();
        renderPendingRequests();
        renderQueuedTurns();
      } else if (act === "clear-search") {
        state.searchText = "";
        renderProjectBoard();
      } else if (act === "toggle-all-projects") {
        state.showAllProjects = !state.showAllProjects;
        renderProjectBoard();
      }
      return;
    }

    const expandBtn = e.target.closest("[data-expand-project-cwd]");
    if (expandBtn) {
      const cwd = expandBtn.dataset.expandProjectCwd;
      if (cwd) {
        const prevCount = Number(state.expandedProjects.get(cwd)) || 0;
        state.expandedProjects.set(cwd, prevCount + THREAD_EXPAND_STEP);
        renderProjectBoard();
      }
      return;
    }

    const collapseBtn = e.target.closest("[data-collapse-project-cwd]");
    if (collapseBtn) {
      state.expandedProjects.delete(collapseBtn.dataset.collapseProjectCwd);
      renderProjectBoard();
      return;
    }

    if (state.batchSelect.active) {
      const batchProjHead = e.target.closest("[data-batch-project-cwd]");
      if (batchProjHead && batchProjHead.dataset.batchProjectCwd) {
        toggleBatchProjectSelection(batchProjHead.dataset.batchProjectCwd);
        return;
      }
      const openBtn = e.target.closest("[data-board-open-thread]");
      if (openBtn && openBtn.dataset.boardOpenThread) {
        toggleBatchThreadSelection(openBtn.dataset.boardOpenThread, { shiftKey: e.shiftKey });
        return;
      }
    }

    const pinBtn = e.target.closest("[data-toggle-pin-cwd]");
    if (pinBtn) {
      void toggleProjectPin(pinBtn.dataset.togglePinCwd);
      return;
    }

    const aliasBtn = e.target.closest("[data-alias-cwd]");
    if (aliasBtn) {
      void promptProjectAlias(aliasBtn.dataset.aliasCwd);
      return;
    }

    const newBtn = e.target.closest("[data-new-in-cwd]");
    if (newBtn) {
      void openNewThreadModal({ cwd: newBtn.dataset.newInCwd, provider: defaultNewThreadProvider() });
      return;
    }

    const openBtn = e.target.closest("[data-board-open-thread]");
    if (openBtn && openBtn.dataset.boardOpenThread) {
      void selectThread(openBtn.dataset.boardOpenThread).catch((error) => {
        showToastBanner("打开会话失败", { detail: formatActionError(error), error: true });
      });
    }
  });

  $("threadList").addEventListener("click", (e) => {
    const foldBtn = e.target.closest("[data-batch-fold-cwd]");
    if (foldBtn) {
      e.stopPropagation();
      toggleSidebarGroupCollapse(foldBtn.dataset.batchFoldCwd);
      return;
    }
    const newBtn = e.target.closest("[data-new-in-cwd]");
    if (newBtn) {
      e.stopPropagation();
      void openNewThreadModal({ cwd: newBtn.dataset.newInCwd, provider: defaultNewThreadProvider() });
      return;
    }
    const staleBtn = e.target.closest("[data-sidebar-stale-projects]");
    if (staleBtn) {
      e.stopPropagation();
      const mode = staleBtn.dataset.sidebarStaleProjects;
      if (mode === "expand") {
        state.showStaleProjects = true;
        state.staleProjectsOpenedAt = Date.now();
      } else {
        state.showStaleProjects = false;
        state.staleProjectsOpenedAt = 0;
      }
      saveSidebarFoldState();
      renderThreadList();
      return;
    }
    const expandBtn = e.target.closest("[data-sidebar-expand-cwd]");
    if (expandBtn) {
      e.stopPropagation();
      const cwd = normalizeProjectCwd(expandBtn.dataset.sidebarExpandCwd) || "默认工作区";
      const prevCount = Number(state.expandedSidebarGroups.get(cwd)) || 0;
      state.expandedSidebarGroups.set(cwd, prevCount + THREAD_EXPAND_STEP);
      state.expandedThreadsAt[cwd] = Date.now();
      setSidebarGroupManualPref(cwd, "expand");
      renderThreadList();
      return;
    }
    const collapseBtn = e.target.closest("[data-sidebar-collapse-cwd]");
    if (collapseBtn) {
      e.stopPropagation();
      const cwd = normalizeProjectCwd(collapseBtn.dataset.sidebarCollapseCwd) || "默认工作区";
      state.expandedSidebarGroups.delete(cwd);
      delete state.expandedThreadsAt[cwd];
      setSidebarGroupManualPref(cwd, "expand");
      renderThreadList();
      return;
    }
    const toggle = e.target.closest("[data-toggle-cwd]");
    if (toggle) {
      const cwd = toggle.dataset.toggleCwd;
      if (state.batchSelect.active) {
        toggleBatchProjectSelection(cwd);
      } else {
        toggleSidebarGroupCollapse(cwd);
      }
      return;
    }
    const item = e.target.closest("[data-thread-id]");
    if (item) {
      if (state.batchSelect.active) {
        toggleBatchThreadSelection(item.dataset.threadId, { shiftKey: e.shiftKey });
        return;
      }
      void selectThread(item.dataset.threadId).catch((error) => {
        const errMsg = formatActionError(error, "加载会话失败");
        setComposerStatus("error", `加载会话失败：${errMsg}`);
        showToastBanner("加载会话失败", { detail: errMsg, error: true });
      });
    }
  });

  bindLongPressMultiSelect($("threadList"), (el) => {
    const item = el.closest("[data-thread-id]");
    if (item?.dataset?.threadId) return { threadId: item.dataset.threadId };
    const head = el.closest("[data-toggle-cwd]");
    if (head?.dataset?.toggleCwd) return { projectCwd: head.dataset.toggleCwd };
    return null;
  });

  $("threadList").addEventListener("contextmenu", (e) => {
    if (state.batchSelect.active) return;
    const item = e.target.closest("[data-thread-id]");
    const tid = item?.dataset?.threadId || "";
    if (!tid) return;
    e.preventDefault();
    openThreadContextMenu(tid, e.clientX, e.clientY);
  });

  bindLongPressMultiSelect($("projectBoard"), (el) => {
    const task = el.closest("[data-board-open-thread]");
    if (task?.dataset?.boardOpenThread) return { threadId: task.dataset.boardOpenThread };
    const head = el.closest(".board-card-head");
    const card = head?.closest("[data-project-cwd]");
    if (card?.dataset?.projectCwd) return { projectCwd: card.dataset.projectCwd };
    return null;
  });

  $("composerProviderSelect").addEventListener("change", () => {
    state.userPickedDraftModel = false;
    syncComposerProfileSelect();
    syncModelAndEffortSelectors();
    renderAgentTelemetryBar();
  });

  $("composerProfileSelect").addEventListener("change", () => {
    state.userPickedDraftModel = false;
    syncComposerProfileSelect();
    renderComposerConfigChip();
    renderAgentTelemetryBar();
    void refreshModelsForProfile(currentComposerProvider(), currentComposerProfileId());
  });

  $("newModalProbeProfilesBtn")?.addEventListener("click", () => {
    void triggerProfileProbe({ provider: $("newProviderSelect").value || defaultProviderValue() });
  });

  const handleProfilePillClick = (e, { isNewModal = false } = {}) => {
    const copyLoginBtn = e.target.closest("[data-copy-login-cmd]");
    if (copyLoginBtn) {
      e.stopPropagation();
      const loginCmd = copyLoginBtn.dataset.copyLoginCmd || "";
      if (loginCmd) {
        void copyTextToClipboard(loginCmd).then((copied) => {
          if (copied) {
            copyLoginBtn.textContent = "已复制";
            clearTimeout(copyLoginBtn._copyTimer);
            copyLoginBtn._copyTimer = setTimeout(() => {
              copyLoginBtn.textContent = "复制登录";
            }, 1800);
            showToastBanner("已复制终端登录命令", {
              detail: "请在 Mac 终端粘贴执行登录后点击「测通」",
            });
          } else {
            showToastBanner("请手动在终端执行以下命令", { detail: loginCmd });
          }
        });
      }
      return;
    }
    const probeBtn = e.target.closest("[data-probe-profile]");
    if (probeBtn) {
      e.stopPropagation();
      void triggerProfileProbe({
        provider: probeBtn.dataset.probeProvider,
        profileId: probeBtn.dataset.probeProfile,
      });
      return;
    }
    const disableBtn = e.target.closest("[data-toggle-disable-profile]");
    if (disableBtn) {
      e.stopPropagation();
      void toggleProfileDisabled({
        provider: disableBtn.dataset.profileProvider,
        profileId: disableBtn.dataset.toggleDisableProfile,
        disabled: disableBtn.dataset.nextDisabled === "1",
      });
      return;
    }
    const relayBtn = e.target.closest("[data-relay-profile]");
    if (!isNewModal && relayBtn && state.activeThread) {
      const targetProfile = state.profiles.find(
        (p) => p.provider === relayBtn.dataset.profileProvider && p.id === relayBtn.dataset.relayProfile,
      );
      if (targetProfile) {
        void relayThreadWithProfile(targetProfile, {
          cwd: state.activeThread.cwd || "",
          text: $("promptInput")?.value || "",
          images: [...state.images],
        });
      }
      return;
    }
    const selectBtn = e.target.closest("[data-select-profile]");
    if (selectBtn) {
      const nextId = selectBtn.dataset.selectProfile;
      const targetSelect = isNewModal ? $("newProfileSelect") : $("composerProfileSelect");
      if (targetSelect && !targetSelect.disabled) {
        targetSelect.value = nextId;
        if (isNewModal) {
          syncNewProfileSelect();
          void refreshModelsForProfile($("newProviderSelect").value || defaultProviderValue(), nextId);
        } else {
          syncComposerProfileSelect();
          void refreshModelsForProfile(currentComposerProvider(), nextId);
        }
      }
    }
  };

  $("composerProfilePills")?.addEventListener("click", (e) => handleProfilePillClick(e, { isNewModal: false }));
  $("newProfilePills")?.addEventListener("click", (e) => handleProfilePillClick(e, { isNewModal: true }));
  $("newProfileSelect")?.addEventListener("change", () => {
    syncNewProfileSelect();
    void refreshModelsForProfile($("newProviderSelect").value || defaultProviderValue(), $("newProfileSelect").value);
  });

  $("modelSelect").addEventListener("change", () => {
    const provider = currentComposerProvider();
    const nextModel = $("modelSelect").value;
    const models = ensurePreferredModelInList(
      resolveModelsForProvider(state.modelsByProvider, state.allModels, provider),
      provider,
      nextModel,
    );
    const selected = models.find((m) => (m.id || m.model) === nextModel) || null;
    syncEffortSelectForModel(selected);
    const nextEffort = $("effortSelect").hidden ? "" : ($("effortSelect").value || "");
    if (state.activeThreadId) {
      saveLocalThreadPrefs(state.activeThreadId, { model: nextModel, modelExplicit: true, effort: nextEffort });
      if (state.activeThread) {
        state.activeThread.model = nextModel;
        state.activeThread.reasoningEffort = nextEffort;
      }
      void apiPost("api/thread/prefs", {
        threadId: state.activeThreadId,
        model: nextModel,
        effort: nextEffort,
      }).catch(() => null);
    } else {
      state.userPickedDraftModel = true;
      saveNewThreadPrefs(provider, { model: nextModel, effort: nextEffort });
    }
    const label = selected?.displayName || nextModel || "默认模型";
    setComposerStatus("success", `已选择模型：${label}`, { autoClearMs: 2200 });
  });

  $("effortSelect").addEventListener("change", () => {
    const nextEffort = $("effortSelect").hidden ? "" : ($("effortSelect").value || "");
    if (state.activeThreadId) {
      saveLocalThreadPrefs(state.activeThreadId, { effort: nextEffort });
      if (state.activeThread) state.activeThread.reasoningEffort = nextEffort;
      void apiPost("api/thread/prefs", {
        threadId: state.activeThreadId,
        effort: nextEffort,
      }).catch(() => null);
    } else {
      saveNewThreadPrefs(currentComposerProvider(), { effort: nextEffort });
    }
    renderComposerConfigChip();
  });

  $("permissionSelect").addEventListener("change", async () => {
    const nextPerm = normalizeUiPermissionMode($("permissionSelect").value, "turbo");
    state.defaultPermissionMode = saveDefaultPermissionMode(nextPerm);
    $("permissionSelect").classList.toggle("is-turbo", nextPerm === "turbo");
    renderComposerConfigChip();
    let approvedCount = 0;
    if (state.activeThreadId) {
      saveLocalThreadPrefs(state.activeThreadId, { permissionMode: nextPerm });
      if (state.activeThread) state.activeThread.permissionMode = nextPerm;
      const res = await apiPost("api/thread/prefs", {
        threadId: state.activeThreadId,
        permissionMode: nextPerm,
      }).catch(() => null);
      approvedCount = Number(res?.autoApprovedCount || 0);
      if (nextPerm === "turbo" && !approvedCount) {
        approvedCount = await autoApproveTurboRequestsForThread(state.activeThreadId);
      }
    }
    const label = permissionModeDisplayLabel(nextPerm);
    setComposerStatus(
      "success",
      approvedCount > 0 ? `已切换为 ${label}，并自动批准 ${approvedCount} 项待确认请求` : `已切换权限：${label}`,
      { autoClearMs: 2500 },
    );
  });

  $("newProviderPills")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-select-provider]");
    if (btn?.dataset?.selectProvider) {
      selectNewModalProvider(btn.dataset.selectProvider);
    }
  });
  $("newProviderSelect").addEventListener("change", () => {
    selectNewModalProvider($("newProviderSelect").value || defaultNewThreadProvider());
  });

  $("promptInput").addEventListener("input", () => {
    renderComposerControls();
    void updateSlashCommandMenu();
  });
  $("promptInput").addEventListener("change", () => renderComposerControls());
  $("promptInput").addEventListener("compositionend", () => {
    renderComposerControls();
    void updateSlashCommandMenu();
  });
  $("runningSubmitMode").addEventListener("change", () => renderComposerControls());

  $("promptInput").addEventListener("keydown", (e) => {
    if (state.slashMenuOpen && state.slashMenuItems.length && !e.isComposing && e.keyCode !== 229) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        state.slashMenuIndex = (state.slashMenuIndex + 1) % state.slashMenuItems.length;
        renderSlashCommandMenu();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        state.slashMenuIndex = (state.slashMenuIndex - 1 + state.slashMenuItems.length) % state.slashMenuItems.length;
        renderSlashCommandMenu();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeSlashCommandMenu();
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        applySlashMenuChoice(state.slashMenuIndex);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      void handleSend();
    }
  });

  $("composerSlashBtn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (state.slashMenuOpen) {
      closeSlashCommandMenu();
      return;
    }
    void updateSlashCommandMenu({ manual: true });
    $("promptInput")?.focus();
  });

  $("slashCommandMenu")?.addEventListener("click", (e) => {
    const itemBtn = e.target.closest("[data-slash-index]");
    if (!itemBtn) return;
    e.stopPropagation();
    applySlashMenuChoice(Number(itemBtn.dataset.slashIndex) || 0);
  });

  document.addEventListener("click", (e) => {
    if (!state.slashMenuOpen) return;
    if (e.target.closest("#slashCommandMenu") || e.target.closest("#composerSlashBtn")) return;
    closeSlashCommandMenu();
  });

  $("promptInput").addEventListener("paste", (e) => {
    const items = [...(e.clipboardData?.items || [])];
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) void addComposerImageFile(file);
      }
    }
  });

  $("imageUploadBtn").addEventListener("click", () => $("imageFileInput").click());
  $("composerVoiceBtn")?.addEventListener("click", () => void toggleComposerDictation());
  $("imageFileInput").addEventListener("change", (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = "";
    for (const file of files) void addComposerImageFile(file);
  });

  $("composerImages").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-remove-img]");
    if (!btn) return;
    state.images.splice(Number(btn.dataset.removeImg), 1);
    renderComposerImages();
    renderComposerControls();
  });

  const composerArea = $("composerArea");
  const composerBox = composerArea?.querySelector(".composer-box");
  if (composerArea && composerBox) {
    let dragDepth = 0;
    const isFileDrag = (e) => Boolean(e.dataTransfer?.types && [...e.dataTransfer.types].includes("Files"));
    composerArea.addEventListener("dragenter", (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      dragDepth += 1;
      composerBox.classList.add("is-dragover");
    });
    composerArea.addEventListener("dragover", (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      composerBox.classList.add("is-dragover");
    });
    composerArea.addEventListener("dragleave", (e) => {
      if (!isFileDrag(e) && dragDepth === 0) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) composerBox.classList.remove("is-dragover");
    });
    composerArea.addEventListener("drop", (e) => {
      dragDepth = 0;
      composerBox.classList.remove("is-dragover");
      const files = [...(e.dataTransfer?.files || [])].filter(
        (file) => String(file?.type || "").startsWith("image/") || /\.(?:png|jpe?g|webp|gif|bmp)$/i.test(String(file?.name || "")),
      );
      if (!files.length) return;
      e.preventDefault();
      for (const file of files) void addComposerImageFile(file);
    });
  }

  $("messagesViewport")?.addEventListener("error", (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    if (!img.classList.contains("msg-image") && !img.classList.contains("md-inline-img")) return;
    const failedSrc = img.getAttribute("src") || img.currentSrc || img.src || "";
    if (failedSrc) {
      markThreadImageFailed(failedSrc);
      revealedDeferredImageSrcs.delete(failedSrc);
    }
    markCardImageBroken(img);
  }, true);

  document.addEventListener("click", (e) => {
    const fileTrigger = e.target.closest("[data-local-file-path]");
    if (fileTrigger) {
      const targetThreadId = state.activeThread?.id || state.activeThreadId || "";
      const filePath = fileTrigger.dataset.localFilePath || "";
      const lineAnchor = Number(fileTrigger.dataset.localFileLine) || null;
      if (targetThreadId && filePath) {
        e.preventDefault();
        void openFilePreviewModal(targetThreadId, filePath, lineAnchor);
        return;
      }
    }
    const revealAllTrigger = e.target.closest("[data-reveal-thread-images]");
    if (revealAllTrigger) {
      const activeTid = state.activeThread?.id || state.activeThreadId || "";
      if (activeTid) {
        setThreadImagesUnlocked(activeTid, true);
      }
      return;
    }
    const revealInlineTrigger = e.target.closest("[data-reveal-inline-img]");
    if (revealInlineTrigger) {
      const wrap = revealInlineTrigger.closest(".md-inline-img-wrap");
      const lazyImg = wrap?.querySelector("img[data-lazy-src]");
      if (lazyImg) {
        activateDeferredImage(lazyImg);
      }
      return;
    }
    const previewTrigger = e.target.closest("[data-preview-src]");
    if (previewTrigger && !e.target.closest("[data-remove-img]")) {
      const deferredImg = previewTrigger.querySelector("img[data-lazy-src]");
      if (deferredImg) {
        activateDeferredImage(deferredImg);
        return;
      }
      const src = previewTrigger.dataset.previewSrc || "";
      const rawSrc = previewTrigger.dataset.previewRaw || "";
      const caption = previewTrigger.dataset.previewCaption || "";
      if (src) {
        openImagePreviewModal(src, caption, rawSrc);
        return;
      }
    }
    const inlineImg = e.target.closest(".md-inline-img");
    if (inlineImg) {
      if (inlineImg.dataset.lazySrc) {
        activateDeferredImage(inlineImg);
        return;
      }
      const src = inlineImg.dataset.previewSrc || inlineImg.getAttribute("src") || "";
      const rawSrc = inlineImg.dataset.previewRaw || "";
      const caption = inlineImg.dataset.previewCaption || inlineImg.getAttribute("alt") || "图片预览";
      if (src) openImagePreviewModal(src, caption, rawSrc);
    }
  });

  $("imagePreviewLoadRawBtn")?.addEventListener("click", () => {
    const info = state.imagePreview;
    const img = $("imagePreviewImg");
    const metaEl = $("imagePreviewMeta");
    const btn = $("imagePreviewLoadRawBtn");
    if (!info?.rawSrc || !img || !btn) return;
    btn.disabled = true;
    btn.textContent = "加载中…";
    img.onload = () => {
      if (state.imagePreview) state.imagePreview.showingRaw = true;
      btn.hidden = true;
      btn.disabled = false;
      if (metaEl) metaEl.textContent = "原图";
    };
    img.onerror = () => {
      btn.disabled = false;
      btn.textContent = "重试原图";
    };
    img.src = info.rawSrc;
  });

  const imgModal = $("imagePreviewModal");
  if (imgModal) {
    const stage = $("imagePreviewStage");
    const imgEl = $("imagePreviewImg");
    const zoomBtn = $("imagePreviewZoomBtn");

    const applyPreviewTransform = (dragging = false) => {
      const info = state.imagePreview;
      if (!info || !imgEl) return;
      const scale = Math.max(1, Math.min(6, info.scale || 1));
      info.scale = scale;
      if (scale <= 1.01) {
        info.scale = 1;
        info.tx = 0;
        info.ty = 0;
        imgEl.style.transform = "";
        imgEl.classList.remove("is-zoomed", "is-dragging");
        if (zoomBtn) zoomBtn.hidden = true;
        return;
      }
      imgEl.classList.add("is-zoomed");
      imgEl.classList.toggle("is-dragging", dragging);
      imgEl.style.transform = `translate3d(${info.tx.toFixed(1)}px, ${info.ty.toFixed(1)}px, 0) scale(${scale.toFixed(3)})`;
      if (zoomBtn) {
        zoomBtn.hidden = false;
        zoomBtn.textContent = `${Math.round(scale * 100)}%`;
      }
    };

    const zoomAtPoint = (nextScaleRaw, clientX, clientY) => {
      const info = state.imagePreview;
      if (!info || !stage) return;
      const oldScale = info.scale || 1;
      const nextScale = Math.max(1, Math.min(6, nextScaleRaw));
      if (Math.abs(nextScale - oldScale) < 0.001) return;
      const rect = stage.getBoundingClientRect();
      const ox = clientX - (rect.left + rect.width / 2);
      const oy = clientY - (rect.top + rect.height / 2);
      const ratio = nextScale / oldScale;
      info.tx = ox - (ox - (info.tx || 0)) * ratio;
      info.ty = oy - (oy - (info.ty || 0)) * ratio;
      info.scale = nextScale;
      applyPreviewTransform(false);
    };

    const resetPreviewZoom = () => {
      if (!state.imagePreview) return;
      state.imagePreview.scale = 1;
      state.imagePreview.tx = 0;
      state.imagePreview.ty = 0;
      applyPreviewTransform(false);
    };

    zoomBtn?.addEventListener("click", resetPreviewZoom);
    stage?.addEventListener("dblclick", (e) => {
      e.preventDefault();
      if ((state.imagePreview?.scale || 1) > 1.05) {
        resetPreviewZoom();
      } else {
        zoomAtPoint(2.2, e.clientX, e.clientY);
      }
    });

    // Trackpad two-finger pinch (`ctrlKey` + wheel) & two-finger pan when zoomed
    stage?.addEventListener("wheel", (e) => {
      const info = state.imagePreview;
      if (!info) return;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const factor = Math.exp(-e.deltaY * 0.01);
        zoomAtPoint((info.scale || 1) * factor, e.clientX, e.clientY);
      } else if ((info.scale || 1) > 1.01) {
        e.preventDefault();
        info.tx = (info.tx || 0) - e.deltaX;
        info.ty = (info.ty || 0) - e.deltaY;
        applyPreviewTransform(true);
      }
    }, { passive: false });

    // Touch two-finger pinch & single-finger pan
    let pinchState = null;
    let panState = null;
    const touchDist = (t1, t2) => Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
    const touchMid = (t1, t2) => ({ x: (t1.clientX + t2.clientX) / 2, y: (t1.clientY + t2.clientY) / 2 });

    stage?.addEventListener("touchstart", (e) => {
      const info = state.imagePreview;
      if (!info) return;
      if (e.touches.length === 2) {
        e.preventDefault();
        panState = null;
        const mid = touchMid(e.touches[0], e.touches[1]);
        pinchState = {
          startDist: Math.max(1, touchDist(e.touches[0], e.touches[1])),
          startScale: info.scale || 1,
          lastMid: mid,
        };
      } else if (e.touches.length === 1 && (info.scale || 1) > 1.01) {
        panState = { x: e.touches[0].clientX, y: e.touches[0].clientY, tx: info.tx || 0, ty: info.ty || 0 };
      }
    }, { passive: false });

    stage?.addEventListener("touchmove", (e) => {
      const info = state.imagePreview;
      if (!info) return;
      if (e.touches.length === 2 && pinchState) {
        e.preventDefault();
        const dist = touchDist(e.touches[0], e.touches[1]);
        const mid = touchMid(e.touches[0], e.touches[1]);
        const nextScale = pinchState.startScale * (dist / pinchState.startDist);
        info.tx = (info.tx || 0) + (mid.x - pinchState.lastMid.x);
        info.ty = (info.ty || 0) + (mid.y - pinchState.lastMid.y);
        pinchState.lastMid = mid;
        zoomAtPoint(nextScale, mid.x, mid.y);
      } else if (e.touches.length === 1 && panState) {
        e.preventDefault();
        info.tx = panState.tx + (e.touches[0].clientX - panState.x);
        info.ty = panState.ty + (e.touches[0].clientY - panState.y);
        applyPreviewTransform(true);
      }
    }, { passive: false });

    stage?.addEventListener("touchend", () => {
      pinchState = null;
      panState = null;
      applyPreviewTransform(false);
    });

    stage?.addEventListener("mousedown", (e) => {
      const info = state.imagePreview;
      if (e.button !== 0 || !info || (info.scale || 1) <= 1.01) return;
      e.preventDefault();
      panState = { x: e.clientX, y: e.clientY, tx: info.tx || 0, ty: info.ty || 0 };
    });
    window.addEventListener("mousemove", (e) => {
      if (!panState || !state.imagePreview) return;
      state.imagePreview.tx = panState.tx + (e.clientX - panState.x);
      state.imagePreview.ty = panState.ty + (e.clientY - panState.y);
      applyPreviewTransform(true);
    });
    window.addEventListener("mouseup", () => {
      if (!panState) return;
      panState = null;
      applyPreviewTransform(false);
    });

    imgModal.addEventListener("click", (e) => {
      if (e.target === imgModal) imgModal.close();
    });
    imgModal.addEventListener("close", () => {
      resetPreviewZoom();
      if (imgEl) {
        imgEl.onload = null;
        imgEl.onerror = null;
        imgEl.removeAttribute("src");
      }
    });
  }

  $("filePreviewToggleRawBtn")?.addEventListener("click", () => {
    const fp = state.filePreview;
    if (!fp?.meta) return;
    fp.rawMode = !fp.rawMode;
    const btn = $("filePreviewToggleRawBtn");
    if (btn) btn.textContent = fp.rawMode ? "渲染" : "源码";
    renderFilePreviewBody(fp.meta, { threadId: fp.threadId, rawMode: fp.rawMode });
  });

  $("filePreviewCopyBtn")?.addEventListener("click", async () => {
    const text = state.filePreview?.meta?.content || "";
    const btn = $("filePreviewCopyBtn");
    if (!text || !btn) return;
    try {
      await navigator.clipboard?.writeText(text);
      btn.textContent = "已复制";
      setTimeout(() => { btn.textContent = "复制"; }, 1400);
    } catch {}
  });

  const fileModal = $("filePreviewModal");
  if (fileModal) {
    fileModal.addEventListener("click", (e) => {
      if (e.target === fileModal) fileModal.close();
    });
    fileModal.addEventListener("close", () => {
      const bodyEl = $("filePreviewBody");
      if (bodyEl) bodyEl.innerHTML = "";
    });
  }

  $("composerGoalBtn").addEventListener("click", () => {
    state.composerGoal = !state.composerGoal;
    renderComposerControls();
  });

  $("composerStatus").addEventListener("click", (e) => {
    if (e.target.closest("[data-failover-trigger]") && state.lastFailoverContext?.altProfile) {
      const ctx = state.lastFailoverContext;
      clearComposerStatus();
      void relayThreadWithProfile(ctx.altProfile, ctx);
      return;
    }
    if (e.target.closest("[data-dismiss-composer-status]")) clearComposerStatus();
  });

  $("sendBtn").addEventListener("click", () => void handleSend());
  $("messagesViewport")?.addEventListener("click", async (e) => {
    const resumeBtn = e.target.closest("[data-resume-interrupted-turn]");
    if (resumeBtn) {
      if (!state.activeThreadId || state.isSubmitting) return;
      if (isActiveThreadRunning()) {
        showToastBanner("当前会话正在执行中", { detail: "无需重复启动" });
        return;
      }
      const goalSuspended = Boolean(state.activeThread?.goalState?.active);
      resumeBtn.disabled = true;
      try {
        await handleSend({
          overrideText: "继续完成刚才中断的步骤",
          clearDraft: false,
          forceGoal: goalSuspended,
        });
      } finally {
        resumeBtn.disabled = false;
      }
      return;
    }
    const forkBtn = e.target.closest("[data-fork-turn-index]");
    if (forkBtn) {
      if (!state.activeThreadId || forkBtn.disabled) return;
      const upToTurnIndex = Number(forkBtn.dataset.forkTurnIndex);
      const upToTurnId = forkBtn.dataset.forkTurnId || "";
      forkBtn.disabled = true;
      try {
        await forkThreadAction(state.activeThreadId, {
          ...(Number.isInteger(upToTurnIndex) && upToTurnIndex >= 0 ? { upToTurnIndex } : {}),
          ...(upToTurnId ? { upToTurnId } : {}),
        });
      } finally {
        forkBtn.disabled = false;
      }
      return;
    }
    const messageCopyBtn = e.target.closest("[data-copy-message]");
    const copyBtn = messageCopyBtn || e.target.closest("[data-copy-code]");
    if (!copyBtn) return;
    const block = copyBtn.closest(".md-code-block");
    const codeText = messageCopyBtn
      ? messageCopyBtn.dataset.copyMessage
      : (block?.querySelector("pre > code")?.textContent ?? "");
    if (!codeText) return;
    const copyLabel = messageCopyBtn?.querySelector("span") || copyBtn;
    const copied = await copyTextToClipboard(codeText);
    if (copied) {
      copyLabel.textContent = "已复制";
      copyBtn.classList.add("is-copied");
      clearTimeout(copyBtn._copyTimer);
      copyBtn._copyTimer = setTimeout(() => {
        copyLabel.textContent = "复制";
        copyBtn.classList.remove("is-copied");
      }, 1500);
    } else if (messageCopyBtn) {
      showToastBanner("复制失败", { detail: "请重试或选中文字后复制", error: true });
    }
  });
  $("loadOlderBtn").addEventListener("click", async () => {
    try {
      await loadOlderMessages();
    } catch (error) {
      setComposerStatus("error", `加载更早对话失败：${formatActionError(error)}`);
    }
  });
  $("refreshThreadBtn").addEventListener("click", async () => {
    try {
      await refreshThreads();
      if (state.activeThreadId) await selectThread(state.activeThreadId, { focusScroll: false });
    } catch (error) {
      const errMsg = formatActionError(error, "刷新失败");
      setComposerStatus("error", `刷新失败：${errMsg}`);
      showToastBanner("刷新失败", { detail: errMsg, error: true });
    }
  });

  const interruptBtn = $("interruptBtn");
  interruptBtn.addEventListener("click", async () => {
    if (!state.activeThreadId || interruptBtn.disabled) return;
    interruptBtn.disabled = true;
    setComposerStatus("info", "正在中断当前执行…");
    try {
      await apiPost("api/interrupt", { threadId: state.activeThreadId });
      await selectThread(state.activeThreadId, { focusScroll: false });
      setComposerStatus("success", "已中断当前执行", { autoClearMs: 2200 });
    } catch (error) {
      const errMsg = formatActionError(error, "中断失败");
      setComposerStatus("error", `中断失败：${errMsg}`);
      showToastBanner("中断失败", { detail: errMsg, error: true });
    } finally {
      interruptBtn.disabled = false;
    }
  });

  $("goalToggleBtn").addEventListener("click", async () => {
    if (!state.activeThreadId || !state.activeThread) return;
    try {
      const enabled = !state.activeThread.goalState?.active;
      const res = await apiPost("api/thread/goal", {
        threadId: state.activeThreadId,
        enabled,
        model: $("modelSelect").value || "",
        effort: $("effortSelect").hidden ? "" : ($("effortSelect").value || ""),
        permissionMode: normalizeUiPermissionMode($("permissionSelect").value || state.defaultPermissionMode || "turbo", "turbo"),
      });
      state.activeThread.goalState = res.goalState;
      renderTopbarAndControls();
      renderThreadList();
    } catch (error) {
      const errMsg = formatActionError(error, "切换 Goal 模式失败");
      setComposerStatus("error", `切换 Goal 失败：${errMsg}`);
      showToastBanner("切换 Goal 失败", { detail: errMsg, error: true });
    }
  });

  $("renameThreadBtn").addEventListener("click", async () => {
    if (!state.activeThreadId) return;
    const next = prompt("输入新的会话标题：", state.activeThread?.title || "");
    if (!next || !next.trim()) return;
    try {
      await apiPost("api/thread/name", { threadId: state.activeThreadId, name: next.trim() });
      await selectThread(state.activeThreadId, { focusScroll: false });
      await refreshThreads();
    } catch (error) {
      const errMsg = formatActionError(error, "重命名失败");
      setComposerStatus("error", `重命名失败：${errMsg}`);
      showToastBanner("重命名失败", { detail: errMsg, error: true });
    }
  });

  $("toggleThreadImagesBtn")?.addEventListener("click", () => {
    const tid = state.activeThread?.id || state.activeThreadId || "";
    if (!tid) return;
    setThreadImagesUnlocked(tid, !isThreadImagesUnlocked(tid));
    setTopbarMenuOpen(false);
  });

  $("archiveThreadBtn").addEventListener("click", async () => {
    if (!state.activeThreadId || !state.activeThread) return;
    try {
      const nextArchived = !state.activeThread.archived;
      await apiPost("api/thread/archive", { threadId: state.activeThreadId, archived: nextArchived });
      if (nextArchived && !state.showArchived) {
        await selectThread("");
      } else {
        await selectThread(state.activeThreadId, { focusScroll: false });
      }
      await refreshThreads();
    } catch (error) {
      const errMsg = formatActionError(error, "归档操作失败");
      setComposerStatus("error", `归档失败：${errMsg}`);
      showToastBanner("归档失败", { detail: errMsg, error: true });
    }
  });

  $("queuedTurnsBar").addEventListener("click", async (e) => {
    const toggleBtn = e.target.closest("[data-queue-toggle]");
    if (toggleBtn) {
      state.queuedPanelCollapsed = !state.queuedPanelCollapsed;
      renderQueuedTurns();
      return;
    }

    const steerBtn = e.target.closest("[data-queue-steer]");
    if (steerBtn && state.activeThreadId) {
      if (steerBtn.disabled) return;
      const steerId = steerBtn.dataset.queueSteer;
      const entry = (state.queuedTurns || []).find((item) => item.id === steerId);
      steerBtn.disabled = true;
      setComposerStatus("pending", "正在直接引导进当前会话…");
      try {
        const isThreadRunning = Boolean(state.activeThread?.live || state.liveActivity?.status === "running");
        const res = await apiPost("api/thread/queue/steer", {
          threadId: state.activeThreadId,
          id: steerId,
          expectedTurnId: isThreadRunning ? (state.liveActivity?.turnId || "") : "",
        });
        applyActiveQueuedTurns(state.activeThreadId, res.items || []);
        if (state.activeThread) {
          const entryText = String(entry?.text || res.entry?.text || "").trim();
          const imageCount = Number(entry?.imageCount ?? res.entry?.imageCount ?? 0);
          const userContent = [
            ...(entryText ? [{ type: "text", text: entryText }] : []),
            ...(imageCount > 0 ? [{ type: "text", text: `[图片附件 x${imageCount}]` }] : []),
          ];
          if (userContent.length) {
            if (!Array.isArray(state.activeThread.turns)) state.activeThread.turns = [];
            const tailTurn = state.activeThread.turns[state.activeThread.turns.length - 1];
            if (tailTurn && (tailTurn.status === "inProgress" || tailTurn.status === "running")) {
              tailTurn.items = [
                ...(Array.isArray(tailTurn.items) ? tailTurn.items : []),
                { type: "userMessage", id: `user-steer-${Date.now()}`, content: userContent },
              ];
            } else {
              const turnId = res.result?.turn?.id || `optimistic-turn-${Date.now()}`;
              state.activeThread.turns.push({
                id: turnId,
                status: "inProgress",
                startedAt: Math.floor(Date.now() / 1000),
                items: [{ type: "userMessage", id: `user-${turnId}`, content: userContent }],
              });
            }
          }
          state.activeThread.live = true;
          syncThreadSummaryIntoList({ id: state.activeThreadId, live: true });
          state.liveActivity = mergeLiveActivity(state.liveActivity, {
            turnId: res.result?.turn?.id || state.liveActivity?.turnId || "",
            status: "running",
            phase: `${providerDisplayName(state.activeThread.provider)} 执行中`,
          });
          renderThreadList();
          renderTopbarAndControls();
          renderActiveMessages();
          scheduleActiveThreadReload(state.activeThreadId, 350);
        }
        setComposerStatus("success", "已将排队消息直接引导进当前会话", { autoClearMs: 2600 });
      } catch (error) {
        const errMsg = formatActionError(error, "引导失败");
        setComposerStatus("error", `引导排队消息失败：${errMsg}`);
        showToastBanner("引导失败", { detail: errMsg, error: true });
      } finally {
        if (steerBtn.isConnected) steerBtn.disabled = false;
      }
      return;
    }

    const editBtn = e.target.closest("[data-queue-edit]");
    if (editBtn && state.activeThreadId) {
      const editId = editBtn.dataset.queueEdit;
      const entry = (state.queuedTurns || []).find((item) => item.id === editId);
      const targetThreadId = state.activeThreadId;
      try {
        editBtn.disabled = true;
        const res = await apiGet(
          `api/thread/queue/entry?threadId=${encodeURIComponent(targetThreadId)}&id=${encodeURIComponent(editId)}`,
        );
        if (state.activeThreadId !== targetThreadId) return;
        const fullEntry = res?.entry || entry;
        if (!fullEntry) {
          throw new Error("未找到该排队消息");
        }
        const input = $("promptInput");
        const existingEdit = activeEditingQueueItem();
        const prevDraftText = existingEdit ? existingEdit.prevDraftText : String(input?.value || "");
        const prevImages = existingEdit ? existingEdit.prevImages : [...(state.images || [])];
        const prevGoal = existingEdit ? existingEdit.prevGoal : Boolean(state.composerGoal);

        const restoredImages = (Array.isArray(fullEntry.images) ? fullEntry.images : [])
          .filter((img) => img && img.dataUrl)
          .map((img, idx) => ({
            id: `queue-edit-${editId}-${idx}-${Date.now()}`,
            name: img.name || `image-${idx + 1}.jpg`,
            dataUrl: img.dataUrl,
            byteLength: estimateDataUrlBytes(img.dataUrl),
            compressed: true,
          }));

        const listIndex = (state.queuedTurns || []).findIndex((q) => q.id === editId);
        state.editingQueueItem = {
          id: editId,
          threadId: targetThreadId,
          position: Number(fullEntry.position) || (listIndex >= 0 ? listIndex + 1 : 1),
          prevDraftText,
          prevImages,
          prevGoal,
        };
        if (input) {
          input.value = String(fullEntry.text || "");
        }
        state.images = restoredImages;
        state.composerGoal = Boolean(fullEntry.goalMode);
        renderComposerImages();
        renderComposerEditBanner();
        renderQueuedTurns();
        renderComposerControls();
        input?.focus();
        setComposerStatus(
          "info",
          restoredImages.length
            ? `已载入排队 #${state.editingQueueItem.position}（含 ${restoredImages.length} 张图片），修改后点击“保存更新”`
            : `已载入排队 #${state.editingQueueItem.position}，修改后点击“保存更新”`,
          { autoClearMs: 4000 },
        );
      } catch (error) {
        if (Number(error?.status || 0) === 404 || error?.code === "queued_turn_not_found") {
          setComposerStatus("info", "该排队消息已自动发送或取消", { autoClearMs: 4000 });
          void apiGet(`api/thread/queue?id=${encodeURIComponent(targetThreadId)}`)
            .then((qRes) => applyActiveQueuedTurns(targetThreadId, qRes?.items || []))
            .catch(() => {});
        } else {
          setComposerStatus("error", `载入排队消息失败：${formatActionError(error)}`);
        }
      } finally {
        if (editBtn.isConnected) editBtn.disabled = false;
      }
      return;
    }

    const cancelBtn = e.target.closest("[data-queue-cancel], [data-cancel-queue]");
    if (!cancelBtn || !state.activeThreadId) return;
    const cancelId = cancelBtn.dataset.queueCancel || cancelBtn.dataset.cancelQueue;
    try {
      const res = await apiPost("api/thread/queue/cancel", {
        threadId: state.activeThreadId,
        id: cancelId,
      });
      if (state.editingQueueItem?.id === cancelId) {
        clearQueueEditState({ restoreDraft: true });
      }
      applyActiveQueuedTurns(state.activeThreadId, res.items || []);
    } catch (error) {
      setComposerStatus("error", `取消排队失败：${formatActionError(error)}`);
    }
  });

  $("composerEditBanner")?.addEventListener("click", (e) => {
    const cancelEditBtn = e.target.closest("[data-cancel-queue-edit]");
    if (!cancelEditBtn) return;
    clearQueueEditState({ restoreDraft: true });
    $("promptInput")?.focus();
  });

  $("pendingRequestsDock").addEventListener("click", async (e) => {
    let targetRequestId = "";
    try {
      const declineBtn = e.target.closest("[data-decline-id]");
      if (declineBtn) {
        targetRequestId = declineBtn.dataset.declineId || "";
        await apiPost("api/server-request", {
          requestId: targetRequestId,
          decision: "decline",
        });
        removePendingRequestById(targetRequestId);
        return;
      }
      const optBtn = e.target.closest("[data-option-id]");
      if (optBtn) {
        targetRequestId = optBtn.dataset.requestId || "";
        await apiPost("api/server-request", {
          requestId: targetRequestId,
          optionId: optBtn.dataset.optionId,
        });
        removePendingRequestById(targetRequestId);
        return;
      }
      const decBtn = e.target.closest("[data-decision]");
      if (decBtn) {
        targetRequestId = decBtn.dataset.requestId || "";
        await apiPost("api/approval", {
          requestId: targetRequestId,
          decision: decBtn.dataset.decision,
        });
        removePendingRequestById(targetRequestId);
      }
    } catch (error) {
      if (targetRequestId && Number(error?.status) === 404) {
        removePendingRequestById(targetRequestId);
        setComposerStatus("info", "该确认项已自动处理或过期", { autoClearMs: 2500 });
        return;
      }
      const errMsg = formatActionError(error, "响应审批请求失败");
      setComposerStatus("error", errMsg);
      showToastBanner("审批请求失败", { detail: errMsg, error: true });
    }
  });

  $("pendingRequestsDock").addEventListener("change", (e) => syncUserInputQuestion(e.target));

  $("pendingRequestsDock").addEventListener("submit", async (e) => {
    const form = e.target.closest("form[data-kind='userInput']");
    if (!form) return;
    e.preventDefault();
    if (form.dataset.submitting === "1" || !form.reportValidity()) return;
    const requestId = form.dataset.requestId || "";
    const submitBtn = form.querySelector("[type='submit']");
    try {
      const req = state.pendingRequests.find((r) => r.id === requestId);
      const answers = collectUserInputAnswers(req, form);
      form.dataset.submitting = "1";
      submitBtn.disabled = true;
      submitBtn.textContent = "提交中…";
      await apiPost("api/server-request", { requestId, decision: "accept", answers });
      removePendingRequestById(requestId);
    } catch (error) {
      if (requestId && Number(error?.status) === 404) {
        removePendingRequestById(requestId);
        setComposerStatus("info", "该确认项已自动处理或过期", { autoClearMs: 2500 });
        return;
      }
      const errMsg = formatActionError(error, "提交回答失败");
      setComposerStatus("error", errMsg);
      showToastBanner("提交回答失败", { detail: errMsg, error: true });
    } finally {
      delete form.dataset.submitting;
      submitBtn.disabled = false;
      submitBtn.textContent = "提交回答";
    }
  });

  $("newThreadBtn").addEventListener("click", () => {
    openNewThreadModal({
      cwd: state.activeThread?.cwd || state.newThreadCwd || "",
      provider: defaultNewThreadProvider(),
    });
  });

  $("newThreadForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitBtn = $("createThreadSubmitBtn");
    const errEl = $("newThreadError");
    errEl.hidden = true;
    errEl.textContent = "";
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "创建中…";
    }
    const provider = $("newProviderSelect").value;
    const profileId = $("newProfileSelect").value || defaultProfileForProvider(provider);
    const model = $("newModelSelect")?.value || "";
    const effort = getNewThreadPrefs(provider).effort || "";
    const cwd = $("newCwdInput").value.trim();
    const permissionMode = normalizeUiPermissionMode($("newPermissionSelect").value || "turbo", "turbo");
    state.defaultPermissionMode = saveDefaultPermissionMode(permissionMode);
    const goalMode = $("newGoalCheckbox").checked;
    const text = $("newPromptInput").value;
    try {
      const created = await apiPost("api/thread/new", {
        provider,
        profileId,
        model,
        effort,
        cwd,
        text,
        permissionMode,
        goalMode,
      });
      saveNewThreadPrefs(provider, { model, effort });
      $("newPromptInput").value = "";
      $("newThreadModal").close();
      const createdProvider = created?.thread?.provider || provider;
      if (state.providerFilter !== "all" && createdProvider && state.providerFilter !== createdProvider) {
        setProviderFilter("all");
      }
      await refreshThreads();
      if (created?.thread?.id) {
        saveLocalThreadPrefs(created.thread.id, { model, effort, permissionMode });
        await selectThread(created.thread.id);
      }
    } catch (error) {
      const errMsg = formatActionError(error, "创建会话失败");
      errEl.textContent = `创建失败：${errMsg}`;
      errEl.hidden = false;
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = "创建会话";
      }
    }
  });

  $("voiceAutoAnnounceBtn")?.addEventListener("click", () => {
    const next = !state.voice.config.autoBroadcastEvents;
    state.voice.config = saveVoiceConfig({ autoBroadcastEvents: next });
    renderVoiceCallUi();
  });

  $("voiceModelSelect")?.addEventListener("change", (e) => {
    const selectedKey = String(e.target?.value || "auto").trim() || "auto";
    state.voice.config = saveVoiceConfig({ preferredModelKey: selectedKey });
    const parsed = parseVoiceModelSelectionKey(selectedKey);
    if (parsed.voiceModel) {
      state.voice.modelName = parsed.voiceModel;
    }
    if (parsed.voiceProvider && parsed.voiceProvider !== "auto") {
      state.voice.dispatchProvider = parsed.voiceProvider;
    }
    renderVoiceCallUi();
    if (state.voice.callActive && state.voice.callId && !state.voice.backendMissing) {
      void apiPostWithHotFallback("api/voice/call/start", {
        callId: state.voice.callId,
        callScope: effectiveVoiceScope(),
        activeThreadId: effectiveVoiceThreadId(),
        ...voiceSelectionPayload(),
      }).then((res) => {
        if (res?.dispatchModel || res?.model) {
          state.voice.modelName = res?.dispatchModel || res.model;
        }
        if (res?.dispatchProvider) {
          state.voice.dispatchProvider = res.dispatchProvider;
        }
        if (Array.isArray(res?.modelOptions)) {
          state.voice.modelOptions = res.modelOptions;
          renderVoiceModelSelector();
        }
        renderVoiceCallUi();
      }).catch(() => {});
    }
  });

  $("voiceScopeBar")?.addEventListener("click", (e) => {
    const pill = e.target.closest("[data-voice-scope]");
    if (!pill || pill.disabled) return;
    ensureVoiceAudioUnlocked();
    setVoiceCallScope(pill.dataset.voiceScope);
  });

  $("voiceKeyboardToggleBtn")?.addEventListener("click", () => {
    const form = $("voiceTextForm");
    if (!form) return;
    form.hidden = !form.hidden;
    if (!form.hidden) $("voiceTextInput")?.focus();
  });

  $("voiceOrbBtn")?.addEventListener("click", () => triggerVoiceOrbAction());
  $("voiceTalkBtn")?.addEventListener("click", () => triggerVoiceOrbAction());

  $("voiceMuteBtn")?.addEventListener("click", () => {
    ensureVoiceAudioUnlocked();
    if (!state.voice.callActive) return;
    state.voice.isMuted = !state.voice.isMuted;
    state.voice.isRecording = false;
    state.voice.vadDetector?.reset?.();
    if (!state.voice.isMuted && !state.voice.micStream) {
      void startVoiceCallMicPipeline();
    } else {
      renderVoiceCallUi();
    }
  });

  $("voiceReadProgressBtn")?.addEventListener("click", () => {
    ensureVoiceAudioUnlocked();
    if (state.voice.isSpeaking) {
      stopVoicePlayback({ scheduleResume: true, abortReason: "user_barge_in" });
      return;
    }
    void sendVoiceTurnToMac({ mode: "briefing", transcriptText: "播报当前任务进度" });
  });

  $("voiceUnheardBanner")?.addEventListener("click", (e) => {
    const replayAllBtn = e.target.closest("[data-voice-replay-all]");
    if (replayAllBtn) {
      ensureVoiceAudioUnlocked();
      void replayUnheardVoiceItems();
      return;
    }
    const dismissBtn = e.target.closest("[data-voice-dismiss-unheard]");
    if (dismissBtn) {
      clearUnheardVoiceQueue();
    }
  });

  $("voiceCallTranscript")?.addEventListener("click", (e) => {
    const replayBtn = e.target.closest("[data-voice-replay]");
    if (!replayBtn) return;
    const entryId = replayBtn.dataset.voiceReplay;
    if (!entryId) return;
    ensureVoiceAudioUnlocked();
    void replayVoiceTranscriptEntryById(entryId);
  });

  document.addEventListener("click", (e) => {
    if (!state.voice.callActive || state.voice.isSpeaking || state.voice.isProcessing || state.voice.isRecording) return;
    if (!state.voice.unheardQueue.some((u) => u.reason === "autoplay_blocked")) return;
    if (e.target.closest("#voiceModeBtn, #voiceUnheardBanner, #voiceCallTranscript, #voiceOrbBtn, #voiceTalkBtn, #voiceHangupBtn, #voiceMinimizeBtn")) return;
    ensureVoiceAudioUnlocked();
    void replayUnheardVoiceItems({ onlyBlocked: true });
  });

  $("voiceHangupBtn")?.addEventListener("click", () => hangupVoiceCall({ closeModal: true }));
  $("voiceMinimizeBtn")?.addEventListener("click", () => minimizeVoiceModal());
  $("voiceCloseHangupBtn")?.addEventListener("click", () => {
    state.voice.minimized = false;
  });

  $("voiceTextForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    ensureVoiceAudioUnlocked();
    const text = $("voiceTextInput").value.trim();
    if (!text) return;
    $("voiceTextInput").value = "";
    void sendVoiceTurnToMac({ transcriptText: text });
  });

  $("voiceLiveProgressList")?.addEventListener("click", async (e) => {
    const approveBtn = e.target.closest("[data-voice-approve]");
    if (approveBtn) {
      e.stopPropagation();
      const requestId = approveBtn.dataset.voiceApprove;
      const decision = approveBtn.dataset.voiceDecision === "decline" ? "decline" : "accept";
      const req = state.pendingRequests.find((r) => r.id === requestId);
      try {
        if (req?.kind === "acpPermission") {
          const opt = decision === "decline"
            ? (req.options || []).find((o) => /reject|deny/i.test(o.kind || "")) || req.options?.[req.options.length - 1]
            : (req.options || []).find((o) => /allow_once|allow_always/i.test(o.kind || "")) || req.options?.[0];
          await apiPost("api/server-request", {
            requestId,
            ...(opt?.optionId ? { optionId: opt.optionId } : { decision }),
          });
        } else {
          await apiPost("api/approval", { requestId, decision });
        }
        removePendingRequestById(requestId);
      } catch (error) {
        if (Number(error?.status) === 404) {
          removePendingRequestById(requestId);
          return;
        }
        showToastBanner("审批请求失败", { detail: formatActionError(error), error: true });
      }
      return;
    }

    const card = e.target.closest("[data-voice-progress-thread]");
    if (card) {
      const targetId = card.dataset.voiceProgressThread;
      if (targetId) {
        await selectThread(targetId, { focusScroll: true });
        minimizeVoiceModal();
      }
    }
  });

  $("voiceCopilotModal").addEventListener("close", () => {
    if (state.voice.minimized && state.voice.callActive) {
      renderVoiceCallUi();
      return;
    }
    hangupVoiceCall({ closeModal: false });
  });

  $("sidebarUpdateBtn")?.addEventListener("click", () => {
    setSidebarOpen(false);
    void openUpdateModal();
  });
  $("openUpdateModalBtn")?.addEventListener("click", () => void openUpdateModal());
  $("openAutomationsModalBtn")?.addEventListener("click", () => void openAutomationsModal());
  $("refreshAutomationsBtn")?.addEventListener("click", () => void refreshAutomations().catch(() => {}));
  $("automationsGlobalToggle")?.addEventListener("change", (e) => {
    void apiPost("api/automations/toggle", { enabled: Boolean(e.target.checked) })
      .then((snap) => {
        state.automationsSnapshot = snap;
        renderAutomationsModal(snap);
      })
      .catch(() => {});
  });
  $("automationCreateForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const prompt = $("autoPromptInput")?.value?.trim() || "";
    if (!prompt) return;
    try {
      const snap = await apiPost("api/automations/custom", {
        action: "create",
        name: $("autoNameInput")?.value?.trim() || "",
        provider: $("autoProviderSelect")?.value || "codex",
        rrule: $("autoScheduleSelect")?.value || "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
        cwd: $("autoCwdInput")?.value?.trim() || "",
        prompt,
      });
      state.automationsSnapshot = snap;
      renderAutomationsModal(snap);
      $("automationCreateForm")?.reset();
      const details = $("automationCreateDetails");
      if (details) details.open = false;
      showToastBanner("已添加定时任务并开启后台托管");
    } catch (error) {
      showToastBanner("创建定时任务失败", { detail: formatActionError(error), error: true });
    }
  });
  $("automationsList")?.addEventListener("click", async (e) => {
    const runBtn = e.target.closest("[data-auto-run]");
    if (runBtn) {
      const key = runBtn.dataset.autoRun;
      runBtn.disabled = true;
      try {
        const res = await apiPost("api/automations/run", { taskKey: key });
        if (res?.snapshot) {
          state.automationsSnapshot = res.snapshot;
          renderAutomationsModal(res.snapshot);
        }
        showToastBanner("已立即唤起执行定时任务", {
          detail: res?.threadId ? `已启动会话 ${res.threadId}` : "任务已在后台启动",
        });
      } catch (error) {
        showToastBanner("唤起定时任务失败", { detail: formatActionError(error), error: true });
      } finally {
        runBtn.disabled = false;
      }
      return;
    }
    const toggleBtn = e.target.closest("[data-auto-toggle]");
    if (toggleBtn) {
      const key = toggleBtn.dataset.autoToggle;
      const managed = toggleBtn.dataset.autoNextManaged === "1";
      const snap = await apiPost("api/automations/toggle", { taskKey: key, managed }).catch(() => null);
      if (snap) {
        state.automationsSnapshot = snap;
        renderAutomationsModal(snap);
      }
      return;
    }
    const delBtn = e.target.closest("[data-auto-delete]");
    if (delBtn) {
      const snap = await apiPost("api/automations/custom", { action: "delete", id: delBtn.dataset.autoDelete }).catch(() => null);
      if (snap) {
        state.automationsSnapshot = snap;
        renderAutomationsModal(snap);
      }
      return;
    }
    const openThreadBtn = e.target.closest("[data-auto-open-thread]");
    if (openThreadBtn) {
      const tid = openThreadBtn.dataset.autoOpenThread;
      $("automationsModal")?.close();
      if (tid) void selectThread(tid, { focusScroll: true }).catch(() => {});
    }
  });
  $("automationsModal")?.addEventListener("click", (e) => {
    if (e.target === $("automationsModal")) $("automationsModal").close();
  });
  $("restartServiceBtn")?.addEventListener("click", () => void triggerRestartService());
  $("applyDesktopUpdateBtn")?.addEventListener("click", () => void triggerDesktopAppUpdate());
  $("checkUpdateBtn")?.addEventListener("click", () => void triggerCheckUpdates());
  $("applyUpdateBtn")?.addEventListener("click", () => void triggerApplyUpdate());
  $("autoCheckUpdateToggle")?.addEventListener("change", (e) => {
    void saveUpdateConfig({ autoCheckEnabled: Boolean(e.target.checked) });
  });
  $("autoUpdateToggle")?.addEventListener("change", (e) => {
    void saveUpdateConfig({ autoUpdateEnabled: Boolean(e.target.checked) });
  });
  $("autoUpdateDesktopToggle")?.addEventListener("change", (e) => {
    void saveUpdateConfig({ autoUpdateDesktopApp: Boolean(e.target.checked) });
  });
  $("updateModal")?.addEventListener("click", (e) => {
    if (e.target === $("updateModal")) $("updateModal").close();
  });

  $("remoteModalBtn").addEventListener("click", () => void openRemoteModal());

  $("startTunnelBtn")?.addEventListener("click", async () => {
    if (state.tunnelBusy) return;
    state.tunnelBusy = true;
    renderTunnelStatus({ ...(state.tunnelStatus || {}), state: "starting", lastError: "" });
    try {
      const status = await apiPost("api/tunnel/start", {});
      state.tunnelBusy = false;
      renderTunnelStatus(status);
      showToastBanner("免费加密隧道已就绪", { detail: "手机扫码即可连接控制台" });
    } catch (error) {
      state.tunnelBusy = false;
      const latest = await apiGet("api/remote").catch(() => null);
      if (latest) {
        renderRemoteStatus(latest);
      } else {
        renderTunnelStatus({
          ...(state.tunnelStatus || {}),
          state: error?.code === "cloudflared_missing" ? "missing_binary" : "error",
          installed: error?.code !== "cloudflared_missing",
          lastError: formatActionError(error, "开启临时隧道失败"),
        });
      }
      const errEl = $("tunnelErrorText");
      if (errEl && error?.code !== "cloudflared_missing") {
        errEl.hidden = false;
        errEl.textContent = formatActionError(error, "开启临时隧道失败");
      }
    }
  });

  $("stopTunnelBtn")?.addEventListener("click", async () => {
    if (state.tunnelBusy) return;
    state.tunnelBusy = true;
    renderTunnelStatus(state.tunnelStatus);
    try {
      const status = await apiPost("api/tunnel/stop", {});
      state.tunnelBusy = false;
      renderTunnelStatus(status);
      showToastBanner("已关闭临时隧道并废止远程会话");
    } catch (error) {
      state.tunnelBusy = false;
      renderTunnelStatus(state.tunnelStatus);
      showToastBanner("关闭隧道失败", { detail: formatActionError(error), error: true });
    }
  });

  $("rotateTunnelBtn")?.addEventListener("click", async () => {
    if (state.tunnelBusy) return;
    state.tunnelBusy = true;
    renderTunnelStatus(state.tunnelStatus);
    try {
      const status = await apiPost("api/tunnel/rotate", {});
      state.tunnelBusy = false;
      renderTunnelStatus(status);
      if (status.fixedTunnel) renderFixedTunnelStatus(status.fixedTunnel);
      showToastBanner("已重置配对二维码", { detail: "旧手机会话已立即失效" });
    } catch (error) {
      state.tunnelBusy = false;
      renderTunnelStatus(state.tunnelStatus);
      showToastBanner("重置二维码失败", { detail: formatActionError(error), error: true });
    }
  });

  $("copyTunnelUrlBtn")?.addEventListener("click", async () => {
    const val = $("tunnelPairUrlInput")?.value;
    if (!val) return;
    await navigator.clipboard?.writeText(val).catch(() => {});
    $("copyTunnelUrlBtn").textContent = "已复制";
    setTimeout(() => { if ($("copyTunnelUrlBtn")) $("copyTunnelUrlBtn").textContent = "复制"; }, 1500);
  });

  $("copyBrewCmdBtn")?.addEventListener("click", async () => {
    const cmd = state.tunnelStatus?.installHint || $("tunnelInstallCmdCode")?.textContent || "brew install cloudflared";
    await navigator.clipboard?.writeText(cmd).catch(() => {});
    $("copyBrewCmdBtn").textContent = "已复制";
    setTimeout(() => { if ($("copyBrewCmdBtn")) $("copyBrewCmdBtn").textContent = "复制命令"; }, 1500);
  });

  $("startTsFunnelBtn")?.addEventListener("click", async () => {
    if (state.fixedTunnelBusy) return;
    state.fixedTunnelBusy = true;
    renderFixedTunnelStatus(state.fixedTunnelStatus || {});
    try {
      const res = await apiPost("api/tunnel/tailscale/start", {});
      state.fixedTunnelBusy = false;
      renderFixedTunnelStatus(res);
      showToastBanner("Tailscale Funnel 固定链接已就绪", { detail: res.fixedPublicUrl || "可扫码连接" });
    } catch (error) {
      state.fixedTunnelBusy = false;
      const latest = await apiGet("api/remote").catch(() => null);
      if (latest) {
        renderRemoteStatus(latest);
      } else {
        renderFixedTunnelStatus({
          ...(state.fixedTunnelStatus || {}),
          lastError: formatActionError(error, "开启 Tailscale Funnel 失败"),
        });
      }
      if ($("tsErrorText")) {
        $("tsErrorText").hidden = false;
        $("tsErrorText").textContent = formatActionError(error, "开启 Tailscale Funnel 失败");
      }
    }
  });

  $("stopTsFunnelBtn")?.addEventListener("click", async () => {
    if (state.fixedTunnelBusy) return;
    state.fixedTunnelBusy = true;
    renderFixedTunnelStatus(state.fixedTunnelStatus || {});
    try {
      const res = await apiPost("api/tunnel/tailscale/stop", {});
      state.fixedTunnelBusy = false;
      renderFixedTunnelStatus(res);
      showToastBanner("已关闭 Tailscale Funnel 并废止旧会话");
    } catch (error) {
      state.fixedTunnelBusy = false;
      renderFixedTunnelStatus(state.fixedTunnelStatus || {});
      showToastBanner("关闭 Funnel 失败", { detail: formatActionError(error), error: true });
    }
  });

  $("copyTsCmdBtn")?.addEventListener("click", async () => {
    const cmd = state.fixedTunnelStatus?.installHint || $("tsInstallCmdCode")?.textContent || "brew install --cask tailscale";
    await navigator.clipboard?.writeText(cmd).catch(() => {});
    $("copyTsCmdBtn").textContent = "已复制";
    setTimeout(() => { if ($("copyTsCmdBtn")) $("copyTsCmdBtn").textContent = "复制命令"; }, 1500);
  });

  $("fixedPairForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (state.fixedTunnelBusy) return;
    const publicUrl = String($("fixedPublicUrlInput")?.value || "").trim();
    if (!publicUrl) {
      showToastBanner("请输入固定公网域名（如 https://agent.example.com）", { error: true });
      return;
    }
    state.fixedTunnelBusy = true;
    renderFixedTunnelStatus(state.fixedTunnelStatus || {});
    try {
      const res = await apiPost("api/tunnel/fixed-pair", { publicUrl });
      state.fixedTunnelBusy = false;
      renderFixedTunnelStatus(res);
      showToastBanner("固定链接配对二维码已生成");
    } catch (error) {
      state.fixedTunnelBusy = false;
      renderFixedTunnelStatus(state.fixedTunnelStatus || {});
      showToastBanner("生成配对二维码失败", { detail: formatActionError(error), error: true });
    }
  });

  $("rotateFixedPairBtn")?.addEventListener("click", async () => {
    if (state.fixedTunnelBusy) return;
    state.fixedTunnelBusy = true;
    renderFixedTunnelStatus(state.fixedTunnelStatus || {});
    try {
      const status = await apiPost("api/tunnel/rotate", {});
      state.fixedTunnelBusy = false;
      renderTunnelStatus(status);
      if (status.fixedTunnel) renderFixedTunnelStatus(status.fixedTunnel);
      showToastBanner("已重置固定链接配对二维码", { detail: "旧手机会话已立即失效" });
    } catch (error) {
      state.fixedTunnelBusy = false;
      renderFixedTunnelStatus(state.fixedTunnelStatus || {});
      showToastBanner("重置二维码失败", { detail: formatActionError(error), error: true });
    }
  });

  $("clearFixedPairBtn")?.addEventListener("click", async () => {
    if (state.fixedTunnelBusy) return;
    state.fixedTunnelBusy = true;
    renderFixedTunnelStatus(state.fixedTunnelStatus || {});
    try {
      const res = await apiPost("api/tunnel/fixed-pair", { publicUrl: "" });
      state.fixedTunnelBusy = false;
      if ($("fixedPublicUrlInput")) $("fixedPublicUrlInput").value = "";
      renderFixedTunnelStatus(res);
      showToastBanner("已清除固定链接记录");
    } catch (error) {
      state.fixedTunnelBusy = false;
      renderFixedTunnelStatus(state.fixedTunnelStatus || {});
      showToastBanner("清除失败", { detail: formatActionError(error), error: true });
    }
  });

  $("copyFixedUrlBtn")?.addEventListener("click", async () => {
    const val = $("fixedPairUrlInput")?.value;
    if (!val) return;
    await navigator.clipboard?.writeText(val).catch(() => {});
    $("copyFixedUrlBtn").textContent = "已复制";
    setTimeout(() => { if ($("copyFixedUrlBtn")) $("copyFixedUrlBtn").textContent = "复制"; }, 1500);
  });

  $("remotePairForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const status = await apiPost("api/remote/pair", {
        relayUrl: $("relayUrlInput").value.trim(),
        inviteCode: $("inviteCodeInput").value.trim(),
        label: $("hostLabelInput").value.trim(),
      });
      renderRemoteStatus(status);
    } catch (error) {
      showToastBanner("配对失败", { detail: formatActionError(error), error: true });
    }
  });

  $("unpairBtn").addEventListener("click", async () => {
    try {
      const status = await apiPost("api/remote/unpair", {});
      renderRemoteStatus(status);
    } catch (error) {
      showToastBanner("撤销失败", { detail: formatActionError(error), error: true });
    }
  });

  $("copyPairUrlBtn").addEventListener("click", async () => {
    const val = $("remotePairUrlInput").value;
    if (!val) return;
    await navigator.clipboard?.writeText(val).catch(() => {});
    $("copyPairUrlBtn").textContent = "已复制";
    setTimeout(() => { $("copyPairUrlBtn").textContent = "复制"; }, 1500);
  });

  for (const btn of document.querySelectorAll("[data-close-modal]")) {
    btn.addEventListener("click", () => $(btn.dataset.closeModal)?.close());
  }

  const vp = $("messagesViewport");
  bindFollowIntent(vp, {
    pause: () => { state.autoFollow = false; },
    settle: () => {
      const distance = vp.scrollHeight - vp.scrollTop - vp.clientHeight;
      if (distance < 24) state.autoFollow = true;
    },
  });
}

let imageQueueChain = Promise.resolve();

function addComposerImageFile(file) {
  if (!file) return Promise.resolve();
  state.imageProcessingCount += 1;
  setComposerStatus("pending", "正在压缩优化图片…");
  renderComposerControls();

  const task = imageQueueChain.then(async () => {
    const compressedItem = await compressImageFileForUpload(file);
    const budget = validateImageBatchBudget(state.images, compressedItem.byteLength);
    if (!budget.ok) {
      throw new Error(budget.message || "图片数量或总大小超出限制");
    }
    state.images.push(compressedItem);
    renderComposerImages();
    renderComposerControls();
    const origBytes = Number(file.size) || 0;
    if (compressedItem.compressed && origBytes > compressedItem.byteLength * 1.3) {
      setComposerStatus(
        "success",
        `已添加图片（已优化至 ${formatByteSize(compressedItem.byteLength)}）`,
        { autoClearMs: 2200 },
      );
    } else if ($("composerStatus")?.classList.contains("is-pending")) {
      clearComposerStatus();
    }
  }).catch((error) => {
    const msg = error?.message || "读取或压缩图片失败";
    setComposerStatus("error", msg, { autoClearMs: 4200 });
    showToastBanner("添加图片失败", { detail: msg, error: true });
  }).finally(() => {
    state.imageProcessingCount = Math.max(0, state.imageProcessingCount - 1);
    renderComposerControls();
  });

  imageQueueChain = task.catch(() => {});
  return task;
}

function bindVisualViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const syncViewport = () => {
    if (vv.scale > 1.05) return;
    document.documentElement.style.setProperty("--app-height", `${Math.round(vv.height)}px`);
    document.documentElement.style.setProperty("--app-offset-top", `${Math.max(0, Math.round(vv.offsetTop))}px`);
    if (document.activeElement === $("promptInput")) {
      scrollViewportIfFollowing();
    }
  };
  syncViewport();
  vv.addEventListener("resize", syncViewport);
  vv.addEventListener("scroll", syncViewport);
}

let uiVersionCheckInFlight = false;
let lastUiHtmlEtag = "";
let activityPollTimer = null;
let activityPollInFlight = false;
let activityPollTick = 0;

function startLiveActivityPolling() {
  if (activityPollTimer) return;
  activityPollTimer = setInterval(async () => {
    if (document.visibilityState === "hidden" || activityPollInFlight) return;
    activityPollInFlight = true;
    activityPollTick += 1;
    try {
      const targetId = state.activeThreadId;
      if (!isBoardViewActive() && targetId && !state.initialThreadLoading) {
        const wasRunning = isActiveThreadRunning();
        if (wasRunning || (state.queuedTurns || []).length > 0 || activityPollTick % 4 === 0) {
          const cursorQs = state.activityCursor ? `&cursor=${encodeURIComponent(state.activityCursor)}` : "";
          const act = await apiGetWithHotFallback(`api/thread/activity?id=${encodeURIComponent(targetId)}${cursorQs}`).catch(() => null);
          if (state.activeThreadId === targetId && act) {
            const prevLive = Boolean(state.activeThread?.live);
            if (act.cursor) state.activityCursor = act.cursor;
            if (Array.isArray(act.queuedTurns)) {
              applyActiveQueuedTurns(targetId, act.queuedTurns);
            }
            const streamingTurnChanged = Boolean(
              act.streaming?.turnId
              && state.streamingTurnId
              && act.streaming.turnId !== state.streamingTurnId,
            );
            const serverClearedStreamText = Boolean(
              act.live
              && act.streaming
              && !act.streaming.text
              && state.streamingText,
            );
            const duplicatePersistedStream = Boolean(
              act.live
              && state.streamingText
              && isStreamingTextAlreadyPersisted(state.activeThread?.turns, state.streamingText),
            );
            let clearedStaleStream = false;
            if (!act.live && (prevLive || wasRunning)) {
              if (state.activeThread) state.activeThread.live = false;
              syncThreadSummaryIntoList({ id: targetId, live: false });
              state.liveActivity = { status: "completed" };
              state.streamingText = "";
              state.streamingThought = "";
              state.streamingTurnId = "";
            } else if (act.live && (streamingTurnChanged || serverClearedStreamText || duplicatePersistedStream)) {
              state.streamingText = "";
              if (!act.streaming?.thought) state.streamingThought = "";
              if (act.streaming?.turnId) state.streamingTurnId = act.streaming.turnId;
              clearedStaleStream = true;
            }
            const isImmediateTransition = clearedStaleStream || Boolean(act.live) !== prevLive || (!act.live && wasRunning);
            if (act.changed || isImmediateTransition) {
              const sinceLastReload = Date.now() - lastActiveThreadReloadDoneAt;
              if (!isImmediateTransition && act.live && lastActiveThreadReloadDoneAt > 0 && sinceLastReload < 4000) {
                if (act.activity) {
                  state.liveActivity = mergeLiveActivity(state.liveActivity, {
                    status: "running",
                    phase: act.activity.phase || "",
                    text: act.activity.text ?? act.activity.detail ?? "",
                  });
                  renderTopbarAndControls();
                }
                if (!activeThreadReloadInFlight) {
                  scheduleActiveThreadReload(targetId, Math.max(250, 4000 - sinceLastReload));
                }
              } else {
                await reloadActiveThreadProgress(targetId);
              }
            } else if (act.live && act.activity) {
              state.liveActivity = mergeLiveActivity(state.liveActivity, {
                status: "running",
                phase: act.activity.phase || "",
                text: act.activity.text ?? act.activity.detail ?? "",
              });
              renderTopbarAndControls();
            }
          }
        }
      }
      const sidebarVisible = Boolean($("sidebar")?.classList.contains("is-open")) || window.innerWidth > 900;
      const listPollTicks = (isBoardViewActive() || sidebarVisible) ? 6 : 12;
      if (activityPollTick % listPollTicks === 0 && !state.isSubmitting && (isBoardViewActive() || sidebarVisible || state.threads.some((t) => t.live || (t.queuedCount || 0) > 0))) {
        await refreshThreads().catch(() => {});
      }
    } finally {
      activityPollInFlight = false;
    }
  }, 2500);
}

async function checkUiVersionAndReloadIfStale() {
  if (uiVersionCheckInFlight || state.isSubmitting || state.voice?.isRecording || state.voice?.callActive) return;
  const currentMeta = document.querySelector('meta[name="ac-ui-version"]')?.getAttribute("content") || "";
  if (!currentMeta) return;
  const draft = $("promptInput")?.value || "";
  if (draft.trim()) return;

  uiVersionCheckInFlight = true;
  try {
    const headers = {};
    if (lastUiHtmlEtag) headers["If-None-Match"] = lastUiHtmlEtag;
    const res = await fetch("./", { cache: "no-store", credentials: "same-origin", headers });
    const etag = String(res.headers?.get("etag") || "").trim();
    if (etag) lastUiHtmlEtag = etag;
    if (res.status === 304) return;
    if (!res.ok) return;
    const html = await res.text();
    const matched = html.match(/<meta\s+name="ac-ui-version"\s+content="([^"]+)"/i);
    if (matched?.[1] && matched[1] !== currentMeta) {
      location.reload();
    }
  } catch {
    // Ignore transient network errors when returning from background.
  } finally {
    uiVersionCheckInFlight = false;
  }
}

async function init() {
  window.addEventListener("online", () => {
    if (!state.sseConnected || !state.eventSource || state.eventSource.readyState === EventSource.CLOSED) {
      connectEvents();
    }
    if (state.activeThreadId && !isBoardViewActive() && !state.initialThreadLoading) {
      void reloadActiveThreadProgress(state.activeThreadId);
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void checkUiVersionAndReloadIfStale();
      if (!state.sseConnected || !state.eventSource || state.eventSource.readyState === EventSource.CLOSED) {
        connectEvents();
      }
      if (state.activeThreadId && !isBoardViewActive() && !state.initialThreadLoading) {
        void reloadActiveThreadProgress(state.activeThreadId);
      }
      if (state.voice.callActive) {
        resumeVoiceAudioContextIfNeeded();
        renderVoiceUnheardBanner();
        renderVoiceCallUi();
      }
    }
  });
  hydrateDeclarativeIcons(document);
  bindVisualViewport();
  syncProfileSelectors();
  syncModelAndEffortSelectors();
  syncPermissionSelectors();
  bindEvents();
  connectEvents();
  startLiveActivityPolling();

  const initialThread = new URL(location.href).searchParams.get("thread") || "";
  const cachedThreadsPayload = loadCachedThreads();
  if (cachedThreadsPayload?.threads?.length) {
    state.threads = cachedThreadsPayload.threads.filter((t) => !isInternalVoiceThreadClient(t));
    state.projectsMeta = cachedThreadsPayload.projectsMeta || {};
    renderThreadList();
  }

  const modelsPromise = refreshModels().catch(() => {});
  const telemetryPromise = refreshTelemetry().catch(() => {});
  void refreshLocalApps().catch(() => {});
  void refreshUpdateStatus().catch(() => {});

  try {
    if (initialThread) {
      state.activeThreadId = initialThread;
      state.boardOpen = false;
      state.initialThreadLoading = true;
      syncWorkspaceVisibility();
      const turnListEl = $("turnList");
      if (turnListEl) {
        turnListEl.hidden = false;
        turnListEl.innerHTML = `<div class="empty-state" style="text-align:center;color:var(--text-muted);">正在加载会话…</div>`;
      }

      const provPromise = refreshProviders().then(() => {
        if (state.activeThread) {
          renderTopbarAndControls();
          syncProfileSelectors();
          syncModelAndEffortSelectors();
        }
      });
      const threadsPromise = refreshThreads();
      const threadPromise = selectThread(initialThread).then(() => true).catch((err) => {
        if (Number(err?.status) === 404) return false;
        throw err;
      });

      const threadLoaded = await threadPromise;
      state.initialThreadLoading = false;
      if (!threadLoaded) {
        await selectThread("");
      }
      const settled = await Promise.allSettled([provPromise, threadsPromise, modelsPromise, telemetryPromise]);
      const fatalErr = settled.find((r) => r.status === "rejected")?.reason;
      if (fatalErr) throw fatalErr;
      if (threadLoaded && state.activeThread) {
        renderTopbarAndControls();
        renderProjectTaskStrip();
        const hasTurns = Array.isArray(state.activeThread.turns) && state.activeThread.turns.length > 0;
        if (!hasTurns && state.threads.length && !state.threads.some((t) => t.id === initialThread)) {
          await selectThread("");
        }
      }
    } else {
      await Promise.all([
        refreshProviders(),
        refreshThreads(),
      ]);
      void modelsPromise;
      void telemetryPromise;
      renderTopbarAndControls();
      renderActiveMessages();
    }
  } catch (error) {
    state.initialThreadLoading = false;
    const errMsg = formatActionError(error, "初始化控制台失败");
    setComposerStatus("error", errMsg);
    showToastBanner("初始化失败", { detail: errMsg, sticky: true, error: true });
  }
  renderComposerControls();
  setInterval(() => {
    if (pruneExpiredSidebarPrefs(Date.now())) {
      renderThreadList();
    }
    renderAgentTelemetryBar();
    if (state.telemetryExpanded) void refreshExecutionStats();
  }, 60_000);
}

void init();
