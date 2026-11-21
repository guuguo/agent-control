import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PACKAGE_JSON_PATH = resolve(MODULE_DIR, "..", "package.json");

export const DEFAULT_PING_URL = "https://hub.guuguo.top/ping/agent-control";
export const DEFAULT_PING_INITIAL_DELAY_MS = 15_000;
export const DEFAULT_PING_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_PING_MIN_INTERVAL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_PING_TIMEOUT_MS = 5_000;

function isTruthyFlag(raw) {
  const clean = String(raw || "").trim().toLowerCase();
  return clean === "1" || clean === "true" || clean === "yes";
}

export function isTelemetryDisabled(env = process.env) {
  return isTruthyFlag(env?.AGENT_CONTROL_DISABLE_TELEMETRY)
    || isTruthyFlag(env?.DO_NOT_TRACK);
}

export function anonymizeInstanceId(instanceId = "") {
  const raw = String(instanceId || "").trim();
  if (!raw) return "";
  return createHash("sha256")
    .update(`agent-control:${raw}`)
    .digest("hex")
    .slice(0, 16);
}

async function readPackageVersion(packageJsonPath = DEFAULT_PACKAGE_JSON_PATH) {
  try {
    const raw = await readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw);
    return String(parsed?.version || "").trim() || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function readPingState(statePath) {
  if (!statePath) return null;
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    return null;
  }
}

async function writePingState(statePath, state) {
  if (!statePath) return;
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  const tempPath = `${statePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, statePath);
}

/**
 * Create a lightweight, opt-out anonymous startup/daily usage ping client.
 * Sends only anonymized instance hash, version, OS, arch, and Node major version.
 */
export function createUsagePing({
  dataDir = "",
  instanceId = "",
  version = "",
  env = process.env,
  disabled = false,
  pingUrl = String(env?.AGENT_CONTROL_PING_URL || DEFAULT_PING_URL).trim(),
  initialDelayMs = DEFAULT_PING_INITIAL_DELAY_MS,
  intervalMs = DEFAULT_PING_INTERVAL_MS,
  minIntervalMs = DEFAULT_PING_MIN_INTERVAL_MS,
  timeoutMs = DEFAULT_PING_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  const isDisabled = Boolean(disabled || isTelemetryDisabled(env) || !pingUrl || typeof fetchImpl !== "function");
  const statePath = dataDir ? resolve(dataDir, "ping-state.json") : "";
  const anonId = anonymizeInstanceId(instanceId);

  let initialTimer = null;
  let periodicTimer = null;
  let activeController = null;
  let closed = false;
  let inflight = null;

  async function pingOnce() {
    if (isDisabled || closed) return { sent: false, reason: "disabled" };

    const currentNow = now();
    const prev = await readPingState(statePath);
    const lastPingAt = Number(prev?.lastPingAt) || 0;
    if (lastPingAt > 0 && currentNow - lastPingAt < minIntervalMs) {
      return { sent: false, reason: "throttled" };
    }

    const resolvedVersion = version || (await readPackageVersion());
    const nodeMajor = String(process.versions?.node || "").split(".")[0] || "";
    const targetUrl = new URL(pingUrl);
    if (anonId) targetUrl.searchParams.set("id", anonId);
    targetUrl.searchParams.set("v", resolvedVersion);
    targetUrl.searchParams.set("os", process.platform);
    targetUrl.searchParams.set("arch", process.arch);
    if (nodeMajor) targetUrl.searchParams.set("node", nodeMajor);

    const controller = new AbortController();
    activeController = controller;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    timeoutId.unref?.();

    try {
      const res = await fetchImpl(targetUrl.toString(), {
        method: "GET",
        headers: {
          "User-Agent": `agent-control/${resolvedVersion} (${process.platform}; ${process.arch})`,
        },
        signal: controller.signal,
      });
      await writePingState(statePath, {
        lastPingAt: currentNow,
        lastStatus: Number(res?.status) || 0,
        version: resolvedVersion,
      }).catch(() => {});
      return { sent: true, status: Number(res?.status) || 0 };
    } catch {
      return { sent: false, reason: "network_error" };
    } finally {
      clearTimeout(timeoutId);
      if (activeController === controller) {
        activeController = null;
      }
    }
  }

  function triggerPing() {
    if (inflight) return inflight;
    inflight = pingOnce().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  return {
    get disabled() {
      return isDisabled;
    },
    pingOnce: triggerPing,
    start() {
      if (isDisabled || closed) return;
      if (!initialTimer) {
        initialTimer = setTimeout(() => {
          initialTimer = null;
          void triggerPing();
        }, Math.max(0, initialDelayMs));
        initialTimer.unref?.();
      }
      if (!periodicTimer && intervalMs > 0) {
        periodicTimer = setInterval(() => {
          void triggerPing();
        }, intervalMs);
        periodicTimer.unref?.();
      }
    },
    close() {
      closed = true;
      if (initialTimer) {
        clearTimeout(initialTimer);
        initialTimer = null;
      }
      if (periodicTimer) {
        clearInterval(periodicTimer);
        periodicTimer = null;
      }
      if (activeController) {
        try { activeController.abort(); } catch {}
        activeController = null;
      }
    },
  };
}
