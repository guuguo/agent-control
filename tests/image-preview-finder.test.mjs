import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const swift = await readFile(new URL("../desktop/macos/AgentControl.swift", import.meta.url), "utf8");
function fn(name) {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  return app.slice(start, app.indexOf("\n}", start) + 2);
}
function preview(href = "http://127.0.0.1:43310/") {
  const nodes = new Map();
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, { dataset: {}, style: {}, classList: { remove() {} }, setAttribute() {}, showModal() { this.open = true; } });
    return nodes.get(id);
  };
  const ctx = vm.createContext({ URL, location: { href }, state: { activeThread: { id: "codex:work:one", cwd: "/项目 with spaces" }, threads: [] }, $ });
  vm.runInContext(fn("resolveImagePreviewLocalPath") + "\n" + fn("openImagePreviewModal"), ctx);
  return { ctx, $ };
}

test("image preview and caption preserve original path for the existing native Finder menu, including raw upgrade", () => {
  const { ctx, $ } = preview();
  const path = "/Volumes/External SSD/图片 & 测试.png";
  const base = `./api/thread/image?threadId=codex:work:one&path=${encodeURIComponent(path)}`;
  ctx.openImagePreviewModal(`${base}&w=1280`, "图片", `${base}&raw=1`);
  assert.equal($("imagePreviewImg").dataset.localFilePath, path);
  assert.equal($("imagePreviewCaption").dataset.localFilePath, path);
  assert.equal($("imagePreviewImg").src, `${base}&w=1280`);
  // Exercise the actual desktop bridge script against the preview element.
  const bridge = swift.match(/private let localFileContextMenuScript = #"""([\s\S]*?)"""#/)[1];
  let handler;
  const messages = [];
  vm.runInNewContext(bridge, {
    location: { hostname: "127.0.0.1" },
    document: { addEventListener: (_, fn) => { handler = fn; } },
    window: { webkit: { messageHandlers: { localFileContextMenu: { postMessage: (p) => messages.push(p) } } } },
  });
  let prevented = false;
  handler({ target: { closest: () => $("imagePreviewImg") }, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(messages, [path]);
  ctx.openImagePreviewModal("data:image/png;base64,AA==", "上传图片");
  assert.equal($("imagePreviewImg").dataset.localFilePath, undefined);
  assert.equal($("imagePreviewCaption").dataset.localFilePath, undefined);
});

test("relative image paths resolve against their own thread, and relay prefixes remain compatible", () => {
  const { ctx } = preview("https://relay.example/i/mac/");
  const src = "./api/thread/image?threadId=codex:work:one&path=out%2F图片.png";
  assert.equal(ctx.resolveImagePreviewLocalPath(src), "/项目 with spaces/out/图片.png");
  ctx.state.threads = [{ id: "other", cwd: "/other-project" }];
  assert.equal(ctx.resolveImagePreviewLocalPath(src.replace("codex:work:one", "other")), "/other-project/out/图片.png");
  assert.equal(ctx.resolveImagePreviewLocalPath(src.replace("codex:work:one", "unknown")), "");
});

test("external image URLs and non-file image sources cannot inherit a local Finder path", () => {
  const { ctx } = preview();
  for (const src of ["https://example.com/api/thread/image?path=/tmp/fake.png", "./other?path=/tmp/fake.png", "data:image/png;base64,AA==", "./api/thread/image?path=%2F%2Fserver%2Fshare.png", "./api/thread/image?path=C%3A%5Cimage.png", "./api/thread/image?path=~%2Fimage.png"]) {
    assert.equal(ctx.resolveImagePreviewLocalPath(src), "", src);
  }
});
