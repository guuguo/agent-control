import assert from "node:assert/strict";
import test from "node:test";
import { prepareCrossPlatformSpawn } from "../src/platform.mjs";
import { CliMaintenanceManager, hasSignedInProfile } from "../src/providers/cli-maintenance.mjs";

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
