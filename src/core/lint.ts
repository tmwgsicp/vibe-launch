// 清单 lint：扫配置本身的常见错误（本地、不用 SSH），把配错的地方一眼摆出来。
// loadConfig 已挡了"引用不存在的 server / 缺 deploy"，这里补它不管的：Windows 路径 dir
// (git-bash 转换坑，sg1-proxy 就这么坏的)、占位 deploy、连不上的 server 等。透明可控。
import type { Config } from "./types.js";

export interface LintIssue {
  level: "error" | "warn";
  target: string; // 项目名或服务器名
  message: string;
}

export function lintConfig(config: Config): LintIssue[] {
  const issues: LintIssue[] = [];

  for (const [name, p] of Object.entries(config.projects || {})) {
    if (p.dir && (/^[A-Za-z]:[\\/]/.test(p.dir) || p.dir.includes("\\")))
      issues.push({ level: "error", target: name, message: `dir 像 Windows 路径（${p.dir}）—— 多半是 git-bash 路径转换坑，应改成 Linux 绝对路径（如 /root）` });
    else if (p.dir && !p.dir.startsWith("/"))
      issues.push({ level: "warn", target: name, message: `dir 不是绝对路径（${p.dir}）` });

    const dep = (p.deploy || "").trim();
    if (!dep || /^(true|:|#)\s*$/.test(dep))
      issues.push({ level: "warn", target: name, message: `deploy 是占位/空操作（${dep || "空"}），不会真正部署` });
    if (/git\s+(pull|fetch)/.test(dep) && !p.dir)
      issues.push({ level: "warn", target: name, message: `deploy 里有 git pull 但没配 dir，cd 不进目录` });

    if (p.frontend && (!p.frontend.dist || !p.frontend.target))
      issues.push({ level: "warn", target: name, message: `frontend 配了但缺 dist/target` });
    if (p.frontend?.target && !p.frontend.target.startsWith("/"))
      issues.push({ level: "warn", target: name, message: `frontend.target 需为服务器绝对路径（${p.frontend.target}）` });
    if (p.envFile && !p.envFile.startsWith("/"))
      issues.push({ level: "warn", target: name, message: `envFile 不是绝对路径（${p.envFile}）` });
    if (p.proxy && !p.proxy.domain)
      issues.push({ level: "warn", target: name, message: `proxy 配了但没 domain` });
  }

  for (const [name, s] of Object.entries(config.servers || {})) {
    if (!s.host) issues.push({ level: "error", target: name, message: `缺 host` });
    if (!s.identityFile && !s.password)
      issues.push({ level: "warn", target: name, message: `既没配 identityFile 也没 password —— 可能连不上（除非用默认 key / ssh-agent）` });
  }

  return issues;
}
