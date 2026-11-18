import fs from "node:fs";
import os from "node:os";
import {
  execFileCrossPlatform,
  normalizePlatform,
  providerCandidatePaths,
  resolveExecutableCrossPlatform,
} from "../platform.mjs";

const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;
const DEFAULT_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function extractSemver(text) {
  const m = String(text || "").match(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
  return m ? m[1] : "";
}

export function compareSemver(a, b) {
  const parse = (v) => String(v || "").split("-")[0].split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i += 1) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return da > db ? 1 : -1;
  }
  return 0;
}

export const CLI_SPECS = Object.freeze({
  codex: {
    provider: "codex",
    label: "Codex CLI",
    binaryName: "codex",
    envVar: "CODEX_BIN",
    npmPackage: "@openai/codex",
    autoInstallable: true,
    manualHint: "请执行 npm install -g @openai/codex",
  },
  claude: {
    provider: "claude",
    label: "Claude Code CLI",
    binaryName: "claude",
    envVar: "CLAUDE_BIN",
    npmPackage: "@anthropic-ai/claude-code",
    autoInstallable: true,
    manualHint: "请执行 npm install -g @anthropic-ai/claude-code",
  },
  antigravity: {
    provider: "antigravity",
    label: "Antigravity CLI (agy)",
    binaryName: "agy",
    envVar: "AGY_BIN",
    npmPackage: "",
    scriptInstaller: {
      win32: {
        cmd: "powershell.exe",
        args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://antigravity.google/cli/install.ps1 | iex"],
      },
      unix: {
        cmd: "bash",
        args: ["-lc", "curl -fsSL https://antigravity.google/cli/install.sh | bash"],
      },
    },
    autoInstallable: true,
    manualHint: "请运行官方脚本安装 agy CLI（https://antigravity.google/cli/install.ps1 或 install.sh）",
  },
});

export function resolveRealCliExecutable(provider, {
  env = process.env,
  home = os.homedir(),
  platform = process.platform,
  resolveImpl = resolveExecutableCrossPlatform,
} = {}) {
  const spec = CLI_SPECS[provider];
  if (!spec) return null;
  const candidates = providerCandidatePaths(provider, { env, homeDir: home, platform });
  if (provider === "codex" && normalizePlatform(platform) !== "win32") {
    candidates.push("/usr/local/bin/codex");
  }
  return resolveImpl({
    envVar: spec.envVar,
    candidates,
    binaryName: spec.binaryName,
    env,
    platform,
    strictExplicit: false,
  }) || null;
}

export function hasSignedInProfile(profiles = [], provider) {
  return Array.isArray(profiles) && profiles.some(
    (profile) => profile?.provider === provider && Boolean(profile?.account?.signedIn || profile?.authenticated),
  );
}

