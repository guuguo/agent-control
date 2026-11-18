import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import { createThreadMetaStore } from "../src/thread-meta-store.mjs";
import { CodexProvider } from "../src/providers/codex-provider.mjs";
import { createAgentControlServer } from "../src/server.mjs";
import { buildProjectGroups, renderSidebarThreadListHtml } from "../public/project-board.js";

test("会话置顶持久保存，取消置顶保留模型、思考、名称及归档设置", async (t) => {
  const root = await mkdtemp(resolve(os.tmpdir(), "ac-thread-pin-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = resolve(root, "thread-meta.json"), id = "codex:default:thread";
  const store = createThreadMetaStore({ filePath });
  await store.setThreadPrefs(id, { model: "gpt-6.1-sol", reasoningEffort: "high", permissionMode: "turbo" });
  await store.setCustomName(id, "需要置顶的会话");
  await store.setArchived(id, true);
  const before = store.get(id);
  await store.setPinned(id, true);
  const reloaded = createThreadMetaStore({ filePath });
  await reloaded.load();
  const thread = reloaded.applyToThread({ id, cwd: "/project-a", updatedAt: 10 });
  assert.equal(thread.pinned, true);
  assert.equal(thread.updatedAt, 10);
  assert.equal(thread.reasoningEffort, "high");
  await reloaded.setPinned(id, false);
  assert.deepEqual(reloaded.get(id), { ...before, pinned: false });
});

test("只在项目内优先排序，旧置顶会话保持可见，项目整体顺序不变", () => {
  const now = Math.floor(Date.now() / 1000);
  const threads = [
    { id: "old-pin", title: "较早置顶会话", cwd: "/project-a", updatedAt: now - 10 * 86400, pinned: true },
    { id: "new-a", title: "A 最新", cwd: "/project-a", updatedAt: now - 1 },
    { id: "second-a", title: "A 次新", cwd: "/project-a", updatedAt: now - 2 },
    { id: "new-b", title: "B 最新", cwd: "/project-b", updatedAt: now },
  ];
  const groups = buildProjectGroups(threads);
  assert.deepEqual(groups.map((g) => g.cwd), ["/project-b", "/project-a"]);
  assert.deepEqual(groups[1].threads.map((item) => item.id), ["old-pin", "new-a", "second-a"]);
  assert.equal(groups[1].pinned, false);
  const options = { nowMs: now * 1000, autoFoldProjects: false, maxVisiblePerGroup: 1 };
  const html = renderSidebarThreadListHtml(groups, options);
  assert.match(html, /data-thread-id="old-pin"/);
  assert.match(html, /thread-pin-marker[^>]*title="已在当前项目置顶"/);
  threads[0].pinned = false;
  const unpinned = buildProjectGroups(threads);
  assert.deepEqual(unpinned[1].threads.map((item) => item.id), ["new-a", "second-a", "old-pin"]);
  assert.doesNotMatch(renderSidebarThreadListHtml(unpinned, options), /data-thread-id="old-pin"/);
});

test("三个点菜单支持置顶和取消置顶，不打开或中断会话", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function openThreadContextMenu(");
  const fn = source.slice(start, source.indexOf("\n}", start) + 2);
  const thread = { id: "codex:default:menu-pin", title: "菜单测试", pinned: false };
  let menu, handler, refreshed = 0;
  const requests = [];
  const ctx = vm.createContext({
    state: { threads: [thread], activeThreadId: "another-thread" },
    window: { innerWidth: 800, innerHeight: 700, addEventListener() {}, removeEventListener() {} },
    document: { createElement: () => (menu = { style: {}, setAttribute() {}, getBoundingClientRect: () => ({ width: 200, height: 240 }), addEventListener: (_name, cb) => { handler = cb; } }),
      body: { appendChild() {} }, addEventListener() {}, removeEventListener() {} },
    closeThreadContextMenu() {}, iconSvg: () => "", activeThreadContextMenu: null,
    apiPost: async (path, body) => { requests.push({ path, ...JSON.parse(JSON.stringify(body)) }); },
    refreshThreads: async () => { refreshed++; },
  });
  vm.runInContext(fn, ctx);
  ctx.openThreadContextMenu(thread.id, 10, 20);
  assert.match(menu.innerHTML, /data-menu-action="pin"[^>]*>[\s\S]*?在当前项目置顶/);
  const click = () => handler({ target: { closest: () => ({ dataset: { menuAction: "pin" } }) } });
  await click();
  thread.pinned = true;
  ctx.openThreadContextMenu(thread.id, 10, 20);
  assert.match(menu.innerHTML, /取消项目内置顶/);
  await click();
  assert.deepEqual(requests, [
    { path: "api/thread/pin", threadId: thread.id, pinned: true },
    { path: "api/thread/pin", threadId: thread.id, pinned: false },
  ]);
  assert.equal(refreshed, 2);
  assert.equal(ctx.state.activeThreadId, "another-thread");
});

test("HTTP 置顶只更新控制台元数据，列表和详情返回置顶状态", async (t) => {
  const root = await mkdtemp(resolve(os.tmpdir(), "ac-thread-pin-http-"));
  const home = resolve(root, "codex"), dataDir = resolve(root, "data");
  await mkdir(home, { recursive: true });
  const env = { ...process.env, HOME: root, USERPROFILE: root, AGENT_CONTROL_DISABLE_AUTOMATIONS: "1",
    CODEX_BIN: fileURLToPath(new URL("./helpers/mock-codex-cli.mjs", import.meta.url)),
    AGENT_CONTROL_CODEX_HOMES: JSON.stringify([{ id: "default", home }]) };
  const server = await createAgentControlServer({ port: 0, env, dataDir, providers: [new CodexProvider({ env, dataDir })], disableRelay: true, disableTunnel: true, disableUpdateCheck: true });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  await server.start();
  const started = await server.hub.startThread({ provider: "codex", profileId: "default", cwd: root,
    model: "gpt-6.1-sol", effort: "high", text: "置顶接口测试 [COMPLETE_NOW]" });
  const id = started.thread.id;
  for (const pinned of [true, false]) {
    const response = await fetch(`${server.url}/api/thread/pin`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ threadId: id, pinned }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, threadId: id, pinned });
    const list = await (await fetch(`${server.url}/api/threads`)).json();
    assert.equal(list.threads.find((item) => item.id === id)?.pinned, pinned);
    const detail = await server.hub.readThread(id, { detail: "full" });
    assert.equal(detail.thread.pinned, pinned);
    assert.equal(detail.thread.reasoningEffort, "high");
  }
});
