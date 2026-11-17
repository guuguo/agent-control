export const PROVIDERS = Object.freeze(["codex", "claude", "antigravity", "grok", "qoder"]);

export const PROVIDER_LABELS = Object.freeze({
  codex: "Codex",
  claude: "Claude Code",
  antigravity: "Antigravity",
  grok: "Grok",
  qoder: "Qoder",
});

const PROFILE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,48}$/;

export function isValidProvider(provider) {
  return PROVIDERS.includes(String(provider || ""));
}

export function isValidProfileId(profileId) {
  return PROFILE_ID_PATTERN.test(String(profileId || ""));
}

export function badRequest(message, code = "invalid_argument") {
  return Object.assign(new Error(message), { status: 400, code });
}

export function formatCompositeThreadId(provider, profileId, rawId) {
  const cleanProvider = String(provider || "").trim();
  const cleanProfile = String(profileId || "").trim();
  const cleanRaw = String(rawId || "").trim();
  if (!isValidProvider(cleanProvider)) {
    throw badRequest(`不支持的智能体类型：${cleanProvider || "(空)"}`, "invalid_provider");
  }
  if (!isValidProfileId(cleanProfile)) {
    throw badRequest(`无效的实例配置标识：${cleanProfile || "(空)"}`, "invalid_profile");
  }
  if (!cleanRaw) {
    throw badRequest("会话 rawId 不能为空", "invalid_thread_id");
  }
  return `${cleanProvider}:${cleanProfile}:${cleanRaw}`;
}

export function parseCompositeThreadId(value) {
  const text = String(value || "").trim();
  const first = text.indexOf(":");
  const second = first > 0 ? text.indexOf(":", first + 1) : -1;
  if (first <= 0 || second <= first + 1 || second >= text.length - 1) {
    throw badRequest(`无效的复合会话 ID：${text || "(空)"}`, "invalid_composite_thread_id");
  }
  const provider = text.slice(0, first);
  const profileId = text.slice(first + 1, second);
  const rawId = text.slice(second + 1);
  if (!isValidProvider(provider)) {
    throw badRequest(`不支持的智能体类型：${provider}`, "invalid_provider");
  }
  if (!isValidProfileId(profileId)) {
    throw badRequest(`无效的实例配置标识：${profileId}`, "invalid_profile");
  }
  if (!rawId) {
    throw badRequest("会话 rawId 不能为空", "invalid_composite_thread_id");
  }
  return {
    id: text,
    provider,
    profileId,
    rawId,
  };
}

export function tryParseCompositeThreadId(value) {
  try {
    return parseCompositeThreadId(value);
  } catch {
    return null;
  }
}

export function formatProfileKey(provider, profileId) {
  const cleanProvider = String(provider || "").trim();
  const cleanProfile = String(profileId || "").trim();
  if (!isValidProvider(cleanProvider) || !isValidProfileId(cleanProfile)) {
    throw badRequest("无效的 provider/profile 组合", "invalid_profile");
  }
  return `${cleanProvider}:${cleanProfile}`;
}

export function parseProfileKey(value) {
  const text = String(value || "").trim();
  const idx = text.indexOf(":");
  if (idx <= 0 || idx >= text.length - 1) {
    throw badRequest(`无效的实例选择：${text || "(空)"}`, "invalid_profile");
  }
  const provider = text.slice(0, idx);
  const profileId = text.slice(idx + 1);
  if (!isValidProvider(provider) || !isValidProfileId(profileId)) {
    throw badRequest(`无效的实例选择：${text}`, "invalid_profile");
  }
  return { provider, profileId, key: `${provider}:${profileId}` };
}
