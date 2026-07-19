// 部署：SSH 到项目所在服务器，跑可插拔的 deploy 命令，再做健康检查
import type { Config, DeployResult } from "./types.js";
import { getProject } from "./config.js";
import { runOnServer, waitHealthy } from "./ssh.js";
import { recordDeploy } from "./history.js";
import { shQuote as q } from "./sh.js";

function truncate(s: string, n = 4000): string {
  return s.length > n ? s.slice(0, n) + `\n…(已截断 ${s.length - n} 字)` : s;
}

// 部署失败时，把每个相关容器的状态 + 尾部日志抓出来，让失败自解释（不用 AI/人再翻 docker）。
async function gatherDiag(server: import("./types.js").ServerConfig, containers: string[]) {
  const out: { container: string; state?: string; logs: string }[] = [];
  for (const name of containers) {
    const st = await runOnServer(server, `docker inspect -f '{{.State.Status}} (exit {{.State.ExitCode}})' ${q(name)} 2>/dev/null || echo "未找到该容器"`);
    const lg = await runOnServer(server, `docker logs --tail 40 --timestamps ${q(name)} 2>&1 | tail -40`);
    out.push({ container: name, state: st.stdout.trim(), logs: (lg.stdout || lg.stderr || "").trim() });
  }
  return out;
}

export interface DeployOptions {
  /** 只打印执行计划（含 pre/postDeploy 钩子），不在服务器上跑任何命令、不记历史。 */
  dryRun?: boolean;
}

export async function deploy(config: Config, projectName: string, opts: DeployOptions = {}): Promise<DeployResult> {
  const { project, server, serverName } = getProject(config, projectName);
  const result: DeployResult = {
    project: projectName,
    server: serverName,
    success: false,
    output: "",
    health: [],
  };
  const dir = project.dir;
  const wrap = (c: string) => (dir ? `cd ${q(dir)} && ${c}` : c);
  const timeout = (project.deployTimeout ?? 600) * 1000;

  // dry-run：把 preDeploy → deploy → postDeploy 的编排计划打出来，不动服务器。带迁移/建索引的部署先看清楚。
  if (opts.dryRun) {
    const lines: string[] = [];
    for (const c of project.preDeploy ?? []) lines.push(`[preDeploy]  ${c}`);
    lines.push(`[deploy]     ${project.deploy}`);
    for (const c of project.postDeploy ?? []) lines.push(`[postDeploy] ${c}`);
    result.output = "dry-run 执行计划（未在服务器上运行任何命令）：\n" + lines.join("\n");
    result.success = true;
    return result;
  }

  try {
    result.hooks = [];
    // 0. preDeploy 钩子（deploy 命令前，逐条串行）：DB 迁移 / 备份 / 建索引。任一失败即中止，绝不 pull/部署。
    for (const c of project.preDeploy ?? []) {
      const r = await runOnServer(server, wrap(c), undefined, timeout);
      result.hooks.push({ phase: "pre", cmd: c, code: r.code, output: truncate([r.stdout, r.stderr].filter(Boolean).join("\n").trim(), 2000) });
      if (r.code !== 0) {
        result.error = `preDeploy 钩子失败（退出码 ${r.code}）：${c}`;
        return result;
      }
    }

    // 1. 跑部署命令（可插拔）。含构建的部署会久，超时默认 600s（可按项目 deployTimeout 调）。
    const run = await runOnServer(server, wrap(project.deploy), undefined, timeout);
    result.output = truncate([run.stdout, run.stderr].filter(Boolean).join("\n").trim());

    if (run.code !== 0) {
      result.error = `部署命令退出码 ${run.code}`;
      if (project.containers?.length) result.failLogs = await gatherDiag(server, project.containers);
      return result;
    }

    // 2. 记录 git 版本（如果是 git 目录）
    if (dir) {
      const rev = await runOnServer(server, `cd ${q(dir)} && git rev-parse --short HEAD 2>/dev/null || true`);
      result.gitRev = rev.stdout.trim() || undefined;
    }

    // 3. postDeploy 钩子（部署命令成功后，逐条串行）：烟测 / 额外校验。失败即判部署失败并抓诊断。
    for (const c of project.postDeploy ?? []) {
      const r = await runOnServer(server, wrap(c), undefined, timeout);
      result.hooks.push({ phase: "post", cmd: c, code: r.code, output: truncate([r.stdout, r.stderr].filter(Boolean).join("\n").trim(), 2000) });
      if (r.code !== 0) {
        result.error = `postDeploy 钩子失败（退出码 ${r.code}）：${c}`;
        if (project.containers?.length) result.failLogs = await gatherDiag(server, project.containers);
        return result;
      }
    }

    // 4. 健康检查（带预热宽限：服务刚起来需要几秒，轮询到 2xx 或超时）。多端点并行。
    result.health = await Promise.all(
      (project.health ?? []).map(async (url) => {
        const code = await waitHealthy(server, url);
        return { url, httpCode: code, ok: /^2\d\d$/.test(code) };
      })
    );
    const allOk = result.health.every((x) => x.ok);

    result.success = allOk;
    if (!allOk) {
      result.error = "部署命令成功，但健康检查未通过";
      // 健康红了，自动抓容器状态+日志（多半是容器退出/端口没起/连不上依赖）
      if (project.containers?.length) result.failLogs = await gatherDiag(server, project.containers);
    } else if (project.containers?.length) {
      // 健康过了也扫一眼日志：健康端点 200 ≠ 应用没坏（如某些页面模板 500、连接异常）
      const warns: { container: string; sample: string }[] = [];
      for (const name of project.containers) {
        const r = await runOnServer(server, `docker logs --tail 40 ${q(name)} 2>&1 | grep -iE 'traceback|exception|critical|gaierror|errno|raise [A-Z]' | tail -3`);
        const hit = (r.stdout || "").trim();
        if (hit) warns.push({ container: name, sample: hit.slice(0, 600) });
      }
      if (warns.length) result.warnings = warns;
    }
    return result;
  } catch (e) {
    result.error = (e as Error).message;
    return result;
  } finally {
    // 不管从哪个入口（UI / CLI / MCP）部署，都记一条历史——闭环不漏
    recordDeploy({ project: projectName, ts: Date.now(), success: result.success, gitRev: result.gitRev, error: result.error, action: "deploy" });
  }
}
