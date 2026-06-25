// 状态：看项目当前 git 版本 + 容器状态 + 健康检查
import type { Config, StatusResult } from "./types.js";
import { getProject } from "./config.js";
import { runOnServer, curlOnServer } from "./ssh.js";

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
    // git 版本
    if (project.dir) {
      const rev = await runOnServer(server, `git -C ${JSON.stringify(project.dir)} rev-parse --short HEAD 2>/dev/null || true`);
      result.gitRev = rev.stdout.trim() || undefined;
    }
    result.reachable = true;

    // 容器状态
    for (const name of project.containers ?? []) {
      const r = await runOnServer(server, `docker inspect -f '{{.State.Status}}' ${JSON.stringify(name)} 2>/dev/null || echo missing`);
      result.containers.push({ name, state: r.stdout.trim() || "unknown" });
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
