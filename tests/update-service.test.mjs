import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createAgentControlServer } from "../src/server.mjs";
import {
  bumpSemver,
  nextUiVersion,
  runBumpVersion,
} from "../scripts/bump-version.mjs";
import {
  computeDesktopSourceHash,
  DESKTOP_APP_NAME,
  parsePlistStrings,
  parsePorcelainDirtyFiles,
  readInstalledDesktopAppInfo,
  sanitizeRemoteUrl,
  UpdateService,
} from "../src/update-service.mjs";

function gitSync(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function setupLocalGitRemoteFixture(t) {
  const baseDir = await mkdtemp(resolve(os.tmpdir(), "ac-update-git-"));
  t.after(() => rm(baseDir, { recursive: true, force: true }));

  const bareDir = resolve(baseDir, "remote.git");
  const authorDir = resolve(baseDir, "author");
  const appDir = resolve(baseDir, "app");
  const dataDir = resolve(baseDir, "data");

  await mkdir(bareDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  execFileSync("git", ["init", "--bare", "--initial-branch=main", bareDir], { stdio: "pipe" });
  execFileSync("git", ["clone", bareDir, authorDir], { stdio: "pipe" });

  gitSync(authorDir, ["config", "user.email", "test@example.com"]);
  gitSync(authorDir, ["config", "user.name", "Tester"]);
  await mkdir(resolve(authorDir, "public"), { recursive: true });
  await writeFile(resolve(authorDir, "package.json"), JSON.stringify({ name: "agent-control", version: "0.1.0" }, null, 2), "utf8");
  await writeFile(resolve(authorDir, "public", "index.html"), '<meta name="ac-ui-version" content="20261116af" />\n', "utf8");
  await writeFile(resolve(authorDir, "node_modules_marker"), "ok\n", "utf8");
  gitSync(authorDir, ["add", "."]);
  gitSync(authorDir, ["commit", "-m", "init v0.1.0"]);
  gitSync(authorDir, ["push", "-u", "origin", "main"]);

  execFileSync("git", ["clone", "--branch", "main", bareDir, appDir], { stdio: "pipe" });
  gitSync(appDir, ["config", "user.email", "test@example.com"]);
  gitSync(appDir, ["config", "user.name", "Tester"]);
  await mkdir(resolve(appDir, "node_modules"), { recursive: true });

  return { baseDir, bareDir, authorDir, appDir, dataDir };
}

test("sanitizeRemoteUrl strips embedded credentials and parsePorcelainDirtyFiles parses status", () => {
  assert.equal(
    sanitizeRemoteUrl("https://user:ghp_secret123@github.com/guuguo/agent-control.git"),
    "https://github.com/guuguo/agent-control.git",
  );
  assert.equal(
    sanitizeRemoteUrl("git@github.com:guuguo/agent-control.git"),
    "git@github.com:guuguo/agent-control.git",
  );
  assert.deepEqual(parsePorcelainDirtyFiles(" M public/app.js\n?? temp.txt\n"), {
    dirty: true,
    dirtyCount: 2,
    dirtySample: ["public/app.js", "temp.txt"],
  });
  assert.deepEqual(parsePorcelainDirtyFiles(""), {
    dirty: false,
    dirtyCount: 0,
    dirtySample: [],
  });
});

test("UpdateService detects remote commits, blocks dirty apply, and updates cleanly with dependency & restart hooks", async (t) => {
  const { authorDir, appDir, dataDir } = await setupLocalGitRemoteFixture(t);

  let idleFlag = false;
  let npmCalls = 0;
  let restartCtx = null;
  const events = [];

  const service = new UpdateService({
    rootDir: appDir,
    dataDir,
    initialDelayMs: 60_000,
    idleRetryMs: 50,
    restartDelayMs: 10,
    execNpm: async (args) => {
      npmCalls += 1;
      assert.deepEqual(args.slice(0, 2), ["install", "--omit=dev"]);
      return { stdout: "added 0 packages", stderr: "" };
    },
    canAutoUpdateIdle: () => idleFlag,
    restartService: (ctx) => {
      restartCtx = ctx;
    },
    onStatusChange: (snap) => events.push(snap),
  });
  t.after(() => service.close());

  const initial = await service.load();
  assert.equal(initial.isGitRepo, true);
  assert.equal(initial.packageVersion, "0.1.0");
  assert.equal(initial.uiVersion, "20261116af");
  assert.equal(initial.updateState, "up_to_date");
  assert.equal(initial.hasUpdate, false);

  // Author pushes a new version modifying package.json & index.html
  await writeFile(resolve(authorDir, "package.json"), JSON.stringify({ name: "agent-control", version: "0.1.1" }, null, 2), "utf8");
  await writeFile(resolve(authorDir, "public", "index.html"), '<meta name="ac-ui-version" content="20261116zz" />\n', "utf8");
  gitSync(authorDir, ["add", "package.json", "public/index.html"]);
  gitSync(authorDir, ["commit", "-m", "feat: 发布 v0.1.1 自更新演示"]);
  gitSync(authorDir, ["push", "origin", "main"]);

  // Enable autoUpdate while busy (idleFlag = false) -> must detect update without restarting while busy.
  await service.configure({ autoCheckEnabled: true, autoUpdateEnabled: true, checkIntervalHours: 3 });
  const checked = await service.checkForUpdates({ silent: false });
  assert.equal(checked.updateState, "available");
  assert.equal(checked.hasUpdate, true);
  assert.equal(checked.behindCount, 1);
  assert.equal(checked.remoteVersion, "0.1.1");
  assert.equal(checked.pendingCommits.length, 1);
  assert.equal(checked.pendingCommits[0].subject, "feat: 发布 v0.1.1 自更新演示");
  assert.equal(restartCtx, null);

  // Dirty local working tree must block applyUpdate and preserve uncommitted edits.
  await writeFile(resolve(appDir, "local-wip.txt"), "do not overwrite\n", "utf8");
  await assert.rejects(() => service.applyUpdate({ reason: "manual" }), /未提交改动/);
  assert.equal(await readFile(resolve(appDir, "local-wip.txt"), "utf8"), "do not overwrite\n");

  // Clean working tree + idle -> one-click apply succeeds, runs npm install on package.json diff, and schedules restart.
  await rm(resolve(appDir, "local-wip.txt"), { force: true });
  idleFlag = true;
  const applyRes = await service.applyUpdate({ reason: "manual" });
  assert.equal(applyRes.ok, true);
  assert.equal(applyRes.updated, true);
  assert.equal(applyRes.restarting, true);
  assert.equal(applyRes.status.packageVersion, "0.1.1");
  assert.equal(applyRes.status.uiVersion, "20261116zz");
  assert.equal(applyRes.status.behindCount, 0);
  assert.equal(npmCalls, 1);

  await new Promise((r) => setTimeout(r, 40));
  assert.ok(restartCtx);
  assert.notEqual(restartCtx.fromSha, restartCtx.toSha);

  // Persisted settings survive reload.
  const reloaded = new UpdateService({ rootDir: appDir, dataDir });
  t.after(() => reloaded.close());
  const loadedState = await reloaded.load();
  assert.equal(loadedState.autoUpdateEnabled, true);
  assert.equal(loadedState.checkIntervalHours, 3);
  assert.equal(loadedState.lastUpdatedToSha, restartCtx.toSha);
});

test("HTTP /api/update/* endpoints and SSE ready payload expose check, config, and apply controls", async (t) => {
  const { authorDir, appDir, dataDir } = await setupLocalGitRemoteFixture(t);
  let restartCalled = false;

  const srv = await createAgentControlServer({
    port: 0,
    host: "127.0.0.1",
    dataDir,
    disableRelay: true,
    disableTunnel: true,
    disableUpdateCheck: true,
    providers: [],
    updateServiceOptions: {
      rootDir: appDir,
      initialDelayMs: 60_000,
      restartDelayMs: 10,
      execNpm: async () => ({ stdout: "", stderr: "" }),
      restartService: () => {
        restartCalled = true;
      },
    },
  });
  await srv.start();
  t.after(() => srv.close());

  const initialRes = await fetch(`${srv.url}/api/update`);
  assert.equal(initialRes.status, 200);
  const initialJson = await initialRes.json();
  assert.equal(initialJson.packageVersion, "0.1.0");
  assert.equal(initialJson.updateState, "up_to_date");

  // Push remote update and trigger /api/update/check
  await writeFile(resolve(authorDir, "package.json"), JSON.stringify({ name: "agent-control", version: "0.2.0" }, null, 2), "utf8");
  gitSync(authorDir, ["add", "package.json"]);
  gitSync(authorDir, ["commit", "-m", "chore: bump to 0.2.0"]);
  gitSync(authorDir, ["push", "origin", "main"]);

  const checkRes = await fetch(`${srv.url}/api/update/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(checkRes.status, 200);
  const checkJson = await checkRes.json();
  assert.equal(checkJson.hasUpdate, true);
  assert.equal(checkJson.remoteVersion, "0.2.0");

  const cfgRes = await fetch(`${srv.url}/api/update/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ autoCheckEnabled: true, autoUpdateEnabled: true }),
  });
  assert.equal(cfgRes.status, 200);
  const cfgJson = await cfgRes.json();
  assert.equal(cfgJson.autoUpdateEnabled, true);

  const applyRes = await fetch(`${srv.url}/api/update/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "manual" }),
  });
  assert.equal(applyRes.status, 200);
  const applyJson = await applyRes.json();
  assert.equal(applyJson.ok, true);
  assert.equal(applyJson.updated, true);
  assert.equal(applyJson.status.packageVersion, "0.2.0");

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(restartCalled, true);
});

test("bump-version scripts sync package.json, UI version, and CHANGELOG cleanly", async (t) => {
  assert.equal(bumpSemver("0.1.0", "patch"), "0.1.1");
  assert.equal(bumpSemver("0.1.0", "minor"), "0.2.0");
  assert.equal(bumpSemver("0.1.0", "major"), "1.0.0");
  assert.equal(bumpSemver("0.1.0", "2.3.4"), "2.3.4");

  const day = new Date(2026, 10, 16);
  assert.equal(nextUiVersion("20261116af", day), "20261116ag");
  assert.equal(nextUiVersion("20261115z", day), "20261116a");

  const tempRoot = await mkdtemp(resolve(os.tmpdir(), "ac-bump-ver-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  await mkdir(resolve(tempRoot, "public"), { recursive: true });
  await writeFile(resolve(tempRoot, "package.json"), JSON.stringify({ name: "agent-control", version: "0.1.0" }, null, 2), "utf8");
  await writeFile(resolve(tempRoot, "public", "index.html"), '<meta name="ac-ui-version" content="20261116af" />\n<script type="module" src="./app.js?v=20261116af"></script>\n', "utf8");
  await writeFile(resolve(tempRoot, "public", "app.js"), 'import { x } from "./icons.js?v=20261116af";\n', "utf8");
  await writeFile(resolve(tempRoot, "CHANGELOG.md"), "# 更新日志 (CHANGELOG)\n\n## v0.1.0 (2026-11-16)\n\n- init\n", "utf8");

  const res = runBumpVersion("0.2.0", { rootDir: tempRoot, date: day });
  assert.equal(res.oldVersion, "0.1.0");
  assert.equal(res.newVersion, "0.2.0");
  assert.equal(res.newUiVersion, "20261116ag");

  const pkg = JSON.parse(await readFile(resolve(tempRoot, "package.json"), "utf8"));
  assert.equal(pkg.version, "0.2.0");
  const html = await readFile(resolve(tempRoot, "public", "index.html"), "utf8");
  assert.match(html, /content="20261116ag"/);
  assert.match(html, /app\.js\?v=20261116ag/);
  const appJs = await readFile(resolve(tempRoot, "public", "app.js"), "utf8");
  assert.match(appJs, /icons\.js\?v=20261116ag/);
  const log = await readFile(resolve(tempRoot, "CHANGELOG.md"), "utf8");
  assert.match(log, /^# 更新日志 \(CHANGELOG\)\s+## v0\.2\.0 \(2026-11-16\)/);
});

test("UpdateService detects desktop shell drift, builds via /api/update/desktop, and syncs on applyUpdate", async (t) => {
  const { authorDir, appDir, dataDir, baseDir } = await setupLocalGitRemoteFixture(t);
  const desktopDir = resolve(baseDir, "Applications");
  const appBundle = resolve(desktopDir, DESKTOP_APP_NAME);

  await mkdir(resolve(authorDir, "desktop", "macos"), { recursive: true });
  await writeFile(resolve(authorDir, "desktop", "macos", "AgentControl.swift"), "// v1\n", "utf8");
  await writeFile(resolve(authorDir, "desktop", "macos", "Info.plist"), "<plist></plist>\n", "utf8");
  await writeFile(resolve(authorDir, "desktop", "macos", "build-app.sh"), "#!/usr/bin/env bash\n", "utf8");
  await writeFile(resolve(authorDir, "desktop", "macos", "render-icon.swift"), "// icon\n", "utf8");
  gitSync(authorDir, ["add", "."]);
  gitSync(authorDir, ["commit", "-m", "add desktop source"]);
  gitSync(authorDir, ["push", "origin", "main"]);
  gitSync(appDir, ["pull", "--ff-only", "origin", "main"]);

  async function writeDesktopBundle({ version, hash, buildNumber = "1", root = appDir }) {
    await mkdir(resolve(appBundle, "Contents"), { recursive: true });
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      `  <key>CFBundleShortVersionString</key><string>${version}</string>`,
      `  <key>CFBundleVersion</key><string>${buildNumber}</string>`,
      ...(hash ? [`  <key>AgentControlBuildHash</key><string>${hash}</string>`] : []),
      `  <key>AgentControlRepoRoot</key><string>${root}</string>`,
      '</dict></plist>',
    ].join("\n");
    await writeFile(resolve(appBundle, "Contents", "Info.plist"), xml, "utf8");
  }

  // Legacy 0.1.0 shell without AgentControlBuildHash should be flagged as outdated on darwin.
  await writeDesktopBundle({ version: "0.1.0", hash: "" });
  const parsedPlist = parsePlistStrings(await readFile(resolve(appBundle, "Contents", "Info.plist"), "utf8"));
  assert.equal(parsedPlist.CFBundleShortVersionString, "0.1.0");

  const initialDesktopInfo = await readInstalledDesktopAppInfo({
    rootDir: appDir,
    packageVersion: "0.1.0",
    platform: "darwin",
    installDir: desktopDir,
  });
  assert.equal(initialDesktopInfo.supported, true);
  assert.equal(initialDesktopInfo.installed, true);
  assert.equal(initialDesktopInfo.needsUpdate, true);
  assert.equal(initialDesktopInfo.state, "outdated");

  let buildCalls = 0;
  let relaunchCalls = 0;
  let serviceRestartCalls = 0;

  const srv = await createAgentControlServer({
    host: "127.0.0.1",
    port: 0,
    dataDir,
    disableRelay: true,
    disableTunnel: true,
    disableUpdateCheck: true,
    providers: [],
    updateServiceOptions: {
      rootDir: appDir,
      platform: "darwin",
      desktopInstallDir: desktopDir,
      initialDelayMs: 60_000,
      restartDelayMs: 10,
      execNpm: async () => ({ stdout: "", stderr: "" }),
      execDesktopBuild: async () => {
        buildCalls += 1;
        const pkg = JSON.parse(await readFile(resolve(appDir, "package.json"), "utf8"));
        const hash = await computeDesktopSourceHash(appDir, pkg.version);
        await writeDesktopBundle({ version: pkg.version, hash, buildNumber: String(buildCalls + 1) });
      },
      relaunchDesktopApp: async () => {
        relaunchCalls += 1;
      },
      restartService: () => {
        serviceRestartCalls += 1;
      },
    },
  });
  await srv.start();
  t.after(() => srv.close());

  const beforeStatus = await (await fetch(`${srv.url}/api/update`)).json();
  assert.equal(beforeStatus.desktopApp.needsUpdate, true);
  assert.equal(beforeStatus.autoUpdateDesktopApp, true);

  // Manual desktop rebuild via POST /api/update/desktop
  const desktopRes = await fetch(`${srv.url}/api/update/desktop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "manual" }),
  });
  assert.equal(desktopRes.status, 200);
  const desktopJson = await desktopRes.json();
  assert.equal(desktopJson.ok, true);
  assert.equal(desktopJson.rebuilt, true);
  assert.equal(desktopJson.status.desktopApp.needsUpdate, false);
  assert.equal(desktopJson.status.desktopApp.state, "up_to_date");
  assert.equal(buildCalls, 1);

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(relaunchCalls, 1);

  // Remote bump to 0.2.0 + Swift source change -> applyUpdate automatically rebuilds desktop shell too.
  await writeFile(resolve(authorDir, "package.json"), JSON.stringify({ name: "agent-control", version: "0.2.0" }, null, 2), "utf8");
  await writeFile(resolve(authorDir, "desktop", "macos", "AgentControl.swift"), "// v2\n", "utf8");
  gitSync(authorDir, ["add", "."]);
  gitSync(authorDir, ["commit", "-m", "release v0.2.0 with desktop shell update"]);
  gitSync(authorDir, ["push", "origin", "main"]);

  const applyRes = await fetch(`${srv.url}/api/update/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "manual" }),
  });
  assert.equal(applyRes.status, 200);
  const applyJson = await applyRes.json();
  assert.equal(applyJson.ok, true);
  assert.equal(applyJson.desktopRebuilt, true);
  assert.equal(applyJson.status.packageVersion, "0.2.0");
  assert.equal(applyJson.status.desktopApp.installedVersion, "0.2.0");
  assert.equal(applyJson.status.desktopApp.needsUpdate, false);
  assert.equal(buildCalls, 2);

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(serviceRestartCalls, 1);
  assert.equal(relaunchCalls, 2);
});
