// 重启：SSH 到项目所在服务器，docker restart 项目配置的容器，再做健康检查。
// 幂等安全动词（不拉代码、不构建，只重启），所以能进 MCP 给 AI 自动调。
// 用途：容器假死、改了 .env / 配置要重新加载、deploy 后想单独重启某项目。
import type { Config } from "./types.js";
import { getProject } from "./config.js";
import { runOnServer, waitHealthy } from "./ssh.js";

export interface RestartResult {
  project: string;
  server: string;
  success: boolean;
  restarted: { container: string; ok: boolean; output: string }[];
  health: { url: string; httpCode: string; ok: boolean }[];
  error?: string;
}

export async function restart(
  config: Config,
  projectName: string,
  opts: { only?: string[] } = {}
): Promise<RestartResult> {
  const { project, server, serverName } = getProject(config, projectName);
  const result: RestartResult = {
    project: projectName,
    server: serverName,
    success: false,
    restarted: [],
    health: [],
  };

  const all = project.containers ?? [];
  if (!all.length) {
    result.error = "项目未配置容器（containers），无可重启对象";
    return result;
  }

  // 选择性重启：只重指定容器（poller 改动只重 worker、不打断 api 用户）。校验都在项目里，避免手滑重错。
  let containers = all;
  if (opts.only?.length) {
    const unknown = opts.only.filter((c) => !all.includes(c));
    if (unknown.length) {
      result.error = `--only 指定的容器不在项目配置里：${unknown.join(", ")}（可选：${all.join(", ")}）`;
      return result;
    }
    containers = opts.only;
  }

  try {
    // 多容器并行重启（互相独立；连接池在 MCP/UI 下复用连接，CLI 下各自短连接）
    result.restarted = await Promise.all(
      containers.map(async (name) => {
        const r = await runOnServer(server, `docker restart ${JSON.stringify(name)}`);
        return { container: name, ok: r.code === 0, output: (r.stdout || r.stderr || "").trim() };
      })
    );
    const allRestarted = result.restarted.every((x) => x.ok);

    // 健康检查并行（同 deploy：2xx 才算通过）
    result.health = await Promise.all(
      (project.health ?? []).map(async (url) => {
        const code = await waitHealthy(server, url);
        return { url, httpCode: code, ok: /^2\d\d$/.test(code) };
      })
    );
    const allHealthy = result.health.every((x) => x.ok);

    result.success = allRestarted && allHealthy;
    if (!allRestarted) result.error = "部分容器重启失败";
    else if (!allHealthy) result.error = "容器已重启，但健康检查未通过";
    return result;
  } catch (e) {
    result.error = (e as Error).message;
    return result;
  }
}
