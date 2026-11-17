import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  AutomationScheduler,
  computeNextRunAtMs,
  discoverClaudeScheduledTasks,
  discoverCodexAutomations,
  formatRruleHuman,
  parseRrule,
} from "../src/automation-scheduler.mjs";

test("RRULE parsing, human formatting, and next-run calculation work cleanly", () => {
  assert.deepEqual(parseRrule("RRULE:FREQ=HOURLY;INTERVAL=1;BYMINUTE=0"), {
    freq: "HOURLY",
    interval: 1,
    byMinute: 0,
    byHour: null,
    byDay: [],
    count: null,
  });
  assert.equal(formatRruleHuman("FREQ=DAILY;BYHOUR=9;BYMINUTE=0"), "每天 09:00");
  assert.equal(formatRruleHuman("FREQ=MINUTELY;INTERVAL=30"), "每 30 分钟");
  assert.equal(formatRruleHuman("FREQ=WEEKLY;BYDAY=FR;BYHOUR=10;BYMINUTE=0;COUNT=1"), "周五 10:00 (单次)");

  const last = new Date(2026, 10, 17, 9, 0, 0, 0).getTime();
  assert.equal(
    computeNextRunAtMs("FREQ=DAILY;BYHOUR=9;BYMINUTE=0", { lastRunAtMs: last }),
    new Date(2026, 10, 18, 9, 0, 0, 0).getTime(),
  );
  assert.equal(
    computeNextRunAtMs("FREQ=WEEKLY;BYDAY=FR;BYHOUR=10;BYMINUTE=0;COUNT=1", { lastRunAtMs: last }),
    0,
  );
});

test("AutomationScheduler discovers Codex/Claude tasks, avoids duplicate runs when native ran, and wakes overdue tasks", async (t) => {
  const dir = await mkdtemp(resolve(os.tmpdir(), "ac-automations-"));
  const codexHome = resolve(dir, "codex-home");
  const claudeHome = resolve(dir, "claude-home");
  const dataDir = resolve(dir, "data");
  const projDir = resolve(dir, "proj");
  await Promise.all([
    mkdir(resolve(codexHome, "sqlite"), { recursive: true }),
    mkdir(resolve(codexHome, "automations", "daily-brief"), { recursive: true }),
    mkdir(resolve(claudeHome, "scheduled-tasks", "weekly-audit"), { recursive: true }),
    mkdir(dataDir, { recursive: true }),
    mkdir(projDir, { recursive: true }),
  ]);
  t.after(() => rm(dir, { recursive: true, force: true }));

  const nowMs = Date.now();
  const db = new DatabaseSync(resolve(codexHome, "sqlite", "codex.db"));
  db.exec(`
    CREATE TABLE automations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      next_run_at INTEGER,
      last_run_at INTEGER,
      cwds TEXT NOT NULL DEFAULT '[]',
      rrule TEXT NOT NULL DEFAULT 'FREQ=HOURLY;INTERVAL=24;BYMINUTE=0',
      model TEXT,
      reasoning_effort TEXT,
      kind TEXT NOT NULL DEFAULT 'cron',
      target_thread_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  const ins = db.prepare(`
    INSERT INTO automations (id, name, prompt, status, next_run_at, last_run_at, cwds, rrule, model, reasoning_effort, kind, target_thread_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // 1) Overdue & native app has NOT run yet -> should be triggered by Agent Control.
  ins.run(
    "due-job",
    "每天巡检",
    "检查昨天日志是否有报错",
    "ACTIVE",
    nowMs - 120_000,
    nowMs - 86_400_000,
    JSON.stringify([projDir]),
    "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
    "gpt-5.4",
    "medium",
    "cron",
    "",
    nowMs - 86_400_000,
    nowMs - 86_400_000,
  );
  // 2) Already executed by native Codex app in current window -> must skip!
  ins.run(
    "native-ran-job",
    "已由原端跑过",
    "无需重复触发",
    "ACTIVE",
    nowMs - 60_000,
    nowMs - 10_000,
    JSON.stringify([projDir]),
    "FREQ=HOURLY;INTERVAL=1;BYMINUTE=0",
    "gpt-5.4",
    "low",
    "cron",
    "",
    nowMs - 86_400_000,
    nowMs - 10_000,
  );
  // 3) Paused job -> discovered but NOT triggered automatically.
  ins.run(
    "paused-job",
    "暂停中的任务",
    "手动才会触发",
    "PAUSED",
    nowMs - 60_000,
    0,
    JSON.stringify([projDir]),
    "FREQ=HOURLY;INTERVAL=1",
    "gpt-5.4",
    "medium",
    "cron",
    "",
    nowMs - 86_400_000,
    nowMs - 86_400_000,
  );
  db.close();

  await writeFile(
    resolve(claudeHome, "scheduled-tasks", "weekly-audit", "SKILL.md"),
    "---\nname: weekly-audit\ndescription: 每周日志巡检\n---\n请检查近期异常记录。\n",
    "utf8",
  );

  const codexItems = discoverCodexAutomations({ id: "default", label: "Codex 默认", home: codexHome });
  assert.equal(codexItems.length, 3);
  const claudeItems = discoverClaudeScheduledTasks({ id: "default", label: "Claude 默认", home: claudeHome });
  assert.equal(claudeItems.length, 1);

  const started = [];
  const events = [];
  const hub = {
    async listProvidersAndProfiles() {
      return {
        profiles: [
          { provider: "codex", id: "default", label: "Codex 默认", home: codexHome, installed: true },
          { provider: "claude", id: "default", label: "Claude 默认", home: claudeHome, installed: true },
        ],
      };
    },
    async startThread(args) {
      started.push(args);
      return { thread: { id: `${args.provider}:${args.profileId}:thr-${started.length}` } };
    },
  };

  const scheduler = new AutomationScheduler({
    hub,
    dataDir,
    onEvent: (eventName, payload) => events.push({ eventName, payload }),
  });
  await scheduler.load();

  const tick1 = await scheduler.tick({ nowMs });
  assert.equal(tick1.ran.length, 1);
  assert.equal(tick1.ran[0].taskKey, "codex:default:due-job");
  assert.equal(started.length, 1);
  assert.equal(started[0].cwd, projDir);
  assert.equal(started[0].text, "检查昨天日志是否有报错");
  assert.ok(events.some((e) => e.eventName === "automation_run" && e.payload?.taskKey === "codex:default:due-job"));

  // Immediate second tick must NOT re-trigger due-job (debounced + persisted).
  const tick2 = await scheduler.tick({ nowMs: nowMs + 5_000 });
  assert.equal(tick2.ran.length, 0);
  assert.equal(started.length, 1);

  // Manual runNow works even on PAUSED task.
  const manualRes = await scheduler.runNow("codex:default:paused-job", { nowMs: nowMs + 6_000 });
  assert.equal(manualRes.ok, true);
  assert.equal(started.length, 2);

  // Creating and triggering a custom multi-agent scheduled task works cleanly.
  const customSnap = await scheduler.saveCustomTask({
    action: "create",
    id: "custom-claude",
    name: "Claude 巡检",
    provider: "claude",
    cwd: projDir,
    prompt: "汇总今日进展",
    rrule: "FREQ=MINUTELY;INTERVAL=30",
  });
  assert.ok(customSnap.tasks.some((item) => item.id === "custom-claude" && item.managed));

  const customRun = await scheduler.runNow("custom:claude:custom-claude", { nowMs: nowMs + 7_000 });
  assert.equal(customRun.ok, true);
  assert.equal(started[2].provider, "claude");
  assert.equal(started[2].text, "汇总今日进展");
  scheduler.close();
});
