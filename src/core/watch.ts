// vl deploy --watch：部署后持续盯健康 / 自定义指标一段时间，异常就打点告警。
// 灰度上线的收尾："部署 → 盯 30 分钟 → 不对就秒回滚"。不填 --watch 的命令则轮询 project.health。
import type { Config } from "./types.js";
import { getProject } from "./config.js";
import { runOnServer, curlOnServer } from "./ssh.js";

export interface WatchOptions {
  /** 自定义健康命令（服务器上跑，退出码 0 = 健康）；不填则轮询 project.health 的 URL。 */
  cmd?: string;
  durationMs: number;
  intervalMs?: number;
  onTick?: (line: string) => void;
}

export interface WatchResult {
  project: string;
  server: string;
  ticks: number;
  failures: number;
  ok: boolean;
}

export async function watch(config: Config, projectName: string, opts: WatchOptions): Promise<WatchResult> {
  const { project, server, serverName } = getProject(config, projectName);
  const interval = opts.intervalMs ?? 30000;
  const log = opts.onTick ?? (() => {});
  const start = Date.now();
  let ticks = 0;
  let failures = 0;

  const probe = async (): Promise<{ ok: boolean; detail: string }> => {
    if (opts.cmd) {
      const r = await runOnServer(server, opts.cmd, project.dir, 30000);
      return { ok: r.code === 0, detail: r.code === 0 ? "ok" : `exit ${r.code} ${(r.stderr || r.stdout).trim().slice(0, 200)}` };
    }
    const urls = project.health ?? [];
    if (!urls.length) return { ok: true, detail: "（无 health，仅计时）" };
    const codes = await Promise.all(urls.map((u) => curlOnServer(server, u)));
    return { ok: codes.every((c) => /^2\d\d$/.test(c)), detail: urls.map((u, i) => `${u}→${codes[i]}`).join("  ") };
  };

  // 立即探一次，之后每 interval 探一次，直到时长用完
  while (Date.now() - start < opts.durationMs) {
    const { ok, detail } = await probe();
    ticks++;
    if (!ok) failures++;
    const elapsed = Math.round((Date.now() - start) / 1000);
    log(`[+${elapsed}s] ${ok ? "🟢" : "🔴 异常"} ${detail}`);
    const remaining = opts.durationMs - (Date.now() - start);
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(interval, remaining)));
  }

  return { project: projectName, server: serverName, ticks, failures, ok: failures === 0 };
}