export function resolveHomebrewCask(executablePath) {
  if (!executablePath) return "";
  try {
    const resolved = fs.realpathSync(executablePath);
    const match = resolved.match(/\/Caskroom\/([^/]+)\//);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

export class CliMaintenanceManager {
  #env;
  #home;
  #platform;
  #resolveExecutable;
  #execImpl;
  #cooldownMs;
  #state = new Map();
  #inFlight = new Map();
  #onUpdated;

  constructor({
    env = process.env,
    home = os.homedir(),
    platform = process.platform,
    resolveExecutableImpl = resolveExecutableCrossPlatform,
    execImpl = null,
    cooldownMs = DEFAULT_COOLDOWN_MS,
    onUpdated = null,
  } = {}) {
    this.#env = env;
    this.#home = home;
    this.#platform = platform;
    this.#resolveExecutable = resolveExecutableImpl;
    this.#execImpl = typeof execImpl === "function"
      ? execImpl
      : (cmd, args, opts) => execFileCrossPlatform(cmd, args, opts, { platform: this.#platform });
    this.#cooldownMs = cooldownMs;
    this.#onUpdated = typeof onUpdated === "function" ? onUpdated : null;
  }

  inspect(profiles = []) {
    const out = {};
    for (const [provider, spec] of Object.entries(CLI_SPECS)) {
      const hasAuth = hasSignedInProfile(profiles, provider);
      const executable = resolveRealCliExecutable(provider, {
        env: this.#env,
        home: this.#home,
        platform: this.#platform,
        resolveImpl: this.#resolveExecutable,
      });
      const prev = this.#state.get(provider) || {};
      const cliInstalled = Boolean(executable);
      let status = "idle";
      if (this.#inFlight.has(provider)) {
        status = "installing";
      } else if (cliInstalled) {
        status = "ready";
      } else if (hasAuth && spec.autoInstallable) {
        status = prev.lastError ? "error" : "missing_auto";
      } else if (hasAuth) {
        status = "missing_manual";
      }
      const installedVersion = cliInstalled ? (prev.installedVersion || "") : "";
      const latestVersion = cliInstalled ? (prev.latestVersion || "") : "";
      const updateAvailable = Boolean(
        cliInstalled
        && installedVersion
        && latestVersion
        && compareSemver(latestVersion, installedVersion) > 0,
      );
      out[provider] = {
        provider,
        label: spec.label,
        hasAuth,
        cliInstalled,
        executable,
        installedVersion,
        latestVersion,
        updateAvailable,
        updatable: Boolean(spec.npmPackage),
        autoInstallable: spec.autoInstallable,
        status,
        installing: this.#inFlight.has(provider),
        lastError: cliInstalled ? (prev.lastUpgradeError || "") : (prev.lastError || ""),
        lastCheckedAt: prev.lastCheckedAt || 0,
        lastUpdateCheckAt: prev.lastUpdateCheckAt || 0,
        lastAttemptAt: prev.lastAttemptAt || 0,
        manualHint: spec.manualHint,
      };
    }
    return out;
  }

  async installCli(provider, { force = false } = {}) {
    const spec = CLI_SPECS[provider];
    if (!spec) throw new Error(`Unsupported CLI provider: ${provider}`);
    const existing = resolveRealCliExecutable(provider, {
      env: this.#env,
      home: this.#home,
      platform: this.#platform,
      resolveImpl: this.#resolveExecutable,
    });
    if (existing) {
      this.#state.set(provider, { lastCheckedAt: Date.now(), lastAttemptAt: Date.now(), lastError: "" });
      return { provider, ok: true, alreadyInstalled: true, executable: existing };
    }
    if (!spec.autoInstallable || (!spec.npmPackage && !spec.scriptInstaller)) {
      this.#state.set(provider, {
        lastCheckedAt: Date.now(),
        lastAttemptAt: Date.now(),
        lastError: spec.manualHint,
      });
      return { provider, ok: false, manualRequired: true, message: spec.manualHint };
    }
    if (this.#inFlight.has(provider)) return this.#inFlight.get(provider);

    const prev = this.#state.get(provider);
    if (!force && prev?.lastAttemptAt && (Date.now() - prev.lastAttemptAt) < this.#cooldownMs) {
      return { provider, ok: false, skippedCooldown: true, message: prev.lastError || "冷却中" };
    }

    const run = (async () => {
      const isWin = normalizePlatform(this.#platform) === "win32";
      let installCmd = "";
      let installArgs = [];
      if (spec.npmPackage) {
        installCmd = this.#resolveExecutable({
          binaryName: "npm",
          env: this.#env,
          platform: this.#platform,
        }) || (isWin ? "npm.cmd" : "npm");
        installArgs = ["install", "-g", spec.npmPackage, "--no-audit", "--no-fund"];
      } else if (spec.scriptInstaller) {
        const entry = isWin ? spec.scriptInstaller.win32 : spec.scriptInstaller.unix;
        installCmd = entry.cmd;
        installArgs = entry.args;
      }
      try {
        await this.#execImpl(
          installCmd,
          installArgs,
          {
            env: this.#env,
            timeout: 180_000,
            windowsHide: true,
            shell: false,
          },
        );
        const resolvedAfter = resolveRealCliExecutable(provider, {
          env: this.#env,
          home: this.#home,
          platform: this.#platform,
          resolveImpl: this.#resolveExecutable,
        });
        this.#state.set(provider, {
          lastCheckedAt: Date.now(),
          lastAttemptAt: Date.now(),
          lastError: resolvedAfter ? "" : `已执行安装，但未检测到 ${spec.binaryName}，${spec.manualHint}`,
        });
        if (resolvedAfter && this.#onUpdated) {
          try { await this.#onUpdated(provider, resolvedAfter); } catch {}
        }
        return {
          provider,
          ok: Boolean(resolvedAfter),
          executable: resolvedAfter,
          message: resolvedAfter ? `${spec.label} 安装成功` : spec.manualHint,
        };
      } catch (err) {
        const message = String(err?.stderr || err?.message || err || "安装失败").trim().slice(0, 400);
        this.#state.set(provider, {
          lastCheckedAt: Date.now(),
          lastAttemptAt: Date.now(),
          lastError: message,
        });
        return { provider, ok: false, message };
      } finally {
        this.#inFlight.delete(provider);
      }
    })();

    this.#inFlight.set(provider, run);
    return run;
  }

  ensureMissingClis(profiles = []) {
    const snapshot = this.inspect(profiles);
    const triggered = [];
    for (const item of Object.values(snapshot)) {
      if (!item.hasAuth || item.cliInstalled || !item.autoInstallable || item.installing) continue;
      if (item.lastAttemptAt && (Date.now() - item.lastAttemptAt) < this.#cooldownMs) continue;
      triggered.push(item.provider);
      void this.installCli(item.provider);
    }
    return triggered;
  }

  #resolveNpmBin() {
    const isWin = normalizePlatform(this.#platform) === "win32";
    return this.#resolveExecutable({
      binaryName: "npm",
      env: this.#env,
      platform: this.#platform,
    }) || (isWin ? "npm.cmd" : "npm");
  }

  async readInstalledVersion(provider) {
    const executable = resolveRealCliExecutable(provider, {
      env: this.#env,
      home: this.#home,
      platform: this.#platform,
      resolveImpl: this.#resolveExecutable,
    });
    if (!executable) return "";
    try {
      const res = await this.#execImpl(executable, ["--version"], {
        env: this.#env,
        timeout: 5_000,
        windowsHide: true,
        shell: false,
      });
      const version = extractSemver(res?.stdout || res?.stderr || "");
      if (version) {
        const prev = this.#state.get(provider) || {};
        this.#state.set(provider, { ...prev, installedVersion: version });
      }
      return version;
    } catch {
      return "";
    }
  }

  async checkUpdates(profiles = [], { force = false, checkIntervalMs = DEFAULT_UPDATE_CHECK_INTERVAL_MS } = {}) {
    const snapshot = this.inspect(profiles);
    const npmBin = this.#resolveNpmBin();
    const now = Date.now();
    await Promise.all(Object.values(snapshot).map(async (item) => {
      const spec = CLI_SPECS[item.provider];
      if (!item.cliInstalled || !spec?.npmPackage) return;
      const prev = this.#state.get(item.provider) || {};
      if (!force && prev.lastUpdateCheckAt && (now - prev.lastUpdateCheckAt) < checkIntervalMs) {
        return;
      }
      const [installedVersion, latestRes] = await Promise.all([
        this.readInstalledVersion(item.provider),
        this.#execImpl(npmBin, ["view", spec.npmPackage, "version"], {
          env: this.#env,
          timeout: 15_000,
          windowsHide: true,
          shell: false,
        }).catch(() => null),
      ]);
      const latestVersion = extractSemver(latestRes?.stdout || latestRes || "") || prev.latestVersion || "";
      const nextPrev = this.#state.get(item.provider) || {};
      this.#state.set(item.provider, {
        ...nextPrev,
        ...(installedVersion ? { installedVersion } : {}),
        ...(latestVersion ? { latestVersion } : {}),
        lastUpdateCheckAt: Date.now(),
      });
    }));
    return this.inspect(profiles);
  }

  async upgradeCli(provider, { force = false } = {}) {
    const spec = CLI_SPECS[provider];
    if (!spec) throw new Error(`Unsupported CLI provider: ${provider}`);
    const existing = resolveRealCliExecutable(provider, {
      env: this.#env,
      home: this.#home,
      platform: this.#platform,
      resolveImpl: this.#resolveExecutable,
    });
    if (!existing) {
      return this.installCli(provider, { force });
    }
    if (!spec.npmPackage) {
      return { provider, ok: false, manualRequired: true, message: spec.manualHint };
    }
    if (this.#inFlight.has(provider)) return this.#inFlight.get(provider);

    const prev = this.#state.get(provider) || {};
    if (!force && prev.lastAttemptAt && (Date.now() - prev.lastAttemptAt) < this.#cooldownMs) {
      return { provider, ok: false, skippedCooldown: true, message: prev.lastUpgradeError || "冷却中" };
    }

    const run = (async () => {
      const caskName = resolveHomebrewCask(existing);
      const upgradeCmd = caskName
        ? (this.#resolveExecutable({ binaryName: "brew", env: this.#env, platform: this.#platform }) || "brew")
        : this.#resolveNpmBin();
      const upgradeArgs = caskName
        ? ["upgrade", "--cask", caskName]
        : ["install", "-g", `${spec.npmPackage}@latest`, "--no-audit", "--no-fund"];
      const beforeVersion = await this.readInstalledVersion(provider);
      try {
        await this.#execImpl(
          upgradeCmd,
          upgradeArgs,
          {
            env: this.#env,
            timeout: 180_000,
            windowsHide: true,
            shell: false,
          },
        );
        const afterVersion = await this.readInstalledVersion(provider);
        const resolvedAfter = resolveRealCliExecutable(provider, {
          env: this.#env,
          home: this.#home,
          platform: this.#platform,
          resolveImpl: this.#resolveExecutable,
        });
        const prevState = this.#state.get(provider) || {};
        this.#state.set(provider, {
          ...prevState,
          installedVersion: afterVersion || prevState.installedVersion || "",
          latestVersion: afterVersion || prevState.latestVersion || "",
          lastCheckedAt: Date.now(),
          lastAttemptAt: Date.now(),
          lastUpdateCheckAt: Date.now(),
          lastUpgradeError: "",
        });
        if (resolvedAfter && this.#onUpdated) {
          try {
            await this.#onUpdated(provider, resolvedAfter, {
              upgraded: true,
              beforeVersion,
              version: afterVersion,
            });
          } catch {}
        }
        return {
          provider,
          ok: true,
          upgraded: Boolean(afterVersion && afterVersion !== beforeVersion),
          beforeVersion,
          version: afterVersion,
          executable: resolvedAfter,
          message: afterVersion ? `${spec.label} 已更新到 ${afterVersion}` : `${spec.label} 更新完成`,
        };
      } catch (err) {
        const message = String(err?.stderr || err?.message || err || "升级失败").trim().slice(0, 400);
        const prevState = this.#state.get(provider) || {};
        this.#state.set(provider, {
          ...prevState,
          lastCheckedAt: Date.now(),
          lastAttemptAt: Date.now(),
          lastUpgradeError: message,
        });
        return { provider, ok: false, message };
      } finally {
        this.#inFlight.delete(provider);
      }
    })();

    this.#inFlight.set(provider, run);
    return run;
  }

  async ensureUpToDateClis(profiles = [], { isIdle = () => true, autoUpgrade = true, forceCheck = false } = {}) {
    const snapshot = await this.checkUpdates(profiles, { force: forceCheck });
    if (!autoUpgrade || !isIdle()) {
      return { checked: snapshot, upgraded: [] };
    }
    const upgraded = [];
    for (const item of Object.values(snapshot)) {
      if (!item.cliInstalled || !item.updatable || !item.updateAvailable || item.installing) continue;
      if (item.lastAttemptAt && (Date.now() - item.lastAttemptAt) < this.#cooldownMs) continue;
      if (!isIdle()) break;
      const res = await this.upgradeCli(item.provider);
      if (res?.ok) upgraded.push(item.provider);
    }
    return { checked: this.inspect(profiles), upgraded };
  }
}
