import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { renderTurnHtml } from "../public/markdown.js";

const output = JSON.stringify({ request: "查询配置", rows: Array.from({ length: 25 }, (_, id) => ({ id, value: `第 ${id} 项配置` })), describe_exports: null }, null, 2);
const turn = (status, text = output) => ({
  id: "command-json", status,
  items: [{ type: "commandExecution", command: "mock-cli config --json", status: "completed", aggregatedOutput: text }],
});
const unescape = (text) => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");

test("运行卡片明确标注末尾预览，并可展开读取完整 JSON", () => {
  const html = renderTurnHtml(turn("inProgress"));
  const live = html.slice(html.indexOf('<div class="live-progress-feed"'));
  assert.match(live, /<summary>输出末尾预览 · 展开查看<\/summary>/);
  assert.doesNotMatch(live, /<details[^>]*\bopen\b/);
  const full = live.match(/<pre class="tool-output">([\s\S]*?)<\/pre>/)?.[1];
  assert.deepEqual(JSON.parse(unescape(full)), JSON.parse(output));
  const snippet = live.match(/<pre class="live-cmd-snippet">([\s\S]*?)<\/pre>/)?.[1];
  assert.equal(unescape(snippet), '  ],\n  "describe_exports": null\n}');
});

test("已完成命令的展开明细保留 JSON 开头、中间字段和末尾", () => {
  const html = renderTurnHtml(turn("completed"));
  const full = html.match(/<pre class="tool-output">([\s\S]*?)<\/pre>/)?.[1];
  assert.ok(output.length > 800);
  assert.deepEqual(JSON.parse(unescape(full)), JSON.parse(output));
  assert.doesNotMatch(html, /class="live-progress-feed"/);
});

test("简短日志不标记省略，完整输出继续转义 HTML", () => {
  const html = renderTurnHtml(turn("inProgress", '<script>alert("测试")</script>\n完成'));
  assert.match(html, /<summary>命令输出 · 展开查看<\/summary>/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("输出更新后保留用户已展开的输出区域", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const code = source.slice(source.indexOf("function captureTurnListOpenKeys("), source.indexOf("function activeDisplayTurns("));
  const previous = { open: true }, next = { open: false };
  const block = (detail) => ({ getAttribute: () => "turn-json", querySelectorAll: (selector) => selector.includes(".live-cmd-output-details") ? [detail] : [] });
  vm.runInNewContext(`${code}\nrestoreTurnListOpenKeys([nextBlock], captureTurnListOpenKeys([previousBlock]));`, { previousBlock: block(previous), nextBlock: block(next) });
  assert.equal(next.open, true);
});
