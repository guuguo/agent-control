import { existsSync } from "node:fs";
import { open, readdir } from "node:fs/promises";
import os from "node:os";
import { basename, extname, resolve } from "node:path";

const CACHE_TTL_MS = 15_000;
const catalogCache = new Map();

const COMMON_COMMANDS = Object.freeze([
  {
    id: "control:goal",
    command: "/goal",
    insertText: "/goal ",
    label: "/goal",
    description: "开启目标自动推进，未完成时自动续跑",
    category: "control",
    categoryLabel: "控制",
    providers: ["all"],
    pinned: true,
    priority: 100,
  },
]);

const PROVIDER_NATIVE_COMMANDS = Object.freeze({
  antigravity: [
    {
      id: "native:agy:plan",
      command: "/plan",
      insertText: "/plan ",
      label: "/plan",
      description: "先梳理方案与改动范围，确认后再动手",
      category: "native",
      categoryLabel: "原生",
      providers: ["antigravity"],
      pinned: true,
      priority: 95,
    },
    {
      id: "native:agy:teamwork",
      command: "/teamwork",
      insertText: "/teamwork ",
      label: "/teamwork",
      description: "开启多子代理并行协同处理大任务",
      category: "native",
      categoryLabel: "原生",
      providers: ["antigravity"],
      pinned: true,
      priority: 94,
    },
    {
      id: "native:agy:boost",
      command: "/boost",
      insertText: "/boost ",
      label: "/boost",
      description: "深度规划、多视角交叉校验与严谨实现",
      category: "native",
      categoryLabel: "原生",
      providers: ["antigravity"],
      pinned: true,
      priority: 93,
    },
    {
      id: "native:agy:compact",
      command: "/compact",
      insertText: "/compact",
      label: "/compact",
      description: "压缩整理当前对话上下文，释放窗口",
      category: "native",
      categoryLabel: "原生",
      providers: ["antigravity"],
      pinned: true,
      priority: 92,
    },
    {
      id: "native:agy:grill-me",
      command: "/grill-me",
      insertText: "/grill-me ",
      label: "/grill-me",
      description: "通过交互式追问对齐关键设计与边界",
      category: "native",
      categoryLabel: "原生",
      providers: ["antigravity"],
      pinned: true,
      priority: 91,
    },
  ],
  claude: [
    {
      id: "native:claude:compact",
      command: "/compact",
      insertText: "/compact ",
      label: "/compact",
      description: "压缩当前会话上下文，节省额度与窗口",
      category: "native",
      categoryLabel: "原生",
      providers: ["claude"],
      pinned: true,
      priority: 95,
    },
    {
      id: "native:claude:review",
      command: "/review",
      insertText: "/review ",
      label: "/review",
      description: "对当前改动做一轮完整代码评审",
      category: "native",
      categoryLabel: "原生",
      providers: ["claude"],
      pinned: true,
      priority: 94,
    },
    {
      id: "native:claude:clear",
      command: "/clear",
      insertText: "/clear",
      label: "/clear",
      description: "清空当前会话上下文重新开始",
      category: "native",
      categoryLabel: "原生",
      providers: ["claude"],
      pinned: true,
      priority: 93,
    },
  ],
  codex: [
    {
      id: "native:codex:review",
      command: "/review",
      insertText: "/review ",
      label: "/review",
      description: "审查当前 Git 变更或潜在缺陷",
      category: "native",
      categoryLabel: "原生",
      providers: ["codex"],
      pinned: true,
      priority: 95,
    },
    {
      id: "native:codex:compact",
      command: "/compact",
      insertText: "/compact",
      label: "/compact",
      description: "压缩整理当前 Codex 会话上下文",
      category: "native",
      categoryLabel: "原生",
      providers: ["codex"],
      pinned: true,
      priority: 94,
    },
    {
      id: "native:codex:diff",
      command: "/diff",
      insertText: "/diff",
      label: "/diff",
      description: "查看当前工作区代码差异",
      category: "native",
      categoryLabel: "原生",
      providers: ["codex"],
      pinned: true,
      priority: 93,
    },
  ],
  grok: [],
});

const PINNED_SKILLS = new Set([
  "diagnose",
  "tdd",
  "requesting-code-review",
  "ponytail-review",
  "handoff",
]);

async function readHeadText(filePath, maxBytes = 768) {
  let handle = null;
  try {
    handle = await open(filePath, "r");
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    await handle?.close().catch(() => {});
  }
}

function extractMarkdownSummary(rawText = "", fallback = "") {
  const text = String(rawText || "").replace(/\r\n/g, "\n").trim();
  if (!text) return fallback;

  if (text.startsWith("---")) {
    const endIdx = text.indexOf("\n---", 3);
    const frontmatter = endIdx > 0 ? text.slice(3, endIdx) : text.slice(3);
    const descMatch = frontmatter.match(/^description:\s*(.+)$/im);
    if (descMatch?.[1]) {
      const cleaned = descMatch[1].trim().replace(/^["'>|-]+\s*/, "").replace(/["']$/, "").trim();
      if (cleaned && cleaned !== ">-" && cleaned !== "|") {
        return cleaned.slice(0, 72);
      }
    }
    const multilineMatch = frontmatter.match(/^description:\s*[>|]-?\s*\n((?:\s+.+\n?)+)/im);
    if (multilineMatch?.[1]) {
      const joined = multilineMatch[1].split("\n").map((l) => l.trim()).filter(Boolean).join(" ");
      if (joined) return joined.slice(0, 72);
    }
  }

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line === "---" || line.startsWith("name:") || line.startsWith("description:")) continue;
    const stripped = line.replace(/^#+\s*/, "").trim();
    if (stripped) return stripped.slice(0, 72);
  }
  return fallback;
}

async function scanMarkdownCommands(dirPath, {
  provider,
  category = "workflow",
  categoryLabel = "工作流",
  pinned = true,
  priority = 80,
} = {}) {
  if (!dirPath || !existsSync(dirPath)) return [];
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const items = [];
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const ext = extname(entry.name).toLowerCase();
    if (ext !== ".md") continue;
    const name = basename(entry.name, ext).trim();
    if (!name) continue;
    const fullPath = resolve(dirPath, entry.name);
    const head = await readHeadText(fullPath);
    const description = extractMarkdownSummary(head, `${categoryLabel} · ${name}`);
    items.push({
      id: `${category}:${provider}:${name}`,
      command: `/${name}`,
      insertText: `/${name} `,
      label: `/${name}`,
      description,
      category,
      categoryLabel,
      providers: [provider],
      pinned,
      priority,
    });
  }
  return items;
}

