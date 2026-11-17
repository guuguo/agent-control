import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import {
  normalizePlatform,
  providerCandidatePaths,
  resolveExecutableCrossPlatform,
} from "../platform.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;

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
    execImpl = execFileAsync,
    cooldownMs = DEFAULT_COOLDOWN_MS,
    onUpdated = null,
  } = {}) {
    this.#env = env;
    this.#home = home;
    this.#platform = platform;
    this.#resolveExecutable = resolveExecutableImpl;
    this.#execImpl = execImpl;
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
      out[provider] = {
        provider,
        label: spec.label,
        hasAuth,
        cliInstalled,
        executable,
        autoInstallable: spec.autoInstallable,
        status,
        installing: this.#inFlight.has(provider),
        lastError: cliInstalled ? "" : (prev.lastError || ""),
        lastCheckedAt: prev.lastCheckedAt || 0,
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
      let useShell = false;
      if (spec.npmPackage) {
        installCmd = this.#resolveExecutable({
          binaryName: "npm",
          env: this.#env,
          platform: this.#platform,
        }) || (isWin ? "npm.cmd" : "npm");
        installArgs = ["install", "-g", spec.npmPackage, "--no-audit", "--no-fund"];
        useShell = isWin;
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
            shell: useShell,
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
}
