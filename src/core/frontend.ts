// 前端一体部署（vl deploy --frontend）：本地 build → sftp 传产物到暂存目录 → 原子替换 → 重启 web → 健康检查。
// 前端产物在你本地 build（Nuxt/Vite 等），传上去换掉旧的即可，不用在服务器上装 node/build。
// 原子替换：先整包传到 <target>.vlnew，一次 mv 换过去，避免上传半截时用户看到残缺页面。
import { promisify } from "node:util";
import { exec as _exec } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Config } from "./types.js";
import { getProject } from "./config.js";
import { connectSSH, runOnServer, waitHealthy } from "./ssh.js";
import { recordDeploy } from "./history.js";
import { recordOp } from "./oplog.js";

const execAsync = promisify(_exec);
import { shQuote as q } from "./sh.js";

export interface FrontendResult {
  project: string;
  server: string;
  steps: string[];
  health: { url: string; httpCode: string; ok: boolean }[];
  success: boolean;
  error?: string;
}

export async function deployFrontend(config: Config, projectName: string): Promise<FrontendResult> {
  const { project, server, serverName } = getProject(config, projectName);
  const res: FrontendResult = { project: projectName, server: serverName, steps: [], health: [], success: false };
  const fe = project.frontend;
  try {
    if (!fe) throw new Error("项目未配置 frontend 段（build / dist / target / restart）");
    if (!fe.dist) throw new Error("frontend.dist 未配置（本地构建产物目录）");
    if (!fe.target || !fe.target.startsWith("/")) throw new Error("frontend.target 需为服务器绝对路径");

    const localCwd = fe.cwd ? resolve(fe.cwd) : process.cwd();

    // 1. 本地构建（在你自己机器上跑）
    if (fe.build) {
      res.steps.push(`本地构建：${fe.build}（cwd=${localCwd}）`);
      try {
        const { stdout, stderr } = await execAsync(fe.build, { cwd: localCwd, maxBuffer: 32 * 1024 * 1024 });
        const tail = (stdout + stderr).trim().split("\n").slice(-3).join("\n  ");
        if (tail) res.steps.push("  " + tail);
      } catch (e: any) {
        throw new Error(`本地构建失败：${String(e.stderr || e.message || "").trim().slice(-500)}`);
      }
    }

    // 2. 校验产物目录存在
    const distPath = resolve(localCwd, fe.dist);
    if (!existsSync(distPath)) throw new Error(`构建产物目录不存在：${distPath}（build 没产出？dist 配错？）`);
    res.steps.push(`产物目录：${distPath}`);

    // 3. 传到服务器暂存目录 <target>.vlnew（先清空）
    const target = fe.target.replace(/\/+$/, "");
    const staging = target + ".vlnew";
    const backup = target + ".vlbak";
    await runOnServer(server, `rm -rf ${q(staging)} && mkdir -p ${q(staging)}`);
    const ssh = await connectSSH(server);
    try {
      const ok = await ssh.putDirectory(distPath, staging, {
        recursive: true,
        concurrency: 8,
        // 只排 .git；**不能排 node_modules** —— Nuxt/Nitro SSR 产物的 .output/server/
        // node_modules 装着运行时依赖(vue-bundle-renderer 等)，过滤掉 web 会
        // ERR_MODULE_NOT_FOUND 起不来。传的是 build 产物(dist)不是项目根，产物内的
        // node_modules 都是必需的，全传。
        validate: (p) => {
          const segs = p.split(/[\\/]/);
          return !segs.includes(".git");
        },
      });
      if (!ok) throw new Error("上传过程中部分文件失败");
    } finally {
      ssh.dispose();
    }
    res.steps.push(`已上传 → ${staging}`);

    // 4. 原子替换：旧产物 → .vlbak，暂存 → 正式
    const swap = await runOnServer(
      server,
      `rm -rf ${q(backup)}; if [ -e ${q(target)} ]; then mv ${q(target)} ${q(backup)}; fi; mv ${q(staging)} ${q(target)} && echo __OK__`
    );
    if (!swap.stdout.includes("__OK__")) throw new Error(`替换失败：${(swap.stderr || swap.stdout).trim()}`);
    res.steps.push(`已替换 → ${target}（旧产物备份在 ${backup}）`);

    // 5. 重启相关容器（web / nginx）
    for (const name of fe.restart ?? []) {
      const r = await runOnServer(server, `docker restart ${q(name)}`);
      res.steps.push(`restart ${name}: ${r.code === 0 ? "✓" : "✗ " + (r.stderr || r.stdout).trim()}`);
    }

    // 6. 健康检查（与 deploy 一致：2xx 才算过；无 health 则视为成功）
    for (const url of project.health ?? []) {
      const code = await waitHealthy(server, url);
      res.health.push({ url, httpCode: code, ok: /^2\d\d$/.test(code) });
    }
    res.success = res.health.length === 0 ? true : res.health.every((x) => x.ok);
    if (!res.success) res.error = "前端产物已上线，但健康检查未通过";
    return res;
  } catch (e) {
    res.error = (e as Error).message;
    return res;
  } finally {
    recordDeploy({ project: projectName, ts: Date.now(), success: res.success, error: res.error, action: "deploy" });
    recordOp("frontend", projectName, res.success, res.error);
  }
}
