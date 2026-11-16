import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import * as ui from "../public/server-request-ui.js";
import { normalizeServerRequest, createServerRequestResponse } from "../src/providers/codex-app-server-client.mjs";
import { ProviderHub } from "../src/provider-hub.mjs";

const request = {
  id: "codex:work:42", provider: "codex", kind: "userInput", isBlocking: false,
  questions: [
    { id: 'scope"[]', header: "范围", question: "要修改哪些内容？", isOther: true,
      options: [{ label: "界面", description: "只调整展示" }, { label: "全部", description: "包含服务端" }] },
    { id: "detail", header: "补充", question: "有什么要求？", options: null, isOther: false },
  ],
};

function questionForm(rows) {
  return { querySelectorAll: () => rows.map(({ id, selected = [], other = "", enabled = true }) => ({
    dataset: { questionId: id },
    querySelectorAll: () => selected.map((value) => ({ value })),
    querySelector: () => ({ value: other, disabled: !enabled }),
  })) };
}

test("Codex questions offer explicit selections and a separate custom answer without preselection", () => {
  const html = ui.renderServerRequestCard(request);
  assert.doesNotMatch(html, / checked/);
  assert.match(html, /data-answer-other/);
  assert.match(html, /自行填写/);
  assert.match(html, /textarea[^>]*data-other-for="detail"/);
  assert.match(html, /后台继续/);
  assert.match(html, /scope&quot;\[\]/);
  const restricted = ui.renderServerRequestCard({ ...request, questions: [{ ...request.questions[0], isOther: false }] });
  assert.doesNotMatch(restricted, /data-answer-other|data-other-for/);
  const secret = ui.renderServerRequestCard({ ...request, questions: [{ id: "secret", question: "输入信息", isSecret: true }] });
  assert.match(secret, /type="password"/);
});

test("selected and custom answers round-trip through the Codex protocol with original question ids", () => {
  const form = questionForm([
    { id: 'scope"[]', selected: ["界面"], other: "旧草稿", enabled: false },
    { id: "detail", other: "保留原来的布局\n支持手机" },
  ]);
  const answers = ui.collectUserInputAnswers(request, form);
  const normalized = normalizeServerRequest({ id: 42, method: "item/tool/requestUserInput", params: {
    threadId: "thread", turnId: "turn", isBlocking: false, questions: request.questions,
  } });
  assert.equal(normalized.isBlocking, false);
  assert.deepEqual(createServerRequestResponse(normalized, { answers }), { answers: {
    'scope"[]': { answers: ["界面"] }, detail: { answers: ["保留原来的布局\n支持手机"] },
  } });
  assert.deepEqual(ui.collectUserInputAnswers(request, questionForm([
    { id: 'scope"[]', other: "自定义范围" }, { id: "detail", other: "按截图调整" },
  ]))['scope"[]'], { answers: ["自定义范围"] });
  assert.throws(() => ui.collectUserInputAnswers(request, questionForm([{ id: 'scope"[]' }])), /请选择或填写/);
});

test("Claude multi-select remains supported alongside optional custom answers", () => {
  const multi = { ...request, provider: "claude", questions: [{ ...request.questions[0], multiSelect: true }] };
  assert.match(ui.renderServerRequestCard(multi), /type="checkbox"/);
  assert.deepEqual(ui.collectUserInputAnswers(multi, questionForm([
    { id: 'scope"[]', selected: ["界面", "全部"], other: "额外说明" },
  ]))['scope"[]'], { answers: ["界面", "全部", "额外说明"] });
});

test("switching between options and a custom answer enables only the relevant text field", () => {
  const input = { disabled: true, required: false };
  const wrapper = { hidden: true };
  const toggle = { checked: true };
  const question = { querySelector: (selector) => selector === "[data-answer-other]" ? toggle
    : selector === ".sr-other-field" ? wrapper : input };
  const target = { closest: () => question };
  ui.syncUserInputQuestion(target);
  assert.equal(input.disabled, false);
  assert.equal(input.required, true);
  assert.equal(wrapper.hidden, false);
  toggle.checked = false;
  ui.syncUserInputQuestion(target);
  assert.equal(input.disabled, true);
  assert.equal(wrapper.hidden, true);
});

test("request list updates retain existing question DOM and drafts", () => {
  const children = [];
  let created = 0;
  const dock = {
    children,
    ownerDocument: { createElement: () => ({ set innerHTML(html) {
      created++;
      this.content = { firstElementChild: {
        dataset: { requestId: html.match(/data-request-id="([^"]*)"/)[1] },
        remove() { children.splice(children.indexOf(this), 1); },
      } };
    } }) },
    insertBefore(card, before) {
      const current = children.indexOf(card);
      if (current >= 0) children.splice(current, 1);
      children.splice(before ? children.indexOf(before) : children.length, 0, card);
    },
  };
  ui.syncServerRequestCards(dock, [request]);
  const first = children[0];
  first.draft = "正在填写";
  ui.syncServerRequestCards(dock, [request, { ...request, id: "codex:work:43" }]);
  assert.equal(children[0], first);
  assert.equal(children[0].draft, "正在填写");
  assert.equal(created, 2);
  ui.syncServerRequestCards(dock, [request]);
  assert.equal(children.length, 1);
});

test("Codex resolved notifications remove only the matching profile's pending question", async (t) => {
  let callbacks;
  const hub = new ProviderHub({ providers: [{ id: "codex", setCallbacks(value) { callbacks = value; }, async close() {} }],
    enableQueueDrain: false, dataDir: "/private/tmp/ac-input-test-unused" });
  t.after(() => hub.close());
  for (const profileId of ["work", "home"]) callbacks.onServerRequest({
    ...request, id: "42", profileId, threadId: `codex:${profileId}:thread`,
  });
  callbacks.onEvent({ type: "codex_notification", provider: "codex", profileId: "work",
    threadId: "codex:work:thread", method: "serverRequest/resolved", params: { requestId: 42 } });
  assert.deepEqual(hub.allPendingRequests().map((r) => r.id), ["codex:home:42"]);
});

test("question submission validates answers, blocks duplicate sends and keeps drafts after failure", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const binding = source.match(/\$\("pendingRequestsDock"\)\.addEventListener\("submit", async \(e\) => \{[\s\S]*?\n  \}\);/)?.[0];
  assert.ok(binding);
  let submit;
  let rejectSend;
  let sent = 0;
  const button = { disabled: false, textContent: "提交回答" };
  const form = { ...questionForm([
    { id: 'scope"[]', selected: ["界面"], enabled: false }, { id: "detail", other: "只改展示" },
  ]), dataset: { requestId: request.id }, reportValidity: () => true, querySelector: () => button };
  const errors = [];
  vm.runInNewContext(binding, {
    $: () => ({ addEventListener: (_, handler) => { submit = handler; } }),
    state: { pendingRequests: [request] }, collectUserInputAnswers: ui.collectUserInputAnswers,
    apiPost: () => { sent++; return new Promise((_, reject) => { rejectSend = reject; }); },
    removePendingRequestById() { assert.fail("failed submission must keep request"); },
    formatActionError: (err) => err.message, setComposerStatus: (_, text) => errors.push(text), showToastBanner() {},
  });
  const event = { target: { closest: () => form }, preventDefault() {} };
  const pending = submit(event);
  await submit(event);
  assert.equal(sent, 1);
  assert.equal(button.disabled, true);
  rejectSend(new Error("网络中断"));
  await pending;
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "提交回答");
  assert.deepEqual(errors, ["网络中断"]);
  form.reportValidity = () => false;
  await submit(event);
  assert.equal(sent, 1);
});
