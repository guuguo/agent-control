import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { PROVIDER_TABS_PREF_KEY, loadHiddenProviderTabs, saveHiddenProviderTabs, renderProviderTabsHtml, renderProviderTabsSettingsHtml, visibleProviderFilter } from "../public/provider-tabs.js";
import { renderProviderPillsHtml, resolveModelsForProvider } from "../public/instance-switcher.js";

test("Agent 筛选入口可隐藏并保存，全部固定保留且隐藏选中项回到全部", () => {
  const data = new Map();
  const storage = { getItem: (key) => data.get(key), setItem: (key, value) => data.set(key, value) };
  assert.deepEqual(loadHiddenProviderTabs(storage), []);
  saveHiddenProviderTabs(["claude", "grok", "all", "unknown"], storage);
  const hidden = loadHiddenProviderTabs(storage);
  assert.deepEqual(hidden, ["claude", "grok"]);
  const html = renderProviderTabsHtml(hidden);
  assert.doesNotMatch(html, /data-provider="(?:claude|grok)"/);
  assert.match(html, /data-provider="all"/);
  assert.match(html, /data-provider="qoder"/);
  assert.equal(visibleProviderFilter("claude", hidden), "all");
  assert.equal(visibleProviderFilter("qoder", hidden), "qoder");
  assert.match(renderProviderTabsSettingsHtml(hidden), /data-provider-tab-visible="claude">/);
  assert.match(renderProviderTabsSettingsHtml(hidden), /data-provider-tab-visible="qoder" checked/);
  assert.doesNotMatch(renderProviderTabsSettingsHtml(hidden), /data-provider-tab-visible="all"/);
  data.set(PROVIDER_TABS_PREF_KEY, "broken");
  assert.deepEqual(loadHiddenProviderTabs(storage), []);
  saveHiddenProviderTabs([], storage);
  assert.match(renderProviderTabsHtml(loadHiddenProviderTabs(storage)), /data-provider="claude"/);
});

test("Qoder 在新会话选择器和模型目录中可用，隐藏筛选入口不删 Agent", () => {
  assert.match(renderProviderPillsHtml({ selectedProvider: "qoder" }), /data-select-provider="qoder"/);
  assert.deepEqual(resolveModelsForProvider({}, [], "qoder").map((model) => model.id), ["auto", "lite", "performance"]);
  assert.match(renderProviderPillsHtml(), /data-select-provider="grok"/);
});

test("页面勾选处理保存显示偏好，隐藏当前 Agent 时重置筛选，全部显示可恢复", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const change = source.match(/\$\("providerTabsSettingsMenu"\)\.addEventListener\("change", \(e\) => \{[\s\S]*?\n  \}\);/)[0];
  const click = source.match(/\$\("providerTabsSettingsMenu"\)\.addEventListener\("click", \(e\) => \{[\s\S]*?\n  \}\);/)[0];
  const handlers = {};
  const state = { hiddenProviderTabs: [], providerFilter: "qoder", threads: [{ id: "qoder:default:one" }] };
  let saved;
  vm.runInNewContext(change + "\n" + click, { state, $: () => ({ addEventListener: (type, handler) => { handlers[type] = handler; } }),
    saveHiddenProviderTabs: (hidden) => { saved = [...hidden]; },
    setProviderFilter: (selected) => { state.providerFilter = visibleProviderFilter(selected, state.hiddenProviderTabs); },
  });
  handlers.change({ target: { closest: () => ({ dataset: { providerTabVisible: "qoder" }, checked: false }) } });
  assert.deepEqual(saved, ["qoder"]);
  assert.equal(state.providerFilter, "all");
  assert.equal(state.threads.length, 1);
  handlers.click({ target: { closest: () => ({}) } });
  assert.deepEqual(saved, []);
  assert.equal(state.threads.length, 1);
});
