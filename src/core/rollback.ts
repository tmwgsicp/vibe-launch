// 回滚：把已 git 接管的项目代码退回某个历史版本并重启容器 + 健康检查。
// 故意不跑项目的 deploy 命令（里面常有 git pull，会把代码又拉回最新，等于没回滚）。
import type { Config, DeployResult } from "./types.js";
import { getProject } from "./config.js";
import { runOnServer, curlOnServer } from "./ssh.js";

const q = (s: string) => JSON.stringify(s);
// 只接受短/长 commit hash 或 HEAD~N，挡命令注入
const validRev = (rev: string) => /^[0-9a-fA-F]{4,40}$/.test(rev) || /^HEAD~\d+$/.test(rev);

export async function rollback(config: Config, projectName: string, rev: string): Promise<DeployResult> {
  const { project, server, serverName } = getProject(config, projectName);
  const result: DeployResult = { project: projectName, server: serverName, success: false, output: "", health: [] };
  try {
    if (!project.dir) throw new Error("项目没配工作目录");
    if (!rev || !validRev(rev)) throw new Error("非法的版本号（只接受 commit hash 或 HEAD~N）");

    const isGit = (await runOnServer(server, `test -d ${q(project.dir + "/.git")} && echo yes || echo no`)).stdout.trim();
    if (isGit !== "yes") throw new Error('非 git 项目，无法回滚（先用"转 git"接管）');

    const from = (await runOnServer(server, `cd ${q(project.dir)} && git rev-parse --short HEAD`)).stdout.trim();
    const reset = await runOnServer(server, `cd ${q(project.dir)} && git reset --hard ${rev}`);
    if (reset.code !== 0) {
      result.error = `git reset 失败：${(reset.stderr || reset.stdout).trim()}`;
      return result;
    }
    const to = (await runOnServer(server, `cd ${q(project.dir)} && git rev-parse --short HEAD`)).stdout.trim();
    result.gitRev = to;
    let log = `回滚 ${from} → ${to}\n${reset.stdout.trim()}`;

    // 重启相关容器（让新代码生效）
    for (const name of project.containers ?? []) {
      const r = await runOnServer(server, `docker restart ${q(name)}`);
      log += `\nrestart ${name}: ${r.code === 0 ? "ok" : (r.stderr || r.stdout).trim()}`;
    }
    result.output = log;

    // 健康检查
    let allOk = true;
    for (const url of project.health ?? []) {
      const code = await curlOnServer(server, url);
      const ok = /^2\d\d$/.test(code);
      if (!ok) allOk = false;
      result.health.push({ url, httpCode: code, ok });
    }
    result.success = (project.health?.length ?? 0) === 0 ? true : allOk;
    if (!result.success) result.error = "回滚完成，但健康检查未通过";
    return result;
  } catch (e) {
    result.error = (e as Error).message;
    return result;
  }
}