async function scanSkillDirectories(dirPaths = [], { provider = "" } = {}) {
  const seen = new Set();
  const items = [];
  const prefix = provider === "codex" ? "$" : "/";
  for (const dirPath of dirPaths) {
    if (!dirPath || !existsSync(dirPath)) continue;
    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillName = entry.name.trim();
      if (!skillName || seen.has(skillName)) continue;
      const skillFile = resolve(dirPath, skillName, "SKILL.md");
      if (!existsSync(skillFile)) continue;
      seen.add(skillName);
      const isPinned = PINNED_SKILLS.has(skillName);
      const head = await readHeadText(skillFile, 640);
      const description = extractMarkdownSummary(head, `技能 · ${skillName}`);
      items.push({
        id: `skill:${skillName}`,
        command: `${prefix}${skillName}`,
        insertText: `${prefix}${skillName} `,
        label: `${prefix}${skillName}`,
        description,
        category: "skill",
        categoryLabel: "技能",
        providers: ["all"],
        pinned: isPinned,
        priority: isPinned ? 72 : 30,
      });
    }
  }
  return items;
}

export async function listSlashCommands({
  provider = "",
  cwd = "",
  query = "",
  homeDir = os.homedir(),
  useCache = true,
} = {}) {
  const cleanProvider = String(provider || "").trim().toLowerCase() || "antigravity";
  const cleanCwd = String(cwd || "").trim();
  const cacheKey = `${homeDir}::${cleanProvider}::${cleanCwd}`;

  let catalog = null;
  if (useCache) {
    const cached = catalogCache.get(cacheKey);
    if (cached && (Date.now() - cached.at) < CACHE_TTL_MS) {
      catalog = cached.items;
    }
  }

  if (!catalog) {
    const native = PROVIDER_NATIVE_COMMANDS[cleanProvider] || [];
    const customScans = [];

    if (cleanProvider === "antigravity" || cleanProvider === "claude" || cleanProvider === "codex") {
      customScans.push(
        scanMarkdownCommands(resolve(homeDir, ".gemini", "antigravity", "global_workflows"), {
          provider: cleanProvider,
          category: "workflow",
          categoryLabel: "工作流",
          pinned: true,
          priority: 82,
        }),
      );
    }
    if (cleanProvider === "claude") {
      customScans.push(
        scanMarkdownCommands(resolve(homeDir, ".claude", "commands"), {
          provider: "claude",
          category: "workflow",
          categoryLabel: "命令",
          pinned: true,
          priority: 85,
        }),
      );
      if (cleanCwd) {
        customScans.push(
          scanMarkdownCommands(resolve(cleanCwd, ".claude", "commands"), {
            provider: "claude",
            category: "workflow",
            categoryLabel: "项目命令",
            pinned: true,
            priority: 86,
          }),
        );
      }
    }
    if (cleanProvider === "codex") {
      customScans.push(
        scanMarkdownCommands(resolve(homeDir, ".codex", "prompts"), {
          provider: "codex",
          category: "workflow",
          categoryLabel: "提示词",
          pinned: true,
          priority: 84,
        }),
      );
    }
    if (cleanCwd) {
      customScans.push(
        scanMarkdownCommands(resolve(cleanCwd, ".agents", "workflows"), {
          provider: cleanProvider,
          category: "workflow",
          categoryLabel: "项目工作流",
          pinned: true,
          priority: 83,
        }),
      );
    }

    const skillDirs = [
      ...(cleanCwd ? [resolve(cleanCwd, ".agents", "skills")] : []),
      resolve(homeDir, ".agents", "skills"),
      resolve(homeDir, ".gemini", "antigravity", "skills"),
      resolve(homeDir, ".claude", "skills"),
    ];
    const [customGroups, skills] = await Promise.all([
      Promise.all(customScans),
      scanSkillDirectories(skillDirs, { provider: cleanProvider }),
    ]);

    const merged = new Map();
    for (const item of [...COMMON_COMMANDS, ...native, ...customGroups.flat(), ...skills]) {
      const dedupeKey = item.command.toLowerCase();
      const prev = merged.get(dedupeKey);
      if (!prev || item.priority > prev.priority) {
        merged.set(dedupeKey, item);
      }
    }
    catalog = [...merged.values()].sort((a, b) => (b.priority - a.priority) || a.command.localeCompare(b.command));
    if (useCache) {
      catalogCache.set(cacheKey, { at: Date.now(), items: catalog });
    }
  }

  const cleanQuery = String(query || "").trim().replace(/^[/$\s]+/, "").toLowerCase();
  if (!cleanQuery) {
    return catalog.filter((item) => item.pinned).slice(0, 14);
  }
  return catalog
    .filter((item) => {
      const cmd = item.command.toLowerCase();
      const desc = String(item.description || "").toLowerCase();
      return cmd.includes(cleanQuery) || desc.includes(cleanQuery);
    })
    .slice(0, 14);
}
