import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  extractCodexUserAttachmentsAndText,
  isCodexHeartbeatText,
  isCodexQuestionReplyText,
} from "./codex-input-clean.mjs";
import { isUserHomePath, normalizeWorkspacePath, resolvePlatformDataDir } from "./platform.mjs";
import { stripPromptNoise } from "./thread-display.mjs";

export const TITLE_SCHEMA_VERSION = 3;

const DEFAULT_TITLE_MAX_LEN = 32;
const LOW_QUALITY_TITLE_MAX_LEN = 36;
const FINAL_TITLE_MAX_LEN = 25;
const PREFIXED_CORE_MAX_LEN = 15;
const UNPREFIXED_CORE_MAX_LEN = 22;

const META_CATEGORIES = new Set([
  "任务", "修复", "排查", "调研", "优化", "新功能", "重构", "部署",
  "验收", "方案", "巡检", "角色卡", "分镜", "发布", "成片", "剧本", "复盘",
]);

const CONTINUATION_EXACT = new Set([
  "继续",
  "继续吧",
  "继续执行",
  "继续推进",
  "继续完成",
  "继续修改",
  "继续排查",
  "继续检查",
  "继续看",
  "接着做",
  "接着来",
  "往下做",
  "按这个来",
  "按计划执行",
  "开始执行",
  "执行吧",
  "动手吧",
  "直接改",
  "改吧",
  "好的",
  "好",
  "行",
  "可以",
  "没问题",
  "对",
  "是的",
  "嗯",
  "收到",
  "谢谢",
  "辛苦了",
  "好了吗",
  "改好了吗",
  "弄好了吗",
  "要",
  "不要",
  "ok",
  "okay",
  "yes",
  "yep",
  "sure",
  "continue",
  "proceed",
  "go ahead",
  "lgtm",
  "do it",
  "ship it",
  "thanks",
  "跑一下测试",
  "跑下测试",
  "跑测试",
  "跑单测",
  "运行测试",
  "跑一下单测",
  "测一下",
  "验证一下",
  "检查一下",
  "提交代码",
  "提交一下",
  "git commit",
  "git push",
  "push 一下",
  "推上去",
  "构建一下",
  "打包一下",
  "重启一下",
  "刷新一下",
  "再试一次",
  "重试一下",
  "回滚",
  "撤销",
  "第一个",
  "第二个",
]);

const GENERIC_LOW_WEIGHT_WORDS = new Set([
  "claude", "codex", "antigravity", "gemini", "grok", "agent", "cli", "ide", "app", "ai",
  "项目", "代码", "文件", "功能", "问题", "逻辑", "内容", "任务", "会话", "情况", "状态", "结果",
  "修改", "优化", "修复", "实现", "新增", "调整", "更新", "检查", "排查", "查看", "查询", "分析",
  "处理", "支持", "配置", "报错", "错误", "需求", "方案", "信息", "一下", "当前", "现在", "后续",
  "bug", "fix", "fixed", "update", "updated", "add", "added", "check", "error", "issue",
  "task", "session", "project", "code", "file", "files", "feature", "logic", "test", "tests",
  "mjs", "cjs", "js", "ts", "tsx", "jsx", "py", "json", "md", "txt", "sh", "yaml", "yml",
]);

const EN_STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being", "to", "of", "in",
  "on", "at", "for", "with", "by", "from", "as", "and", "or", "but", "if", "when", "that",
  "this", "these", "those", "it", "its", "my", "our", "your", "their", "we", "you", "they",
  "can", "could", "would", "should", "will", "may", "might", "must", "please", "help", "me",
  "want", "need", "let", "lets", "now", "into", "about", "not", "no", "yes", "do", "does",
  "did", "has", "have", "had", "how", "why", "what", "which", "where", "who",
]);

const ZH_STOP_SPLITTER_RE = /(?:的|了|着|过|和|与|及|或|把|被|将|在|从|到|对|给|让|用|按|并|且|而|都|也|还|又|再|先|就|只|要|想|能|会|可以|一下|一个|一些|这个|那个|这些|那些|当前|现在|目前|我们|你们|请问|麻烦|帮我|里面|其中|里|中|上|下)/g;

const OPEN_TO_CLOSE = new Map([
  ["《", "》"],
  ["「", "」"],
  ["『", "』"],
  ["“", "”"],
  ["（", "）"],
  ["(", ")"],
  ["【", "】"],
  ["[", "]"],
]);
const CLOSE_CHARS = new Set(["》", "」", "』", "”", "）", ")", "】", "]"]);
const TOGGLE_QUOTES = new Set(['"', "`"]);

// Built-in generic rules; user-specific rules can be placed in <dataDir>/title-rules.json.
const BUILTIN_SERIES_TARGETS = [];

const BUILTIN_APP_TARGETS = [
  { target: "AgentCtrl", domainKey: "app:agent-control", re: /agent-control|agent\s*control|agentctrl/i, stripRe: /(?:agent-control|agent\s+control|agentctrl)/gi },
  { target: "YouTube", domainKey: "plat:youtube", re: /youtube/i, stripRe: /youtube/gi },
];

const BUILTIN_CWD_SOFTWARE_RULES = [
  { target: "AgentCtrl", domainKey: "app:agent-control", re: /(?:^|\/)agent-control(?:\/|$)/i, stripRe: /(?:agent-control|agent\s+control|agentctrl)/gi },
];

// Tier 3: Generic AI agent tools & public platforms.
const GENERIC_TOOL_TARGETS = [
  { target: "Antigravity", domainKey: "tool:antigravity", re: /\bantigravity\b/i, stripRe: /\bantigravity\b/gi },
  { target: "Claude", domainKey: "tool:claude", re: /\bclaude\b/i, stripRe: /\bclaude\b/gi },
  { target: "Gemini", domainKey: "tool:gemini", re: /\bgemini\b/i, stripRe: /\bgemini\b/gi },
  { target: "Codex", domainKey: "tool:codex", re: /\bcodex\b/i, stripRe: /\bcodex\b/gi },
  { target: "Grok", domainKey: "tool:grok", re: /\bgrok\b/i, stripRe: /\bgrok\b/gi },
  { target: "视频号", domainKey: "plat:weixin", re: /视频号/i, stripRe: null },
  { target: "小红书", domainKey: "plat:xiaohongshu", re: /小红书/i, stripRe: null },
  { target: "抖音", domainKey: "plat:douyin", re: /抖音/i, stripRe: null },
  { target: "B站", domainKey: "plat:bilibili", re: /B站|bilibili/i, stripRe: null },
];

const GENERIC_TMP_DIR_RE = /^(?:tmp|temp|workspace|work|project|repo|drift|drift-proj|mock-[a-z0-9-]+|ac-[a-z0-9-]+)$/i;
const BUILTIN_GENERIC_FALLBACK_TARGETS = new Set(["通用", "本机环境"]);

function compileRuleEntry(item) {
  if (!item || typeof item !== "object" || !item.target || !item.domainKey) return null;
  if (item.re instanceof RegExp) {
    return {
      target: String(item.target),
      domainKey: String(item.domainKey),
      re: item.re,
      stripRe: item.stripRe instanceof RegExp ? item.stripRe : null,
    };
  }
  if (!item.pattern) return null;
  try {
    return {
      target: String(item.target),
      domainKey: String(item.domainKey),
      re: new RegExp(String(item.pattern), String(item.flags || "i")),
      stripRe: item.stripPattern ? new RegExp(String(item.stripPattern), String(item.stripFlags || "gi")) : null,
    };
  } catch {
    return null;
  }
}

let cachedExternalRulesPath = "";
let cachedExternalRulesMtimeMs = -1;
let cachedExternalRules = null;

function loadExternalTitleRules() {
  if (process.env.AGENT_CONTROL_DISABLE_LOCAL_TITLE_RULES === "1") return null;
  const rulesPath = process.env.AGENT_CONTROL_TITLE_RULES_FILE
    ? String(process.env.AGENT_CONTROL_TITLE_RULES_FILE)
    : join(resolvePlatformDataDir({ customDir: process.env.AGENT_CONTROL_DATA_DIR }), "title-rules.json");
  if (!rulesPath || !existsSync(rulesPath)) return null;
  try {
    const stat = statSync(rulesPath);
    if (cachedExternalRules && cachedExternalRulesPath === rulesPath && cachedExternalRulesMtimeMs === stat.mtimeMs) {
      return cachedExternalRules;
    }
    const parsed = JSON.parse(readFileSync(rulesPath, "utf8"));
    cachedExternalRulesPath = rulesPath;
    cachedExternalRulesMtimeMs = stat.mtimeMs;
    cachedExternalRules = parsed && typeof parsed === "object" ? parsed : null;
    return cachedExternalRules;
  } catch {
    return null;
  }
}

