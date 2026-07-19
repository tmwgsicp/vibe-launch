// 状态：看项目当前 git 版本 + 容器状态 + 健康检查
import type { Config, StatusResult } from "./types.js";
import { getProject } from "./config.js";
import { runOnServer, curlOnServer } from "./ssh.js";
import { shQuote as q } from "./sh.js";

export async function status(config: Config, projectName: string): Promise<StatusResult> {
  const { project, server, serverName } = getProject(config, projectName);
  const result: StatusResult = {
    project: projectName,
    server: serverName,
    containers: [],
    health: [],
    reachable: false,
  };

  try {
    // git 版本 + 分支 + 仓库（一次 SSH）
    if (project.dir) {
      const g = await runOnServer(
        server,
        `cd ${q(project.dir)} 2>/dev/null && ` +
          `{ echo "H:$(git rev-parse --short HEAD 2>/dev/null)"; ` +
          `echo "B:$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"; ` +
          `echo "R:$(git config --get remote.origin.url 2>/dev/null)"; } || true`
      );
      for (const line of g.stdout.split("\n")) {
        if (line.startsWith("H:")) result.gitRev = line.slice(2).trim() || undefined;
        else if (line.startsWith("B:")) result.gitBranch = line.slice(2).trim() || undefined;
        else if (line.startsWith("R:")) result.gitRepo = line.slice(2).trim() || undefined;
      }
    }
    result.reachable = true;

    // 容器状态
    for (const name of project.containers ?? []) {
      const r = await runOnServer(server, `docker inspect -f '{{.State.Status}}' ${q(name)} 2>/dev/null || echo missing`);
      result.containers.push({ name, state: r.stdout.trim() || "unknown" });
    }

    // 非容器项目(systemd)：从 restartCmd 解析服务名，systemctl is-active 展示状态。
    // 补齐"非容器一等公民" —— 以前 systemd 项目 status 的容器行是空的。
    if (!project.containers?.length) {
      // restartCmd 优先；没配则从 deploy 命令兜底解析（老 systemd 项目 deploy 结尾常是 systemctl restart …）
      const src = project.restartCmd || project.deploy || "";
      const m = src.match(/systemctl\s+(?:restart|reload|start)\s+([^&|;]+)/);
      const svcs = m ? m[1].split(/\s+/).filter((s) => s && !s.startsWith("-") && /^[A-Za-z0-9._@-]+$/.test(s)) : [];
      for (const s of svcs) {
        const r = await runOnServer(server, `systemctl is-active ${q(s)} 2>/dev/null || echo unknown`);
        result.containers.push({ name: s, state: r.stdout.trim() || "unknown" });
      }
    }

    // 健康检查
    for (const url of project.health ?? []) {
      const code = await curlOnServer(server, url);
      result.health.push({ url, httpCode: code, ok: /^2\d\d$/.test(code) });
    }
    return result;
  } catch (e) {
    result.error = (e as Error).message;
    return result;
  }
}
