import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractCodexSkillContexts } from "../public/codex-skill-context.js";
import { normalizeCodexUserMessageItem, stripCodexPromptWrappers } from "../src/codex-input-clean.mjs";
import { parseUserMessageContent, renderTurnHtml } from "../public/markdown.js";
import { loadCodexThreadHistory } from "../src/providers/codex-thread-history.mjs";

const skill = (name = "demo-skill", body = "# 技能说明\n\n读取项目文件，保留已有改动。") => `<skill>\n<name>${name}</name>\n<path>/Users/test/skills/${name}/SKILL.md</path>\n${body}\n</skill>`;
const userItem = (text) => ({ type: "userMessage", id: "user-skill", content: [{ type: "text", text }] });

test("Codex 技能注入显示为默认折叠卡片，可查看文件和复制正文，原始与规范化消息一致", () => {
  const raw = skill();
  for (const item of [userItem(raw), normalizeCodexUserMessageItem(userItem(raw))]) {
    const parsed = parseUserMessageContent(item);
    assert.deepEqual(parsed.textParts, []);
    assert.equal(parsed.skills[0].name, "demo-skill");
    assert.equal(parsed.skills[0].path, "/Users/test/skills/demo-skill/SKILL.md");
    const html = renderTurnHtml({ id: "t", items: [item] }, { threadId: "codex:default:t" });
    assert.match(html, /<details class="skill-context-card task-notif-card heartbeat-disclosure">/);
    assert.match(html, /技能加载/);
    assert.match(html, /data-local-file-path="\/Users\/test\/skills\/demo-skill\/SKILL.md"/);
    assert.match(html, /复制/);
    assert.match(html, /读取项目文件，保留已有改动。/);
    assert.doesNotMatch(html, /&lt;skill&gt;|&lt;name&gt;|msg-role">你<\/span>/);
    assert.equal(stripCodexPromptWrappers(raw), "");
    // This change only formats the view; upstream task instructions stay intact.
    assert.equal(item.content[0].text, raw);
  }
});

test("多个技能与真实请求、图片、问题回答、目标续跑混排时互不吞内容", () => {
  const raw = `请检查项目\n${skill()}\n${skill("second-skill")}\n保留用户补充\n<image path="/tmp/demo.png" name="截图">\n<send_user_message_question_reply>[{"question":"范围？","answer":"本项目"}]</send_user_message_question_reply>\n<codex_internal_context source="goal"><objective>完成核对</objective></codex_internal_context>`;
  const item = normalizeCodexUserMessageItem(userItem(raw));
  const parsed = parseUserMessageContent(item);
  assert.deepEqual(parsed.skills.map((s) => s.name), ["demo-skill", "second-skill"]);
  assert.match(parsed.textParts[0], /请检查项目/);
  assert.match(parsed.textParts[0], /保留用户补充/);
  assert.equal(parsed.images[0].path, "/tmp/demo.png");
  assert.equal(parsed.questionReplies[0].answer, "本项目");
  assert.equal(parsed.goalContext.objective, "完成核对");
  const html = renderTurnHtml({ id: "mixed", items: [item] });
  assert.equal((html.match(/class="msg-row msg-skill-context"/g) || []).length, 2);
  assert.match(html, /目标续跑/);
  assert.match(html, /user-question-reply/);
  const preview = stripCodexPromptWrappers(raw);
  assert.match(preview, /请检查项目/);
  assert.doesNotMatch(preview, /技能说明|second-skill/);
  assert.equal(stripCodexPromptWrappers(`请检查项目\n${skill().slice(0, 70)}`), "请检查项目");
  const heartbeat = parseUserMessageContent(userItem(`${skill()}\n<heartbeat><automation_id>test</automation_id><instructions>检查</instructions></heartbeat>`));
  assert.equal(heartbeat.skills.length, 1);
  const hbHtml = renderTurnHtml({ id: "hb", items: [userItem(`${skill()}\n<heartbeat><automation_id>test</automation_id><instructions>检查</instructions></heartbeat>`)] });
  assert.match(hbHtml, /技能加载/);
  assert.match(hbHtml, /定时任务/);
});

test("代码示例、普通技能名与不完整未知标签保持原样；技能正文里的附件标记不误当用户附件", () => {
  for (const raw of [
    "$demo-skill 请执行检查", `示例：\n\`\`\`xml\n${skill()}\n\`\`\``,
    `示例：<skill><name>demo</name></skill>`,
    "<skill>\n<name>demo</name>\n没有来源路径的未知内容\n</skill>",
    skill().replace("SKILL.md", "README.md"),
  ]) {
    assert.deepEqual(extractCodexSkillContexts(raw), { text: raw, skills: [] });
  }
  const raw = skill("demo-skill", '```xml\n<image path="/tmp/sample.png" name="示例">\n```\n<script>alert(1)</script>');
  const parsed = parseUserMessageContent(userItem(raw));
  assert.equal(parsed.images.length, 0);
  assert.match(parsed.skills[0].body, /<image/);
  const html = renderTurnHtml({ items: [userItem(raw)] });
  assert.doesNotMatch(html, /<script>|onerror=/);
  const unclosed = skill().replace(/<\/skill>$/, "");
  assert.equal(extractCodexSkillContexts(unclosed).skills.length, 1);
  const windows = skill().replace("/Users/test/skills/demo-skill/SKILL.md", "C:\\Users\\test\\skills\\demo\\SKILL.md");
  assert.equal(extractCodexSkillContexts(windows).skills[0].path, "C:\\Users\\test\\skills\\demo\\SKILL.md");
});

test("完整历史与大文件预览保留各个技能，双协议同一记录仍正确去重", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ac-skill-context-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "rollout.jsonl");
  const raws = [skill(), skill("other-skill")];
  const records = [
    { type: "event_msg", payload: { type: "task_started", turn_id: "t" } },
    { type: "event_msg", payload: { type: "user_message", message: raws[0] } },
    ...raws.map((text) => ({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } })),
    { type: "event_msg", payload: { type: "task_complete", turn_id: "t" } },
  ];
  await writeFile(path, records.map((r, i) => JSON.stringify({ timestamp: `2026-11-17T00:00:0${i}.000Z`, ...r })).join("\n") + "\n");
  const client = { async request() { return { thread: { id: "t", turns: [{ id: "t", status: "completed", items: raws.map(userItem) }] } }; } };
  for (const largeBytesThreshold of [Infinity, 1]) {
    const result = await loadCodexThreadHistory({ client, rawId: "t", indexedThread: { id: "t", rolloutPath: path }, largeBytesThreshold });
    const items = result.thread.turns[0].items.filter((item) => item.type === "userMessage");
    assert.deepEqual(items.flatMap((item) => parseUserMessageContent(item).skills.map((s) => s.name)), ["demo-skill", "other-skill"]);
  }
});
