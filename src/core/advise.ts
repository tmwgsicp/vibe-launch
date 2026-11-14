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

/** 内存健康规则。advise（读监测样本）和 doctor（现场采一次）共用，口径只有这一处。
 *  背景（2026-11-15）：阿里云镜像 /etc/sysctl.conf 带 vm.swappiness=0 且最后加载，覆盖 sysctl.d 里的任何设置 →
 *  swap 永远 0%，原有「swap 用量≥60%」规则永远不响；内存一紧机器颠簸到 SSH 握手超时、也不触发 OOM。 */
export function memoryIssues(
  name: string,
  m: { memPct?: number | null; swapPct?: number | null; swappiness?: number | null; psiMem?: number | null; psiIo?: number | null; oomGuard?: boolean | null }
): Advisory[] {
  const out: Advisory[] = [];
  const memCmd = "ps -eo pid,rss,comm --sort=-rss | head -12; cat /proc/pressure/memory 2>/dev/null";
  if (m.psiMem != null && m.psiMem >= 10)
    out.push({ level: "error", target: name, problem: `内存颠簸（近 1 分钟 ${m.psiMem}% 的时间所有任务都在等内存）`, fix: "机器即将卡死（SSH 会进不去）：先停/重启最占内存的服务", action: { kind: "cmd", label: "看内存占用", server: name, cmd: memCmd } });
  else if (m.memPct != null && m.memPct >= 90)
    out.push({ level: m.memPct >= 95 ? "error" : "warn", target: name, problem: `内存将满（已用 ${m.memPct}%，不含可回收缓存）`, fix: "排查吃内存的进程；长期偏高应拆服务或加内存", action: { kind: "cmd", label: "看内存占用", server: name, cmd: memCmd } });
  if (m.psiIo != null && m.psiIo >= 30)
    out.push({ level: "warn", target: name, problem: `磁盘 IO 卡顿（近 1 分钟 ${m.psiIo}% 的时间所有任务都在等 IO）`, fix: "常见原因：内存不足反复读盘、日志狂写、崩溃循环", action: { kind: "cmd", label: "看 IO", server: name, cmd: "cat /proc/pressure/io; ps -eo pid,stat,comm | awk '$2 ~ /D/'" } });
  if (m.swapPct != null && m.swappiness === 0)
    out.push({ level: "warn", target: name, problem: "配了 swap 但不会被用（vm.swappiness 实际是 0）", fix: "内存紧时会直接卡死而不是用 swap。改 /etc/sysctl.conf 那一行（阿里云镜像在这里写死 0，且最后加载、会覆盖 sysctl.d），再 sysctl --system 并核对实际值", action: { kind: "cmd", label: "看 swappiness 出处", server: name, cmd: "sysctl vm.swappiness; grep -H swappiness /etc/sysctl.conf /etc/sysctl.d/*.conf 2>/dev/null" } });
  if (m.oomGuard === false && m.memPct != null && m.memPct >= 80)
    out.push({ level: "warn", target: name, problem: `内存已用 ${m.memPct}% 且没有 OOM 兜底（earlyoom/systemd-oomd 都没跑）`, fix: "装 earlyoom：内存耗尽前主动杀进程，避免整机卡死只能控制台重启", action: { kind: "cmd", label: "装 earlyoom", server: name, cmd: "apt-get install -y earlyoom || yum install -y earlyoom; systemctl enable --now earlyoom" } });
  return out;
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
      adv.push({ level: "error", target: name, problem: "服务器连不上", fix: "可能宕机或网络不通，先体检看看", action: { kind: "doctor", label: "体检", server: name } });
      continue;
    }
    if (l.diskPct != null && l.diskPct >= 90)
      adv.push({ level: l.diskPct >= 95 ? "error" : "warn", target: name, problem: `磁盘将满（已用 ${l.diskPct}%）`, fix: "清理无用的 Docker 镜像/数据，或排查大目录", action: { kind: "cmd", label: "排查大目录", server: name, cmd: "du -sh /* 2>/dev/null | sort -rh | head; docker system df" } });
    if (l.swapPct != null && l.swapPct >= 60)
      adv.push({ level: "warn", target: name, problem: `内存吃紧（Swap 虚拟内存已用 ${l.swapPct}%）`, fix: "排查吃内存的进程；长期偏高应给服务器加内存", action: { kind: "cmd", label: "看内存占用", server: name, cmd: "ps -eo pid,comm,%mem --sort=-%mem | head" } });
    adv.push(...memoryIssues(name, l));
    if (l.inodePct != null && l.inodePct >= 90)
      adv.push({ level: l.inodePct >= 95 ? "error" : "warn", target: name, problem: `inode（文件数）将满（${l.inodePct}%，与磁盘空间无关）`, fix: "清理小文件很多的目录（如日志、缓存）", action: { kind: "cmd", label: "排查文件数", server: name, cmd: "for d in /var /home /tmp /opt /root; do printf '%s ' $d; find $d -xdev 2>/dev/null | wc -l; done | sort -k2 -rn" } });
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
      adv.push({ level: "error", target: name, problem: "项目连不上", fix: "所在服务器可能宕机", action: { kind: "doctor", label: "体检", server } });
      continue;
    }
    if (l.healthOk === false)
      adv.push({ level: "error", target: name, problem: "健康检查未通过（网站没响应）", fix: "多半是应用退出或连不上依赖，看日志定位", action: logsAction });

    const h = hist["project:" + name] || [];
    const rs = h.map((x) => x.restarts).filter((x): x is number => x != null);
    const rd = rs.length >= 2 ? rs[rs.length - 1] - rs[0] : 0;
    if (rd > 0)
      adv.push({ level: "warn", target: name, problem: `容器反复重启 ${rd} 次（疑似崩溃循环）`, fix: "看日志找反复崩溃的原因", action: logsAction });

    if (l.certDays != null && l.certDays <= 14) {
      const d0 = p.proxy?.domain?.trim().split(/[\s,]+/)[0] || "域名";
      adv.push({ level: l.certDays <= 3 ? "error" : "warn", target: name, problem: l.certDays < 0 ? "HTTPS 证书已过期（浏览器会报“不安全”）" : `HTTPS 证书还有 ${l.certDays} 天过期`, fix: "vibe-launch 装的 Caddy 会自动续；否则在证书服务商/面板续签", action: { kind: "cmd", label: "看证书", server, cmd: `echo | openssl s_client -servername ${d0} -connect ${d0}:443 2>/dev/null | openssl x509 -noout -dates` } });
    }
  }

  for (const i of lintConfig(config))
    adv.push({ level: i.level, target: i.target, problem: "配置：" + i.message, fix: "去对应项目/服务器编辑里改" });

  return adv;
}
