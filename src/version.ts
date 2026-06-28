import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// 单一版本来源：运行时读 package.json，避免在 cli/mcp 里各硬编码一份版本号。
// 编译产物在 <root>/dist/version.js，package.json 在 <root>/package.json。
function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, "..", "package.json"), join(here, "package.json")]) {
    try {
      const pkg = JSON.parse(readFileSync(p, "utf8"));
      if (pkg.version) return pkg.version as string;
    } catch {
      /* 试下一个候选路径 */
    }
  }
  return "0.0.0";
}

export const VERSION = readVersion();
