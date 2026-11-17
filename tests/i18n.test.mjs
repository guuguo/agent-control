import test from "node:test";
import assert from "node:assert/strict";

import {
  SUPPORTED_LOCALES,
  normalizeLocale,
  detectInitialLocale,
  translateText,
  setLocale,
  getLocale,
} from "../public/i18n.js";

test("normalizeLocale maps regional browser codes cleanly", () => {
  assert.equal(normalizeLocale("en-US"), "en");
  assert.equal(normalizeLocale("ja-JP"), "ja");
  assert.equal(normalizeLocale("ko-KR"), "ko");
  assert.equal(normalizeLocale("zh-TW"), "zh-TW");
  assert.equal(normalizeLocale("zh-Hant-HK"), "zh-TW");
  assert.equal(normalizeLocale("zh-CN"), "zh-CN");
  assert.equal(normalizeLocale("fr-FR"), "");
});

test("detectInitialLocale prefers stored preference and falls back safely", () => {
  const mem = new Map([["ac.locale", "ja"]]);
  const storage = {
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => mem.set(k, v),
  };
  assert.equal(detectInitialLocale(storage), "ja");
  assert.equal(SUPPORTED_LOCALES.length, 5);
});

test("translateText translates core UI strings across all supported locales", () => {
  assert.equal(translateText("+ 新建会话", "en"), "+ New Session");
  assert.equal(translateText("+ 新建会话", "ja"), "+ 新規セッション");
  assert.equal(translateText("+ 新建会话", "ko"), "+ 새 세션");
  assert.equal(translateText("+ 新建会话", "zh-TW"), "+ 新增會話");
  assert.equal(translateText("+ 新建会话", "zh-CN"), "+ 新建会话");

  // Unknown or dynamic user content remains untouched
  assert.equal(translateText("fix: auth race condition", "en"), "fix: auth race condition");
});

test("setLocale persists normalized locale", () => {
  const mem = new Map();
  const storage = {
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => mem.set(k, v),
  };
  const updated = setLocale("ko-KR", storage);
  assert.equal(updated, "ko");
  assert.equal(getLocale(), "ko");
  assert.equal(mem.get("ac.locale"), "ko");
});
