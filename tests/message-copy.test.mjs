import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { escapeHtml, renderMessageCopyButton, renderTurnHtml } from "../public/markdown.js";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const clipboardHelper = source.match(/async function copyTextToClipboard\(text\) \{[\s\S]*?\n\}/)?.[0];
const clickBinding = source.match(/\$\("messagesViewport"\)\?\.addEventListener\("click", async \(e\) => \{[\s\S]*?\n  \}\);/)?.[0];
assert.ok(clipboardHelper && clickBinding);

test("user and agent messages expose copyable Markdown without hidden goal markers or HTML injection", () => {
  const text = '**原文**\n\n```js\nconsole.log("<tag> & 文本");\n```';
  const html = renderTurnHtml({ status: "completed", items: [
    { type: "userMessage", content: [{ type: "text", text }] },
    { type: "agentMessage", text: `${text}<!-- GOAL_COMPLETE -->` },
  ] });
  assert.equal((html.match(/data-copy-message=/g) || []).length, 2);
  assert.equal(html.split(`data-copy-message="${escapeHtml(text)}"`).length - 1, 2);
  assert.doesNotMatch(html, /GOAL_COMPLETE|<tag>/);
  assert.equal(renderMessageCopyButton("   "), "");
  assert.doesNotMatch(renderTurnHtml({ items: [{ type: "userMessage", content: [{ type: "image", url: "data:image/png;base64,AA==" }] }] }), /data-copy-message/);
});

test("message click copies only its source and restores feedback after repeated clicks", async () => {
  const writes = [];
  const timers = new Map();
  const classes = new Set();
  const label = { textContent: "复制" };
  const text = "# 回复\n\n[链接](/tmp/a.md)";
  const button = {
    dataset: { copyMessage: text },
    closest: () => null,
    querySelector: () => label,
    classList: { add: (v) => classes.add(v), remove: (v) => classes.delete(v) },
  };
  let listener;
  vm.runInNewContext(`${clipboardHelper}\n${clickBinding}`, {
    navigator: { clipboard: { writeText: async (value) => writes.push(value) } },
    $: () => ({ addEventListener: (_, handler) => { listener = handler; } }),
    setTimeout: (handler) => { const id = Symbol(); timers.set(id, handler); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  const event = { target: { closest: (selector) => selector === "[data-copy-message]" ? button : null } };
  await listener(event);
  assert.equal(label.textContent, "已复制");
  await listener(event);
  assert.deepEqual(writes, [text, text]);
  assert.equal(timers.size, 1);
  for (const handler of timers.values()) handler();
  assert.equal(label.textContent, "复制");
  assert.equal(classes.has("is-copied"), false);
});

test("clipboard falls back to browser copy when Clipboard API is denied", async () => {
  let field;
  let copied = "";
  let removed = false;
  const copy = vm.runInNewContext(`(${clipboardHelper})`, {
    navigator: { clipboard: { writeText: async () => { throw new Error("denied"); } } },
    document: {
      createElement: () => (field = { style: {}, setAttribute() {}, select() {} }),
      body: { appendChild() {}, removeChild() { removed = true; } },
      execCommand: () => { copied = field.value; return true; },
    },
  });
  assert.equal(await copy("```\n保留格式\n```"), true);
  assert.equal(copied, "```\n保留格式\n```");
  assert.equal(removed, true);
});
