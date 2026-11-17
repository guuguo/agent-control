import { basename } from "node:path";
import { extractCodexGoalContext } from "../public/codex-goal-context.js";
import { extractCodexSkillContexts } from "../public/codex-skill-context.js";

const CODEX_IMAGE_TAG_RE = /<image\b([^>\n]*\b(?:name|path)\s*=[^>\n]*)>(?:\s*<\/image>)?/gi;
const CODEX_IMAGE_TRUNCATED_RE = /<image\b(?=[^>\n]*\b(?:name|path)\s*=)[^>\n]*$/i;
const CODEX_CLOSING_IMAGE_TAG_LINE_RE = /^[ \t]*<\/image>[ \t]*$/gim;
const CODEX_FILES_HEADER_RE = /^\s*#\s*Files (?:mentioned|pasted) by the user:(?:\s*\n|\s+)([\s\S]*)$/i;
const CODEX_FILES_REQUEST_SPLIT_RE = /\n+#+\s*My request:[ \t]*(?:\n|$)/i;
const CODEX_FILES_REQUEST_INLINE_SPLIT_RE = /\s+##\s*My request:\s*/i;
const CODEX_LEADING_MY_REQUEST_RE = /^\s*#+\s*My request:[ \t]*(?:\n|$)/i;
const CODEX_TRAILING_TRUNCATED_MY_REQUEST_RE = /\s*#+\s*My(?:\s+r[^\n]*)?$/i;
const CODEX_QUESTION_REPLY_TAG_RE = /<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>/gi;
const CODEX_QUESTION_REPLY_TRUNCATED_RE = /<send_user_message_question_rep[\s\S]*$/i;
const CODEX_AMBIENT_BROWSER_RE = /<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>/gi;
const CODEX_AMBIENT_BROWSER_TRUNCATED_RE = /<in-app-browser-context\b[\s\S]*$/i;
const CODEX_EXTERNAL_APPS_RE = /<external_codex_apps_[^>]*>[\s\S]*?<\/external_codex_apps_[^>]*>/gi;
const CODEX_APPS_CTX_RE = /<codex_apps_[^>]*>[\s\S]*?<\/codex_apps_[^>]*>/gi;
const CODEX_HEARTBEAT_START_RE = /^\s*(?:```(?:xml)?\s*\n)?<heartbeat\b/i;
const CODEX_HEARTBEAT_BLOCK_RE = /(?:```(?:xml)?\s*\n)?<heartbeat\b[^>]*>([\s\S]*?)<\/heartbeat>(?:\s*```)?/i;
const CODEX_HEARTBEAT_INCOMPLETE_RE = /(?:```(?:xml)?\s*\n)?<heartbeat\b[^>]*>([\s\S]*)$/i;
const HTML_SPACE_ENTITY_RE = /(?:&#x0*20;|&#0*32;|&nbsp;)/gi;
const RASTER_IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|gif)$/i;

function stripWrappingQuotes(value = "") {
  const s = String(value || "").trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1).trim();
  }
  return s;
}

function parseCodexImageTagAttrs(attrText = "") {
  const attrs = String(attrText || "");
  let pathVal = "";
  let nameVal = "";

  const pathMatch = attrs.match(/\bpath\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  if (pathMatch) {
    pathVal = (pathMatch[1] ?? pathMatch[2] ?? pathMatch[3] ?? "").trim();
  }

  const nameMatch = attrs.match(/\bname\s*=\s*(?:"([^"]*)"|'([^']*)'|(\[[^\]\n]*\]|[^\s>]+))/i);
  if (nameMatch) {
    nameVal = (nameMatch[1] ?? nameMatch[2] ?? nameMatch[3] ?? "").trim();
  }

  return {
    name: stripWrappingQuotes(nameVal),
    path: stripWrappingQuotes(pathVal),
  };
}

function cleanImageDisplayName(name = "", path = "") {
  const rawName = String(name || "").trim();
  const base = path ? basename(path) : "";
  if (!rawName) return base || "图片";
  if (/^\[Image\s*#?\d*\]$/i.test(rawName)) {
    return base || rawName;
  }
  return rawName;
}

function parseQuestionReplyPayload(jsonText = "") {
  const raw = String(jsonText || "").trim();
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === "object" ? [parsed] : []);
  const replies = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const question = String(entry.question || "").trim();
    const answerList = Array.isArray(entry.answers)
      ? entry.answers.map((v) => String(v ?? "").trim()).filter(Boolean)
      : [];
    const answer = answerList.length
      ? answerList.join(" / ")
      : String(entry.answer ?? "").trim();
    if (!question && !answer) continue;
    replies.push({ question, answer });
  }
  return replies;
}

