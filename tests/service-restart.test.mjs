import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { restartLaunchAgent } from "../scripts/service.mjs";
import { CodexProvider } from "../src/providers/codex-provider.mjs";

test("managed Mac restart uses kickstart and propagates permission failures without unload/load fallback", () => {
  const calls = [];
  restartLaunchAgent({ uid: 501, execute: (...args) => calls.push(args) });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ["launchctl", ["kickstart", "-k", "gui/501/com.guuguo.agent-control"]]);
  const failure = Object.assign(new Error("Operation not permitted"), { status: 1 });
  let count = 0;
  assert.throws(() => restartLaunchAgent({ uid: 501, execute: () => { count++; throw failure; } }), (err) => err === failure);
  assert.equal(count, 1);
});

test("Codex existing thread sends the selected sandbox policy on every turn, including switching to Turbo", async (t) => {
  const root = await mkdtemp(resolve(os.tmpdir(), "ac-turn-policy-"));
  const home = resolve(root, "codex");
  await mkdir(home);
  t.after(() => rm(root, { recursive: true, force: true }));
  let completed = 0;
  const provider = new CodexProvider({
    env: { ...process.env, CODEX_BIN: fileURLToPath(new URL("./helpers/mock-codex-cli.mjs", import.meta.url)),
      AGENT_CONTROL_CODEX_HOMES: JSON.stringify([{ id: "default", home }]) },
    onEvent: (event) => { if (event.method === "turn/completed") completed++; },
  });
  t.after(() => provider.close());
  const thread = await provider.startThread({ cwd: root, permissionMode: "workspace" });
  for (const [mode, approvalPolicy, type] of [["workspace", "on-request", "workspaceWrite"], ["turbo", "never", "dangerFullAccess"], ["safe", "on-request", "readOnly"], ["full", "never", "dangerFullAccess"]]) {
    await writeFile(resolve(home, ".mock-expected-turn-policy"), JSON.stringify({ approvalPolicy, sandboxPolicy: { type } }));
    const before = completed;
    await provider.sendTurn({ profileId: "default", rawId: thread.thread.rawId, cwd: root, text: "检查权限 [COMPLETE_NOW]", permissionMode: mode });
    const deadline = Date.now() + 3000;
    while (completed === before && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(completed, before + 1, `${mode} turn must finish through the Mock protocol`);
  }
});
