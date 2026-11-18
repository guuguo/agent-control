// 展示策略只影响缩略图加载，不参与服务端文件访问授权。
export function autoPreviewThreadImages({ hostname = "", finePointer = false } = {}) {
  if (!finePointer) return false;
  const host = String(hostname).toLowerCase();
  if (host === "localhost" || host === "[::1]" || host === "::1" || host.endsWith(".local")) return true;
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = octets;
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}
