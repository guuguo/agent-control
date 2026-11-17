import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { defaultDataDir } from "./instance-identity.mjs";

export function queuedTurnsPath(dataDir = defaultDataDir()) {
  return resolve(dataDir, "queued-turns.json");
}

async function writeJsonAtomic(filePath, payload) {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, filePath);
}

export function createQueuedTurnQueue({
  deliver,
  canDeliver = () => true,
  isRetryable,
  onEvent = () => {},
  retryMs = 1_500,
  autoStart = true,
  initialEntries = [],
  filePath = "",
} = {}) {
  const queues = new Map();
  const steeringIds = new Set();
  let draining = null;
  let timer = null;
  let writeChain = Promise.resolve();

  const snapshotEntries = () => [...queues.values()].flat();

  const persist = () => {
    if (!filePath) return;
    const entries = snapshotEntries();
    writeChain = writeChain
      .then(() => writeJsonAtomic(filePath, { version: 1, entries }))
      .catch(() => {});
  };

  const schedule = () => {
    if (!autoStart || timer || !queues.size) return;
    timer = setTimeout(async () => {
      timer = null;
      await drainOnce();
      schedule();
    }, retryMs);
    timer.unref?.();
  };

  const removeById = (threadId, id) => {
    const entries = queues.get(threadId) || [];
    const index = entries.findIndex((item) => item?.id === id);
    if (index < 0) return null;
    const [entry] = entries.splice(index, 1);
    if (!entries.length) queues.delete(threadId);
    if (entry) persist();
    return entry;
  };

  const drain = async () => {
    for (const [threadId, entries] of [...queues]) {
      const entry = entries[0];
      if (!entry || steeringIds.has(entry.id)) continue;
      if (!await canDeliver(entry)) continue;
      try {
        const result = await deliver(entry);
        delete entry.lastRetryError;
        delete entry.lastRetryAt;
        removeById(threadId, entry.id);
        onEvent({ type: "started", entry, result });
      } catch (error) {
        if (isRetryable?.(error)) {
          const msg = String(error?.message || error || "").trim();
          if (msg && entry.lastRetryError !== msg) {
            entry.lastRetryError = msg;
            entry.lastRetryAt = Date.now();
            onEvent({
              type: "retry_blocked",
              entry,
              error: { message: msg, code: error?.code || "" },
            });
          }
          continue;
        }
        delete entry.lastRetryError;
        delete entry.lastRetryAt;
        removeById(threadId, entry.id);
        onEvent({ type: "failed", entry, error: { message: error?.message || String(error) } });
      }
    }
  };

  const drainOnce = async () => {
    if (draining) return draining;
    draining = drain().finally(() => { draining = null; });
    return draining;
  };

  for (const entry of initialEntries) {
    if (!entry?.id || !entry?.threadId) continue;
    const entries = queues.get(entry.threadId) || [];
    entries.push(entry);
    queues.set(entry.threadId, entries);
  }

  const api = {
    async load() {
      if (!filePath) return;
      let raw = "";
      try {
        raw = await readFile(filePath, "utf8");
      } catch (error) {
        if (error?.code === "ENOENT") return;
        throw error;
      }
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
      if (!entries.length) return;
      const seen = new Set(snapshotEntries().map((item) => item.id));
      for (const entry of entries) {
        if (!entry?.id || !entry?.threadId || seen.has(entry.id)) continue;
        seen.add(entry.id);
        const list = queues.get(entry.threadId) || [];
        list.push(entry);
        queues.set(entry.threadId, list);
      }
      schedule();
    },
    async flush() {
      await writeChain;
    },
    enqueue(threadId, input) {
      const entries = queues.get(threadId) || [];
      const entry = { id: randomUUID(), threadId, createdAt: Date.now(), ...input };
      entries.push(entry);
      queues.set(threadId, entries);
      persist();
      onEvent({ type: "queued", entry, position: entries.length });
      schedule();
      return { ...entry, position: entries.length };
    },
    enqueuePriority(threadId, input) {
      const entries = queues.get(threadId) || [];
      const source = String(input?.source || "resume");
      if (source === "resume") {
        const existingResume = entries.find((item) => item?.source === "resume");
        if (existingResume) {
          return { ...existingResume, position: 1, deduplicated: true };
        }
      }
      const entry = {
        id: randomUUID(),
        threadId,
        createdAt: Date.now(),
        source,
        sourceLabel: input?.sourceLabel || "断点优先恢复",
        ...input,
      };
      entries.unshift(entry);
      queues.set(threadId, entries);
      persist();
      onEvent({ type: "queued", entry, position: 1 });
      schedule();
      return { ...entry, position: 1 };
    },
    list(threadId) {
      return [...(queues.get(threadId) || [])];
    },
    get(threadId, id) {
      const entries = queues.get(threadId) || [];
      const index = entries.findIndex((item) => item?.id === id);
      if (index < 0) return null;
      return { ...entries[index], position: index + 1 };
    },
    update(threadId, id, patch = {}) {
      const entries = queues.get(threadId) || [];
      const index = entries.findIndex((item) => item?.id === id);
      if (index < 0) return null;
      const current = entries[index];
      if (!current || steeringIds.has(current.id)) return null;
      const updated = {
        ...current,
        ...(patch.text !== undefined ? { text: String(patch.text || "") } : {}),
        ...(patch.images !== undefined ? { images: Array.isArray(patch.images) ? patch.images : [] } : {}),
        ...(patch.model !== undefined ? { model: String(patch.model || "") } : {}),
        ...(patch.effort !== undefined ? { effort: String(patch.effort || "") } : {}),
        ...(patch.permissionMode !== undefined ? { permissionMode: String(patch.permissionMode || "workspace") } : {}),
        ...(patch.goalMode !== undefined ? { goalMode: Boolean(patch.goalMode) } : {}),
        updatedAt: Date.now(),
      };
      entries[index] = updated;
      persist();
      onEvent({ type: "updated", entry: updated, position: index + 1 });
      return { ...updated, position: index + 1 };
    },
    beginSteer(threadId, id) {
      const entry = (queues.get(threadId) || []).find((item) => item?.id === id);
      if (!entry || steeringIds.has(entry.id)) return null;
      steeringIds.add(entry.id);
      return { ...entry };
    },
    abortSteer(id) {
      steeringIds.delete(id);
    },
    completeSteer(threadId, id, result = null) {
      steeringIds.delete(id);
      const entry = removeById(threadId, id);
      if (!entry) return false;
      onEvent({ type: "steered", entry, result });
      return true;
    },
    has(threadId) {
      return (queues.get(threadId)?.length || 0) > 0;
    },
    all() {
      return [...queues.values()].flat();
    },
    cancel(threadId, id) {
      const entry = removeById(threadId, id);
      if (!entry) return false;
      onEvent({ type: "cancelled", entry });
      return true;
    },
    drainOnce,
    close() {
      clearTimeout(timer);
      timer = null;
    },
  };
  schedule();
  return api;
}
