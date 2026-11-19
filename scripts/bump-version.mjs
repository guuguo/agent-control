import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function parseSemver(raw) {
  const match = String(raw || "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function bumpSemver(current, target = "patch") {
  const explicit = parseSemver(target);
  if (explicit) {
    return `${explicit[0]}.${explicit[1]}.${explicit[2]}`;
  }
  const base = parseSemver(current) || [0, 1, 0];
  if (target === "major") return `${base[0] + 1}.0.0`;
  if (target === "minor") return `${base[0]}.${base[1] + 1}.0`;
  if (target === "patch") return `${base[0]}.${base[1]}.${base[2] + 1}`;
  throw new Error(`无效的版本参数：${target}（支持 patch | minor | major | x.y.z）`);
}

function indexToLetters(num) {
  let n = Math.max(0, Number(num) || 0);
  let out = "";
  do {
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

function lettersToIndex(letters) {
  let n = 0;
  for (const ch of String(letters || "").toLowerCase()) {
    const code = ch.charCodeAt(0) - 97;
    if (code < 0 || code > 25) return -1;
    n = n * 26 + (code + 1);
  }
  return n - 1;
}

export function nextUiVersion(currentUiVersion = "", date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const today = `${yyyy}${mm}${dd}`;
  const match = String(currentUiVersion || "").trim().match(/^(\d{8})([a-z]+)$/i);
  if (match && match[1] === today) {
    const idx = lettersToIndex(match[2]);
    return `${today}${indexToLetters(idx >= 0 ? idx + 1 : 0)}`;
  }
  return `${today}a`;
}

function collectRecentCommitSubjects(rootDir, maxCount = 12) {
  try {
    const lastTag = execFileSync("git", ["-C", rootDir, "describe", "--tags", "--abbrev=0"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const range = lastTag ? `${lastTag}..HEAD` : `-n ${maxCount}`;
    const args = lastTag
      ? ["-C", rootDir, "log", "--format=- %s (%h)", range]
      : ["-C", rootDir, "log", `-n`, String(maxCount), "--format=- %s (%h)"];
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

export function buildReleaseNotesSection({
  newVersion,
  dateStr,
  commitLines = "",
  title = "",
  summary = "",
  locale = "zh",
} = {}) {
  const isEn = String(locale || "").toLowerCase().startsWith("en");
  const lines = String(commitLines || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^-\s*/, "").replace(/\s*\([0-9a-f]{7,40}\)\s*$/i, "").trim())
    .filter(Boolean);

  const buckets = { new: [], improve: [], fix: [], note: [] };
  for (const raw of lines) {
    if (/^(?:chore(?:\([^)]*\))?:\s*)?(?:bump(?:\s+version)?|release)\b|^版本发布(?:\s|$)/i.test(raw)) continue;
    const match = raw.match(/^(feat|fix|perf|refactor|style|ui|docs|chore|ci|build|test)(?:\([^)]*\))?!?:\s*(.+)$/i);
    const kind = (match?.[1] || "").toLowerCase();
    const text = (match?.[2] || raw).trim();
    if (!text) continue;
    if (kind === "feat" || /^(?:新增|增加|支持|接入|上线|add(?:ed)?|support)/i.test(text)) {
      buckets.new.push(`- ${text}`);
    } else if (kind === "fix" || /^(?:修复|修正|解决|fix(?:ed)?|resolve)/i.test(text)) {
      buckets.fix.push(`- ${text}`);
    } else if (["perf", "refactor", "style", "ui"].includes(kind) || /^(?:优化|改进|完善|升级|精简|调整|improv|enhanc|optimiz)/i.test(text)) {
      buckets.improve.push(`- ${text}`);
    } else {
      buckets.note.push(`- ${text}`);
    }
  }

  const resolvedTitle = String(title || "").trim() || (isEn ? `v${newVersion} Release` : `v${newVersion} 版本更新`);
  const summaryLine = isEn
    ? (() => {
      const s = String(summary || "").trim() || "Please summarize the key user-facing highlights of this release.";
      return /^summary\s*:/i.test(s) ? s : `Summary: ${s}`;
    })()
    : (() => {
      const s = String(summary || "").trim() || "请补充面向用户的本版本核心更新亮点。";
      return s.startsWith("一句话总结") ? s : `一句话总结：${s}`;
    })();
  const blocks = [`## v${newVersion} (${dateStr}) — ${resolvedTitle}`, "", summaryLine];

  const appendBucket = (heading, items) => {
    if (items.length === 0) return;
    blocks.push("", `### ${heading}`, "", ...items);
  };
  if (isEn) {
    appendBucket("Added", buckets.new);
    appendBucket("Improved", buckets.improve);
    appendBucket("Fixed", buckets.fix);
    appendBucket("Notes", buckets.note);
  } else {
    appendBucket("新增", buckets.new);
    appendBucket("优化", buckets.improve);
    appendBucket("修复", buckets.fix);
    appendBucket("说明", buckets.note);
  }

  if (buckets.new.length === 0 && buckets.improve.length === 0 && buckets.fix.length === 0 && buckets.note.length === 0) {
    if (isEn) {
      blocks.push("", "### Improved", "", `- Release v${newVersion} (please replace with plain-English user-facing notes)`);
    } else {
      blocks.push("", "### 优化", "", `- 版本发布 v${newVersion}（请补充通俗易懂的中文更新说明）`);
    }
  }

  return `${blocks.join("\n")}\n`;
}

export function runBumpVersion(target = "patch", { rootDir = ROOT_DIR, dryRun = false, date = new Date(), title = "", summary = "" } = {}) {
  const pkgPath = resolve(rootDir, "package.json");
  const lockPath = resolve(rootDir, "package-lock.json");
  const indexPath = resolve(rootDir, "public", "index.html");
  const appJsPath = resolve(rootDir, "public", "app.js");
  const changelogPath = resolve(rootDir, "CHANGELOG.md");
  const releaseNotesPath = resolve(rootDir, "RELEASE_NOTES.md");
  const releaseNotesEnPath = resolve(rootDir, "RELEASE_NOTES.en.md");

  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const oldVersion = String(pkg.version || "0.1.0");
  const newVersion = bumpSemver(oldVersion, target);

  const html = readFileSync(indexPath, "utf8");
  const uiMatch = html.match(/name="ac-ui-version"\s+content="([^"]+)"/i);
  const oldUiVersion = uiMatch?.[1] || "";
  const newUiVersion = nextUiVersion(oldUiVersion, date);

  const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

  if (!dryRun) {
    pkg.version = newVersion;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

    if (existsSync(lockPath)) {
      try {
        const lockDoc = JSON.parse(readFileSync(lockPath, "utf8"));
        lockDoc.version = newVersion;
        if (lockDoc.packages?.[""]) lockDoc.packages[""].version = newVersion;
        writeFileSync(lockPath, `${JSON.stringify(lockDoc, null, 2)}\n`, "utf8");
      } catch {
        // Ignore non-standard package-lock.json.
      }
    }

    if (oldUiVersion) {
      const escapedOld = oldUiVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(escapedOld, "g");
      writeFileSync(indexPath, html.replace(re, newUiVersion), "utf8");
      if (existsSync(appJsPath)) {
        const appJs = readFileSync(appJsPath, "utf8");
        writeFileSync(appJsPath, appJs.replace(re, newUiVersion), "utf8");
      }
    }

    const recentNotes = collectRecentCommitSubjects(rootDir) || `- 版本发布 v${newVersion}`;
    const section = `## v${newVersion} (${dateStr})\n\nUI 资源版本：\`${newUiVersion}\`\n\n${recentNotes}\n`;
    const existingLog = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : "# 更新日志 (CHANGELOG)\n\n";
    if (!existingLog.includes(`## v${newVersion} (`)) {
      const headerMatch = existingLog.match(/^(#\s+[^\n]*\n+)/);
      const updatedLog = headerMatch
        ? `${headerMatch[1]}${section}\n${existingLog.slice(headerMatch[0].length)}`
        : `# 更新日志 (CHANGELOG)\n\n${section}\n${existingLog}`;
      writeFileSync(changelogPath, updatedLog, "utf8");
    }

    const releaseSection = buildReleaseNotesSection({
      newVersion,
      dateStr,
      commitLines: recentNotes,
      title,
      summary,
    });
    const defaultReleaseHeader = "# Agent Control 更新说明\n\n> 本文件面向最终用户，用简明中文记录每个版本最核心的功能变化、体验优化与问题修复。\n\n";
    const existingReleaseNotes = existsSync(releaseNotesPath)
      ? readFileSync(releaseNotesPath, "utf8")
      : defaultReleaseHeader;
    if (!existingReleaseNotes.includes(`## v${newVersion} (`)) {
      const firstH2 = existingReleaseNotes.search(/^##\s+/m);
      const updatedReleaseNotes = firstH2 >= 0
        ? `${existingReleaseNotes.slice(0, firstH2)}${releaseSection}\n${existingReleaseNotes.slice(firstH2)}`
        : `${existingReleaseNotes.replace(/\s*$/, "\n\n")}${releaseSection}`;
      writeFileSync(releaseNotesPath, updatedReleaseNotes, "utf8");
    }

    const releaseSectionEn = buildReleaseNotesSection({
      newVersion,
      dateStr,
      commitLines: recentNotes,
      title,
      summary,
      locale: "en",
    });
    const defaultReleaseHeaderEn = "# Agent Control Release Notes\n\n> Plain-language English release notes for end users covering key additions, improvements, and fixes in each version.\n\n";
    const existingReleaseNotesEn = existsSync(releaseNotesEnPath)
      ? readFileSync(releaseNotesEnPath, "utf8")
      : defaultReleaseHeaderEn;
    if (!existingReleaseNotesEn.includes(`## v${newVersion} (`)) {
      const firstH2En = existingReleaseNotesEn.search(/^##\s+/m);
      const updatedReleaseNotesEn = firstH2En >= 0
        ? `${existingReleaseNotesEn.slice(0, firstH2En)}${releaseSectionEn}\n${existingReleaseNotesEn.slice(firstH2En)}`
        : `${existingReleaseNotesEn.replace(/\s*$/, "\n\n")}${releaseSectionEn}`;
      writeFileSync(releaseNotesEnPath, updatedReleaseNotesEn, "utf8");
    }
  }

  return {
    oldVersion,
    newVersion,
    oldUiVersion,
    newUiVersion,
    dryRun,
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const titleArg = args.find((a) => a.startsWith("--title="));
  const summaryArg = args.find((a) => a.startsWith("--summary="));
  const target = args.find((a) => !a.startsWith("-")) || "patch";
  const res = runBumpVersion(target, {
    dryRun,
    title: titleArg ? titleArg.slice("--title=".length) : "",
    summary: summaryArg ? summaryArg.slice("--summary=".length) : "",
  });
  process.stdout.write(
    `${dryRun ? "[Dry Run] " : ""}版本已更新: v${res.oldVersion} -> v${res.newVersion} (UI: ${res.oldUiVersion} -> ${res.newUiVersion})\n`,
  );
  if (!dryRun) {
    process.stdout.write("提示：请同步完善 RELEASE_NOTES.md 与 RELEASE_NOTES.en.md 顶部章节的用户向中英文更新说明后再提交发布。\n");
  }
}
