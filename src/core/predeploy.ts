// 部署前预览：git fetch 后列出"将拉取的新提交"，让人(尤其小白)点部署前看清这次改了啥。
// 只读、不动工作区（只 fetch，不 pull/merge）。
import type { Config } from "./types.js";
import { getProject } from "./config.js";
import { runOnServer } from "./ssh.js";

import { shQuote as q } from "./sh.js";

export interface IncomingCommit {
  rev: string;
  subject: string;
}

export interface PreDeployResult {
  project: string;
  server: string;
  isGit: boolean;
  branch?: string;
  gitRev?: string;            // 当前 HEAD 短 hash
  incoming: IncomingCommit[]; // HEAD..origin/branch 的新提交（最多 50）
  error?: string;
}

export async function preDeploy(config: Config, projectName: string): Promise<PreDeployResult> {
  const { project, server, serverName } = getProject(config, projectName);
  const r: PreDeployResult = { project: projectName, server: serverName, isGit: false, incoming: [] };
  try {
    if (!project.dir) {
      r.error = "项目没配工作目录，无法预览更新";
      return r;
    }
    const isGit = (await runOnServer(server, `test -d ${q(project.dir + "/.git")} && echo yes || echo no`)).stdout.trim();
    if (isGit !== "yes") {
      r.error = '非 git 项目，先用"转 git"接管后才能预览更新';
      return r;
    }
    r.isGit = true;
    // 一次 SSH：取分支 → fetch → 当前版本 → 列出落后的新提交
    const cmd = [
      `cd ${q(project.dir)} || exit 1`,
      `BR=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)`,
      `git fetch origin "$BR" -q 2>/dev/null || true`,
      `echo "BR:$BR"`,
      `echo "REV:$(git rev-parse --short HEAD 2>/dev/null)"`,
      `git log --pretty=format:'C:%h%x09%s' "HEAD..origin/$BR" 2>/dev/null | head -50`,
    ].join("; ");
    const out = (await runOnServer(server, cmd)).stdout;
    for (const line of out.split("\n")) {
      if (line.startsWith("BR:")) r.branch = line.slice(3).trim() || undefined;
      else if (line.startsWith("REV:")) r.gitRev = line.slice(4).trim() || undefined;
      else if (line.startsWith("C:")) {
        const rest = line.slice(2);
        const tab = rest.indexOf("\t");
        if (tab > 0) r.incoming.push({ rev: rest.slice(0, tab), subject: rest.slice(tab + 1) });
      }
    }
    return r;
  } catch (e) {
    r.error = (e as Error).message;
    return r;
  }
}