function getActiveTitleRules(customRules = undefined) {
  const ext = customRules !== undefined ? customRules : loadExternalTitleRules();
  const seriesTargets = [
    ...((Array.isArray(ext?.seriesTargets) ? ext.seriesTargets : []).map(compileRuleEntry).filter(Boolean)),
    ...BUILTIN_SERIES_TARGETS,
  ];
  const appTargets = [
    ...((Array.isArray(ext?.appTargets) ? ext.appTargets : []).map(compileRuleEntry).filter(Boolean)),
    ...BUILTIN_APP_TARGETS,
  ];
  const cwdRules = [
    ...((Array.isArray(ext?.cwdRules) ? ext.cwdRules : []).map(compileRuleEntry).filter(Boolean)),
    ...BUILTIN_CWD_SOFTWARE_RULES,
  ];
  const genericFallbackTargets = new Set([
    ...BUILTIN_GENERIC_FALLBACK_TARGETS,
    ...(Array.isArray(ext?.genericFallbackTargets) ? ext.genericFallbackTargets.map((s) => String(s || "").trim()).filter(Boolean) : []),
  ]);
  const cwdAliases = ext?.cwdAliases && typeof ext.cwdAliases === "object" ? ext.cwdAliases : {};
  return { seriesTargets, appTargets, cwdRules, genericFallbackTargets, cwdAliases };
}

const EN_EXACT_PHRASE_MAP = new Map([
  ["bug report and screenshot", "问题反馈与截图排查"],
  ["file does not exist error", "文件不存在报错处理"],
  ["gemini ultra cloud usage capabilities", "Gemini云端用量能力"],
  ["remote control codex project design", "远程控制项目设计"],
]);

const EN_ZH_WORD_MAP = new Map([
  ["remote", "远程"],
  ["control", "控制"],
  ["project", "项目"],
  ["design", "设计"],
  ["capabilities", "能力"],
  ["capability", "能力"],
  ["cloud", "云端"],
  ["usage", "用量"],
  ["ultra", ""],
  ["report", "反馈"],
  ["screenshot", "截图"],
  ["does", "不"],
  ["not", "不"],
  ["exist", "存在"],
  ["webhook", "Webhook"],
  ["signature", "签名"],
  ["verification", "校验"],
  ["verify", "校验"],
  ["github", "GitHub"],
  ["events", "事件"],
  ["event", "事件"],
  ["thread", "会话"],
  ["threads", "会话"],
  ["session", "会话"],
  ["title", "标题"],
  ["titles", "标题"],
  ["sidebar", "侧边栏"],
  ["voice", "语音"],
  ["audio", "音频"],
  ["preview", "预览"],
  ["mobile", "手机端"],
  ["timeout", "超时"],
  ["error", "报错"],
  ["bug", "Bug"],
  ["fix", "修复"],
  ["add", "新增"],
  ["update", "更新"],
  ["optimize", "优化"],
  ["refactor", "重构"],
  ["test", "测试"],
  ["tests", "测试"],
  ["auth", "鉴权"],
  ["login", "登录"],
]);

function extractRawRequestTag(raw) {
  const text = String(raw || "");
  const match = text.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  return match ? match[1] : text;
}

function stripInjectedBlocksKeepLines(raw) {
  const unwrapped = extractCodexUserAttachmentsAndText(extractRawRequestTag(raw), {
    preserveQuestionReplies: false,
    truncatedPreview: true,
  }).text;
  return unwrapped
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, "\n")
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, "\n")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "\n")
    .replace(/\[SYSTEM NOTIFICATION - NOT USER INPUT\](?:[^\n]*\n?){0,6}?(?=\s*<task-notification\b|\s*$)/gi, "\n")
    .replace(/<task-notification\b[^>]*>[\s\S]*?<\/task-notification>/gi, "\n")
    .replace(/(?:^|\n)[ \t]*Another Claude session sent a message:\s*\n?<cross-session-message\b[^>]*>[\s\S]*?<\/cross-session-message>|<cross-session-message\b[^>]*>[\s\S]*?<\/cross-session-message>/gi, "\n")
    .replace(/<(system-reminder|local-command-caveat|local-command-stdout|local-command-stderr|command-name|command-message|command-args|side-sessions-event|tools-used-before-summary)\b[^>]*>[\s\S]*?<\/\1>/gi, "\n")
    .replace(/<bash-stdout\b[^>]*>[\s\S]*?<\/bash-stdout>/gi, "\n")
    .replace(/<bash-stderr\b[^>]*>[\s\S]*?<\/bash-stderr>/gi, "\n")
    .replace(/<bash-input\b[^>]*>([\s\S]*?)<\/bash-input>/gi, "\n$1\n")
    .replace(/<skills_instructions>[\s\S]*?<\/skills_instructions>/gi, "\n")
    .replace(/<permissions instructions[\s\S]*?<\/permissions instructions>/gi, "\n")
    .replace(/<multi_agent_[^>]*>[\s\S]*?<\/multi_agent_[^>]*>/gi, "\n")
    .replace(/^# AGENTS\.md instructions[\s\S]*$/m, "\n")
    .replace(/\[Request interrupted by user[^\]]*\]/gi, "\n")
    .replace(/\[AGENT_CONTROL_PING\][^\n]*/gi, "\n")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<!--\s*GOAL_COMPLETE\s*-->/gi, " ")
    .replace(/\r\n?/g, "\n");
}

function stripExampleParentheticals(text) {
  return String(text || "")
    .replace(/（(?:例如|比如|譬如|如|用户\s*20\d{2}-[^）]*|\d+(?:\.\d+)?\s*秒)[：:\s]*[^）\n]*）/g, "")
    .replace(/\((?:e\.g\.|for example|such as|例如|比如|如|用户\s*20\d{2}-[^)]*|\d+(?:\.\d+)?\s*秒)[：:\s]*[^)\n]*\)/gi, "");
}

