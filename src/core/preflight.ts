// 部署前置体检：deploy 真正跑命令前，先做几项快速检查，把"确定会失败"的情况在部署前
// 一句话说清原因，而不是让 deploy 神秘卡住/失败再翻半天（香港 CA 证书坏那种，preflight 一眼抓出）。
// 一次 SSH 采集，快；硬阻断项（目录不存在、docker 没起、磁盘爆、要 pull 但 remote 连不上）会拦下部署，
// 软告警项（磁盘偏高、remote 慢）只提示、照常部署。可用 --no-preflight / skipPreflight 跳过。
import type { Config, PreflightCheck } from "./types.js";
import { getProject } from "./config.js";
import { runOnServer } from "./ssh.js";
import { shQuote as q } from "./sh.js";

export type { PreflightCheck };
export interface PreflightResult {
  project: string;
  server: string;
  checks: PreflightCheck[];
  canDeploy: boolean;
  error?: string;
}

export async function preflight(config: Config, projectName: string): Promise<PreflightResult> {
  const { project, server, serverName } = getProject(config, projectName);
  const res: PreflightResult = { project: projectName, server: serverName, checks: [], canDeploy: true };
  try {
    const dir = project.dir;
    const needDocker = !!project.containers?.length;
    const deployPulls = /git\s+(pull|fetch)/.test(project.deploy || ""); // deploy 里有 git pull/fetch 才把 remote 连不上当硬阻断

    const lines: string[] = [];
    lines.push(`df -P ${dir ? q(dir) : "/"} 2>/dev/null | awk 'NR==2{gsub(/%/,"",$5); print "DISK|"$5}'`);
    if (dir) lines.push(`[ -d ${q(dir)} ] && echo "DIR|ok" || echo "DIR|missing"`);
    if (needDocker) lines.push(`docker info >/dev/null 2>&1 && echo "DOCKER|ok" || echo "DOCKER|down"`);
    if (dir)
      lines.push(
        `if [ -d ${q(dir)}/.git ]; then cd ${q(dir)} && (timeout 12 git ls-remote --exit-code origin >/dev/null 2>&1 && echo "GIT|ok" || echo "GIT|unreachable"); fi`
      );

    const out = (await runOnServer(server, lines.join("; "))).stdout;
    const seen = Object.fromEntries(
      out.split("\n").filter(Boolean).map((l) => { const [k, ...v] = l.split("|"); return [k, v.join("|")]; })
    );

    // 磁盘
    const diskPct = parseInt(seen["DISK"] || "0", 10) || 0;
    res.checks.push({
      name: "磁盘",
      ok: diskPct < 85,
      blocker: diskPct >= 95,
      detail: diskPct ? `使用 ${diskPct}%${diskPct >= 95 ? "（几乎爆满，部署/构建会失败）" : diskPct >= 85 ? "（偏高）" : ""}` : "未知",
    });
    // 工作目录
    if (dir)
      res.checks.push({
        name: "工作目录",
        ok: seen["DIR"] === "ok",
        blocker: true,
        detail: seen["DIR"] === "ok" ? dir : `${dir} 不存在（先 setup-git/clone 放代码）`,
      });
    // docker
    if (needDocker)
      res.checks.push({
        name: "Docker",
        ok: seen["DOCKER"] === "ok",
        blocker: true,
        detail: seen["DOCKER"] === "ok" ? "守护进程正常" : "docker 没起/不可用（配了容器却连不上 docker）",
      });
    // git remote
    if (dir && "GIT" in seen)
      res.checks.push({
        name: "git remote",
        ok: seen["GIT"] === "ok",
        blocker: deployPulls, // 只有 deploy 会 pull 时，连不上才拦
        detail:
          seen["GIT"] === "ok"
            ? "可达"
            : `连不上（${deployPulls ? "deploy 里有 git pull，会失败" : "若 deploy 不拉代码可忽略"}；网络/证书问题用 doctor 查）`,
      });

    res.canDeploy = !res.checks.some((c) => c.blocker && !c.ok);
    return res;
  } catch (e) {
    // 体检本身出错不该拦部署（保守放行），但记下来
    res.error = (e as Error).message;
    res.canDeploy = true;
    return res;
  }
}
