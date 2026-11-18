import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderSystemdUnit } from "../scripts/service.mjs";
import { CodexProvider } from "../src/providers/codex-provider.mjs";

test("Linux 后台继承 Node 与用户 CLI 路径，并通过 Mock CLI 完成真实协议轮次", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(os.tmpdir(), "ac-linux-path-"));
  const cliDir = join(root, "custom-npm", "bin");
  const home = join(root, "codex-home");
  await Promise.all([cliDir, home].map((dir) => mkdir(dir, { recursive: true })));
  t.after(() => rm(root, { recursive: true, force: true }));
  await symlink(fileURLToPath(new URL("./helpers/mock-codex-cli.mjs", import.meta.url)), join(cliDir, "codex"));
  const unit = renderSystemdUnit({ homeDir: root, nodeBin: process.execPath, env: { PATH: cliDir } });
  const pathLine = unit.split("\n").find((line) => line.startsWith('Environment="PATH='));
  const pathValue = JSON.parse(pathLine.slice("Environment=".length)).slice("PATH=".length);
  assert.deepEqual(pathValue.split(":"), [...new Set([dirname(process.execPath), join(root, ".local", "bin"), join(root, ".npm-global", "bin"), cliDir, "/usr/local/bin", "/usr/bin", "/bin"])]);
  let completed = 0;
  const provider = new CodexProvider({
    env: { HOME: root, USERPROFILE: root, PATH: pathValue, CODEX_BIN: join(cliDir, "codex"), AGENT_CONTROL_CODEX_HOMES: JSON.stringify([{ id: "default", home }]) },
    onEvent: (event) => { if (event.method === "turn/completed") completed++; },
  });
  t.after(() => provider.close());
  const created = await provider.startThread({ profileId: "default", cwd: root, text: "检查 Linux 后台 PATH [COMPLETE_NOW]" });
  assert.equal(created.thread.cwd, root);
  const deadline = Date.now() + 3000;
  while (!completed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(completed, 1);
});

test("Linux 上用 systemd 原生工具验证生成的用户服务配置", { skip: process.platform !== "linux" }, async (t) => {
  const root = await mkdtemp(join(os.tmpdir(), "ac-systemd-verify-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const unitPath = join(root, "agent-control.service");
  const workingDir = join(root, "project with spaces");
  await mkdir(join(root, "logs"));
  await mkdir(workingDir);
  await writeFile(unitPath, renderSystemdUnit({ dataDir: root, rootDir: workingDir }));
  execFileSync("systemd-analyze", ["verify", unitPath], { stdio: "pipe" });
});
