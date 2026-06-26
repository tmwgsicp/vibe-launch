// 部署历史：记到 ~/.vibe-launch/history.json（最近 200 条）。UI 部署后写一条，详情页回看。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const FILE = join(homedir(), ".vibe-launch", "history.json");

export interface DeployRecord {
  project: string;
  ts: number;        // 毫秒时间戳（调用方传，core 不调 Date）
  success: boolean;
  gitRev?: string;
  error?: string;
  action?: "deploy" | "rollback";
}

function readAll(): DeployRecord[] {
  try {
    const a = JSON.parse(readFileSync(FILE, "utf8"));
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

export function recordDeploy(rec: DeployRecord): void {
  const all = readAll();
  all.unshift(rec);
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(all.slice(0, 200), null, 2));
  } catch {
    /* 写不了就算了，历史是 nice-to-have */
  }
}

export function getHistory(project?: string, limit = 20): DeployRecord[] {
  const all = readAll();
  return (project ? all.filter((r) => r.project === project) : all).slice(0, limit);
}
