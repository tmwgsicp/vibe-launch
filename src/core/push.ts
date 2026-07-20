// 推送本地代码到服务器：sftp 把本地文件夹整个传到项目的服务器 dir。
// 给不用 git/GitHub 的小白 —— AI 写完一个文件夹，直接推上去，之后 suggest+deploy 起服务。
// 跳过 node_modules/.git/venv 等（体积大、可重装）；服务器上靠 deploy 命令重新装依赖。
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Config } from "./types.js";
import { getProject } from "./config.js";
import { connectSSH, runOnServer } from "./ssh.js";
import { shQuote } from "./sh.js";
import { recordOp } from "./oplog.js";

// 传时跳过的目录/文件（体积大或可重新生成；服务器上会重装依赖）
const SKIP = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".DS_Store", ".pytest_cache", ".mypy_cache", ".next", ".output", ".nuxt", "dist", "build", ".turbo", ".cache"]);

export interface PushResult {
  project: string;
  server: string;
  target: string;
  steps: string[];
  success: boolean;
  error?: string;
}

export async function pushCode(config: Config, projectName: string, localDir?: string): Promise<PushResult> {
  const { project, server, serverName } = getProject(config, projectName);
  const res: PushResult = { project: projectName, server: serverName, target: project.dir || "", steps: [], success: false };
  try {
    if (!project.dir) throw new Error("项目没配服务器目录（dir）。先在项目里填“工作目录”，如 /project/myapp");
    const src = resolve(localDir || project.localSource || process.cwd());
    if (!existsSync(src)) throw new Error(`本地目录不存在：${src}`);
    res.steps.push(`本地：${src}`);
    res.steps.push(`目标：${serverName}:${project.dir}`);

    await runOnServer(server, `mkdir -p ${shQuote(project.dir)}`);
    const ssh = await connectSSH(server);
    try {
      const ok = await ssh.putDirectory(src, project.dir, {
        recursive: true,
        concurrency: 8,
        validate: (p) => !p.split(/[\\/]/).some((seg) => SKIP.has(seg)),
      });
      if (!ok) throw new Error("上传过程中部分文件失败（可重试）");
    } finally {
      ssh.dispose();
    }
    res.steps.push("✓ 已上传（跳过 node_modules/.git/dist 等，服务器上由部署命令重装依赖）");
    res.steps.push(`下一步：在项目里点「部署」（没配部署命令就先用「探测部署方式」拿建议）`);
    res.success = true;
    return res;
  } catch (e) {
    res.error = (e as Error).message;
    return res;
  } finally {
    recordOp("push", projectName, res.success, res.error || res.target);
  }
}
