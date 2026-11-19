import assert from "node:assert/strict";
import test from "node:test";
import { prepareCrossPlatformSpawn } from "../src/platform.mjs";
import {
  CliMaintenanceManager,
  detectCliInstallSource,
  hasSignedInProfile,
  resolveHomebrewCask,
  resolveSiblingTool,
} from "../src/providers/cli-maintenance.mjs";

test("hasSignedInProfile checks signedIn or authenticated flags per provider", () => {
  const profiles = [
    { provider: "codex", account: { signedIn: true } },
    { provider: "claude", account: { signedIn: false } },
    { provider: "grok", authenticated: true },
  ];
  assert.equal(hasSignedInProfile(profiles, "codex"), true);
  assert.equal(hasSignedInProfile(profiles, "claude"), false);
  assert.equal(hasSignedInProfile(profiles, "grok"), true);
  assert.equal(hasSignedInProfile(profiles, "antigravity"), false);
});

test("CliMaintenanceManager auto-installs missing npm-based CLI when auth exists", async () => {
  let installedCodex = false;
  const calls = [];
  const updated = [];
  const manager = new CliMaintenanceManager({
    platform: "win32",
    resolveExecutableImpl: ({ binaryName }) => {
      if (binaryName === "npm") return "C:\\Program Files\\nodejs\\npm.cmd";
      if (binaryName === "codex" && installedCodex) return "C:\\Users\\Admin\\AppData\\Roaming\\npm\\codex.cmd";
      return null;
    },
    execImpl: async (bin, args, opts) => {
      calls.push({ bin, args, opts });
      installedCodex = true;
      return { stdout: "added 1 package", stderr: "" };
    },
    onUpdated: async (provider, executable) => {
      updated.push({ provider, executable });
    },
  });

  const profiles = [
    { provider: "codex", account: { signedIn: true } },
    { provider: "antigravity", account: { signedIn: true } },
    { provider: "claude", account: { signedIn: false } },
  ];

  const initial = manager.inspect(profiles);
  assert.equal(initial.codex.status, "missing_auto");
  assert.equal(initial.antigravity.status, "missing_auto");
  assert.equal(initial.claude.status, "idle");

  const triggered = manager.ensureMissingClis(profiles);
  assert.deepEqual(triggered, ["codex", "antigravity"]);

  // Wait for async install microtasks to finish
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args.slice(0, 3), ["install", "-g", "@openai/codex"]);
  assert.equal(calls[0].opts.shell, false);
  assert.equal(calls[1].bin, "powershell.exe");

  const winPrepared = prepareCrossPlatformSpawn(
    "C:\\Program Files\\nodejs\\npm.cmd",
    ["install", "-g", "@openai/codex"],
    {},
    { platform: "win32", existsSyncImpl: () => false },
  );
  assert.equal(winPrepared.options.shell, false);
  assert.equal(winPrepared.options.windowsVerbatimArguments, true);
  assert.match(winPrepared.args[3], /^""C:\\Program Files\\nodejs\\npm\.cmd" install -g @openai\/codex"$/);
  assert.deepEqual(updated, [{
    provider: "codex",
    executable: "C:\\Users\\Admin\\AppData\\Roaming\\npm\\codex.cmd",
  }]);

  const after = manager.inspect(profiles);
  assert.equal(after.codex.status, "ready");
  assert.equal(after.codex.cliInstalled, true);
});

