// 持久化监测的采集层：定时把每台服务器的指标 + 每个项目的状态采成样本落盘。
// 常驻 vl ui 进程内跑（开着操作台=在监测），也可 vl monitor 无界面常驻。
import type { Config } from "./types.js";
import { getServerStats } from "./serverstats.js";
import { status } from "./status.js";
import { appendSamples, pruneOld, type Sample } from "./metrics.js";

const pct = (used?: number, total?: number) =>
  total && used != null ? Math.round((used / total) * 100) : null;
const isUp = (st: string) => /running|up/i.test(st) || /^active$/i.test(st);

/** 采集一轮：所有服务器指标 + 所有项目状态 → 样本数组（并落盘）。 */
export async function collectOnce(config: Config, now: number): Promise<Sample[]> {
  const samples: Sample[] = [];

  await Promise.allSettled(
    Object.entries(config.servers || {}).map(async ([name, s]) => {
      try {
        const st = await getServerStats(s);
        samples.push({
          ts: now, kind: "server", name,
          reachable: st.reachable !== false,
          load1: st.load?.[0] ?? null,
          cores: st.cores ?? null,
          memPct: pct(st.memUsedMb, st.memTotalMb),
          diskPct: pct(st.diskUsedMb, st.diskTotalMb),
        });
      } catch { samples.push({ ts: now, kind: "server", name, reachable: false }); }
    })
  );

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
        });
      } catch { samples.push({ ts: now, kind: "project", name, reachable: false }); }
    })
  );

  appendSamples(samples);
  return samples;
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
    } catch { /* 单轮失败不该中断循环 */ }
  };
  void tick(); // 立即采第一轮
  const timer = setInterval(() => void tick(), intervalMs);
  (timer as { unref?: () => void }).unref?.();
  return { stop: () => { running = false; clearInterval(timer); } };
}
