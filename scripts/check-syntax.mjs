import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function walkJsFiles(dirPath) {
  const results = [];
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "vendor") continue;
      results.push(...walkJsFiles(join(dirPath, entry.name)));
      continue;
    }
    if (entry.isFile() && /\.(?:m?js)$/.test(entry.name)) {
      results.push(join(dirPath, entry.name));
    }
  }
  return results;
}

for (const filePath of walkJsFiles(ROOT_DIR)) {
  execFileSync(process.execPath, ["--check", filePath], { stdio: "inherit" });
}

process.stdout.write("Syntax OK\n");
