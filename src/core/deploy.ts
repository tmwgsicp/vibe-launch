// 部署：SSH 到项目所在服务器，跑可插拔的 deploy 命令，再做健康检查
import type { Config, DeployResult } from "./types.js";
import { getProject } from "./config.js";
import { runOnServer, curlOnServer } from "./ssh.js";

function truncate(s: string, n = 4000): string {
  return s.length > n ? s.slice(0, n) + `\n…(已截断 ${s.length - n} 字)` : s;
}

export async function deploy(config: Config, projectName: string): Promise<DeployResult> {
  const { project, server, serverName } = getProject(config, projectName);
  const result: DeployResult = {
    project: projectName,
    server: serverName,
    success: false,
    output: "",
    health: [],
  };

  try {
    // 1. 跑部署命令（可插拔）
    const cmd = project.dir ? `cd ${JSON.stringify(project.dir)} && ${project.deploy}` : project.deploy;
    const run = await runOnServer(server, cmd);
    result.output = truncate([run.stdout, run.stderr].filter(Boolean).join("\n").trim());

    if (run.code !== 0) {
      result.error = `部署命令退出码 ${run.code}`;
      return result;
    }

    // 2. 记录 git 版本（如果是 git 目录）
    if (project.dir) {
      const rev = await runOnServer(server, `git -C ${JSON.stringify(project.dir)} rev-parse --short HEAD 2>/dev/null || true`);
      result.gitRev = rev.stdout.trim() || undefined;
    }

    // 3. 健康检查
    let allOk = true;
    for (const url of project.health ?? []) {
      const code = await curlOnServer(server, url);
      const ok = /^2\d\d$/.test(code);
      if (!ok) allOk = false;
      result.health.push({ url, httpCode: code, ok });
    }

    result.success = allOk;
    if (!allOk) result.error = "部署命令成功，但健康检查未通过";
    return result;
  } catch (e) {
    result.error = (e as Error).message;
    return result;
  }
}
