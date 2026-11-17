// Shared by history normalization and the browser's raw-message fallback.
export function extractCodexGoalContext(rawText = "", { truncatedPreview = false } = {}) {
  let goalContext = null;
  const text = String(rawText || "").replace(/\r\n?/g, "\n").replace(
    /(^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\2[ \t]*(?=\n|$))|<codex_internal_context\b([^>]*)>([\s\S]*?)(?:<\/codex_internal_context>|(?![\s\S]))/gim,
    (raw, codeFence, _delimiter, attrs, body) => {
      if (codeFence || goalContext || !/(?:^|\s)source\s*=\s*(?:"goal"|'goal'|goal(?=\s|$))/i.test(attrs)) return raw;
      const objective = body.match(/<objective\b[^>]*>([\s\S]*?)<\/objective>/i);
      // The outer closing tag can be absent, as in Codex continuation records.
      // Only previews may be cut off before the objective itself is complete.
      if (!objective && !truncatedPreview) return raw;
      goalContext = { objective: objective?.[1].trim() || "" };
      return "\n";
    },
  );
  return { text: text.trim(), goalContext };
}
