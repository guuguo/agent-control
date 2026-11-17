// Skill injection records are display data; never execute or load their paths here.
export function extractCodexSkillContexts(rawText = "", { truncatedPreview = false } = {}) {
  const skills = [];
  const text = String(rawText || "").replace(/\r\n?/g, "\n").replace(
    /(^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\2[ \t]*(?=\n|$))|^[ \t]*<skill>[ \t]*\n([\s\S]*?)(?:<\/skill>|(?![\s\S]))/gim,
    (raw, codeFence, _delimiter, inner) => {
      if (codeFence) return raw;
      const header = inner.match(/^\s*<name>([^<>\n]+)<\/name>\s*<path>([^<>\n]+)<\/path>\s*/i);
      if (!header) {
        if (truncatedPreview && /^\s*<name>[^<>\n]+<\/name>\s*<path>(?:\/|~\/|[A-Za-z]:[\\/])[^<>]*$/i.test(inner)) return "\n";
        return raw;
      }
      const name = header[1].trim();
      const path = header[2].trim();
      if (!name || !/^(?:\/|~\/|[A-Za-z]:[\\/]).*[\\/]SKILL\.md$/i.test(path)) return raw;
      skills.push({ name, path, body: inner.slice(header[0].length).trim() });
      return "\n";
    },
  );
  return { text: text.trim(), skills };
}
