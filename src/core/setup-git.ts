// setup-git：把项目目录在服务器上转成 git checkout
//   1. 确保服务器装了 git
//   2. 服务器生成专用 deploy key（每项目一把）
//   3. 本地用 gh 把 deploy key 加到 GitHub 仓库（只读）
//   4. 写 ~/.ssh/config Host 别名，让 git 走这把 key 免密拉取
// 用 ssh-config 别名而非 GIT_SSH_COMMAND/core.sshCommand —— 后两者老 git(<2.3/<2.10)不支持，
// 别名方案把"选哪把 key"交给 ssh，任何 git 版本（含 1.8）都通用。
import { execFileSync } from "node:child_process";
import type { Config } from "./types.js";
import { getProject } from "./config.js";
import { runOnServer } from "./ssh.js";
import { getStoredToken } from "./github-auth.js";

const q = (s: string) => JSON.stringify(s); // 简易 shell 引用（与 deploy.ts 一致）

export interface SetupGitOptions {
  project: string;
  /** GitHub 仓库：owner/repo 或完整 git URL */
  repo: string;
  /** 分支，默认 main */
  branch?: string;
  /** 目录非空且非 git 时，允许先备份再转换（会用仓库覆盖被跟踪文件，保留未跟踪文件如 .env/.output） */
  adopt?: boolean;
  /** gh 可执行路径，默认 "gh" */
  ghPath?: string;
  /** GitHub PAT（替代 gh）；不填则读环境变量 GITHUB_TOKEN/GH_TOKEN */
  token?: string;
}

export interface SetupGitResult {
  project: string;
  server: string;
  success: boolean;
  steps: string[];
  deployKeyTitle?: string;
  gitRev?: string;
  error?: string;
}

function parseRepo(repo: string): { ownerRepo: string } {
  let m: RegExpMatchArray | null;
  if ((m = repo.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/))) return { ownerRepo: `${m[1]}/${m[2]}` };
  if ((m = repo.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/))) return { ownerRepo: `${m[1]}/${m[2]}` };
  if ((m = repo.match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/))) return { ownerRepo: `${m[1]}/${m[2]}` };
  throw new Error(`无法解析仓库 "${repo}"，请用 owner/repo 或完整 git URL`);
}

const normKey = (k: string) => k.trim().split(/\s+/).slice(0, 2).join(" "); // 只比 type+base64，忽略注释

/** 把 deploy key 加到 GitHub 仓库（只读、幂等）。三路：token 直连 API → gh → 提示。 */
async function registerDeployKey(
  cfg: { ghPath?: string; token?: string },
  ownerRepo: string,
  title: string,
  pubkey: string,
  steps: string[]
): Promise<void> {
  const want = normKey(pubkey);
  // token 来源优先级：显式传入 > 环境变量 > device flow 存的 token
  const token = cfg.token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || getStoredToken();

  // 路 1：token（PAT）—— 直连 GitHub API，不依赖 gh
  if (token) {
    const base = `https://api.github.com/repos/${ownerRepo}/keys`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "vibe-launch",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    const listRes = await fetch(base, { headers });
    if (listRes.status === 401) throw new Error("GitHub token 无效（401）。需要 repo / Administration:write 权限");
    if (listRes.ok) {
      const keys = (await listRes.json()) as any[];
      if (Array.isArray(keys) && keys.some((k) => normKey(k.key) === want)) {
        steps.push(`✓ deploy key 已在仓库 ${ownerRepo}（跳过）`);
        return;
      }
    }
    const addRes = await fetch(base, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ title, key: pubkey, read_only: true }),
    });
    if (addRes.ok) {
      steps.push(`✓ deploy key 已加到 GitHub 仓库 ${ownerRepo}（只读，token）`);
    } else {
      const body = await addRes.text();
      if (addRes.status === 422 || /already/i.test(body)) steps.push(`✓ deploy key 已在仓库 ${ownerRepo}（跳过）`);
      else throw new Error(`加 deploy key 失败 (HTTP ${addRes.status}): ${body.slice(0, 200)}`);
    }
    return;
  }

  // 路 2：gh（本地已登录）
  const gh = cfg.ghPath || "gh";
  try {
    execFileSync(gh, ["--version"], { stdio: "ignore" });
  } catch {
    // 路 3：都没有 —— 给清楚的下一步
    throw new Error(
      `没法把 deploy key 加到 GitHub。三选一：\n` +
        `  1) vibe-launch auth（浏览器点一下授权，推荐）\n` +
        `  2) gh auth login 后重试\n` +
        `  3) 传 --token <PAT> 或设 GITHUB_TOKEN（需 repo / Administration:write 权限）`
    );
  }
  try {
    const out = execFileSync(gh, ["api", "--paginate", `repos/${ownerRepo}/keys`], { encoding: "utf8" });
    const keys = JSON.parse(out);
    if (Array.isArray(keys) && keys.some((k: any) => normKey(k.key) === want)) {
      steps.push(`✓ deploy key 已在仓库 ${ownerRepo}（跳过）`);
      return;
    }
  } catch {
    /* 查不到就继续尝试添加 */
  }
  try {
    execFileSync(
      gh,
      ["api", `repos/${ownerRepo}/keys`, "-f", `title=${title}`, "-f", `key=${pubkey}`, "-F", "read_only=true"],
      { stdio: "pipe" }
    );
    steps.push(`✓ deploy key 已加到 GitHub 仓库 ${ownerRepo}（只读，gh）`);
  } catch (e: any) {
    const o = (e?.stderr?.toString() || e?.stdout?.toString() || e?.message || "").trim();
    if (/already|422/i.test(o)) steps.push(`✓ deploy key 已在仓库 ${ownerRepo}（跳过）`);
    else throw new Error(`加 deploy key 到 GitHub 失败: ${o}`);
  }
}