export function formatCodexQuestionRepliesSummary(replies = []) {
  const list = (Array.isArray(replies) ? replies : [])
    .map((item) => String(item?.answer || "").trim())
    .filter(Boolean);
  if (!list.length) return "";
  return `回答：${list.join("；")}`;
}

function extractXmlTagInner(xmlBody = "", tagName = "") {
  const re = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = String(xmlBody || "").match(re);
  if (match) return match[1].trim();
  const unclosedRe = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*)$`, "i");
  const unclosed = String(xmlBody || "").match(unclosedRe);
  return unclosed ? unclosed[1].replace(/<[^>]*$/, "").trim() : "";
}

/**
 * Check if raw text begins with a Codex scheduled automation <heartbeat> record.
 */
export function isCodexHeartbeatText(rawText = "") {
  return CODEX_HEARTBEAT_START_RE.test(String(rawText || ""));
}

/**
 * Parse a scheduler-injected user <heartbeat> prompt into structured metadata.
 */
export function parseCodexHeartbeatUserPrompt(rawText = "", { truncatedPreview = false } = {}) {
  const normalized = String(rawText || "").replace(/\r\n?/g, "\n");
  let match = normalized.match(CODEX_HEARTBEAT_BLOCK_RE);
  if (!match && truncatedPreview) {
    match = normalized.match(CODEX_HEARTBEAT_INCOMPLETE_RE);
  }
  if (!match) return null;

  const inner = match[1] || "";
  const automationId = extractXmlTagInner(inner, "automation_id");
  const currentTimeIso = extractXmlTagInner(inner, "current_time_iso");
  const instructions = extractXmlTagInner(inner, "instructions");
  if (!automationId && !currentTimeIso && !instructions) return null;

  const remainder = normalized
    .replace(match[0], "\n")
    .trim();

  return {
    heartbeat: {
      automationId,
      currentTimeIso,
      instructions,
    },
    remainder,
  };
}

/**
 * Parse a Codex assistant <heartbeat> reply into decision, message, and extra text.
 */
export function parseCodexHeartbeatAgentReply(rawText = "", { allowIncomplete = false } = {}) {
  const normalized = String(rawText || "").replace(/\r\n?/g, "\n");
  if (!normalized.trim()) return null;

  let match = normalized.match(CODEX_HEARTBEAT_BLOCK_RE);
  if (!match && allowIncomplete) {
    match = normalized.match(CODEX_HEARTBEAT_INCOMPLETE_RE);
  }
  if (!match) return null;

  const inner = match[1] || "";
  const automationId = extractXmlTagInner(inner, "automation_id");
  const decisionRaw = extractXmlTagInner(inner, "decision").toUpperCase();
  const message = extractXmlTagInner(inner, "message");
  const decision = decisionRaw === "NOTIFY" || decisionRaw === "DONT_NOTIFY"
    ? decisionRaw
    : (decisionRaw || (message && !match[0].includes("</heartbeat>") ? "" : "DONT_NOTIFY"));
  const extraText = normalized.replace(match[0], "\n").trim();

  return {
    automationId,
    decision,
    notify: decision === "NOTIFY",
    message,
    extraText,
  };
}

function extractFilesMentionedHeader(text = "") {
  const raw = String(text || "").replace(/\r\n?/g, "\n");
  const leadMatch = raw.match(CODEX_FILES_HEADER_RE);
  if (!leadMatch) {
    return null;
  }

  const afterHeader = leadMatch[1] || "";
  let body = afterHeader;
  let requestText = "";
  const multiSplit = afterHeader.match(CODEX_FILES_REQUEST_SPLIT_RE);
  if (multiSplit && multiSplit.index !== undefined) {
    body = afterHeader.slice(0, multiSplit.index);
    requestText = afterHeader.slice(multiSplit.index + multiSplit[0].length);
  } else {
    const inlineSplit = afterHeader.match(CODEX_FILES_REQUEST_INLINE_SPLIT_RE);
    if (inlineSplit && inlineSplit.index !== undefined) {
      body = afterHeader.slice(0, inlineSplit.index);
      requestText = afterHeader.slice(inlineSplit.index + inlineSplit[0].length);
    } else {
      requestText = "";
    }
  }

  const images = [];
  const files = [];
  const lineMatches = body.split("\n");
  for (let i = 0; i < lineMatches.length; i += 1) {
    const line = lineMatches[i];
    const headerRe = /##\s+(?:"((?:[^"\n]|\\")+)"|([^\n":]+?)):\s+((?:\/|~\/|[A-Za-z]:[\\/])[^\n]+?)(?=\s+Image attachment:|\s+Distinguish instructions|\s+##\s+My request:|$)/gi;
    let m;
    while ((m = headerRe.exec(line)) !== null) {
      const cleanLabel = String(m[1] ?? m[2] ?? "").replace(/\\"/g, '"').trim();
      const rawPath = String(m[3] || "").trim().replace(/\s+…$/, "");
      if (!rawPath || rawPath.endsWith("…")) continue;
      const nextChunk = `${line.slice(m.index)}\n${lineMatches[i + 1] || ""}`;
      const isImageFlag = /Image attachment:\s*true\b/i.test(nextChunk);
      if (isImageFlag || RASTER_IMAGE_EXT_RE.test(rawPath)) {
        images.push({
          type: "localImage",
          name: cleanImageDisplayName(cleanLabel, rawPath),
          path: rawPath,
          label: cleanLabel,
        });
      } else {
        files.push({
          type: "localFile",
          name: basename(rawPath) || cleanLabel || "文件",
          path: rawPath,
          label: cleanLabel || basename(rawPath) || "文件",
        });
      }
    }
  }

  return {
    images,
    files,
    text: String(requestText || "").replace(HTML_SPACE_ENTITY_RE, " ").trim(),
  };
}

/**
 * Parse Codex CLI/Desktop user wrapper markup (<image>, # Files mentioned/pasted,
 * ambient UI context, <heartbeat>, and <send_user_message_question_reply>)
 * into structured attachments + clean prompt text.
 */
export function extractCodexUserAttachmentsAndText(rawText = "", {
  preserveQuestionReplies = false,
  truncatedPreview = false,
} = {}) {
  const goal = extractCodexGoalContext(rawText, { truncatedPreview });
  let working = goal.text;
  const images = [];
  const files = [];
  const questionReplies = [];

  if (isCodexHeartbeatText(working)) {
    const parsedHb = parseCodexHeartbeatUserPrompt(working, { truncatedPreview });
    if (parsedHb) {
      return {
        text: parsedHb.remainder,
        images,
        files,
        questionReplies,
        heartbeat: parsedHb.heartbeat,
        goalContext: goal.goalContext,
      };
    }
  }

  const hadAmbientWrapper = (
    CODEX_AMBIENT_BROWSER_RE.test(working)
    || (truncatedPreview && CODEX_AMBIENT_BROWSER_TRUNCATED_RE.test(working))
    || CODEX_EXTERNAL_APPS_RE.test(working)
    || CODEX_APPS_CTX_RE.test(working)
  );
  CODEX_AMBIENT_BROWSER_RE.lastIndex = 0;
  CODEX_EXTERNAL_APPS_RE.lastIndex = 0;
  CODEX_APPS_CTX_RE.lastIndex = 0;

  working = working
    .replace(CODEX_AMBIENT_BROWSER_RE, "\n")
    .replace(CODEX_EXTERNAL_APPS_RE, "\n")
    .replace(CODEX_APPS_CTX_RE, "\n");
  if (truncatedPreview) {
    working = working.replace(CODEX_AMBIENT_BROWSER_TRUNCATED_RE, "\n");
  }
  if (hadAmbientWrapper) {
    working = working.replace(CODEX_LEADING_MY_REQUEST_RE, "");
    if (truncatedPreview) {
      working = working.replace(CODEX_TRAILING_TRUNCATED_MY_REQUEST_RE, "");
    }
  }

  working = working.replace(CODEX_IMAGE_TAG_RE, (_, attrText) => {
    const { name, path } = parseCodexImageTagAttrs(attrText);
    if (path) {
      images.push({
        type: "localImage",
        name: cleanImageDisplayName(name, path),
        path,
        label: name || basename(path),
      });
    } else {
      images.push({
        type: "image",
        name: cleanImageDisplayName(name, ""),
        path: "",
        label: name || "图片",
        missingFile: true,
      });
    }
    return "\n";
  });

  working = working.replace(CODEX_CLOSING_IMAGE_TAG_LINE_RE, "\n");
  working = working.replace(/<\/image>/gi, " ");
  if (truncatedPreview) {
    working = working.replace(CODEX_IMAGE_TRUNCATED_RE, " ");
  }

  const filesHeader = extractFilesMentionedHeader(working);
  if (filesHeader) {
    for (const img of filesHeader.images) {
      images.push(img);
    }
    for (const f of filesHeader.files) {
      files.push(f);
    }
    working = filesHeader.text;
  }

  working = working.replace(CODEX_QUESTION_REPLY_TAG_RE, (_, innerJson) => {
    const parsed = parseQuestionReplyPayload(innerJson);
    if (parsed.length) {
      questionReplies.push(...parsed);
      return preserveQuestionReplies ? `\n${formatCodexQuestionRepliesSummary(parsed)}\n` : "\n";
    }
    return "\n";
  });
  if (truncatedPreview) {
    working = working.replace(CODEX_QUESTION_REPLY_TRUNCATED_RE, " ");
  }

  working = working.replace(HTML_SPACE_ENTITY_RE, " ");

  return {
    text: working.trim(),
    images,
    files,
    questionReplies,
    heartbeat: null,
    goalContext: goal.goalContext,
  };
}

/**
 * Strip Codex user wrapper tags cleanly for single-line preview / title extraction.
 */
export function stripCodexPromptWrappers(rawText = "") {
  const extracted = extractCodexUserAttachmentsAndText(rawText, {
    preserveQuestionReplies: true,
    truncatedPreview: true,
  });
  return extractCodexSkillContexts(extracted.text, { truncatedPreview: true }).text;
}

/**
 * Check if raw text consists primarily of a Codex clarification reply wrapper.
 */
export function isCodexQuestionReplyText(rawText = "") {
  return /^\s*<send_user_message_question_rep/i.test(String(rawText || ""));
}

const MAX_FALLBACK_INLINE_IMAGE_CHARS = 512 * 1024;

function dedupeUserContentImages(images = []) {
  const out = [];
  const seenPaths = new Set();
  const seenUrls = new Set();
  for (const img of images) {
    if (!img || typeof img !== "object") continue;
    const cleanPath = String(img.path || "").trim();
    const cleanUrl = String(img.url || "").trim();
    if (cleanPath) {
      if (seenPaths.has(cleanPath)) continue;
      seenPaths.add(cleanPath);
      out.push({
        type: "localImage",
        name: img.name || basename(cleanPath) || "图片",
        path: cleanPath,
        ...(img.label ? { label: img.label } : {}),
      });
    } else if (cleanUrl) {
      if (seenUrls.has(cleanUrl)) continue;
      seenUrls.add(cleanUrl);
      out.push({
        type: "image",
        ...(img.name ? { name: img.name } : {}),
        url: cleanUrl,
      });
    } else if (img.missingFile) {
      out.push({
        type: "image",
        name: img.name || "图片",
        path: "",
        missingFile: true,
      });
    }
  }
  return out;
}

function dedupeUserContentFiles(files = []) {
  const out = [];
  const seenPaths = new Set();
  for (const file of files) {
    if (!file || typeof file !== "object") continue;
    const cleanPath = String(file.path || "").trim();
    if (!cleanPath || seenPaths.has(cleanPath)) continue;
    seenPaths.add(cleanPath);
    out.push({
      type: "localFile",
      name: file.name || basename(cleanPath) || "文件",
      path: cleanPath,
      ...(file.label ? { label: file.label } : {}),
    });
  }
  return out;
}

/**
 * Normalize a Codex userMessage item (from rollout or thread/read) so XML wrappers,
 * pasted/mentioned file headers, heartbeats, and duplicate local/inline images become clean structured content parts.
 */
export function normalizeCodexUserMessageItem(item, { automationNames = null } = {}) {
  if (!item || typeof item !== "object" || item.type !== "userMessage") return item;
  const rawParts = Array.isArray(item.content) ? item.content : [];
  const collectedText = [];
  const existingLocalImages = [];
  const existingLocalFiles = [];
  const existingInlineImages = [];

  for (const part of rawParts) {
    if (!part || typeof part !== "object") continue;
    const type = String(part.type || "").toLowerCase();
    if (type === "text" || type === "input_text") {
      if (typeof part.text === "string" && part.text.trim()) {
        collectedText.push(part.text);
      }
    } else if (type === "local_file" || type === "localfile") {
      const p = String(part.path || "").trim();
      if (p) {
        existingLocalFiles.push({
          type: "localFile",
          name: String(part.name || basename(p) || "文件"),
          path: p,
          ...(part.label ? { label: part.label } : {}),
        });
      }
    } else if (type === "local_image" || type === "localimage") {
      const p = String(part.path || "").trim();
      if (p) {
        existingLocalImages.push({
          type: "localImage",
          name: String(part.name || basename(p) || "图片"),
          path: p,
        });
      }
    } else if (type === "image" || type === "input_image") {
      const p = String(part.path || "").trim();
      const url = String(part.url || part.image_url || "").trim();
      if (p) {
        existingLocalImages.push({
          type: "localImage",
          name: String(part.name || basename(p) || "图片"),
          path: p,
        });
      } else if (url) {
        existingInlineImages.push({
          type: "image",
          ...(part.name ? { name: part.name } : {}),
          url,
        });
      } else if (part.missingFile) {
        existingInlineImages.push({
          type: "image",
          name: String(part.name || "图片"),
          path: "",
          missingFile: true,
        });
      }
    }
  }

  if (!collectedText.length && typeof item.text === "string" && item.text.trim()) {
    collectedText.push(item.text);
  }

  const joinedText = collectedText.join("\n");
  const extracted = extractCodexUserAttachmentsAndText(joinedText, {
    preserveQuestionReplies: false,
    truncatedPreview: false,
  });

  const allImages = dedupeUserContentImages([
    ...existingLocalImages,
    ...extracted.images.filter((img) => Boolean(img.path)),
  ]);

  if (allImages.length === 0) {
    for (const inlineImg of existingInlineImages) {
      if (inlineImg.url && inlineImg.url.length <= MAX_FALLBACK_INLINE_IMAGE_CHARS) {
        allImages.push(inlineImg);
      } else {
        allImages.push({
          type: "image",
          name: inlineImg.name || "图片",
          path: "",
          missingFile: true,
        });
      }
    }
    if (allImages.length === 0) {
      for (const placeholder of extracted.images) {
        if (!placeholder.path) allImages.push(placeholder);
      }
    }
  }

  const allFiles = dedupeUserContentFiles([
    ...existingLocalFiles,
    ...(extracted.files || []),
  ]);

  const nextContent = [...allImages, ...allFiles];
  if (extracted.text) {
    nextContent.push({ type: "text", text: extracted.text });
  }

  const mergedReplies = Array.isArray(item.questionReplies) && item.questionReplies.length
    ? item.questionReplies
    : extracted.questionReplies;

  let mergedHeartbeat = item.heartbeat || null;
  if (extracted.heartbeat) {
    const autoId = extracted.heartbeat.automationId || "";
    const autoName = (autoId && automationNames?.get(autoId)) || item.heartbeat?.automationName || "";
    mergedHeartbeat = {
      ...extracted.heartbeat,
      ...(autoName ? { automationName: autoName } : {}),
    };
  }

  return {
    ...item,
    content: nextContent,
    ...(mergedReplies.length ? { questionReplies: mergedReplies } : {}),
    ...(mergedHeartbeat ? { heartbeat: mergedHeartbeat } : {}),
    ...((item.goalContext || extracted.goalContext) ? { goalContext: item.goalContext || extracted.goalContext } : {}),
  };
}

/**
 * Normalize a Codex agentMessage item so <heartbeat> replies are unwrapped into
 * clean display text plus structured heartbeat metadata.
 */
export function normalizeCodexAgentMessageItem(item, { automationNames = null } = {}) {
  if (!item || typeof item !== "object" || item.type !== "agentMessage") return item;
  const parsed = parseCodexHeartbeatAgentReply(item.text || "", { allowIncomplete: false });
  if (!parsed) return item;
  const autoId = parsed.automationId || item.heartbeat?.automationId || "";
  const autoName = (autoId && automationNames?.get(autoId)) || item.heartbeat?.automationName || "";
  const cleanText = [parsed.extraText, parsed.message].filter(Boolean).join("\n\n");
  return {
    ...item,
    text: cleanText,
    heartbeat: {
      automationId: autoId,
      ...(autoName ? { automationName: autoName } : {}),
      decision: parsed.decision,
      notify: parsed.notify,
      message: parsed.message,
    },
  };
}

function getTurnHeartbeatSummary(turn) {
  if (!turn || typeof turn !== "object") return null;
  if (turn.status === "inProgress" || turn.status === "running") return null;
  if (turn.error?.message) return null;
  const items = Array.isArray(turn.items) ? turn.items : [];
  if (!items.length) return null;

  let userHeartbeat = null;
  let primaryAgent = null;
  let hasNormalUserContent = false;
  let hasFileChange = false;

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "fileChange") {
      hasFileChange = true;
    } else if (item.type === "userMessage") {
      if (item.heartbeat) {
        userHeartbeat = item.heartbeat;
      }
      const content = Array.isArray(item.content) ? item.content : [];
      const hasUserParts = content.some((p) => {
        if (!p || typeof p !== "object") return false;
        if (p.type === "text" || p.type === "input_text") {
          const t = String(p.text || "").trim();
          return Boolean(t && !isCodexHeartbeatText(t));
        }
        return true;
      });
      if (hasUserParts || (Array.isArray(item.questionReplies) && item.questionReplies.length)) {
        hasNormalUserContent = true;
      }
    } else if (item.type === "agentMessage") {
      const hb = item.heartbeat || parseCodexHeartbeatAgentReply(item.text || "", { allowIncomplete: false });
      if (hb || item.phase !== "commentary") {
        primaryAgent = { item, hb };
      }
    }
  }

  if (hasNormalUserContent || hasFileChange) return null;
  if (!userHeartbeat && !primaryAgent?.hb) return null;
  const agentHb = primaryAgent?.hb || null;
  if (!agentHb || agentHb.notify) return null;

  const automationId = agentHb.automationId || userHeartbeat?.automationId || "";
  const automationName = agentHb.automationName || userHeartbeat?.automationName || "";
  return {
    automationId,
    automationName,
    currentTimeIso: userHeartbeat?.currentTimeIso || "",
    instructions: userHeartbeat?.instructions || "",
    message: agentHb.message || "",
    startedAt: turn.startedAt || null,
    completedAt: turn.completedAt || turn.startedAt || null,
  };
}

/**
 * Coalesce consecutive completed DONT_NOTIFY heartbeat turns into a single compact
 * summary turn while preserving earliest pagination boundaries.
 */
export function collapseSilentHeartbeatTurns(turns = []) {
  const list = Array.isArray(turns) ? turns : [];
  if (!list.length) return [];

  const result = [];
  let silentRun = [];

  const flushRun = () => {
    if (!silentRun.length) return;
    const first = silentRun[0];
    const last = silentRun[silentRun.length - 1];
    const firstInfo = first.info;
    const lastInfo = last.info;
    const totalCount = silentRun.reduce((sum, entry) => sum + (entry.turn?.quietHeartbeatGroup?.count || 1), 0);
    const mergedTurn = {
      ...last.turn,
      ...(first.turn._offset !== undefined ? { _offset: first.turn._offset } : {}),
      ...(first.turn._firstSourceIndex !== undefined
        ? { _firstSourceIndex: first.turn._firstSourceIndex }
        : (first.turn._sourceIndex !== undefined ? { _firstSourceIndex: first.turn._sourceIndex } : {})),
      quietHeartbeatGroup: {
        count: totalCount,
        automationId: lastInfo.automationId || firstInfo.automationId || "",
        automationName: lastInfo.automationName || firstInfo.automationName || "",
        firstStartedAt: first.turn?.quietHeartbeatGroup?.firstStartedAt || firstInfo.startedAt || null,
        lastCompletedAt: last.turn?.quietHeartbeatGroup?.lastCompletedAt || lastInfo.completedAt || lastInfo.startedAt || null,
        currentTimeIso: lastInfo.currentTimeIso || firstInfo.currentTimeIso || "",
        message: lastInfo.message || firstInfo.message || "",
        instructions: lastInfo.instructions || firstInfo.instructions || "",
      },
    };
    result.push(mergedTurn);
    silentRun = [];
  };

  for (const turn of list) {
    const info = turn?.quietHeartbeatGroup
      ? {
          automationId: turn.quietHeartbeatGroup.automationId || "",
          automationName: turn.quietHeartbeatGroup.automationName || "",
          currentTimeIso: turn.quietHeartbeatGroup.currentTimeIso || "",
          instructions: turn.quietHeartbeatGroup.instructions || "",
          message: turn.quietHeartbeatGroup.message || "",
          startedAt: turn.quietHeartbeatGroup.firstStartedAt || turn.startedAt || null,
          completedAt: turn.quietHeartbeatGroup.lastCompletedAt || turn.completedAt || null,
        }
      : getTurnHeartbeatSummary(turn);

    if (!info) {
      flushRun();
      result.push(turn);
      continue;
    }

    if (silentRun.length > 0) {
      const prevAutoId = silentRun[silentRun.length - 1].info.automationId || "";
      const nextAutoId = info.automationId || "";
      if (prevAutoId && nextAutoId && prevAutoId !== nextAutoId) {
        flushRun();
      }
    }
    silentRun.push({ turn, info });
  }
  flushRun();
  return result;
}