function normalizeUrlAndMarkdownTokens(text) {
  return String(text || "")
    .replace(/!\[([^\]\n]*)\]\(\s*(?:<[^>\n]+>|(?:[^()\n]|\([^()\n]*\))*)\s*\)/g, "$1")
    .replace(/\[([^\]\n]+)\]\(\s*(?:<[^>\n]+>|(?:[^()\n]|\([^()\n]*\))*)\s*\)/g, "$1")
    .replace(/\[([^\]\n]+)\]\(\s*(?:<(?:\/|[A-Za-z]:\\|https?:|file:)[^>\n]*|(?:\/|[A-Za-z]:\\|https?:|file:)[^)\n]*)$/, "$1")
    .replace(/`([^`\n]{1,120})`/g, "$1")
    .replace(/(?:https?|file):\/\/[^\s)>\]]+/gi, " ");
}

function cleanSingleLineForTitle(line) {
  let out = String(line || "");
  out = normalizeUrlAndMarkdownTokens(out);
  out = stripExampleParentheticals(out);
  out = out
    .replace(/^[\s>#*-]+/, "")
    .replace(/^\d+[.)、]\s+/, "")
    .replace(/^\/goal(?:\s+|$)/i, "")
    .replace(/^\[AC_VOICE_CALL\]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return out;
}

function cleanPromptLines(raw) {
  const pre = stripInjectedBlocksKeepLines(raw);
  return pre
    .split("\n")
    .map(cleanSingleLineForTitle)
    .filter(Boolean);
}

export function cleanPromptForTitle(raw) {
  return cleanPromptLines(raw).join(" ").replace(/\s+/g, " ").trim();
}

function normalizeForContinuationCheck(raw) {
  return cleanPromptForTitle(raw)
    .replace(/[，。！？、；：,.!?;:~`'"“”‘’()（）[\]【】\s]+$/g, "")
    .replace(/^[，。！？、；：,.!?;:~`'"“”‘’()（）[\]【】\s]+/g, "")
    .trim();
}

export function isContinuationOrControlPrompt(raw) {
  if (isCodexQuestionReplyText(raw) || isCodexHeartbeatText(raw)) return true;
  const rawTrimmed = stripPromptNoise(raw);
  if (!rawTrimmed) return true;
  if (/^\[Goal 自动推进/i.test(rawTrimmed)) return true;
  if (/<!--\s*GOAL_COMPLETE\s*-->/i.test(rawTrimmed)) return true;
  if (/^\[plan review(?:\s+due)?\]/i.test(rawTrimmed)) return true;
  if (/^\[AGENT_CONTROL_PING\]/i.test(rawTrimmed)) return true;
  if (/^\/goal\s*$/i.test(rawTrimmed)) return true;
  if (/^\/(?:compact|clear|status|help|model|plan|review|init|cost|doctor|login|logout|resume)(?:\s|$)/i.test(rawTrimmed)) {
    return true;
  }

  const normalized = normalizeForContinuationCheck(raw);
  if (!normalized) return true;
  const lower = normalized.toLowerCase();
  if (CONTINUATION_EXACT.has(normalized) || CONTINUATION_EXACT.has(lower)) {
    return true;
  }
  if (/^(?:选\s*)?(?:方案\s*)?[A-D1-4一二三四]$/i.test(normalized)) {
    return true;
  }
  if (/^按\s*(?:方案\s*)?[A-Z0-9一二三四]\s*(?:继续|执行|来|做)?$/i.test(normalized)) {
    return true;
  }
  if (/^(?:帮我|请)?(?:继续(?:执行|完成|推进|修改|检查|排查|测试|做|看)?|接着(?:做|执行|查|改|看)?|往下(?:做|推进)?)(?:吧|啊|吗|一下)?$/.test(normalized)) {
    return true;
  }
  if (normalized.length <= 18) {
    if (/^(?:帮我|请)?(?:跑一下|跑下|运行|跑|测一下|验证一下|提交|push\s*一下|构建一下|打包一下|重启一下|刷新一下)?(?:单?测|测试|代码|git|commit|push)?(?:吧|啊)?$/i.test(normalized)
      && /(?:测试|单测|提交|commit|push|构建|打包|重启|刷新|验证|重试|再试)/i.test(normalized)
    ) {
      return true;
    }
    if (/^(?:为什么|怎么还是|还是不行|还有问题|报错了|又报错了|修一下这个|修一下刚才那个报错|把这个也改了|这里不对|不对|再改一下|顺便改一下|再看看|你怎么看|怎么挂了|怎么卡死了)$/i.test(normalized)) {
      return true;
    }
    if (/^(?:为什么|怎么还是)(?:还是)?(?:不行|报错|失败|卡住)[了吗啊呀]?$/.test(normalized)) {
      return true;
    }
    if (/(?:这个|那个|这里|那里|刚才|上面|上述)/.test(normalized) && countHighWeightTokens(normalized) === 0) {
      return true;
    }
  }
  return false;
}

export function isQuestionOrInquiryPrompt(raw) {
  const clean = normalizeForContinuationCheck(raw);
  if (!clean) return true;
  const rawTrimmed = cleanPromptForTitle(raw);
  if (/[？?]\s*$/.test(rawTrimmed)) return true;
  if (/(?:吗|呢)\s*$/.test(clean) && !/^(?:把|为|给|将|使用|请用|用)/.test(clean)) return true;
  if (/(?:^|[，,。\s])(?:为啥|为什么|是什么情况|怎么回事|怎么了|是不是|有没有|需要[^。！？]{0,16}(?:改动|改|重跑|重写)吗|要改吗|好使吗|可行吗)(?:$|[，,。？！?\s])/.test(rawTrimmed)) {
    return true;
  }
  return false;
}

function isDeicticOrPlaceholderPrompt(raw) {
  const clean = cleanPromptForTitle(raw);
  if (!clean) return true;
  return /^(?:看下|看看|帮我看下|看)?(?:这个项目|这个问题|这个页面|这个报错)(?:[。，,\s]+|$)/.test(clean)
    || /^(?:小助理\s*bug\s*等下发你图|等下发你图|等下给你看)[。，,\s]*$/i.test(clean);
}

function isCanonicalBracketUpstreamTitle(rawUpstream) {
  const clean = stripPromptNoise(rawUpstream);
  if (!clean) return false;
  const match = clean.match(/^【([^】\n]{1,64})】\s*(\S.*)$/);
  if (!match) return false;
  const parts = match[1].split(/[｜|]/).map((part) => part.trim()).filter(Boolean);
  // 3 段及以上上下文（如【客户｜提出人｜模块｜机型】异常）视为工单/技能规范标题，原样保留不裁剪。
  if (parts.length < 3) return false;
  return !isLowQualityTitle(match[2].trim());
}

function isGoodConciseUpstreamTitle(rawUpstream) {
  const clean = stripPromptNoise(rawUpstream);
  if (!clean || isLowQualityTitle(clean)) return false;
  if (clean.length < 4 || clean.length > 24) return false;
  if (!/[\u4e00-\u9fff]/.test(clean)) return false;
  if (/^(?:#*\s*任务|任务\s*[：:]|请?(?:遵循|按照|依照|使用|调用|先?读取)|<)/i.test(clean)) return false;
  if (isQuestionOrInquiryPrompt(clean)) return false;
  return true;
}

function stripLeadingConversationalFiller(line) {
  let out = String(line || "").trim();
  const zhPrefixRe = /^(?:你好[，,、\s]*|嗨[，,、\s]*|请问(?:一下)?[，,、\s]*|麻烦(?:你)?[，,、\s]*|请你?[，,、\s]*|帮我(?:们)?(?:先|再|顺便)?|帮忙(?:先|再)?|能不能(?:帮我)?|能否(?:帮我)?|可以(?:帮我)?|我想(?:让你|请你|要)?|我现在(?:想|需要|要)|我们需要|需要你?(?:帮我)?|现在(?:请|帮我|需要|要)?|先帮我|顺便(?:帮我)?)+/i;
  const enPrefixRe = /^(?:(?:hi|hello|hey)[,!\s]+|(?:can|could|would)\s+you\s+(?:please\s+)?|please\s+(?:help\s+(?:me\s+)?)?|help\s+me\s+(?:to\s+)?|i\s+(?:want|need)\s+(?:you\s+)?to\s+|let'?s\s+)/i;

  for (const iPass of [0, 1, 2, 3]) {
    void iPass;
    const before = out;
    out = out
      .replace(/^#*\s*任务\s*[：:]\s*/i, "")
      .replace(/^工作目录\s*[：:]\s*\S+\s*[。；;\s]*/i, "")
      .replace(/^(?:(?:中文|然后|另外|好的|行|那)[，,、\s]*){1,3}(?=[\u4e00-\u9fffA-Za-z])/, "")
      .replace(zhPrefixRe, "")
      .replace(enPrefixRe, "")
      .trim();

    const compUseMatch = out.match(
      /^(?:请?\s*)?使用\s+Computer\s+Use\s+在(?:用户)?现有的\s*(?:Google\s*)?Chrome\s*浏览器中\s*(.+)$/i,
    );
    if (compUseMatch?.[1]) {
      out = compUseMatch[1].trim();
    }

    const skillMatch = out.match(
      /^(?:请?\s*)?(?:严格)?(?:遵循|按照|依照|使用|调用|通过|用|结合)\s+[^，。；\n]{2,68}?(?:技能|工具|方案|skills?)(?:[，,、：:\s]+|(?=[为给把对将向按读生制创修]))(.+)$/i,
    );
    if (skillMatch?.[1] && skillMatch[1].trim().length >= 6) {
      out = skillMatch[1].trim();
    }

    const seqMatch = out.match(
      /^在当前(?:单一)?会话内(?:严格)?按\s*[a-zA-Z0-9→\-\s、,，]{2,30}?顺序(?:串行|逐张)?\s*(.+)$/i,
    );
    if (seqMatch?.[1] && seqMatch[1].trim().length >= 6) {
      out = seqMatch[1].trim();
    }

    const prereqReadMatch = out.match(
      /^(?:请?\s*)?先?(?:完整)?读取(?:一下|下)?\s*[^，。；\n]{2,90}?[，,、；;\s]+(.{6,})$/,
    );
    if (prereqReadMatch?.[1]) {
      out = prereqReadMatch[1].trim();
    }

    const lookMatch = out.match(/^(?:看一下|看下|看看|瞧瞧)\s*(.+)$/);
    if (lookMatch?.[1] && lookMatch[1].trim().length >= 4) {
      out = lookMatch[1].trim();
    }

    out = out.replace(
      /^(优化|修复|排查|实现|检查|清理|整理|重构|调整|升级|补充|测试|查看|查询|确认|改进|完善)(?:一下|下)(?:\s+|(?=[\u4e00-\u9fffA-Za-z0-9]))/,
      (_, verb, offset, str) => {
        const rest = str.slice(offset + verb.length + (str[offset + verb.length] === "下" ? 1 : 2)).trimStart();
        return /^[A-Za-z0-9`]/.test(rest) ? `${verb} ` : verb;
      },
    );
    if (out === before) break;
  }
  return out;
}

