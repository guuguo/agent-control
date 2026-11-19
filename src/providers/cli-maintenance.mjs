import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

export function resolveHomebrewCask(executablePath, { realpathImpl = fs.realpathSync } = {}) {
  if (!executablePath) return "";
  let target = String(executablePath);
  try {
    target = realpathImpl(executablePath) || target;
  } catch {
    // Fall back to executablePath as-is when symlink cannot be resolved on disk.
  }
  const match = target.match(/\/Caskroom\/([^/]+)\//);
  return match ? match[1] : "";
}

export function detectCliInstallSource(executablePath, { realpathImpl = fs.realpathSync } = {}) {
  if (!executablePath) {
    return { source: "", caskName: "", formulaName: "", realPath: "" };
  }
  let realPath = String(executablePath);
  try {
    realPath = realpathImpl(executablePath) || realPath;
  } catch {
    // Fall back to raw executablePath when realpath fails.
  }

  const caskMatch = realPath.match(/\/Caskroom\/([^/]+)\//);
  if (caskMatch) {
    return {
      source: "homebrew-cask",
      caskName: caskMatch[1],
      formulaName: "",
      realPath,
    };
  }

  const cellarMatch = realPath.match(/\/Cellar\/([^/]+)\//);
  if (cellarMatch && !/[\\/]node_modules[\\/]/i.test(realPath)) {
    return {
      source: "homebrew-formula",
      caskName: "",
      formulaName: cellarMatch[1],
      realPath,
    };
  }

  if (/[\\/]node_modules[\\/]/i.test(realPath)) {
    return {
      source: "npm",
      caskName: "",
      formulaName: "",
      realPath,
    };
  }

  return {
    source: "standalone",
    caskName: "",
    formulaName: "",
    realPath,
  };
}

export function resolveSiblingTool(executablePath, toolName, { existsSyncImpl = fs.existsSync } = {}) {
  if (!executablePath || !toolName) return "";
  try {
    const dir = path.dirname(String(executablePath));
    if (!dir || dir === ".") return "";
    const candidate = path.join(dir, toolName);
    if (existsSyncImpl(candidate)) {
      return candidate;
    }
  } catch {
    // Ignore invalid paths.
  }
  return "";
}

export class CliMaintenanceManager {
  #env;
  #home;
  #platform;
  #resolveExecutable;
  #realpathImpl;
  #existsSyncImpl;
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
    realpathImpl = fs.realpathSync,
    existsSyncImpl = fs.existsSync,
    execImpl = null,
    cooldownMs = DEFAULT_COOLDOWN_MS,
    onUpdated = null,
  } = {}) {
    this.#env = env;
    this.#home = home;
    this.#platform = platform;
    this.#resolveExecutable = resolveExecutableImpl;
    this.#realpathImpl = typeof realpathImpl === "function" ? realpathImpl : fs.realpathSync;
    this.#existsSyncImpl = typeof existsSyncImpl === "function" ? existsSyncImpl : fs.existsSync;
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
      const installInfo = cliInstalled
        ? detectCliInstallSource(executable, { realpathImpl: this.#realpathImpl })
        : { source: "", caskName: "", formulaName: "", realPath: "" };
      let manualHint = spec.manualHint;
      if (installInfo.source === "homebrew-cask" && installInfo.caskName) {
        manualHint = `请执行 brew upgrade --cask ${installInfo.caskName}`;
      } else if (installInfo.source === "homebrew-formula" && installInfo.formulaName) {
        manualHint = `请执行 brew upgrade ${installInfo.formulaName}`;
      }

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
        installSource: cliInstalled ? installInfo.source : "",
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
        manualHint,
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
        installCmd = this.#resolveNpmBin();
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

  #resolveBrewBin(executablePath = "") {
    const sibling = resolveSiblingTool(executablePath, "brew", { existsSyncImpl: this.#existsSyncImpl });
    if (sibling) return sibling;
    return this.#resolveExecutable({
      binaryName: "brew",
      env: this.#env,
      platform: this.#platform,
    }) || "brew";
  }

  #resolveMatchingNpmBin(executablePath = "") {
    const isWin = normalizePlatform(this.#platform) === "win32";
    const toolName = isWin ? "npm.cmd" : "npm";
    const sibling = resolveSiblingTool(executablePath, toolName, { existsSyncImpl: this.#existsSyncImpl });
    if (sibling) return sibling;
    return this.#resolveNpmBin();
  }

  async #fetchLatestVersionForSource(spec, installInfo, executablePath, { env = this.#env } = {}) {
    if (installInfo?.source === "homebrew-cask" && installInfo.caskName) {
      const brewBin = this.#resolveBrewBin(executablePath);
      const res = await this.#execImpl(
        brewBin,
        ["info", "--cask", "--json=v2", installInfo.caskName],
        {
          env,
          timeout: 20_000,
          windowsHide: true,
          shell: false,
        },
      ).catch(() => null);
      if (!res?.stdout) return "";
      try {
        const parsed = JSON.parse(res.stdout);
        return extractSemver(parsed?.casks?.[0]?.version || "");
      } catch {
        return "";
      }
    }

    if (installInfo?.source === "homebrew-formula" && installInfo.formulaName) {
      const brewBin = this.#resolveBrewBin(executablePath);
      const res = await this.#execImpl(
        brewBin,
        ["info", "--json=v2", installInfo.formulaName],
        {
          env,
          timeout: 20_000,
          windowsHide: true,
          shell: false,
        },
      ).catch(() => null);
      if (!res?.stdout) return "";
      try {
        const parsed = JSON.parse(res.stdout);
        return extractSemver(parsed?.formulae?.[0]?.versions?.stable || "");
      } catch {
        return "";
      }
    }

    const npmBin = this.#resolveMatchingNpmBin(executablePath);
    const latestRes = await this.#execImpl(npmBin, ["view", spec.npmPackage, "version"], {
      env,
      timeout: 15_000,
      windowsHide: true,
      shell: false,
    }).catch(() => null);
    return extractSemver(latestRes?.stdout || latestRes || "");
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
    const now = Date.now();
    await Promise.all(Object.values(snapshot).map(async (item) => {
      const spec = CLI_SPECS[item.provider];
      if (!item.cliInstalled || !spec?.npmPackage) return;
      const prev = this.#state.get(item.provider) || {};
      if (!force && prev.lastUpdateCheckAt && (now - prev.lastUpdateCheckAt) < checkIntervalMs) {
        return;
      }
      const installInfo = detectCliInstallSource(item.executable, { realpathImpl: this.#realpathImpl });
      const [installedVersion, fetchedLatest] = await Promise.all([
        this.readInstalledVersion(item.provider),
        this.#fetchLatestVersionForSource(spec, installInfo, item.executable),
      ]);
      const latestVersion = fetchedLatest || prev.latestVersion || "";
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
      const installInfo = detectCliInstallSource(existing, { realpathImpl: this.#realpathImpl });
      const isHomebrew = installInfo.source === "homebrew-cask" || installInfo.source === "homebrew-formula";
      let upgradeCmd = "";
      let upgradeArgs = [];
      let upgradeEnv = this.#env;

      if (installInfo.source === "homebrew-cask" && installInfo.caskName) {
        upgradeCmd = this.#resolveBrewBin(existing);
        upgradeArgs = ["upgrade", "--cask", installInfo.caskName];
        upgradeEnv = { HOMEBREW_AUTO_UPDATE_SECS: "60", ...this.#env };
      } else if (installInfo.source === "homebrew-formula" && installInfo.formulaName) {
        upgradeCmd = this.#resolveBrewBin(existing);
        upgradeArgs = ["upgrade", installInfo.formulaName];
        upgradeEnv = { HOMEBREW_AUTO_UPDATE_SECS: "60", ...this.#env };
      } else {
        upgradeCmd = this.#resolveMatchingNpmBin(existing);
        upgradeArgs = ["install", "-g", `${spec.npmPackage}@latest`, "--no-audit", "--no-fund"];
      }

      const beforeVersion = await this.readInstalledVersion(provider);
      const expectedLatest = prev.latestVersion || "";
      try {
        await this.#execImpl(
          upgradeCmd,
          upgradeArgs,
          {
            env: upgradeEnv,
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

        const expectedUpgrade = Boolean(beforeVersion && expectedLatest && compareSemver(expectedLatest, beforeVersion) > 0);
        const versionAdvanced = Boolean(afterVersion && (!beforeVersion || compareSemver(afterVersion, beforeVersion) > 0));

        if (expectedUpgrade && !versionAdvanced) {
          if (isHomebrew) {
            const sourceLatest = await this.#fetchLatestVersionForSource(spec, installInfo, resolvedAfter || existing, { env: upgradeEnv });
            if (sourceLatest && afterVersion && compareSemver(sourceLatest, afterVersion) <= 0) {
              const sourceLabel = installInfo.source === "homebrew-cask" ? `Homebrew Cask (${installInfo.caskName})` : `Homebrew (${installInfo.formulaName})`;
              const message = `${sourceLabel} 当前最新即为 v${afterVersion}，尚未同步更高版本`;
              const prevState = this.#state.get(provider) || {};
              this.#state.set(provider, {
                ...prevState,
                installedVersion: afterVersion,
                latestVersion: sourceLatest,
                lastCheckedAt: Date.now(),
                lastAttemptAt: Date.now(),
                lastUpdateCheckAt: Date.now(),
                lastUpgradeError: message,
              });
              return {
                provider,
                ok: false,
                upgraded: false,
                beforeVersion,
                version: afterVersion,
                executable: resolvedAfter || existing,
                message,
              };
            }
          }

          const currentVerLabel = afterVersion ? `v${afterVersion}` : "旧版本";
          const message = isHomebrew
            ? `已执行 ${upgradeCmd}，但当前版本仍为 ${currentVerLabel}，请检查本机包管理器状态`
            : `已执行更新命令，但当前生效路径（${resolvedAfter || existing}）仍为 ${currentVerLabel}，可能存在多份安装路径遮蔽（如 Homebrew 与 nvm 并存）`;
          const prevState = this.#state.get(provider) || {};
          this.#state.set(provider, {
            ...prevState,
            ...(afterVersion ? { installedVersion: afterVersion } : {}),
            lastCheckedAt: Date.now(),
            lastAttemptAt: Date.now(),
            lastUpdateCheckAt: Date.now(),
            lastUpgradeError: message,
          });
          return {
            provider,
            ok: false,
            upgraded: false,
            beforeVersion,
            version: afterVersion,
            executable: resolvedAfter || existing,
            message,
          };
        }

        const prevState = this.#state.get(provider) || {};
        const nextLatest = (expectedLatest && afterVersion && compareSemver(afterVersion, expectedLatest) >= 0)
          ? afterVersion
          : (afterVersion || prevState.latestVersion || "");
        this.#state.set(provider, {
          ...prevState,
          installedVersion: afterVersion || prevState.installedVersion || "",
          latestVersion: nextLatest,
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
          upgraded: versionAdvanced,
          beforeVersion,
          version: afterVersion,
          executable: resolvedAfter,
          message: afterVersion ? `${spec.label} 已更新到 v${afterVersion}` : `${spec.label} 更新完成`,
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
