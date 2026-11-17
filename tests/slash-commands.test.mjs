import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  applySlashCommandSelection,
  filterSlashCommands,
  parseSlashTrigger,
  renderSlashMenuHtml,
} from "../public/slash-commands.js";
import { ProviderHub } from "../src/provider-hub.mjs";
import { createAgentControlServer } from "../src/server.mjs";
import { listSlashCommands } from "../src/slash-commands.mjs";

test("listSlashCommands 按智能体隔离高频原生命令、扫描工作流并按搜索过滤技能", async (t) => {
  const home = await mkdtemp(resolve(os.tmpdir(), "ac-slash-home-"));
  const cwd = await mkdtemp(resolve(os.tmpdir(), "ac-slash-cwd-"));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  await mkdir(resolve(home, ".gemini", "antigravity", "global_workflows"), { recursive: true });
  await writeFile(
    resolve(home, ".gemini", "antigravity", "global_workflows", "vibe-coding.md"),
    "---\ndescription: 快速原型与迭代工作流\n---\n# Vibe Coding\n",
    "utf8",
  );

  await mkdir(resolve(home, ".claude", "commands"), { recursive: true });
  await writeFile(
    resolve(home, ".claude", "commands", "deploy-check.md"),
    "# 发布前校验清单\n检查构建与环境变量",
    "utf8",
  );

  // 高频置顶技能 + 普通技能（无 query 时不展示普通技能）
  await mkdir(resolve(home, ".agents", "skills", "diagnose"), { recursive: true });
  await writeFile(
    resolve(home, ".agents", "skills", "diagnose", "SKILL.md"),
    "---\nname: diagnose\ndescription: 疑难缺陷与性能定位闭环\n---\n",
    "utf8",
  );
  await mkdir(resolve(home, ".agents", "skills", "gg-clean-mac"), { recursive: true });
  await writeFile(
    resolve(home, ".agents", "skills", "gg-clean-mac", "SKILL.md"),
    "---\nname: gg-clean-mac\ndescription: 安全清理 macOS 缓存与磁盘空间\n---\n",
    "utf8",
  );

  const agyPinned = await listSlashCommands({ provider: "antigravity", cwd, homeDir: home, useCache: false });
  assert.ok(agyPinned.some((c) => c.command === "/goal"));
  assert.ok(agyPinned.some((c) => c.command === "/plan"));
  assert.ok(agyPinned.some((c) => c.command === "/vibe-coding"));
  assert.ok(agyPinned.some((c) => c.command === "/diagnose"));
  assert.ok(!agyPinned.some((c) => c.command === "/deploy-check"), "Antigravity 不应混入 Claude 专属命令");
  assert.ok(!agyPinned.some((c) => c.command === "/gg-clean-mac"), "无搜索词时不铺出未置顶技能");

  const claudePinned = await listSlashCommands({ provider: "claude", cwd, homeDir: home, useCache: false });
  assert.ok(claudePinned.some((c) => c.command === "/deploy-check"));
  assert.ok(!claudePinned.some((c) => c.command === "/teamwork"), "Claude 不应混入 Antigravity 专属命令");

  const codexSearch = await listSlashCommands({
    provider: "codex",
    cwd,
    query: "clean",
    homeDir: home,
    useCache: false,
  });
  const matchedSkill = codexSearch.find((c) => c.id === "skill:gg-clean-mac");
  assert.ok(matchedSkill, "输入关键词时应检索到未置顶技能");
  assert.equal(matchedSkill.command, "$gg-clean-mac", "Codex 技能前缀应自动使用 $");
});

test("前端 slash trigger 仅在行首触发且不误伤文件路径", () => {
  assert.deepEqual(parseSlashTrigger("/pl", 3), {
    triggerPrefix: "/",
    query: "pl",
    start: 0,
    end: 3,
  });
  assert.deepEqual(parseSlashTrigger("第一行\n$dia", 8), {
    triggerPrefix: "$",
    query: "dia",
    start: 4,
    end: 8,
  });
  assert.equal(parseSlashTrigger("修改 src/app.js", 15), null);

  const applied = applySlashCommandSelection(
    "/pl",
    { command: "/plan", insertText: "/plan " },
    parseSlashTrigger("/pl", 3),
  );
  assert.deepEqual(applied, { text: "/plan ", cursorPos: 6 });

  const filtered = filterSlashCommands([
    { command: "/plan", description: "规划", pinned: true, priority: 95 },
    { command: "/gg-clean-mac", description: "清理", pinned: false, priority: 30 },
  ], "");
  assert.equal(filtered.length, 1);

  const html = renderSlashMenuHtml([
    { id: "native:agy:plan", label: "/plan", command: "/plan", description: "先规划后动手", category: "native", categoryLabel: "原生" },
  ], 0);
  assert.match(html, /slash-command-item is-active/);
  assert.match(html, /\/plan/);
});

test("HTTP GET /api/slash-commands 返回当前引擎常用指令列表", async (t) => {
  const dir = await mkdtemp(resolve(os.tmpdir(), "ac-slash-http-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const hub = new ProviderHub({ dataDir: dir, providers: [], enableQueueDrain: false });
  const srv = await createAgentControlServer({ hub, host: "127.0.0.1", port: 0, disableRelay: true, dataDir: dir });
  await hub.init();
  await srv.start();
  t.after(async () => {
    await srv.close();
    await hub.close();
  });

  const res = await fetch(`${srv.url}/api/slash-commands?provider=codex`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.items));
  assert.ok(body.items.some((item) => item.command === "/goal"));
  assert.ok(body.items.some((item) => item.command === "/review"));
});
