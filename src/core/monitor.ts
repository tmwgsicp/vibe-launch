// 持久化监测的采集层：定时把每台服务器的指标 + 每个项目的状态采成样本落盘。
// 常驻 vl ui 进程内跑（开着操作台=在监测），也可 vl monitor 无界面常驻。
import type { Config } from "./types.js";
import { getServerStats } from "./serverstats.js";
import { status } from "./status.js";
import { certDaysByProject } from "./cert.js";
import { appendSamples, pruneOld, type Sample } from "./metrics.js";
import { loadConfig } from "./config.js";
import { advise } from "./advise.js";
import { sendNotify } from "./notify.js";

const pct = (used?: number, total?: number) =>
  total && used != null ? Math.round((used / total) * 100) : null;
const isUp = (st: string) => /running|up/i.test(st) || /^active$/i.test(st);

// 网络是累计字节，速率要靠相邻两次采样的差 / 时间。进程内记住上一次的累计值。
const lastNet: Record<string, { rx: number; tx: number; ts: number }> = {};
function netRate(name: string, rx?: number, tx?: number, now?: number): { netRx: number | null; netTx: number | null } {
  if (rx == null || tx == null || now == null) return { netRx: null, netTx: null };
  const prev = lastNet[name];
  lastNet[name] = { rx, tx, ts: now };
  if (!prev || now <= prev.ts) return { netRx: null, netTx: null }; // 首次没法算速率
  const dt = (now - prev.ts) / 1000;
  const mbps = (b: number) => Math.max(0, Math.round((b / dt / 1048576) * 100) / 100); // 负数=计数器重置(重启)，归 0
  return { netRx: mbps(rx - prev.rx), netTx: mbps(tx - prev.tx) };
}

/** 采集一轮：所有服务器指标 + 所有项目状态 → 样本数组（并落盘）。 */
export async function collectOnce(config: Config, now: number): Promise<Sample[]> {
  const samples: Sample[] = [];

  await Promise.allSettled(
    Object.entries(config.servers || {}).map(async ([name, s]) => {
      try {
        const st = await getServerStats(s);
        const { netRx, netTx } = netRate(name, st.netRxBytes, st.netTxBytes, now);
        samples.push({
          ts: now, kind: "server", name,
          reachable: st.reachable !== false,
          load1: st.load?.[0] ?? null,
          cores: st.cores ?? null,
          memPct: pct(st.memUsedMb, st.memTotalMb),
          swapPct: pct(st.swapUsedMb, st.swapTotalMb),
          diskPct: pct(st.diskUsedMb, st.diskTotalMb),
          inodePct: pct(st.inodesUsed, st.inodesTotal),
          tcpConns: st.tcpEstablished ?? null,
          netRx, netTx,
        });
      } catch { samples.push({ ts: now, kind: "server", name, reachable: false }); }
    })
  );

  const certMap = await certDaysByProject(config); // 域名证书到期（本机 TLS 直连，不走 SSH）
  await Promise.allSettled(
    Object.keys(config.projects || {}).map(async (name) => {
      try {
        const s = await status(config, name);
        const health = s.health || [];
        const cts = s.containers || [];
        samples.push({
          ts: now, kind: "project", name,
          reachable: s.reachable,
          healthOk: health.length ? health.every((h) => h.ok) : null,
          cUp: cts.filter((c) => isUp(c.state)).length,
          cTotal: cts.length,
          restarts: cts.reduce((a, c) => a + (c.restartCount || 0), 0),
          certDays: name in certMap ? certMap[name] : null,
        });
      } catch { samples.push({ ts: now, kind: "project", name, reachable: false }); }
    })
  );

  appendSamples(samples);
  return samples;
}

// 告警去重：记住已推过的问题。key 把问题里的数字抹成 #（91%→92% 算同一条，不重复刷）。
const notified = new Set<string>();
const advKey = (target: string, problem: string) => target + "|" + problem.replace(/\d+/g, "#");

/** 采完一轮后检查建议：新出现的“运行时问题”推 webhook；恢复了就从已推集合移除。配置类问题不推。 */
async function notifyCheck(): Promise<void> {
  let cfg;
  try { cfg = loadConfig(); } catch { return; } // 现读，能拿到用户刚在设置里改的 webhook
  const webhook = cfg.notify?.webhook;
  if (!webhook) return;
  const advs = advise(cfg).filter((a) => !a.problem.startsWith("配置：")); // 配置错不是运行时事故，别推
  const cur = new Set(advs.map((a) => advKey(a.target, a.problem)));
  for (const k of [...notified]) if (!cur.has(k)) notified.delete(k); // 已恢复
  const fresh = advs.filter((a) => !notified.has(advKey(a.target, a.problem)));
  if (!fresh.length) return;
  for (const a of fresh) notified.add(advKey(a.target, a.problem));
  const text = "⚠ vibe-launch 监测到问题：\n" + fresh.map((a) => `· ${a.target}：${a.problem}\n  → ${a.fix}`).join("\n");
  await sendNotify(webhook, text).catch(() => {});
}

export interface CollectorHandle { stop: () => void; }

/** 启动采集循环：立即采一次，之后每 intervalMs 采一次。onTick 收到每轮样本（用于日志/告警）。 */
export function startCollector(config: Config, intervalMs: number, onTick?: (s: Sample[]) => void): CollectorHandle {
  pruneOld();
  let running = true;
  const tick = async () => {
    if (!running) return;
    try {
      const s = await collectOnce(config, Date.now());
      onTick?.(s);
      await notifyCheck(); // 采完就检查要不要告警
    } catch { /* 单轮失败不该中断循环 */ }
  };
  void tick(); // 立即采第一轮
  const timer = setInterval(() => void tick(), intervalMs);
  (timer as { unref?: () => void }).unref?.();
  return { stop: () => { running = false; clearInterval(timer); } };
}
