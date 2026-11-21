import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import vm from "node:vm";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isLoopbackHostname } from "../public/image-preview-policy.js";
import { CodexProvider } from "../src/providers/codex-provider.mjs";
import { createAgentControlServer } from "../src/server.mjs";
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
  const parsedHref = new URL(href);
  const ctx = vm.createContext({ URL, isLoopbackHostname, location: { href, hostname: parsedHref.hostname }, state: { activeThread: { id: "codex:work:one", cwd: "/项目 with spaces" }, threads: [] }, $ });
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

test("imagePreviewRevealBtn is shown only for loopback local images and hidden for data URLs or relay pages", () => {
  const local = preview("http://127.0.0.1:43310/");
  const base = "./api/thread/image?threadId=codex:work:one&path=out%2Fbanner.png";
  local.ctx.openImagePreviewModal(`${base}&w=1280`, "banner.png", `${base}&raw=1`);
  assert.equal(local.$("imagePreviewRevealBtn").hidden, false);
  assert.equal(local.ctx.state.imagePreview.revealPath, "out/banner.png");
  assert.equal(local.ctx.state.imagePreview.revealThreadId, "codex:work:one");

  const bareBase = "./api/thread/image?threadId=codex:work:one&path=banner.png";
  local.ctx.openImagePreviewModal(`${bareBase}&w=1280`, "banner.png", `${bareBase}&raw=1`);
  assert.equal(local.ctx.state.imagePreview.revealPath, "banner.png");

  local.ctx.openImagePreviewModal("data:image/png;base64,AA==", "上传图片");
  assert.equal(local.$("imagePreviewRevealBtn").hidden, true);

  const remote = preview("https://relay.example/i/mac/");
  remote.ctx.openImagePreviewModal(`${base}&w=1280`, "banner.png", `${base}&raw=1`);
  assert.equal(remote.$("imagePreviewRevealBtn").hidden, true);
});

test("POST /api/thread/reveal invokes local reveal for direct loopback requests and blocks proxied requests", async (t) => {
  const root = await mkdtemp(resolve(os.tmpdir(), "ac-reveal-"));
  const home = resolve(root, "codex");
  const workspace = resolve(root, "project");
  const dataDir = resolve(root, "data");
  await Promise.all([home, workspace].map((dir) => mkdir(dir, { recursive: true })));
  const imagePath = resolve(workspace, "banner.png");
  await writeFile(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
  const rolloutPath = resolve(home, "rollout.jsonl");
  await writeFile(rolloutPath, `${JSON.stringify({ timestamp: "2026-11-20T01:00:00Z", type: "event_msg", payload: { type: "task_started", turn_id: "t1" } })}\n`);
  const db = new DatabaseSync(resolve(home, "state_5.sqlite"));
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, model_provider TEXT, cwd TEXT, title TEXT, archived INTEGER, first_user_message TEXT, model TEXT, reasoning_effort TEXT, thread_source TEXT, preview TEXT, name TEXT, git_sha TEXT, git_branch TEXT, git_origin_url TEXT)`);
  db.prepare("INSERT INTO threads (id,rollout_path,created_at,updated_at,source,model_provider,cwd,title,archived,first_user_message,model,reasoning_effort,thread_source,preview,name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("reveal-thread", rolloutPath, 1700000000, 1700000001, "vscode", "openai", workspace, "访达定位", 0, "hi", "gpt-6.1-sol", "medium", "user", "hi", "");
  db.close();

  const revealed = [];
  const provider = new CodexProvider({ env: { ...process.env, HOME: root, USERPROFILE: root, CODEX_BIN: fileURLToPath(new URL("./helpers/mock-codex-cli.mjs", import.meta.url)), AGENT_CONTROL_CODEX_HOMES: JSON.stringify([{ id: "default", home }]) } });
  const server = await createAgentControlServer({
    port: 0,
    dataDir,
    providers: [provider],
    disableRelay: true,
    disableTunnel: true,
    disableUpdateCheck: true,
    revealFileImpl: async (filePath) => { revealed.push(filePath); },
    env: { ...process.env, HOME: root, AGENT_CONTROL_DISABLE_AUTOMATIONS: "1" },
  });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  await server.start();

  const nestedDir = resolve(workspace, "public", "assets", "brand");
  await mkdir(nestedDir, { recursive: true });
  const nestedImagePath = resolve(nestedDir, "nested-banner.png");
  await writeFile(nestedImagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));

  const okRes = await fetch(`${server.url}/api/thread/reveal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadId: "codex:default:reveal-thread", path: imagePath }),
  });
  assert.equal(okRes.status, 200);
  const okBody = await okRes.json();
  assert.equal(okBody.ok, true);
  assert.equal(revealed.length, 1);

  const bareRes = await fetch(`${server.url}/api/thread/reveal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadId: "codex:default:reveal-thread", path: "nested-banner.png" }),
  });
  assert.equal(bareRes.status, 200);
  const bareBody = await bareRes.json();
  assert.equal(bareBody.ok, true);
  assert.equal(revealed.length, 2);

  const blockedRes = await fetch(`${server.url}/api/thread/reveal`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.9" },
    body: JSON.stringify({ threadId: "codex:default:reveal-thread", path: imagePath }),
  });
  assert.ok([401, 403].includes(blockedRes.status), `expected 401 or 403, got ${blockedRes.status}`);
  assert.equal(revealed.length, 2);
});
