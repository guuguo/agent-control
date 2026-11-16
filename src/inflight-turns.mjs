import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { defaultDataDir } from "./instance-identity.mjs";

export function inflightTurnsPath(dataDir = defaultDataDir()) {
  return resolve(dataDir, "inflight-turns.json");
}

async function writeJsonAtomic(filePath, payload) {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, filePath);
}

/**
 * 持久化由控制端发起、尚未观测到终态的运行中轮次账本。
 * 进程重启时不会在 close() 清空未完成记录，用于识别被重启打断的任务并优先断点续跑。
 */
export function createInflightTurnStore({ filePath = "" } = {}) {
  const entries = new Map();
  let loaded = false;
  let writeChain = Promise.resolve();

  const persist = () => {
    if (!filePath) return;
    const list = [...entries.values()];
    writeChain = writeChain
      .then(() => writeJsonAtomic(filePath, { version: 1, entries: list }))
      .catch(() => {});
  };

  return {
    filePath,
    async load() {
      if (loaded || !filePath) {
        loaded = true;
        return [...entries.values()];
      }
      loaded = true;
      let raw = "";
      try {
        raw = await readFile(filePath, "utf8");
      } catch (error) {
        if (error?.code === "ENOENT") return [];
        throw error;
      }
      try {
        const parsed = JSON.parse(raw);
        const list = Array.isArray(parsed?.entries) ? parsed.entries : [];
        for (const item of list) {
          if (!item?.threadId || entries.has(item.threadId)) continue;
          entries.set(item.threadId, { ...item });
        }
      } catch {
        // Ignore corrupt inflight ledger; never block hub startup.
      }
      return [...entries.values()];
    },
    get(threadId) {
      const item = entries.get(threadId);
      return item ? { ...item } : null;
    },
    all() {
      return [...entries.values()].map((item) => ({ ...item }));
    },
    markStarted(threadId, meta = {}) {
      const cleanId = String(threadId || "").trim();
      if (!cleanId) return null;
      const prev = entries.get(cleanId);
      const next = {
        threadId: cleanId,
        cwd: String(meta.cwd || prev?.cwd || ""),
        model: String(meta.model || prev?.model || ""),
        effort: String(meta.effort || prev?.effort || ""),
        permissionMode: String(meta.permissionMode || prev?.permissionMode || "workspace"),
        goalMode: Boolean(meta.goalMode ?? prev?.goalMode ?? false),
        resumeAttempts: Math.max(0, Number(meta.resumeAttempts ?? prev?.resumeAttempts) || 0),
        startedAt: Number(meta.startedAt) || Date.now(),
        updatedAt: Date.now(),
      };
      entries.set(cleanId, next);
      persist();
      return { ...next };
    },
    clear(threadId) {
      const cleanId = String(threadId || "").trim();
      if (!cleanId || !entries.has(cleanId)) return false;
      entries.delete(cleanId);
      persist();
      return true;
    },
    flush() {
      return writeChain;
    },
  };
}
