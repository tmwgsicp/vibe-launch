// 重启：SSH 到项目所在服务器，docker restart 项目配置的容器，再做健康检查。
// 幂等安全动词（不拉代码、不构建，只重启），所以能进 MCP 给 AI 自动调。
// 用途：容器假死、改了 .env / 配置要重新加载、deploy 后想单独重启某项目。
import type { Config } from "./types.js";
import { getProject } from "./config.js";
import { runOnServer, curlOnServer } from "./ssh.js";

export interface RestartResult {
  project: string;
  server: string;
  success: boolean;
  restarted: { container: string; ok: boolean; output: string }[];
  health: { url: string; httpCode: string; ok: boolean }[];
  error?: string;
}

export async function restart(config: Config, projectName: string): Promise<RestartResult> {
  const { project, server, serverName } = getProject(config, projectName);
  const result: RestartResult = {
    project: projectName,
    server: serverName,
    success: false,
    restarted: [],
    health: [],
  };

  const containers = project.containers ?? [];
  if (!containers.length) {
    result.error = "项目未配置容器（containers），无可重启对象";
    return result;
  }

  try {
    let allRestarted = true;
    for (const name of containers) {
      const r = await runOnServer(server, `docker restart ${JSON.stringify(name)}`);
      const ok = r.code === 0;
      if (!ok) allRestarted = false;
      result.restarted.push({ container: name, ok, output: (r.stdout || r.stderr || "").trim() });
    }

    // 健康检查（同 deploy：2xx 才算通过）
    let allHealthy = true;
    for (const url of project.health ?? []) {
      const code = await curlOnServer(server, url);
      const ok = /^2\d\d$/.test(code);
      if (!ok) allHealthy = false;
      result.health.push({ url, httpCode: code, ok });
    }

    result.success = allRestarted && allHealthy;
    if (!allRestarted) result.error = "部分容器重启失败";
    else if (!allHealthy) result.error = "容器已重启，但健康检查未通过";
    return result;
  } catch (e) {
    result.error = (e as Error).message;
    return result;
  }
}
