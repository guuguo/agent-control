import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, resolve } from "node:path";
import { defaultDataDir } from "./instance-identity.mjs";

export const MANAGED_PROFILE_PROVIDERS = new Set(["codex", "claude", "grok"]);

const RESERVED_PROFILE_IDS = new Set(["default", "home", "desktop", "cli", "env"]);

export function managedProfilesPath(dataDir = defaultDataDir()) {
  return resolve(dataDir, "managed-profiles.json");
}

function cleanName(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim().slice(0, 40);
}

function slugAscii(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^\.+/, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function expandHomePath(rawPath, homeDir = os.homedir()) {
  const clean = String(rawPath || "").trim();
  if (!clean) return "";
  if (clean === "~") return resolve(homeDir);
  if (clean.startsWith("~/") || clean.startsWith("~\\")) {
    return resolve(homeDir, clean.slice(2));
  }
  return resolve(clean);
}

async function pathExists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function canonicalPath(dirPath) {
  const resolved = resolve(dirPath);
  if (await pathExists(resolved)) {
    return realpath(resolved).catch(() => resolved);
  }
  return resolved;
}

async function writeJsonAtomic(filePath, payload) {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, filePath);
}

export async function readManagedProfiles(dataDir = "") {
  if (!dataDir) return [];
  try {
    const raw = JSON.parse(await readFile(managedProfilesPath(dataDir), "utf8"));
    const items = Array.isArray(raw?.profiles) ? raw.profiles : (Array.isArray(raw) ? raw : []);
    const out = [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const provider = String(item.provider || "").trim().toLowerCase();
      const id = String(item.id || "").trim();
      const name = cleanName(item.name || id);
      const home = String(item.home || "").trim();
      if (!MANAGED_PROFILE_PROVIDERS.has(provider) || !id || !home) continue;
      out.push({
        id,
        provider,
        name: name || id,
        home: resolve(home),
        createdAt: Number(item.createdAt) || 0,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function allocateUniqueId(name, provider, takenIds = new Set()) {
  let base = slugAscii(name);
  if (!base || RESERVED_PROFILE_IDS.has(base)) {
    const suffix = `${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 4)}`;
    base = `${provider}-${suffix}`;
  }
  if (!takenIds.has(base) && !RESERVED_PROFILE_IDS.has(base)) {
    return base;
  }
  let idx = 2;
  while (takenIds.has(`${base}-${idx}`) || RESERVED_PROFILE_IDS.has(`${base}-${idx}`)) {
    idx += 1;
  }
  return `${base}-${idx}`;
}

export async function createManagedProfile({
  dataDir = defaultDataDir(),
  provider = "",
  name = "",
  customHome = "",
  existingHomes = [],
  existingIds = [],
} = {}) {
  const cleanProvider = String(provider || "").trim().toLowerCase();
  if (!MANAGED_PROFILE_PROVIDERS.has(cleanProvider)) {
    throw Object.assign(new Error(`不支持创建该智能体的多开实例：${cleanProvider || "unknown"}`), {
      status: 400,
      code: "unsupported_managed_provider",
    });
  }
  const normalizedName = cleanName(name);
  if (!normalizedName) {
    throw Object.assign(new Error("实例名称不能为空"), {
      status: 400,
      code: "invalid_profile_name",
    });
  }

  const allManaged = await readManagedProfiles(dataDir);
  const sameProvider = allManaged.filter((item) => item.provider === cleanProvider);
  const takenIds = new Set([
    ...sameProvider.map((item) => item.id),
    ...(Array.isArray(existingIds) ? existingIds.map((item) => String(item || "").trim()).filter(Boolean) : []),
  ]);
  const id = allocateUniqueId(normalizedName, cleanProvider, takenIds);

  const rawCustomHome = String(customHome || "").trim();
  const home = rawCustomHome
    ? expandHomePath(rawCustomHome)
    : resolve(dataDir, "instances", cleanProvider, id);

  const targetCanon = await canonicalPath(home);
  const candidateHomes = [
    ...sameProvider.map((item) => item.home),
    ...(Array.isArray(existingHomes) ? existingHomes : []),
  ].filter(Boolean);
  for (const existing of candidateHomes) {
    if ((await canonicalPath(existing)) === targetCanon) {
      throw Object.assign(new Error("该实例目录已被占用"), {
        status: 409,
        code: "profile_home_conflict",
      });
    }
  }

  await mkdir(home, { recursive: true, mode: 0o700 });
  if (cleanProvider === "codex") {
    const configPath = resolve(home, "config.toml");
    if (!(await pathExists(configPath))) {
      const defaultConfig = [
        'sandbox_mode = "danger-full-access"',
        'approval_policy = "never"',
        "",
      ].join("\n");
      await writeFile(configPath, defaultConfig, { encoding: "utf8", mode: 0o600 });
    }
  }

  const entry = {
    id,
    provider: cleanProvider,
    name: normalizedName,
    home,
    createdAt: Math.floor(Date.now() / 1000),
  };
  await writeJsonAtomic(managedProfilesPath(dataDir), {
    version: 1,
    profiles: [...allManaged, entry],
  });
  return entry;
}

export async function deleteManagedProfile({
  dataDir = defaultDataDir(),
  provider = "",
  profileId = "",
} = {}) {
  const cleanProvider = String(provider || "").trim().toLowerCase();
  const cleanId = String(profileId || "").trim();
  const allManaged = await readManagedProfiles(dataDir);
  const target = allManaged.find((item) => item.provider === cleanProvider && item.id === cleanId);
  if (!target) {
    throw Object.assign(new Error("仅支持移除由 Agent Control 创建的托管多开实例"), {
      status: 404,
      code: "managed_profile_not_found",
    });
  }
  const remaining = allManaged.filter((item) => !(item.provider === cleanProvider && item.id === cleanId));
  await writeJsonAtomic(managedProfilesPath(dataDir), {
    version: 1,
    profiles: remaining,
  });
  return target;
}
