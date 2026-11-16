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

export function runBumpVersion(target = "patch", { rootDir = ROOT_DIR, dryRun = false, date = new Date() } = {}) {
  const pkgPath = resolve(rootDir, "package.json");
  const lockPath = resolve(rootDir, "package-lock.json");
  const indexPath = resolve(rootDir, "public", "index.html");
  const appJsPath = resolve(rootDir, "public", "app.js");
  const changelogPath = resolve(rootDir, "CHANGELOG.md");

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
  const target = args.find((a) => !a.startsWith("-")) || "patch";
  const res = runBumpVersion(target, { dryRun });
  process.stdout.write(
    `${dryRun ? "[Dry Run] " : ""}版本已更新: v${res.oldVersion} -> v${res.newVersion} (UI: ${res.oldUiVersion} -> ${res.newUiVersion})\n`,
  );
}