test("CliMaintenanceManager checks npm updates and upgrades outdated CLIs only when idle", async () => {
  let codexVersion = "0.162.0";
  const calls = [];
  const upgradedEvents = [];
  const manager = new CliMaintenanceManager({
    platform: "darwin",
    resolveExecutableImpl: ({ binaryName }) => {
      if (binaryName === "npm") return "/usr/local/bin/npm";
      if (binaryName === "codex") return "/usr/local/bin/codex";
      return null;
    },
    execImpl: async (bin, args) => {
      calls.push({ bin, args });
      if (bin === "/usr/local/bin/codex" && args[0] === "--version") {
        return { stdout: `codex-cli ${codexVersion}\n`, stderr: "" };
      }
      if (bin === "/usr/local/bin/npm" && args[0] === "view") {
        return { stdout: "0.166.0\n", stderr: "" };
      }
      if (bin === "/usr/local/bin/npm" && args[0] === "install" && args[2] === "@openai/codex@latest") {
        codexVersion = "0.166.0";
        return { stdout: "updated 1 package\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
    onUpdated: async (provider, executable, meta) => {
      upgradedEvents.push({ provider, executable, meta });
    },
  });

  const profiles = [{ provider: "codex", account: { signedIn: true } }];

  // Busy turn prevents auto-upgrade, while still reporting updateAvailable.
  const busyRes = await manager.ensureUpToDateClis(profiles, {
    isIdle: () => false,
    autoUpgrade: true,
    forceCheck: true,
  });
  assert.deepEqual(busyRes.upgraded, []);
  assert.equal(busyRes.checked.codex.installedVersion, "0.162.0");
  assert.equal(busyRes.checked.codex.latestVersion, "0.166.0");
  assert.equal(busyRes.checked.codex.updateAvailable, true);

  // Idle state triggers npm install -g @openai/codex@latest.
  const idleRes = await manager.ensureUpToDateClis(profiles, {
    isIdle: () => true,
    autoUpgrade: true,
    forceCheck: false,
  });
  assert.deepEqual(idleRes.upgraded, ["codex"]);
  assert.equal(idleRes.checked.codex.installedVersion, "0.166.0");
  assert.equal(idleRes.checked.codex.updateAvailable, false);
  assert.equal(upgradedEvents.length, 1);
  assert.equal(upgradedEvents[0].meta.beforeVersion, "0.162.0");
  assert.equal(upgradedEvents[0].meta.version, "0.166.0");
  assert.ok(calls.some((c) => c.args[0] === "install" && c.args[2] === "@openai/codex@latest"));
});

test("detectCliInstallSource distinguishes Homebrew Cask, Homebrew Formula (non-node), npm, and standalone binaries", () => {
  assert.deepEqual(
    detectCliInstallSource("/opt/homebrew/bin/claude", {
      realpathImpl: () => "/opt/homebrew/Caskroom/claude-code/2.1.311/claude",
    }),
    {
      source: "homebrew-cask",
      caskName: "claude-code",
      formulaName: "",
      realPath: "/opt/homebrew/Caskroom/claude-code/2.1.311/claude",
    },
  );
  assert.equal(
    resolveHomebrewCask("/opt/homebrew/bin/claude", {
      realpathImpl: () => "/opt/homebrew/Caskroom/claude-code/2.1.311/claude",
    }),
    "claude-code",
  );
  assert.deepEqual(
    detectCliInstallSource("/opt/homebrew/bin/codex", {
      realpathImpl: () => "/opt/homebrew/Cellar/node@24/24.18.0/lib/node_modules/@openai/codex/bin/codex.js",
    }),
    {
      source: "npm",
      caskName: "",
      formulaName: "",
      realPath: "/opt/homebrew/Cellar/node@24/24.18.0/lib/node_modules/@openai/codex/bin/codex.js",
    },
  );
  assert.deepEqual(
    detectCliInstallSource("/opt/homebrew/bin/some-cli", {
      realpathImpl: () => "/opt/homebrew/Cellar/some-cli/1.2.3/bin/some-cli",
    }),
    {
      source: "homebrew-formula",
      caskName: "",
      formulaName: "some-cli",
      realPath: "/opt/homebrew/Cellar/some-cli/1.2.3/bin/some-cli",
    },
  );
  assert.equal(
    resolveSiblingTool("/custom/nvm/v24/bin/codex", "npm", {
      existsSyncImpl: (p) => p === "/custom/nvm/v24/bin/npm",
    }),
    "/custom/nvm/v24/bin/npm",
  );
});

test("CliMaintenanceManager checks Homebrew Cask source for Cask-managed CLI and only triggers real Cask upgrades", async () => {
  let installedCaskVersion = "2.1.311";
  let remoteCaskVersion = "2.1.311";
  const calls = [];
  const manager = new CliMaintenanceManager({
    platform: "darwin",
    resolveExecutableImpl: ({ binaryName }) => {
      if (binaryName === "claude") return "/opt/homebrew/bin/claude";
      if (binaryName === "brew") return "/opt/homebrew/bin/brew";
      if (binaryName === "npm") return "/Users/test/.local/bin/npm";
      return null;
    },
    realpathImpl: (p) => (p === "/opt/homebrew/bin/claude"
      ? `/opt/homebrew/Caskroom/claude-code/${installedCaskVersion}/claude`
      : p),
    existsSyncImpl: (p) => p === "/opt/homebrew/bin/brew",
    execImpl: async (bin, args) => {
      calls.push({ bin, args });
      if (bin === "/opt/homebrew/bin/claude" && args[0] === "--version") {
        return { stdout: `${installedCaskVersion} (Claude Code)\n`, stderr: "" };
      }
      if (bin === "/opt/homebrew/bin/brew" && args[0] === "info" && args[1] === "--cask") {
        return { stdout: JSON.stringify({ casks: [{ token: "claude-code", version: remoteCaskVersion }] }), stderr: "" };
      }
      if (bin === "/opt/homebrew/bin/brew" && args[0] === "upgrade" && args[2] === "claude-code") {
        installedCaskVersion = remoteCaskVersion;
        return { stdout: "==> Upgrading claude-code\n", stderr: "" };
      }
      throw new Error(`Unexpected command: ${bin} ${args.join(" ")}`);
    },
  });

  const profiles = [{ provider: "claude", account: { signedIn: true } }];
  // When Homebrew Cask is still on 2.1.311, do NOT query npm and do NOT report false updateAvailable.
  const firstCheck = await manager.checkUpdates(profiles, { force: true });
  assert.equal(firstCheck.claude.installSource, "homebrew-cask");
  assert.equal(firstCheck.claude.installedVersion, "2.1.311");
  assert.equal(firstCheck.claude.latestVersion, "2.1.311");
  assert.equal(firstCheck.claude.updateAvailable, false);
  assert.equal(firstCheck.claude.manualHint, "请执行 brew upgrade --cask claude-code");
  assert.equal(calls.some((c) => c.bin.includes("npm")), false);

  // When Homebrew Cask publishes 2.1.328, checkUpdates reports it and upgradeCli upgrades cleanly.
  remoteCaskVersion = "2.1.328";
  const secondCheck = await manager.checkUpdates(profiles, { force: true });
  assert.equal(secondCheck.claude.latestVersion, "2.1.328");
  assert.equal(secondCheck.claude.updateAvailable, true);

  const upRes = await manager.upgradeCli("claude", { force: true });
  assert.equal(upRes.ok, true);
  assert.equal(upRes.upgraded, true);
  assert.equal(upRes.beforeVersion, "2.1.311");
  assert.equal(upRes.version, "2.1.328");
  const afterInspect = manager.inspect(profiles);
  assert.equal(afterInspect.claude.installedVersion, "2.1.328");
  assert.equal(afterInspect.claude.updateAvailable, false);
});

test("CliMaintenanceManager reports honest failure when upgrade leaves active version unchanged and prefers sibling npm", async () => {
  const npmCalls = [];
  const shadowedManager = new CliMaintenanceManager({
    platform: "darwin",
    resolveExecutableImpl: ({ binaryName }) => {
      if (binaryName === "codex") return "/custom/nvm/v24/bin/codex";
      if (binaryName === "npm") return "/wrong/global/bin/npm";
      return null;
    },
    realpathImpl: (p) => (p === "/custom/nvm/v24/bin/codex"
      ? "/custom/nvm/v24/lib/node_modules/@openai/codex/bin/codex.js"
      : p),
    existsSyncImpl: (p) => p === "/custom/nvm/v24/bin/npm",
    execImpl: async (bin, args) => {
      npmCalls.push({ bin, args });
      if (bin === "/custom/nvm/v24/bin/codex" && args[0] === "--version") {
        return { stdout: "codex-cli 0.160.0\n", stderr: "" };
      }
      if (bin === "/custom/nvm/v24/bin/npm" && args[0] === "view") {
        return { stdout: "0.170.0\n", stderr: "" };
      }
      if (bin === "/custom/nvm/v24/bin/npm" && args[0] === "install") {
        // Simulates command succeeding with exit 0 while effective binary stays at 0.160.0
        return { stdout: "added 1 package\n", stderr: "" };
      }
      throw new Error(`Unexpected bin: ${bin}`);
    },
  });

  const profiles = [{ provider: "codex", account: { signedIn: true } }];
  const checked = await shadowedManager.checkUpdates(profiles, { force: true });
  assert.equal(checked.codex.updateAvailable, true);
  assert.ok(npmCalls.every((c) => c.bin !== "/wrong/global/bin/npm"));
  assert.ok(npmCalls.some((c) => c.bin === "/custom/nvm/v24/bin/npm" && c.args[0] === "view"));

  const failedUpgrade = await shadowedManager.upgradeCli("codex", { force: true });
  assert.equal(failedUpgrade.ok, false);
  assert.equal(failedUpgrade.upgraded, false);
  assert.match(failedUpgrade.message, /多份安装路径遮蔽/);

  const after = shadowedManager.inspect(profiles);
  // Real latestVersion must be preserved instead of faking 0.160.0 as latest, and error is surfaced.
  assert.equal(after.codex.installedVersion, "0.160.0");
  assert.equal(after.codex.latestVersion, "0.170.0");
  assert.equal(after.codex.updateAvailable, true);
  assert.match(after.codex.lastError, /多份安装路径遮蔽/);
});
