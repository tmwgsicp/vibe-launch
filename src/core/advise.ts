// 建议层：把监测/配置里"发现的问题"变成"问题 + 怎么办 + 可点的工具"。
// 不只亮红灯，还给解决方案 —— 无痛 + 看比说高效。零额外 SSH：只读已采的 metrics + 清单 lint。
//
// action 是给前端/AI 的结构化动作：
//  - logs   : 看某容器日志（UI 一键开日志流）
//  - deploy : 部署该项目
//  - doctor : 对该服务器体检
//  - cmd    : 一条排查/修复命令（UI 展示可复制；服务器级问题没有项目上下文，故不自动执行）
import type { Config } from "./types.js";
import { readSamples, type Sample } from "./metrics.js";
import { lintConfig } from "./lint.js";

export interface Advisory {
  level: "error" | "warn";
  target: string;   // 服务器或项目名
  problem: string;  // 一句话：什么问题
  fix: string;      // 一句话：怎么办
  action?: {
    kind: "logs" | "deploy" | "doctor" | "cmd";
    label: string;
    server?: string;
    project?: string;
    container?: string;
    cmd?: string;
  };
}

/** 从 restartCmd/deploy 里抠出第一个 systemd 服务名（给非容器项目看日志用）。 */
function firstService(src?: string): string | undefined {
  const m = (src || "").match(/systemctl\s+(?:restart|reload|start)\s+([^&|;]+)/);
  return m ? m[1].split(/\s+/).find((s) => s && !s.startsWith("-") && /^[A-Za-z0-9._@-]+$/.test(s)) : undefined;
}

export function advise(config: Config): Advisory[] {
  const adv: Advisory[] = [];
  const samples = readSamples(undefined, 3000);
  const latest: Record<string, Sample> = {};
  const hist: Record<string, Sample[]> = {};
  for (const s of samples) {
    const k = s.kind + ":" + s.name;
    (hist[k] = hist[k] || []).push(s);
    latest[k] = s;
  }

  for (const name of Object.keys(config.servers || {})) {
    const l = latest["server:" + name];
    if (!l) continue;
    if (l.reachable === false) {
      adv.push({ level: "error", target: name, problem: "服务器连不上", fix: "查网络/SSH/证书是不是坏了", action: { kind: "doctor", label: "网络体检", server: name } });
      continue;
    }
    if (l.diskPct != null && l.diskPct >= 90)
      adv.push({ level: l.diskPct >= 95 ? "error" : "warn", target: name, problem: `磁盘 ${l.diskPct}%`, fix: "清 docker 悬垂镜像/卷，或定位大目录", action: { kind: "cmd", label: "看大目录", server: name, cmd: "du -sh /* 2>/dev/null | sort -rh | head; docker system df" } });
    if (l.swapPct != null && l.swapPct >= 60)
      adv.push({ level: "warn", target: name, problem: `Swap ${l.swapPct}%（内存压力）`, fix: "看吃内存的进程，考虑加内存/限容器", action: { kind: "cmd", label: "看内存占用", server: name, cmd: "ps -eo pid,comm,%mem --sort=-%mem | head" } });
    if (l.inodePct != null && l.inodePct >= 90)
      adv.push({ level: l.inodePct >= 95 ? "error" : "warn", target: name, problem: `inode ${l.inodePct}%（快耗尽，与磁盘空间无关）`, fix: "找小文件多的目录清理（常见：日志、session、缓存）", action: { kind: "cmd", label: "找 inode 大户", server: name, cmd: "for d in /var /home /tmp /opt /root; do printf '%s ' $d; find $d -xdev 2>/dev/null | wc -l; done | sort -k2 -rn" } });
  }

  for (const name of Object.keys(config.projects || {})) {
    const p = config.projects[name];
    const l = latest["project:" + name];
    if (!l) continue;
    const server = p.server;
    const c0 = p.containers?.[0];
    const logsAction = c0
      ? { kind: "logs" as const, label: "看日志", server, project: name, container: c0 }
      : { kind: "cmd" as const, label: "看服务日志", server, cmd: `journalctl -u ${firstService(p.restartCmd || p.deploy) || "你的服务"} -n 80 --no-pager` };

    if (l.reachable === false) {
      adv.push({ level: "error", target: name, problem: "项目连不上", fix: "所在服务器可能挂了", action: { kind: "doctor", label: "网络体检", server } });
      continue;
    }
    if (l.healthOk === false)
      adv.push({ level: "error", target: name, problem: "健康检查失败", fix: "看日志定位（多半容器退出/依赖连不上）", action: logsAction });

    const h = hist["project:" + name] || [];
    const rs = h.map((x) => x.restarts).filter((x): x is number => x != null);
    const rd = rs.length >= 2 ? rs[rs.length - 1] - rs[0] : 0;
    if (rd > 0)
      adv.push({ level: "warn", target: name, problem: `容器观察期内重启 +${rd}（疑似崩溃循环）`, fix: "看日志找反复崩溃的原因", action: logsAction });

    if (l.certDays != null && l.certDays <= 14) {
      const d0 = p.proxy?.domain?.trim().split(/[\s,]+/)[0] || "域名";
      adv.push({ level: l.certDays <= 3 ? "error" : "warn", target: name, problem: l.certDays < 0 ? "HTTPS 证书已过期" : `HTTPS 证书 ${l.certDays} 天后过期`, fix: "vibe-launch 管的 Caddy 会自动续；否则手动续（acme.sh / certbot / 1Panel 续签）", action: { kind: "cmd", label: "看证书日期", server, cmd: `echo | openssl s_client -servername ${d0} -connect ${d0}:443 2>/dev/null | openssl x509 -noout -dates` } });
    }
  }

  for (const i of lintConfig(config))
    adv.push({ level: i.level, target: i.target, problem: "配置：" + i.message, fix: "去对应项目/服务器编辑里改" });

  return adv;
}
