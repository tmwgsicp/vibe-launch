// 持久化监测的存储层：把每次采集的样本按天追加到 ~/.vibe-launch/metrics/YYYY-MM-DD.jsonl。
// 用 jsonl（不引 sqlite 原生依赖，守住"零原生依赖"卖点），按天滚动 + 保留最近 KEEP_DAYS 天。
import { readFileSync, appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), ".vibe-launch", "metrics");
const KEEP_DAYS = 7;

export interface Sample {
  ts: number;
  kind: "server" | "project";
  name: string;
  reachable?: boolean;
  // server
  load1?: number | null;
  cores?: number | null;
  memPct?: number | null;
  diskPct?: number | null;
  // project
  healthOk?: boolean | null;
  cUp?: number;
  cTotal?: number;
}

const dayName = (ts: number) => new Date(ts).toISOString().slice(0, 10);

export function appendSamples(samples: Sample[]): void {
  if (!samples.length) return;
  try {
    mkdirSync(DIR, { recursive: true });
    const byFile: Record<string, string[]> = {};
    for (const s of samples) (byFile[join(DIR, dayName(s.ts) + ".jsonl")] ||= []).push(JSON.stringify(s));
    for (const [f, lines] of Object.entries(byFile)) appendFileSync(f, lines.join("\n") + "\n");
  } catch { /* 尽力而为，绝不影响主流程 */ }
}

/** 读最近样本：扫最近 2 天文件，按 name 过滤，取最后 limit 条（按时间正序）。 */
export function readSamples(target?: string, limit = 240): Sample[] {
  try {
    const files = readdirSync(DIR).filter((f) => f.endsWith(".jsonl")).sort().slice(-2);
    const out: Sample[] = [];
    for (const f of files) {
      for (const line of readFileSync(join(DIR, f), "utf8").split("\n")) {
        if (!line) continue;
        try { const s = JSON.parse(line) as Sample; if (!target || s.name === target) out.push(s); } catch { /* 跳过坏行 */ }
      }
    }
    return out.slice(-limit);
  } catch { return []; }
}

/** 删掉超过 KEEP_DAYS 天的旧指标文件。 */
export function pruneOld(): void {
  try {
    const files = readdirSync(DIR).filter((f) => f.endsWith(".jsonl")).sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_DAYS))) {
      try { unlinkSync(join(DIR, f)); } catch { /* ignore */ }
    }
  } catch { /* 目录还不存在等，忽略 */ }
}
