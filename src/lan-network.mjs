import os from "node:os";

function normalizeHost(host) {
  return String(host || "").trim().toLowerCase();
}

export function isLanListeningHost(host) {
  const normalized = normalizeHost(host);
  if (!normalized || normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]") {
    return true;
  }
  return normalized !== "127.0.0.1"
    && normalized !== "localhost"
    && normalized !== "::1"
    && normalized !== "[::1]";
}

function classifyIpv4Rank(ip) {
  const octets = String(ip || "").split(".").map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return -1;
  }
  const [a, b] = octets;
  if (a === 0 || a === 127) return -1;
  if (a === 169 && b === 254) return -1; // Link-local IPv4
  if (a === 100 && b >= 64 && b <= 127) return -1; // CGNAT / Tailscale
  if (a === 192 && b === 168) return 0;
  if (a === 10) return 1;
  if (a === 172 && b >= 16 && b <= 31) return 2;
  return 3;
}

/**
 * Enumerate reachable LAN HTTP URLs for the running server.
 */
export function listLanUrls({
  port,
  host = "127.0.0.1",
  interfaces = os.networkInterfaces(),
} = {}) {
  const numericPort = Number(port);
  const enabled = isLanListeningHost(host) && Number.isInteger(numericPort) && numericPort > 0;
  if (!enabled) {
    return { enabled: false, urls: [], primaryUrl: "" };
  }

  const normalizedHost = normalizeHost(host);
  const explicitIpRank = classifyIpv4Rank(normalizedHost);
  if (explicitIpRank >= 0) {
    const url = `http://${normalizedHost}:${numericPort}`;
    return { enabled: true, urls: [url], primaryUrl: url };
  }

  const candidates = [];
  const seen = new Set();
  for (const entries of Object.values(interfaces || {})) {
    for (const entry of entries || []) {
      const family = String(entry?.family || "").toUpperCase();
      if ((family !== "IPV4" && entry?.family !== 4) || entry?.internal) continue;
      const ip = String(entry?.address || "").trim();
      if (!ip || seen.has(ip)) continue;
      const rank = classifyIpv4Rank(ip);
      if (rank < 0) continue;
      seen.add(ip);
      candidates.push({ ip, rank });
    }
  }

  candidates.sort((left, right) => left.rank - right.rank || left.ip.localeCompare(right.ip));
  const urls = candidates.map((item) => `http://${item.ip}:${numericPort}`);
  return {
    enabled: true,
    urls,
    primaryUrl: urls[0] || "",
  };
}