function truncateTitleCleanly(text, maxLength, { allowCommaSplit = true } = {}) {
  let clean = String(text || "")
    .replace(/[。！？!?；;，,：:\s]+$/g, "")
    .trim();
  if (!clean) return "";
  if (clean.length <= maxLength) return clean;

  if (allowCommaSplit) {
    const commaMatch = clean.match(/^(.{6,}?)[，,]\s*/);
    if (commaMatch && commaMatch[1].length >= 6 && commaMatch[1].length <= maxLength) {
      return commaMatch[1].trim();
    }
  }

  let cut = clean.slice(0, Math.max(1, maxLength - 1));
  if (/[a-zA-Z0-9_-]/.test(clean[cut.length] || "")) {
    const lastSpace = cut.lastIndexOf(" ");
    if (lastSpace >= Math.floor(maxLength * 0.55)) {
      cut = cut.slice(0, lastSpace);
    }
  }
  cut = cut.replace(/[，,、：:；;\-\s(（["'“‘]+$/g, "").trimEnd();
  if (!cut) cut = clean.slice(0, Math.max(1, maxLength - 1)).trimEnd();
  return `${cut}…`;
}

function cutClauseForTitle(line) {
  const src = String(line || "").trim();
  if (!src) return "";

  const stack = [];
  let cutIndex = -1;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (TOGGLE_QUOTES.has(ch)) {
      if (stack[stack.length - 1] === ch) stack.pop();
      else stack.push(ch);
      continue;
    }
    const expectedClose = OPEN_TO_CLOSE.get(ch);
    if (expectedClose) {
      stack.push(expectedClose);
      continue;
    }
    if (CLOSE_CHARS.has(ch)) {
      if (stack.length && stack[stack.length - 1] === ch) {
        stack.pop();
      }
      continue;
    }

    if (stack.length > 0) continue;

    const rest = src.slice(i);
    if (i >= 5 && (
      /^[。！？!?；;\n]/.test(ch)
      || rest.startsWith("——")
      || /^\s+--\s+/.test(rest)
      || /^[：:]\s*(?:当|如果|要求|需要|比如|例如|其中|具体|即|1\.|a\))/.test(rest)
      || /^，\s*(?:当|如果|要求|需要|并且|同时|确保|不要|避免|比如|例如|我发现|我觉得)/.test(rest)
    )) {
      cutIndex = i;
      break;
    }
    if (i >= 8 && (ch === "：" || (ch === ":" && !rest.startsWith("://")))) {
      cutIndex = i;
      break;
    }
  }

  return cutIndex >= 0 ? src.slice(0, cutIndex).trim() : src;
}

function pickSubstantiveLine(lines) {
  for (const line of lines) {
    const stripped = stripLeadingConversationalFiller(line);
    if (!stripped) continue;
    if (/^(?:这个问题|以下几个需求|如下|请看下方|看这里|工作目录)[：:，,。\s]*$/i.test(stripped)) continue;
    return stripped;
  }
  return "";
}

export function summarizeTaskTitle(raw, { maxLength = DEFAULT_TITLE_MAX_LEN, assistantText = "" } = {}) {
  const cap = Math.max(8, Number(maxLength) || DEFAULT_TITLE_MAX_LEN);
  const lines = cleanPromptLines(raw);
  const primary = pickSubstantiveLine(lines);
  if (primary) {
    const claused = cutClauseForTitle(primary);
    const candidate = truncateTitleCleanly(claused || primary, cap);
    if (candidate) return candidate;
  }

  const cleanAssistant = cleanPromptLines(assistantText)[0] || "";
  if (cleanAssistant) {
    const strippedAssistant = cleanAssistant
      .replace(/^(?:好的[，,]?\s*|没问题[，,]?\s*)?(?:我已经|我已|已为您|已帮您|已完成)/, "")
      .trim();
    const claused = cutClauseForTitle(strippedAssistant || cleanAssistant);
    const candidate = truncateTitleCleanly(claused, cap);
    if (candidate) return candidate;
  }
  return "";
}

export function extractTopicTokens(text) {
  const clean = cleanPromptForTitle(text);
  const tokenWeights = new Map();
  if (!clean) return tokenWeights;

  const addToken = (tok, weight) => {
    if (!tok) return;
    const prev = tokenWeights.get(tok);
    if (prev === undefined || weight > prev) {
      tokenWeights.set(tok, weight);
    }
  };

  const asciiMatches = clean.match(/[a-zA-Z0-9][a-zA-Z0-9._/-]*/g) || [];
  for (const rawTok of asciiMatches) {
    const lower = rawTok.toLowerCase();
    if (lower.length < 2 || EN_STOP_WORDS.has(lower)) continue;
    const parts = rawTok
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[._/\-\s]+/)
      .map((p) => p.toLowerCase())
      .filter((p) => p.length >= 2 && !EN_STOP_WORDS.has(p));
    if (parts.length > 1) {
      for (const part of parts) {
        const w = GENERIC_LOW_WEIGHT_WORDS.has(part) ? 0.25 : 1.0;
        addToken(part, w);
      }
    } else {
      const w = GENERIC_LOW_WEIGHT_WORDS.has(lower) ? 0.25 : 1.0;
      addToken(lower, w);
    }
  }

  const zhRuns = clean.match(/[\u4e00-\u9fff]+/g) || [];
  for (const run of zhRuns) {
    const chunks = run.split(ZH_STOP_SPLITTER_RE).filter(Boolean);
    for (const chunk of chunks) {
      if (chunk.length < 2) continue;
      if (chunk.length === 2) {
        addToken(chunk, GENERIC_LOW_WEIGHT_WORDS.has(chunk) ? 0.25 : 1.0);
        continue;
      }
      for (let i = 0; i <= chunk.length - 2; i += 1) {
        const bg = chunk.slice(i, i + 2);
        addToken(bg, GENERIC_LOW_WEIGHT_WORDS.has(bg) ? 0.25 : 1.0);
      }
    }
  }

  return tokenWeights;
}

function countHighWeightTokens(text) {
  let count = 0;
  for (const weight of extractTopicTokens(text).values()) {
    if (weight >= 0.9) count += 1;
  }
  return count;
}

export function isSubstantiveTaskPrompt(text) {
  if (isContinuationOrControlPrompt(text)) return false;
  const clean = cleanPromptForTitle(text);
  if (!clean) return false;
  const hasCjk = /[\u4e00-\u9fff]/.test(clean);
  if (hasCjk ? clean.length < 6 : clean.length < 12) return false;
  const summary = summarizeTaskTitle(clean);
  if (summary.length < 4) return false;
  return countHighWeightTokens(clean) >= 1;
}

export function computeTopicSimilarity(titleA, textB) {
  const tokensA = extractTopicTokens(titleA);
  const tokensB = extractTopicTokens(textB);
  if (tokensA.size === 0 || tokensB.size === 0) {
    return {
      sharedWeight: 0,
      totalTitleWeight: 0,
      titleCoverage: 0,
      sharedHighWeightCount: 0,
    };
  }

  let totalTitleWeight = 0;
  let sharedWeight = 0;
  let sharedHighWeightCount = 0;

  for (const [tok, wA] of tokensA.entries()) {
    totalTitleWeight += wA;
    if (tokensB.has(tok)) {
      const effectiveW = Math.min(wA, tokensB.get(tok));
      sharedWeight += effectiveW;
      if (effectiveW >= 0.9) sharedHighWeightCount += 1;
    }
  }

  return {
    sharedWeight,
    totalTitleWeight,
    titleCoverage: totalTitleWeight > 0 ? sharedWeight / totalTitleWeight : 0,
    sharedHighWeightCount,
  };
}

export function isLowQualityTitle(title) {
  const raw = String(title || "");
  if (/<(?:image\b|send_user_message_question_rep|environment_context|skills_instructions|multi_agent_|in-app-browser-context|heartbeat\b|external_codex_apps_|codex_apps_|task-notification\b|cross-session-message\b|system-reminder\b|local-command-|command-name\b|command-message\b|side-sessions-event\b|tools-used-before-summary\b|bash-input\b|bash-stdout\b|bash-stderr\b)/i.test(raw)) {
    return true;
  }
  if (/^\s*#\s*Files (?:mentioned|pasted) by the user:/i.test(raw)) {
    return true;
  }
  const trimmedRaw = raw.trim();
  if (/^(?:使用|调用|通过|遵循|按照)\s+[$a-zA-Z0-9_./\-（()）]+(?:\s*(?:[、/,/+]|和|与|及)\s*[$a-zA-Z0-9_./\-]+)*(?:\s*(?:技能|工具)\s*$|\s*(?:和|与|及)?\s*(?:…|\.{2,})$)/i.test(trimmedRaw)) {
    return true;
  }
  const clean = stripPromptNoise(title);
  if (!clean) return true;
  if (/^(?:新会话|new chat|new session|untitled|未命名会话)$/i.test(clean)) return true;
  if (/<USER_REQUEST>|\[Goal 自动推进|\[AC_VOICE_CALL\]|\[AGENT_CONTROL_PING\]/i.test(raw)) {
    return true;
  }
  if (clean.length > LOW_QUALITY_TITLE_MAX_LEN) return true;
  if (/[\r\n]/.test(String(title || "").trim())) return true;
  if (/^(?:(?:请(?:你)?(?:帮我)?|帮我|请问|麻烦(?:你)?|我现在(?:需要|想))|(?:can you|please help|help me)\b)/i.test(clean)) {
    return true;
  }
  return false;
}

function extractSingleUserMessageText(item) {
  if (!item || item.type !== "userMessage") return "";
  if (typeof item.text === "string" && item.text.trim()) return item.text;
  const content = Array.isArray(item.content) ? item.content : [];
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

export function extractUserPromptsFromTurns(turns = []) {
  const out = [];
  if (!Array.isArray(turns)) return out;
  for (const turn of turns) {
    const items = Array.isArray(turn?.items) ? turn.items : [];
    const parts = [];
    for (const item of items) {
      if (item?.type !== "userMessage") continue;
      const text = extractSingleUserMessageText(item);
      if (text && text.trim()) parts.push(text.trim());
    }
    const merged = parts.join("\n").trim();
    if (merged) out.push(merged);
  }
  return out;
}

export function extractTouchedPathsFromTurns(turns = [], { maxPaths = 24 } = {}) {
  const out = [];
  const seen = new Set();
  const addPath = (rawPath) => {
    const p = String(rawPath || "").trim().replace(/^file:\/\//i, "");
    if (!p || p.includes("\0") || /^(?:https?:|data:|mailto:)/i.test(p)) return;
    if (seen.has(p)) return;
    seen.add(p);
    out.push(p);
  };
  const scanTextForPaths = (txt) => {
    const raw = String(txt || "");
    if (!raw) return;
    const imgRe = /<image\b[^>]*\bpath\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    let m;
    while ((m = imgRe.exec(raw)) !== null) {
      addPath(m[1] ?? m[2] ?? m[3]);
    }
    const linkRe = /\]\(\s*(?:<([^>\n]+)>|((?:\/|[A-Za-z]:\\|file:\/\/)[^)\s]+))/g;
    while ((m = linkRe.exec(raw)) !== null) {
      addPath(m[1] || m[2]);
    }
    const absRe = /(?:^|[\s`"'《(>])(\/(?:Volumes|Users|home|tmp|opt|var)\/[^\s`"'》)<\n,;；。]{3,160})/g;
    while ((m = absRe.exec(raw)) !== null) {
      addPath(m[1]);
    }
  };

  if (!Array.isArray(turns)) return out;
  for (const turn of turns) {
    for (const item of Array.isArray(turn?.items) ? turn.items : []) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "userMessage") {
        for (const part of Array.isArray(item.content) ? item.content : []) {
          if (part?.path) addPath(part.path);
          if (part?.type === "text" && part.text) scanTextForPaths(part.text);
        }
        if (item.text) scanTextForPaths(item.text);
      } else if (item.type === "fileChange" && item.changes) {
        if (Array.isArray(item.changes)) {
          for (const ch of item.changes) {
            if (ch?.path) addPath(ch.path);
          }
        } else if (typeof item.changes === "object") {
          for (const key of Object.keys(item.changes)) addPath(key);
        }
      } else if (item.type === "mcpToolCall" && item.arguments && typeof item.arguments === "object") {
        for (const k of ["Path", "path", "TargetFile", "AbsolutePath", "File", "file_path"]) {
          if (item.arguments[k]) addPath(item.arguments[k]);
        }
      } else if (item.type === "agentMessage" && item.text) {
        scanTextForPaths(item.text);
      }
      if (out.length >= maxPaths) return out.slice(0, maxPaths);
    }
  }
  return out;
}

function sanitizePathsForMatching(paths = []) {
  return paths
    .map((p) => String(p || "").replace(/\\/g, "/"))
    .map((p) => p
      .replace(/\/\.agents\/skills\/[^/\s]+/gi, "")
      .replace(/\/\.claude\/skills\/[^/\s]+/gi, "")
      .replace(/\/\.gemini\/[^/]+\/skills\/[^/\s]+/gi, ""))
    .filter(Boolean);
}

function sanitizeTextForEntityMatching(text = "") {
  return String(text || "")
    .replace(/\/Users\/[^/\s]+\/\.(?:agents|claude|gemini)\/(?:antigravity\/)?skills\/[^\s)>》]+/gi, "")
    .replace(/工作目录\s*[：:]\s*(?:`[^`]+`|\S+)/gi, "");
}

function matchRulesInInputs(rules, inputs = []) {
  for (const input of inputs) {
    const s = String(input || "").trim();
    if (!s) continue;
    for (const rule of rules) {
      if (rule.re.test(s)) return rule;
    }
  }
  return null;
}

function cleanProjectBasename(cwd = "", cwdAliases = {}) {
  const norm = normalizeWorkspacePath(cwd);
  if (!norm) return "";
  if (isUserHomePath(norm)) return "本机环境";
  const parts = norm.replace(/\\/g, "/").split("/").filter(Boolean);
  const last = parts[parts.length - 1] || "";
  if (!last || GENERIC_TMP_DIR_RE.test(last)) return "";
  const aliased = cwdAliases?.[last];
  if (aliased && typeof aliased === "object" && aliased.target) {
    return String(aliased.target);
  }
  return last.length > 8 ? last.slice(0, 8) : last;
}

export function resolveCwdOwnDomain({ cwd = "", projectAlias = "", customRules = undefined } = {}) {
  const { cwdRules, cwdAliases } = getActiveTitleRules(customRules);
  const normCwd = normalizeWorkspacePath(cwd).replace(/\\/g, "/");
  if (normCwd) {
    for (const rule of cwdRules) {
      if (rule.re.test(normCwd)) {
        return {
          cwdTarget: rule.target,
          cwdDomainKey: rule.domainKey,
          cwdStripRe: rule.stripRe,
        };
      }
    }
  }
  const cleanAlias = String(projectAlias || "").trim();
  const baseTarget = cleanProjectBasename(cwd, cwdAliases);
  const normParts = normCwd ? normCwd.split("/").filter(Boolean) : [];
  const rawLast = normParts[normParts.length - 1] || "";
  const aliasEntry = rawLast ? cwdAliases?.[rawLast] : null;
  if (aliasEntry && typeof aliasEntry === "object" && aliasEntry.target) {
    return {
      cwdTarget: String(aliasEntry.target),
      cwdDomainKey: String(aliasEntry.domainKey || `alias:${aliasEntry.target}`),
      cwdStripRe: null,
    };
  }
  if (baseTarget === "本机环境") {
    return { cwdTarget: "本机环境", cwdDomainKey: "workspace:home", cwdStripRe: null };
  }
  if (cleanAlias && cleanAlias.length <= 8) {
    return { cwdTarget: cleanAlias, cwdDomainKey: `alias:${cleanAlias}`, cwdStripRe: null };
  }
  if (baseTarget) {
    return { cwdTarget: baseTarget, cwdDomainKey: `cwd:${baseTarget.toLowerCase()}`, cwdStripRe: null };
  }
  return { cwdTarget: "", cwdDomainKey: "", cwdStripRe: null };
}

export function resolveTitleDomainAndTarget({
  texts = [],
  touchedPaths = [],
  cwd = "",
  projectAlias = "",
  primaryHint = "",
  customRules = undefined,
} = {}) {
  const { seriesTargets, appTargets, cwdRules } = getActiveTitleRules(customRules);
  const normCwd = normalizeWorkspacePath(cwd).replace(/\\/g, "/");
  const cleanPaths = sanitizePathsForMatching(touchedPaths);
  const cleanTexts = texts.map(sanitizeTextForEntityMatching).filter(Boolean);
  const cleanPrimary = sanitizeTextForEntityMatching(primaryHint);

  const primaryInputs = [cleanPrimary, ...cleanPaths].filter(Boolean);
  const allConcreteInputs = [...primaryInputs, ...cleanTexts];

  const seriesMatch = matchRulesInInputs(seriesTargets, allConcreteInputs);
  if (seriesMatch) {
    return {
      target: seriesMatch.target,
      domainKey: seriesMatch.domainKey,
      stripRe: seriesMatch.stripRe,
      isExplicitTarget: true,
    };
  }

  const appMatch = matchRulesInInputs(appTargets, primaryInputs)
    || matchRulesInInputs(appTargets, cleanTexts);
  if (appMatch) {
    return {
      target: appMatch.target,
      domainKey: appMatch.domainKey,
      stripRe: appMatch.stripRe,
      isExplicitTarget: true,
    };
  }

  if (normCwd) {
    for (const rule of cwdRules) {
      if (rule.re.test(normCwd)) {
        return {
          target: rule.target,
          domainKey: rule.domainKey,
          stripRe: rule.stripRe,
          isExplicitTarget: true,
        };
      }
    }
  }

  const genericToolMatch = matchRulesInInputs(GENERIC_TOOL_TARGETS, primaryInputs)
    || matchRulesInInputs(GENERIC_TOOL_TARGETS, cleanTexts);
  if (genericToolMatch) {
    return {
      target: genericToolMatch.target,
      domainKey: genericToolMatch.domainKey,
      stripRe: genericToolMatch.stripRe,
      isExplicitTarget: true,
    };
  }

  const own = resolveCwdOwnDomain({ cwd, projectAlias, customRules });
  if (own.cwdTarget) {
    return {
      target: own.cwdTarget,
      domainKey: own.cwdDomainKey,
      stripRe: own.cwdStripRe,
      isExplicitTarget: false,
    };
  }

  return {
    target: "通用",
    domainKey: "",
    stripRe: null,
    isExplicitTarget: false,
  };
}

function findRuleDomainForTargetName(head = "", customRules = undefined) {
  const { seriesTargets, appTargets, cwdRules } = getActiveTitleRules(customRules);
  const all = [...seriesTargets, ...appTargets, ...cwdRules, ...GENERIC_TOOL_TARGETS];
  const hit = all.find((r) => r.target === head);
  return hit ? hit.domainKey : "";
}

export function compactLegacyBracketTitle(rawTitle, { cwd = "", projectAlias = "", customRules = undefined } = {}) {
  const raw = String(rawTitle || "").replace(/\s+/g, " ").trim();
  const match = raw.match(/^【([^】｜|]{1,16})(?:[｜|]([^】]{1,28}))?】\s*(.+)$/);
  if (!match) return null;

  const head = match[1].trim();
  const mid = (match[2] || "").split(/[｜|]/)[0].trim();
  const tail = match[3].trim();
  if (!head || !tail) return null;

  let core = tail;
  if (mid && !META_CATEGORIES.has(mid) && tail.length <= 7 && mid.length <= 3 && !tail.includes(mid)) {
    core = `${mid}${tail}`;
  }
  core = core.replace(/的问题$/, "").trim();

  const { genericFallbackTargets } = getActiveTitleRules(customRules);
  const { cwdDomainKey } = resolveCwdOwnDomain({ cwd, projectAlias, customRules });
  const headDomainKey = findRuleDomainForTargetName(head, customRules);
  const omitPrefix = Boolean(
    genericFallbackTargets.has(head)
    || (cwdDomainKey && headDomainKey && headDomainKey === cwdDomainKey)
    || (cwdDomainKey.startsWith("app:") && headDomainKey.startsWith("tool:")),
  );

  if (omitPrefix) {
    return {
      title: truncateTitleCleanly(core, UNPREFIXED_CORE_MAX_LEN, { allowCommaSplit: false }),
      domainKey: cwdDomainKey || headDomainKey,
      target: head,
    };
  }

  const maxCore = Math.max(8, FINAL_TITLE_MAX_LEN - head.length - 1);
  const compactCore = truncateTitleCleanly(core, maxCore, { allowCommaSplit: false });
  return {
    title: `${head}·${compactCore}`,
    domainKey: headDomainKey || `case:${head}`,
    target: head,
  };
}

function humanizeAsciiPhraseToZh(text) {
  const s = String(text || "").trim();
  if (!s || /[\u4e00-\u9fff]/.test(s)) return s;

  const exact = EN_EXACT_PHRASE_MAP.get(s.toLowerCase());
  if (exact) return exact;

  const out = s
    .replace(/\bbug\s+report(?:\s+and\s+screenshot)?\b/gi, "问题反馈与截图排查")
    .replace(/\bfile\s+does\s+not\s+exist\s+error\b/gi, "文件不存在报错处理")
    .replace(/\bremote\s+control\b/gi, "远程控制")
    .replace(/\bproject\s+design\b/gi, "项目设计")
    .replace(/\busage\s+capabilities\b/gi, "云端用量能力")
    .replace(/\bsignature\s+verification\b/gi, "签名校验");

  if (!/[\u4e00-\u9fff]/.test(out) && out.split(/\s+/).length < 2) {
    return s;
  }

  const tokens = out.split(/\s+/).filter(Boolean);
  const mapped = [];
  for (const tok of tokens) {
    const cleanTok = tok.replace(/[.,!?;:]+$/g, "");
    const lower = cleanTok.toLowerCase();
    if (EN_STOP_WORDS.has(lower)) continue;
    const zh = EN_ZH_WORD_MAP.get(lower);
    if (zh !== undefined) {
      if (zh) mapped.push(zh);
    } else {
      mapped.push(cleanTok);
    }
  }
  const joined = mapped
    .filter(Boolean)
    .reduce((acc, cur) => {
      if (!acc) return cur;
      const prev = acc[acc.length - 1];
      const bothAscii = /^[A-Za-z0-9]/.test(prev[prev.length - 1]) && /^[A-Za-z0-9]/.test(cur[0]);
      return bothAscii ? `${acc} ${cur}` : `${acc}${cur}`;
    }, "");
  return joined || s;
}

function shortenWorkTitle(rawWork = "") {
  let clean = String(rawWork || "").trim();
  if (!clean) return "";
  const clause = clean.split(/[，,！？!?；;]/)[0]?.trim() || "";
  if (clause.length >= 3) clean = clause;
  return clean.length > 9 ? clean.slice(0, 9) : clean;
}

function extractDeliverableCore({
  seedText = "",
  target = "",
  stripRe = null,
  maxLength = UNPREFIXED_CORE_MAX_LEN,
} = {}) {
  const raw = String(seedText || "").trim();
  if (!raw) return "";

  const epMatch = raw.match(/\b(ep\d+)\b/i);
  if (epMatch && /(?:分镜|四宫格|六宫格|留白脸|storyboard)/i.test(raw)) {
    const ep = epMatch[1].toLowerCase();
    const isBlank = /脸部留白|留白脸/.test(raw);
    const grid = /四宫格/.test(raw) ? "四宫格" : (/六宫格/.test(raw) ? "六宫格" : "");
    const actCount = raw.match(/全([三四五六])幕/)?.[1];
    const orient = /竖屏|竖版/.test(raw) ? "竖屏" : (/横屏|横版/.test(raw) ? "横屏" : "");
    if (isBlank && grid) return `${ep}留白脸${grid}分镜`;
    if (actCount && orient) return `${ep}全${actCount}幕${orient}分镜`;
    if (grid && orient) return `${ep}${orient}${grid}分镜`;
    if (orient) return `${ep}${orient}分镜`;
  }

  const cardSaveMatch = raw.match(/保存(?:为|到)[^《"'\n]*?[《"']?(?:[^/\\《"'\s]+\/)*([^\s/\\《"'>.]+?)-(角色卡|设定图)\.(?:png|jpe?g|webp)/i);
  if (cardSaveMatch?.[1]) {
    return `生成${cardSaveMatch[1]}${cardSaveMatch[2]}`;
  }

  const singlePlatMatch = raw.match(/只发\s*(视频号|小红书|抖音|B站)\s*《([^》]+)》/);
  if (singlePlatMatch) {
    return `只发${singlePlatMatch[1]}《${shortenWorkTitle(singlePlatMatch[2])}》`;
  }
  const multiPlatMatch = raw.match(/把\s*《([^》]+)》[^。\n]{0,20}?发到\s*([^\n（(。]+)/);
  if (multiPlatMatch) {
    const plats = multiPlatMatch[2]
      .replace(/[、,，和与及\s]+/g, "")
      .replace(/平台$/g, "")
      .slice(0, 6);
    if (plats) return `${plats}发《${shortenWorkTitle(multiPlatMatch[1])}》`;
  }

  let core = summarizeTaskTitle(raw, { maxLength: 40 });
  if (!core) return "";

  const prevBeforeStrip = core;
  if (stripRe) {
    core = core
      .replace(stripRe, " ")
      .replace(/([\u4e00-\u9fff])\s+([\u4e00-\u9fff])/g, "$1$2")
      .replace(/\s+/g, " ")
      .trim();
  }
  core = core
    .replace(/^(?:中|的|里的|中的|功能)+(?=[A-Za-z\u4e00-\u9fff])/, "")
    .replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, "$1")
    .replace(/^((?:优化|修复|排查|查看|检查|重构|升级|新增|实现|拉取|发布|生成|分析|设计)?)\s*的\s*(?=[\u4e00-\u9fffA-Za-z])/, "$1")
    .replace(/([\u4e00-\u9fff]{2,})的(视觉|界面|排版|样式|展示|逻辑|设计)$/, "$1$2")
    .replace(/的+$/, "")
    .trim();

  if (core.length < 3) {
    core = prevBeforeStrip;
  }

  core = humanizeAsciiPhraseToZh(core);
  core = core
    .replace(/^(?:一下|关于|能不能|能否|可否)\s*/, "")
    .replace(/的(?:功能|代码)?(?:与|和)?问题$/, "")
    .replace(/的问题$/, "")
    .replace(/[？?！!]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!core || core.length < 2) {
    core = target || "会话任务";
  }
  return truncateTitleCleanly(core, maxLength, { allowCommaSplit: true });
}

export function buildStructuredThreadTitle({
  seedText = "",
  allTexts = [],
  touchedPaths = [],
  cwd = "",
  projectAlias = "",
  assistantText = "",
  customRules = undefined,
} = {}) {
  const { genericFallbackTargets } = getActiveTitleRules(customRules);
  const cleanSeed = stripPromptNoise(seedText);
  const compacted = compactLegacyBracketTitle(cleanSeed, { cwd, projectAlias, customRules });
  if (compacted) {
    return compacted;
  }

  const effectiveSeed = cleanPromptForTitle(seedText) || cleanPromptForTitle(assistantText) || cleanSeed;
  const primaryActionLine = summarizeTaskTitle(seedText, { maxLength: 60, assistantText });
  const { target, domainKey, stripRe, isExplicitTarget } = resolveTitleDomainAndTarget({
    texts: [effectiveSeed, ...allTexts, assistantText].filter(Boolean),
    touchedPaths,
    cwd,
    projectAlias,
    primaryHint: primaryActionLine || effectiveSeed,
    customRules,
  });
  const { cwdDomainKey, cwdStripRe } = resolveCwdOwnDomain({ cwd, projectAlias, customRules });

  const needPrefix = Boolean(
    isExplicitTarget
    && target
    && domainKey
    && !genericFallbackTargets.has(target)
    && domainKey !== cwdDomainKey
    && !(cwdDomainKey.startsWith("app:") && domainKey.startsWith("tool:")),
  );

  // Strip target entity if prefixed, or strip redundant repo-self name inside its own repo.
  const activeStripRe = needPrefix ? stripRe : cwdStripRe;
  const maxCore = needPrefix
    ? Math.max(8, FINAL_TITLE_MAX_LEN - target.length - 1, PREFIXED_CORE_MAX_LEN)
    : UNPREFIXED_CORE_MAX_LEN;

  const core = extractDeliverableCore({
    seedText: effectiveSeed || assistantText,
    target,
    stripRe: activeStripRe,
    maxLength: maxCore,
  }) || "会话任务";

  if (!needPrefix) {
    return {
      title: truncateTitleCleanly(core, UNPREFIXED_CORE_MAX_LEN, { allowCommaSplit: false }),
      domainKey: cwdDomainKey || domainKey,
      target: target || "通用",
    };
  }

  return {
    title: `${target}·${core}`,
    domainKey,
    target,
  };
}

export function hasEnoughInfoToLock({
  seedText = "",
  assistantText = "",
  touchedPaths = [],
  hasFollowUpTurns = false,
  isCanonicalUpstream = false,
} = {}) {
  if (isCanonicalUpstream) return true;
  if (String(assistantText || "").trim()) return true;
  if (Array.isArray(touchedPaths) && touchedPaths.length > 0) return true;
  const clean = cleanPromptForTitle(seedText);
  if (!clean || isContinuationOrControlPrompt(seedText)) return false;

  const isFuzzyShortQuestion = /^(?:看看|看下|查下|帮我看看)?[^，。！？]{0,12}(?:怎么回事|是什么情况|有bug|是不是有bug|充电集吗|在吗|好使吗)[？?吗呀啊]*$/i.test(clean)
    || (isQuestionOrInquiryPrompt(seedText) && clean.length < 14);
  if (isFuzzyShortQuestion) return false;
  if (hasFollowUpTurns && clean.length >= 6) return true;
  return clean.length >= 6;
}

export function threadTitleSourceSig(text) {
  return cleanPromptForTitle(text).slice(0, 160);
}

function buildOrderedCandidatePrompts({ userPrompts = [], firstUserText = "", lastUserText = "" } = {}) {
  const rawList = [];
  if (Array.isArray(userPrompts) && userPrompts.length > 0) {
    for (const item of userPrompts) {
      if (String(item || "").trim()) rawList.push(String(item).trim());
    }
    const lastSig = threadTitleSourceSig(lastUserText);
    const hasLastInPrompts = Boolean(
      lastSig && rawList.some((item) => threadTitleSourceSig(item) === lastSig),
    );
    if (lastSig && !hasLastInPrompts) {
      rawList.push(String(lastUserText).trim());
    }
  } else {
    if (String(firstUserText || "").trim()) rawList.push(String(firstUserText).trim());
    if (String(lastUserText || "").trim()) rawList.push(String(lastUserText).trim());
  }

  const deduped = [];
  let prevSig = "";
  for (const text of rawList) {
    const sig = threadTitleSourceSig(text);
    if (!sig || sig === prevSig) continue;
    deduped.push(text);
    prevSig = sig;
  }
  return deduped;
}

function buildResult({
  title,
  autoTitleToSave = null,
  sourceSig = "",
  drifted = false,
  reason = "",
  titleLocked = false,
  domainKey = "",
} = {}) {
  return {
    title,
    autoTitleToSave,
    sourceSig,
    drifted,
    reason,
    titleLocked: Boolean(titleLocked),
    domainKey: String(domainKey || ""),
    schemaVersion: TITLE_SCHEMA_VERSION,
  };
}

export function resolveAdaptiveThreadTitle({
  customName = "",
  upstreamCustomTitle = "",
  autoTitle = "",
  autoTitleSourceSig = "",
  titleLocked = false,
  titleDomainKey = "",
  titleSchemaVersion = 0,
  upstreamTitle = "",
  userPrompts = [],
  firstUserText = "",
  lastUserText = "",
  hasFollowUpTurns = false,
  fallbackPreview = "",
  assistantText = "",
  touchedPaths = [],
  cwd = "",
  projectAlias = "",
} = {}) {
  const manualName = stripPromptNoise(customName || upstreamCustomTitle);
  if (manualName) {
    return buildResult({
      title: manualName,
      autoTitleToSave: null,
      sourceSig: "",
      drifted: false,
      reason: "manual",
      titleLocked: true,
      domainKey: titleDomainKey || "",
    });
  }

  const orderedPrompts = buildOrderedCandidatePrompts({ userPrompts, firstUserText, lastUserText });
  let firstSubstantivePrompt = "";
  let latestSubstantivePrompt = "";
  let latestSubstantiveIndex = -1;
  for (let i = 0; i < orderedPrompts.length; i += 1) {
    if (!isContinuationOrControlPrompt(orderedPrompts[i])) {
      if (!firstSubstantivePrompt && !isDeicticOrPlaceholderPrompt(orderedPrompts[i])) {
        firstSubstantivePrompt = orderedPrompts[i];
      }
      latestSubstantivePrompt = orderedPrompts[i];
      latestSubstantiveIndex = i;
    }
  }

  const newestPrompt = orderedPrompts[orderedPrompts.length - 1] || "";
  const newestIsContinuation = Boolean(newestPrompt && isContinuationOrControlPrompt(newestPrompt));
  const promptSig = latestSubstantivePrompt ? threadTitleSourceSig(latestSubstantivePrompt) : "";
  const cleanUpstream = stripPromptNoise(upstreamTitle);
  const validUpstream = !isLowQualityTitle(cleanUpstream) ? cleanUpstream : "";
  const hasBracketTicketUpstream = isCanonicalBracketUpstreamTitle(cleanUpstream);
  if (hasBracketTicketUpstream) {
    return buildResult({
      title: cleanUpstream,
      autoTitleToSave: null,
      sourceSig: "",
      drifted: false,
      reason: "upstream_canonical_ticket",
      titleLocked: true,
      domainKey: titleDomainKey || "",
    });
  }
  const goodConciseUpstream = isGoodConciseUpstreamTitle(cleanUpstream);

  // Only treat prompt as genuine turn-1 when firstUserText or turns array exists (or single-turn new thread).
  const hasRealFirstSource = Boolean(
    String(firstUserText || "").trim()
    || (Array.isArray(userPrompts) && userPrompts.length > 0)
    || (!hasFollowUpTurns && !cleanUpstream),
  );
  let trueFirstPrompt = "";
  if (hasRealFirstSource) {
    if (String(firstUserText || "").trim() && !isContinuationOrControlPrompt(firstUserText) && !isDeicticOrPlaceholderPrompt(firstUserText)) {
      trueFirstPrompt = String(firstUserText).trim();
    } else if (firstSubstantivePrompt) {
      trueFirstPrompt = firstSubstantivePrompt;
    }
  }

  const isLegacySchema = Number(titleSchemaVersion) < TITLE_SCHEMA_VERSION;
  const cleanAuto = stripPromptNoise(autoTitle);
  const validV3Auto = (
    !isLegacySchema
    && cleanAuto
    && (isCanonicalBracketUpstreamTitle(cleanAuto) || !/^【/.test(cleanAuto))
    && !isLowQualityTitle(cleanAuto)
    && cleanAuto.length <= 48
  )
    ? cleanAuto
    : "";

  const explicitFirstSig = threadTitleSourceSig(
    firstUserText
    || (!hasFollowUpTurns ? (orderedPrompts[0] || "") : "")
    || (Array.isArray(userPrompts) && userPrompts.length > 1 ? userPrompts[0] : ""),
  );

  const isSubsequentTurn = Boolean(
    latestSubstantivePrompt && (
      (explicitFirstSig && promptSig !== explicitFirstSig)
      || (hasFollowUpTurns && !explicitFirstSig)
      || (hasFollowUpTurns && latestSubstantiveIndex > 0)
    ),
  );

  const { cwdDomainKey } = resolveCwdOwnDomain({ cwd, projectAlias });
  const effectiveDomainKey = titleDomainKey || resolveTitleDomainAndTarget({
    texts: [validV3Auto || trueFirstPrompt || cleanUpstream].filter(Boolean),
    touchedPaths,
    cwd,
    projectAlias,
  }).domainKey;

  const canSwitchDomain = (candidatePrompt, baseDomainKey) => {
    if (!candidatePrompt || !isSubstantiveTaskPrompt(candidatePrompt)) return null;
    if (isQuestionOrInquiryPrompt(candidatePrompt)) return null;
    const candidatePrimary = summarizeTaskTitle(candidatePrompt, { maxLength: 60 });
    const nextDomain = resolveTitleDomainAndTarget({
      texts: [candidatePrompt],
      touchedPaths: [],
      cwd: "",
      projectAlias: "",
      primaryHint: candidatePrimary || candidatePrompt,
    });
    if (!nextDomain.isExplicitTarget || !nextDomain.domainKey) return null;
    if (baseDomainKey.startsWith("app:") && nextDomain.domainKey.startsWith("tool:")) return null;
    if (cwdDomainKey.startsWith("app:") && nextDomain.domainKey === cwdDomainKey && baseDomainKey === cwdDomainKey) return null;
    if (baseDomainKey && nextDomain.domainKey === baseDomainKey) return null;
    return nextDomain;
  };

  // Stage 2: Locked compact v3 title stays rock-solid across follow-ups & questions.
  if (validV3Auto && titleLocked) {
    if (isSubsequentTurn) {
      const domainSwitch = canSwitchDomain(latestSubstantivePrompt, effectiveDomainKey);
      if (domainSwitch && (!promptSig || autoTitleSourceSig !== promptSig)) {
        const nextBuilt = buildStructuredThreadTitle({
          seedText: latestSubstantivePrompt,
          allTexts: [latestSubstantivePrompt],
          cwd,
          projectAlias,
          assistantText,
        });
        if (nextBuilt.title && nextBuilt.title !== validV3Auto) {
          return buildResult({
            title: nextBuilt.title,
            autoTitleToSave: nextBuilt.title,
            sourceSig: promptSig,
            drifted: true,
            reason: "domain_switch",
            titleLocked: true,
            domainKey: nextBuilt.domainKey || domainSwitch.domainKey,
          });
        }
      }
    }
    return buildResult({
      title: validV3Auto,
      autoTitleToSave: null,
      sourceSig: autoTitleSourceSig || promptSig,
      drifted: false,
      reason: "locked",
      titleLocked: true,
      domainKey: effectiveDomainKey,
    });
  }

  // Stage 1: Existing unlocked v3 draft finalizes and locks once sufficient context is available.
  if (validV3Auto && !titleLocked) {
    const canFinalizeNow = hasEnoughInfoToLock({
      seedText: trueFirstPrompt || latestSubstantivePrompt || cleanUpstream,
      assistantText,
      touchedPaths,
      hasFollowUpTurns,
      isCanonicalUpstream: Boolean(hasBracketTicketUpstream || goodConciseUpstream),
    });
    if (canFinalizeNow) {
      const seedForLock = hasBracketTicketUpstream
        ? cleanUpstream
        : (goodConciseUpstream
          ? cleanUpstream
          : (trueFirstPrompt || validUpstream || latestSubstantivePrompt || cleanUpstream));
      const upgraded = buildStructuredThreadTitle({
        seedText: seedForLock,
        allTexts: [...orderedPrompts, cleanUpstream].filter(Boolean),
        touchedPaths,
        cwd,
        projectAlias,
        assistantText,
      });
      const finalTitle = upgraded.title || validV3Auto;
      return buildResult({
        title: finalTitle,
        autoTitleToSave: finalTitle,
        sourceSig: promptSig || autoTitleSourceSig,
        drifted: false,
        reason: "finalize_lock",
        titleLocked: true,
        domainKey: upgraded.domainKey || effectiveDomainKey,
      });
    }
    if (!promptSig || autoTitleSourceSig === promptSig || newestIsContinuation) {
      return buildResult({
        title: validV3Auto,
        autoTitleToSave: null,
        sourceSig: autoTitleSourceSig || promptSig,
        drifted: false,
        reason: "cached_draft",
        titleLocked: false,
        domainKey: effectiveDomainKey,
      });
    }
  }

  // Stage 0 / Legacy Migration: pick best non-polluted initial seed.
  let initialSeed = "";
  if (hasBracketTicketUpstream) {
    initialSeed = cleanUpstream;
  } else if (goodConciseUpstream) {
    initialSeed = cleanUpstream;
  } else if (trueFirstPrompt) {
    initialSeed = trueFirstPrompt;
  } else if (validUpstream || cleanUpstream) {
    initialSeed = validUpstream || cleanUpstream;
  } else if (!hasFollowUpTurns && latestSubstantivePrompt) {
    initialSeed = latestSubstantivePrompt;
  } else {
    initialSeed = stripPromptNoise(fallbackPreview);
  }

  if (!initialSeed && !assistantText) {
    return buildResult({
      title: "新会话",
      autoTitleToSave: null,
      sourceSig: "",
      drifted: false,
      reason: "fallback",
      titleLocked: false,
      domainKey: "",
    });
  }

  const baselineBuilt = buildStructuredThreadTitle({
    seedText: initialSeed,
    allTexts: [initialSeed, trueFirstPrompt, cleanUpstream].filter(Boolean),
    touchedPaths,
    cwd,
    projectAlias,
    assistantText,
  });

  if (isSubsequentTurn) {
    const domainSwitch = canSwitchDomain(latestSubstantivePrompt, baselineBuilt.domainKey || effectiveDomainKey);
    if (domainSwitch) {
      const switchedBuilt = buildStructuredThreadTitle({
        seedText: latestSubstantivePrompt,
        allTexts: [latestSubstantivePrompt],
        touchedPaths,
        cwd,
        projectAlias,
        assistantText,
      });
      if (switchedBuilt.title && switchedBuilt.title !== baselineBuilt.title) {
        return buildResult({
          title: switchedBuilt.title,
          autoTitleToSave: switchedBuilt.title,
          sourceSig: promptSig,
          drifted: true,
          reason: "domain_switch",
          titleLocked: true,
          domainKey: switchedBuilt.domainKey || domainSwitch.domainKey,
        });
      }
    }
  }

  const nextTitle = baselineBuilt.title;
  if (!nextTitle) {
    return buildResult({
      title: "新会话",
      autoTitleToSave: null,
      sourceSig: "",
      drifted: false,
      reason: "fallback",
      titleLocked: false,
      domainKey: "",
    });
  }

  const shouldLock = hasEnoughInfoToLock({
    seedText: initialSeed,
    assistantText,
    touchedPaths,
    hasFollowUpTurns,
    isCanonicalUpstream: Boolean(hasBracketTicketUpstream || goodConciseUpstream),
  });

  const hadLegacyOrBadAuto = Boolean(autoTitle && (isLegacySchema || autoTitle !== nextTitle));
  const shouldPersist = Boolean(
    hadLegacyOrBadAuto
    || (!hasBracketTicketUpstream && (trueFirstPrompt || nextTitle !== cleanUpstream))
    || shouldLock,
  );

  return buildResult({
    title: nextTitle,
    autoTitleToSave: shouldPersist ? nextTitle : null,
    sourceSig: promptSig || threadTitleSourceSig(initialSeed),
    drifted: false,
    reason: hadLegacyOrBadAuto ? "heal_v3" : (shouldLock ? "initial_lock" : "initial_draft"),
    titleLocked: shouldLock,
    domainKey: baselineBuilt.domainKey,
  });
}
