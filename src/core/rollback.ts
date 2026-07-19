// 回滚：把已 git 接管的项目代码退回某个历史版本并重启容器 + 健康检查。
// 故意不跑项目的 deploy 命令（里面常有 git pull，会把代码又拉回最新，等于没回滚）。
import type { Config, DeployResult } from "./types.js";
import { getProject } from "./config.js";
import { runOnServer, waitHealthy } from "./ssh.js";
import { recordDeploy } from "./history.js";

import { shQuote as q } from "./sh.js";
import { reloadServices } from "./reload.js";
// 只接受短/长 commit hash 或 HEAD~N，挡命令注入
const validRev = (rev: string) => /^[0-9a-fA-F]{4,40}$/.test(rev) || /^HEAD~\d+$/.test(rev);

export async function rollback(
  config: Config,
  projectName: string,
  rev?: string,
  opts: { dryRun?: boolean } = {}
): Promise<DeployResult> {
  const { project, server, serverName } = getProject(config, projectName);
  const result: DeployResult = { project: projectName, server: serverName, success: false, output: "", health: [] };
  try {
    if (!project.dir) throw new Error("项目没配工作目录");
    // 不传版本 = 回退上一个提交（秒回滚最常用）
    const target = rev && rev.trim() ? rev.trim() : "HEAD~1";
    if (!validRev(target)) throw new Error("非法的版本号（只接受 commit hash 或 HEAD~N）");

    const isGit = (await runOnServer(server, `test -d ${q(project.dir + "/.git")} && echo yes || echo no`)).stdout.trim();
    if (isGit !== "yes") throw new Error('非 git 项目，无法回滚（先用"转 git"接管）');

    const from = (await runOnServer(server, `cd ${q(project.dir)} && git rev-parse --short HEAD`)).stdout.trim();
    // 先解析目标版本（校验存在），dry-run 时只报"将回滚到哪"，不动工作区
    const resolved = (await runOnServer(server, `cd ${q(project.dir)} && git rev-parse --short ${target} 2>/dev/null || echo __BAD__`)).stdout.trim();
    if (!resolved || resolved === "__BAD__") throw new Error(`目标版本 ${target} 解析失败（不存在？）`);
    if (opts.dryRun) {
      result.gitRev = resolved;
      const cts = (project.containers ?? []).length
        ? (project.containers as string[]).join(", ")
        : project.restartCmd
          ? `restartCmd: ${project.restartCmd}`
          : "（无 containers/restartCmd，不会自动重启）";
      result.output = `dry-run：将回滚 ${from} → ${resolved}（${target}），git reset --hard 后重启 ${cts}。未执行。`;
      result.success = true;
      return result;
    }
    const reset = await runOnServer(server, `cd ${q(project.dir)} && git reset --hard ${target}`);
    if (reset.code !== 0) {
      result.error = `git reset 失败：${(reset.stderr || reset.stdout).trim()}`;
      return result;
    }
    const to = (await runOnServer(server, `cd ${q(project.dir)} && git rev-parse --short HEAD`)).stdout.trim();
    result.gitRev = to;
    let log = `回滚 ${from} → ${to}\n${reset.stdout.trim()}`;

    // 重启服务让回滚后的代码生效（容器→docker restart，systemd→restartCmd）
    const reload = await reloadServices(server, project);
    if (reload.noTarget) {
      log += `\n⚠ 代码已回滚，但项目没配 containers/restartCmd，服务未自动重启 —— 旧代码可能仍在跑。请手动重启或配 restartCmd。`;
    } else {
      for (const a of reload.actions) log += `\nrestart ${a.target}: ${a.ok ? "ok" : a.output}`;
    }
    result.output = log;

    // 健康检查
    let allOk = true;
    for (const url of project.health ?? []) {
      const code = await waitHealthy(server, url);
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
  } finally {
    // dry-run 不记历史（没真回滚）
    if (!opts.dryRun)
      recordDeploy({ project: projectName, ts: Date.now(), success: result.success, gitRev: result.gitRev, error: result.error, action: "rollback" });
  }
}
