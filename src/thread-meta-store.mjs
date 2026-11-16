import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { defaultDataDir } from "./instance-identity.mjs";
import { normalizeWorkspacePath } from "./platform.mjs";
import { displayThreadTitle } from "./thread-display.mjs";
import { normalizedThreadName } from "./thread-name.mjs";

export function normalizeProjectCwd(cwd) {
  return normalizeWorkspacePath(cwd);
}

function cleanProjectAlias(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim().slice(0, 60);
}

function cleanProfileAlias(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim().slice(0, 40);
}

export function threadMetaPath(dataDir = defaultDataDir()) {
  return resolve(dataDir, "thread-meta.json");
}

export function profileHealthPath(dataDir = defaultDataDir()) {
  return resolve(dataDir, "profile-health.json");
}

async function writeJsonAtomic(filePath, payload) {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, filePath);
}

export function createThreadMetaStore({
  filePath = threadMetaPath(),
  profileFilePath = resolve(dirname(filePath), "profile-health.json"),
} = {}) {
  let state = { version: 1, threads: {}, projects: {}, profiles: {} };
  let loaded = false;
  let writeChain = Promise.resolve();
  let persistScheduled = null;
  let profileWriteChain = Promise.resolve();

  const readProfilesFile = async () => {
    try {
      const parsed = JSON.parse(await readFile(profileFilePath, "utf8"));
      const raw = parsed?.profiles && typeof parsed.profiles === "object" ? parsed.profiles : parsed;
      const profiles = {};
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const [key, item] of Object.entries(raw)) {
          if (!key || key === "version" || !item || typeof item !== "object" || Array.isArray(item)) continue;
          profiles[key] = { ...item };
        }
      }
      return profiles;
    } catch {
      return {};
    }
  };

  const loadProfilesFresh = async () => {
    const fresh = await readProfilesFile();
    if (Object.keys(fresh).length) {
      state.profiles = { ...(state.profiles || {}), ...fresh };
    }
    return state.profiles;
  };

  const ensureLoaded = async () => {
    if (loaded) return;
    loaded = true;
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8"));
      if (parsed && typeof parsed === "object") {
        const projects = {};
        if (parsed.projects && typeof parsed.projects === "object") {
          for (const [rawCwd, item] of Object.entries(parsed.projects)) {
            const key = normalizeProjectCwd(rawCwd);
            if (!key || !item || typeof item !== "object") continue;
            projects[key] = { ...item };
          }
        }
        const legacyProfiles = {};
        if (parsed.profiles && typeof parsed.profiles === "object") {
          for (const [key, item] of Object.entries(parsed.profiles)) {
            if (!key || !item || typeof item !== "object") continue;
            legacyProfiles[key] = { ...item };
          }
        }
        const fileProfiles = await readProfilesFile();
        state = {
          version: 1,
          threads: parsed.threads && typeof parsed.threads === "object" ? { ...parsed.threads } : {},
          projects,
          profiles: { ...legacyProfiles, ...fileProfiles },
        };
      }
    } catch {
      const fileProfiles = await readProfilesFile();
      state = { version: 1, threads: {}, projects: {}, profiles: fileProfiles };
    }
  };

  const persist = () => {
    if (!persistScheduled) {
      persistScheduled = Promise.resolve().then(() => {
        persistScheduled = null;
        const snapshot = {
          version: 1,
          threads: { ...state.threads },
          projects: { ...state.projects },
        };
        const next = writeChain.then(() => writeJsonAtomic(filePath, snapshot));
        writeChain = next.catch(() => {});
        return next;
      });
    }
    return persistScheduled;
  };

  return {
    filePath,
    profileFilePath,
    async load() {
      await ensureLoaded();
      return state;
    },
    get(compositeId) {
      return state.threads[compositeId] ? { ...state.threads[compositeId] } : null;
    },
    async setCustomName(compositeId, name) {
      await ensureLoaded();
      const clean = normalizedThreadName(name);
      const prev = state.threads[compositeId] || {};
      state.threads[compositeId] = {
        ...prev,
        customName: clean,
        updatedAt: Math.floor(Date.now() / 1000),
      };
      await persist();
      return { ...state.threads[compositeId] };
    },
    async setAutoTitle(
      compositeId,
      autoTitle,
      {
        sourceSig = "",
        isDrift = false,
        locked = false,
        domainKey = "",
        schemaVersion = 0,
      } = {},
    ) {
      await ensureLoaded();
      if (!compositeId) return null;
      const trimmed = String(autoTitle || "").trim();
      const clean = trimmed ? normalizedThreadName(trimmed) : "";
      const nextSig = String(sourceSig || "");
      const nextIsDrift = Boolean(clean && isDrift);
      const nextLocked = Boolean(clean && locked);
      const nextDomainKey = clean ? String(domainKey || "") : "";
      const nextSchemaVersion = clean ? (Number(schemaVersion) || 0) : 0;
      const prev = state.threads[compositeId] || {};
      if (
        (prev.autoTitle || "") === clean
        && (prev.autoTitleSourceSig || "") === nextSig
        && Boolean(prev.autoTitleIsDrift) === nextIsDrift
        && Boolean(prev.titleLocked) === nextLocked
        && (prev.titleDomainKey || "") === nextDomainKey
        && (Number(prev.titleSchemaVersion) || 0) === nextSchemaVersion
      ) {
        return { ...prev };
      }
      const now = Math.floor(Date.now() / 1000);
      state.threads[compositeId] = {
        ...prev,
        autoTitle: clean,
        autoTitleSourceSig: nextSig,
        autoTitleIsDrift: nextIsDrift,
        titleLocked: nextLocked,
        titleDomainKey: nextDomainKey,
        titleSchemaVersion: nextSchemaVersion,
        autoTitleUpdatedAt: clean ? now : 0,
        updatedAt: now,
      };
      await persist();
      return { ...state.threads[compositeId] };
    },
    async setArchived(compositeId, archived = true) {
      await ensureLoaded();
      const prev = state.threads[compositeId] || {};
      const nextArchived = Boolean(archived);
      state.threads[compositeId] = {
        ...prev,
        archived: nextArchived,
        archivedAt: nextArchived ? Math.floor(Date.now() / 1000) : null,
        updatedAt: Math.floor(Date.now() / 1000),
      };
      await persist();
      return { ...state.threads[compositeId] };
    },
    async setArchivedMany(compositeIds = [], archived = true) {
      await ensureLoaded();
      const nextArchived = Boolean(archived);
      const now = Math.floor(Date.now() / 1000);
      const updatedIds = [];
      for (const rawId of compositeIds) {
        const id = String(rawId || "").trim();
        if (!id) continue;
        const prev = state.threads[id] || {};
        state.threads[id] = {
          ...prev,
          archived: nextArchived,
          archivedAt: nextArchived ? now : null,
          updatedAt: now,
        };
        updatedIds.push(id);
      }
      if (updatedIds.length > 0) {
        await persist();
      }
      return {
        count: updatedIds.length,
        threadIds: updatedIds,
        archived: nextArchived,
      };
    },
    hasUnarchivedOverrides() {
      return Object.values(state.threads || {}).some((item) => item && item.archived === false);
    },
    async setThreadPrefs(compositeId, patch = {}) {
      await ensureLoaded();
      if (!compositeId) return null;
      const prev = state.threads[compositeId] || {};
      const next = { ...prev, updatedAt: Math.floor(Date.now() / 1000) };
      if (typeof patch.model === "string" && patch.model.trim()) {
        next.model = patch.model.trim();
      }
      if (typeof patch.reasoningEffort === "string") {
        next.reasoningEffort = patch.reasoningEffort.trim();
      }
      if (typeof patch.permissionMode === "string" && patch.permissionMode.trim()) {
        next.permissionMode = patch.permissionMode.trim();
      }
      state.threads[compositeId] = next;
      await persist();
      return { ...state.threads[compositeId] };
    },
    listProjects() {
      const out = {};
      for (const [key, item] of Object.entries(state.projects || {})) {
        out[key] = { ...item };
      }
      return out;
    },
    getProject(cwd) {
      const key = normalizeProjectCwd(cwd);
      return key && state.projects[key] ? { ...state.projects[key] } : null;
    },
    async setProjectMeta(cwd, patch = {}) {
      await ensureLoaded();
      const key = normalizeProjectCwd(cwd);
      if (!key) {
        throw Object.assign(new Error("项目路径 cwd 不能为空"), { status: 400 });
      }
      const prev = state.projects[key] || {};
      const now = Math.floor(Date.now() / 1000);
      const nextPinned = Object.hasOwn(patch, "pinned") ? Boolean(patch.pinned) : Boolean(prev.pinned);
      const nextAlias = Object.hasOwn(patch, "alias") ? cleanProjectAlias(patch.alias) : cleanProjectAlias(prev.alias);
      if (!nextPinned && !nextAlias) {
        delete state.projects[key];
        await persist();
        return { pinned: false, alias: "", pinnedAt: null, updatedAt: now };
      }
      const pinnedAt = nextPinned ? (prev.pinnedAt || now) : null;
      state.projects[key] = {
        ...prev,
        pinned: nextPinned,
        alias: nextAlias,
        pinnedAt,
        updatedAt: now,
      };
      await persist();
      return { ...state.projects[key] };
    },
    applyToThread(thread) {
      if (!thread?.id) return thread;
      const meta = state.threads[thread.id];
      if (!meta) return thread;
      const customName = meta.customName || "";
      const autoTitle = meta.autoTitle || "";
      const nextName = customName || autoTitle || thread.name || "";
      const nextTitle = customName
        || autoTitle
        || thread.title
        || displayThreadTitle({ ...thread, customName, name: nextName });
      return {
        ...thread,
        originalName: thread.originalName ?? thread.name ?? "",
        originalTitle: thread.originalTitle ?? thread.title ?? "",
        name: nextName,
        title: nextTitle,
        customName,
        autoTitle,
        autoTitleSourceSig: meta.autoTitleSourceSig || "",
        autoTitleIsDrift: Boolean(meta.autoTitleIsDrift),
        titleLocked: Boolean(meta.titleLocked),
        titleDomainKey: meta.titleDomainKey || "",
        titleSchemaVersion: Number(meta.titleSchemaVersion) || 0,
        archived: Boolean(meta.archived ?? thread.archived),
        ...(meta.model ? { model: meta.model } : {}),
        ...(meta.reasoningEffort ? { reasoningEffort: meta.reasoningEffort } : {}),
        ...(meta.permissionMode ? { permissionMode: meta.permissionMode } : {}),
      };
    },
    getProfileMeta(profileKey) {
      const key = String(profileKey || "").trim();
      return key && state.profiles?.[key] ? { ...state.profiles[key] } : null;
    },
    listProfilesMeta() {
      const out = {};
      for (const [key, item] of Object.entries(state.profiles || {})) {
        out[key] = { ...item };
      }
      return out;
    },
    async setProfileMeta(profileKey, patch = {}) {
      const key = String(profileKey || "").trim();
      if (!key) {
        throw Object.assign(new Error("实例标识 profileKey 不能为空"), { status: 400 });
      }
      const runUpdate = async () => {
        await ensureLoaded();
        await loadProfilesFresh();
        if (!state.profiles || typeof state.profiles !== "object") {
          state.profiles = {};
        }
        const prev = state.profiles[key] || {};
        const next = { ...prev };
        if (Object.hasOwn(patch, "status") && typeof patch.status === "string") {
          next.status = patch.status;
        }
        if (Object.hasOwn(patch, "reasonCode")) {
          next.reasonCode = String(patch.reasonCode || "");
        }
        if (Object.hasOwn(patch, "shortReason")) {
          next.shortReason = String(patch.shortReason || "");
        }
        if (Object.hasOwn(patch, "detail")) {
          next.detail = String(patch.detail || "").slice(0, 400);
        }
        if (Object.hasOwn(patch, "latencyMs")) {
          next.latencyMs = patch.latencyMs === null || patch.latencyMs === undefined
            ? null
            : Math.max(0, Math.round(Number(patch.latencyMs) || 0));
        }
        if (Object.hasOwn(patch, "checkedAt")) {
          next.checkedAt = Number(patch.checkedAt) || 0;
        }
        if (Object.hasOwn(patch, "cooldownUntil")) {
          next.cooldownUntil = Number(patch.cooldownUntil) || 0;
        }
        if (Object.hasOwn(patch, "disabled")) {
          next.disabled = Boolean(patch.disabled);
        }
        if (Object.hasOwn(patch, "alias")) {
          next.alias = cleanProfileAlias(patch.alias);
        }
        if (Object.hasOwn(patch, "autoAliasSignature")) {
          next.autoAliasSignature = String(patch.autoAliasSignature || "").slice(0, 240);
        }
        if (Object.hasOwn(patch, "autoAliasSource")) {
          next.autoAliasSource = String(patch.autoAliasSource || "").slice(0, 32);
        }
        next.updatedAt = Math.floor(Date.now() / 1000);
        state.profiles[key] = next;
        await writeJsonAtomic(profileFilePath, {
          version: 1,
          profiles: state.profiles,
        });
        return { ...next };
      };
      const op = profileWriteChain.then(runUpdate, runUpdate);
      profileWriteChain = op.catch(() => {});
      return op;
    },
    flush() {
      return Promise.all([persistScheduled || Promise.resolve(), writeChain, profileWriteChain]);
    },
  };
}