export async function setupGit(config: Config, opts: SetupGitOptions): Promise<SetupGitResult> {
  const branch = opts.branch || "main";
  const { project, server, serverName } = getProject(config, opts.project);
  const steps: string[] = [];
  const result: SetupGitResult = { project: opts.project, server: serverName, success: false, steps };

  const run = async (cmd: string, label: string): Promise<string> => {
    const r = await runOnServer(server, cmd);
    if (r.code !== 0) throw new Error(`${label}失败: ${(r.stderr || r.stdout || "").trim()}`);
    return r.stdout.trim();
  };

  try {
    if (!project.dir) throw new Error(`项目 ${opts.project} 没配 dir（git checkout 目录）`);
    const dir = project.dir;
    const { ownerRepo } = parseRepo(opts.repo);
    const alias = `vibe-launch-${opts.project}`; // ssh-config Host 别名
    const aliasUrl = `git@${alias}:${ownerRepo}.git`; // 走别名的 clone/remote URL

    // 0. 服务器 HOME + key 路径
    const home = await run("echo $HOME", "取 HOME");
    const keyPath = `${home}/.ssh/vibe-launch-${opts.project}`;
    const sshDir = `${home}/.ssh`;

    // 1. 确保 git
    const hasGit = (await runOnServer(server, "command -v git >/dev/null 2>&1 && echo yes || echo no")).stdout.trim();
    if (hasGit === "yes") {
      steps.push("✓ git 已存在");
    } else {
      steps.push("服务器没 git，安装中…");
      await run(
        "(command -v apt-get >/dev/null && sudo apt-get update -qq && sudo apt-get install -y -qq git) || " +
          "(command -v dnf >/dev/null && sudo dnf install -y -q git) || " +
          "(command -v yum >/dev/null && sudo yum install -y -q git) || " +
          "(command -v zypper >/dev/null && sudo zypper -n install git) || " +
          "(command -v apk >/dev/null && sudo apk add --no-progress git) || " +
          "(command -v pacman >/dev/null && sudo pacman -Sy --noconfirm git) || " +
          "{ echo '无法自动安装 git（不认识的包管理器，请手动装 git）'; exit 1; }",
        "装 git"
      );
      steps.push("✓ git 已安装");
    }

    // 2. .ssh + known_hosts + deploy key
    await run(`mkdir -p ${q(sshDir)} && chmod 700 ${q(sshDir)}`, "建 .ssh");
    await runOnServer(
      server,
      `ssh-keygen -F github.com >/dev/null 2>&1 || ssh-keyscan -t rsa,ed25519 github.com >> ${q(sshDir + "/known_hosts")} 2>/dev/null`
    );
    const keyExists = (await runOnServer(server, `test -f ${q(keyPath)} && echo yes || echo no`)).stdout.trim();
    if (keyExists === "yes") {
      steps.push("✓ deploy key 已存在（复用）");
    } else {
      await run(`ssh-keygen -t ed25519 -f ${q(keyPath)} -N '' -q -C ${q("vibe-launch:" + opts.project)}`, "生成 deploy key");
      steps.push("✓ 服务器已生成 deploy key");
    }
    const pubkey = await run(`cat ${q(keyPath + ".pub")}`, "读公钥");

    // 3. 写 ~/.ssh/config Host 别名（幂等：先删旧块再追加），让 git 走这把 key
    const cfgPath = `${sshDir}/config`;
    const block = [
      `# >>> vibe-launch:${opts.project} >>>`,
      `Host ${alias}`,
      `    HostName github.com`,
      `    User git`,
      `    IdentityFile ${keyPath}`,
      `    IdentitiesOnly yes`,
      `    StrictHostKeyChecking no`,
      `# <<< vibe-launch:${opts.project} <<<`,
    ].join("\n");
    await run(
      `touch ${q(cfgPath)} && chmod 600 ${q(cfgPath)} && ` +
        `sed -i '/# >>> vibe-launch:${opts.project} >>>/,/# <<< vibe-launch:${opts.project} <<</d' ${q(cfgPath)} && ` +
        `cat >> ${q(cfgPath)} <<'VLBLOCK'\n${block}\nVLBLOCK`,
      "写 ssh 别名"
    );
    steps.push(`✓ 已配 ssh 别名 ${alias}（git 版本无关）`);

    // 4. 把 deploy key 加到 GitHub 仓库（token / gh）
    const title = `vibe-launch:${serverName}:${opts.project}`;
    await registerDeployKey({ ghPath: opts.ghPath, token: opts.token }, ownerRepo, title, pubkey, steps);
    result.deployKeyTitle = title;

    // 5. 配置目录（三态）。用 cd 而非 git -C —— 兼容老 git(1.8 无 -C)
    const state = (
      await runOnServer(
        server,
        `if [ -d ${q(dir + "/.git")} ]; then echo git; ` +
          `elif [ ! -e ${q(dir)} ] || [ -z "$(ls -A ${q(dir)} 2>/dev/null)" ]; then echo empty; ` +
          `else echo dirty; fi`
      )
    ).stdout.trim();

    if (state === "git") {
      await run(
        `cd ${q(dir)} && (git remote set-url origin ${q(aliasUrl)} 2>/dev/null || git remote add origin ${q(aliasUrl)}) && ` +
          `git fetch origin ${q(branch)}`,
        "设 remote + fetch"
      );
      steps.push("✓ 已是 git 仓库：重配 remote 走专用 key");
    } else if (state === "empty") {
      await run(`mkdir -p ${q(dir)} && git clone --branch ${q(branch)} ${q(aliasUrl)} ${q(dir)}`, "clone");
      steps.push("✓ 空目录：已 clone");
    } else {
      if (!opts.adopt) {
        throw new Error(
          `目录 ${dir} 非空且不是 git 仓库。加 --adopt 让 vibe-launch 先备份再转成 git checkout` +
            `（用仓库内容覆盖被跟踪文件，保留 .env/.output 等未跟踪文件）`
        );
      }
      await run(`cp -a ${q(dir)} ${q(dir)}.vibe-launch-bak.$(date +%s)`, "备份原目录");
      steps.push(`✓ 已备份原目录（${dir}.vibe-launch-bak.*）`);
      await run(
        `cd ${q(dir)} && git init -q && ` +
          `(git remote add origin ${q(aliasUrl)} 2>/dev/null || git remote set-url origin ${q(aliasUrl)}) && ` +
          `git fetch origin ${q(branch)} && git reset --hard origin/${branch}`,
        "init + fetch + reset"
      );
      steps.push("✓ 已转成 git checkout（原内容已备份，未跟踪文件保留）");
    }

    const rev = (await runOnServer(server, `cd ${q(dir)} && git rev-parse --short HEAD 2>/dev/null || true`)).stdout.trim();
    result.gitRev = rev || undefined;
    result.success = true;
    return result;
  } catch (e) {
    result.error = (e as Error).message;
    return result;
  }
}
