// 统一操作日志：每个"改动型"操作都留一条，便于事后追踪 / 排查 / 审计。
// 存 ~/.vibe-launch/oplog.json（最近 1000 条）。与 history.json（只记 deploy/rollback，喂 UI 部署时间线）
// 互补：oplog 是全量审计流，尤其 run（任意命令）/ env set（改配置）/ 删容器 这类此前完全无痕的操作。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const FILE = join(homedir(), ".vibe-launch", "oplog.json");

export interface OpRecord {
  ts: number;         // 毫秒时间戳
  action: string;     // deploy / restart / rollback / env-set / run / proxy-setup / proxy-apply / proxy-rm / setup-git / onboard / container-remove / container-prune …
  target: string;     // 项目名或服务器名
  ok: boolean;
  detail?: string;    // 简短摘要：命令 / 改的键 / 域名 / 错误等（截断）
}

function readAll(): OpRecord[] {
  try {
    const a = JSON.parse(readFileSync(FILE, "utf8"));
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

/** 记一条操作。失败也记（甚至更该记）。写不了就算了，日志是尽力而为、绝不影响主流程。 */
export function recordOp(action: string, target: string, ok: boolean, detail?: string): void {
  const all = readAll();
  all.unshift({ ts: Date.now(), action, target, ok, detail: detail ? String(detail).replace(/\s+/g, " ").trim().slice(0, 300) : undefined });
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(all.slice(0, 1000), null, 2));
  } catch {
    /* 尽力而为 */
  }
}

export function readOps(limit = 50, target?: string): OpRecord[] {
  const all = readAll();
  return (target ? all.filter((r) => r.target === target) : all).slice(0, limit);
}
