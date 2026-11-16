import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { renderMarkdown } from "../public/markdown.js";

const swiftSource = await readFile(new URL("../desktop/macos/AgentControl.swift", import.meta.url), "utf8");
const script = swiftSource.match(/private let localFileContextMenuScript = #"""([\s\S]*?)"""#/)?.[1];
assert.ok(script, "native file context-menu script must be available");

function page(hostname = "127.0.0.1") {
  const listeners = new Map();
  const messages = [];
  vm.runInNewContext(script, {
    location: { hostname },
    document: { addEventListener: (name, handler) => listeners.set(name, handler) },
    window: { webkit: { messageHandlers: { localFileContextMenu: { postMessage: (path) => messages.push(path) } } } },
  });
  return {
    messages,
    dispatch(type, path) {
      const event = {
        target: { closest: () => path == null ? null : { dataset: { localFilePath: path } } },
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
      };
      listeners.get(type)?.(event);
      return event;
    },
  };
}

test("Mac local file links route right-click to Finder menu without changing left-click preview", () => {
  const path = "/Volumes/External SSD/dev/guuguo/agent-control/dist/替换并重启.command";
  const html = renderMarkdown(`[更新脚本](<${path}>)`);
  const renderedPath = html.match(/data-local-file-path="([^"]+)"/)?.[1];
  assert.equal(renderedPath, path);
  const local = page();
  assert.equal(local.dispatch("click", renderedPath).defaultPrevented, false);
  assert.deepEqual(local.messages, []);
  assert.equal(local.dispatch("contextmenu", renderedPath).defaultPrevented, true);
  assert.deepEqual(local.messages, [path]);
});

test("Mac context menu preserves default handling for remote pages, web links, and relative paths", () => {
  const remote = page("control.example.com");
  assert.equal(remote.dispatch("contextmenu", "/tmp/file.md").defaultPrevented, false);
  assert.deepEqual(remote.messages, []);
  const local = page();
  for (const path of [null, "", "docs/README.md", "//server/share", "https://example.com", "C:\\demo\\file.md"]) {
    assert.equal(local.dispatch("contextmenu", path).defaultPrevented, false, String(path));
  }
  assert.deepEqual(local.messages, []);
});

test("Mac local context menu handles application folders and decoded anchored file links", () => {
  const appPath = "/Volumes/External SSD/dev/guuguo/agent-control/dist/Agent Control.app";
  const appHtml = renderMarkdown(`[应用](<${appPath}>)`);
  const renderedAppPath = appHtml.match(/data-local-file-path="([^"]+)"/)?.[1];
  assert.equal(renderedAppPath, appPath);
  for (const hostname of ["127.0.0.1", "localhost", "[::1]"]) {
    const local = page(hostname);
    assert.equal(local.dispatch("contextmenu", renderedAppPath).defaultPrevented, true);
    const html = renderMarkdown("[源文件](file:///Volumes/External%20SSD/demo/main.swift#L12)");
    const path = html.match(/data-local-file-path="([^"]+)"/)?.[1];
    assert.equal(path, "/Volumes/External SSD/demo/main.swift");
    local.dispatch("contextmenu", path);
    assert.deepEqual(local.messages, [appPath, path]);
  }
});
