import assert from "node:assert/strict";
import test from "node:test";
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
    execImpl: async (bin, args) => {
      calls.push({ bin, args });
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
  assert.equal(calls[1].bin, "powershell.exe");
  assert.deepEqual(updated, [{
    provider: "codex",
    executable: "C:\\Users\\Admin\\AppData\\Roaming\\npm\\codex.cmd",
  }]);

  const after = manager.inspect(profiles);
  assert.equal(after.codex.status, "ready");
  assert.equal(after.codex.cliInstalled, true);
});
