#!/usr/bin/env node
import { Command } from "commander";
import { createInterface } from "node:readline";
import { dirname } from "node:path";
import { loadConfig, saveConfig, addProject, removeProject, exportBundle, importBundle } from "./core/config.js";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { deploy } from "./core/deploy.js";
import { restart } from "./core/restart.js";
import { status } from "./core/status.js";
import { onboard } from "./core/onboard.js";
import { setupGit } from "./core/setup-git.js";
import { deviceLogin, clearToken, getStoredToken } from "./core/github-auth.js";
import { openTunnel } from "./core/tunnel.js";
import { suggestDeploy } from "./core/scaffold.js";
import { runOnProject } from "./core/run.js";
import { rollback } from "./core/rollback.js";
import { deployFrontend } from "./core/frontend.js";
import { setEnv } from "./core/env.js";
import { watch } from "./core/watch.js";
import { setupProxy, applyProxy, removeProxy, listProxy } from "./core/proxy.js";
import { readOps } from "./core/oplog.js";
import { doctor, setDockerMirror } from "./core/doctor.js";
import { lintConfig } from "./core/lint.js";
import { advise } from "./core/advise.js";
import { startCollector } from "./core/monitor.js";
import { sendNotify } from "./core/notify.js";
import { pushCode } from "./core/push.js";
import { VERSION } from "./version.js";

/** 终端二次确认（危险操作用）。非 TTY（脚本/管道）下默认拒绝，要跑就带 -y。 */
function confirm(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (a) => { rl.close(); resolve(/^y(es)?$/i.test(a.trim())); });
  });
}

/**
 * 还原 git-bash(MSYS) 对命令行参数的路径转换。
 * git-bash 会把以 / 开头的参数转成 <Git安装根>/…（如 /root → C:/Program Files/Git/root），
 * 把本该发给 Linux 服务器的绝对路径弄坏（sg1-proxy 的 dir 就是这么坏的）。
 * MSYS 根 = dirname(EXEPATH)（EXEPATH 是 git-bash 设的 …/Git/bin）。只在 win32 生效。
 */
function unmangle(p: string | undefined, label: string): string | undefined {
  if (!p || process.platform !== "win32") return p;
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
  const exe = process.env.EXEPATH;
  if (exe) {
    const root = norm(dirname(exe)); // 如 C:/Program Files/Git
    const pn = norm(p);
    let fixed: string | undefined;
    if (pn.toLowerCase() === root.toLowerCase()) fixed = "/";
    else if (pn.toLowerCase().startsWith(root.toLowerCase() + "/")) fixed = pn.slice(root.length);
    if (fixed && fixed !== p) {
      console.error(`ℹ️ 检测到 git-bash 路径转换，已自动还原 ${label}：${p} → ${fixed}`);
      return fixed;
    }
  }
  if (/^[A-Za-z]:[\\/]/.test(p))
    console.error(`⚠️ ${label} 像 Windows 路径（${p}）——服务器路径应为 Linux 绝对路径（如 /root）。git-bash 里用 //root 或前缀 MSYS_NO_PATHCONV=1 绕开转换。`);
  return p;
}

/** 读一行输入（返回 trim 后的字符串）。非 TTY 返回空串。 */
function question(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (a) => { rl.close(); resolve(a.trim()); });
  });
}

/** 解析时长："30m" / "90s" / "1h" → 毫秒；无单位当分钟；解析不了默认 10 分钟。 */
function parseDuration(s: string): number {
  const m = String(s).trim().match(/^(\d+)\s*([smh])?$/i);
  if (!m) return 10 * 60 * 1000;
  const n = Number(m[1]);
  const u = (m[2] || "m").toLowerCase();
  return n * (u === "s" ? 1000 : u === "h" ? 3600000 : 60000);
}

const program = new Command();
program
  .name("vibe-launch")
  .description("一键把 AI 写的项目部署到你的服务器（MCP + CLI）")
  .version(VERSION)
  .option("-c, --config <path>", "配置文件路径");

function cfg() {
  return loadConfig(program.opts().config);
}

program
  .command("ls")
  .description("列出服务器和项目")
  .action(() => {
    const c = cfg();
    console.log("服务器:");
    for (const [name, s] of Object.entries(c.servers))
      console.log(`  ${name.padEnd(12)} ${s.user}@${s.host}${s.note ? "  (" + s.note + ")" : ""}`);
    console.log("\n项目:");
    for (const [name, p] of Object.entries(c.projects))
      console.log(`  ${name.padEnd(14)} → ${p.server.padEnd(12)} ${p.dir ?? ""}`);
  });

program
  .command("deploy <project>")
  .description("部署指定项目（pre/postDeploy 钩子按配置自动编排）")
  .option("--frontend", "前端一体部署：本地 build → 传产物 → 原子替换 → 重启（走 project.frontend 配置）")
  .option("--dry-run", "只打印执行计划（含钩子），不在服务器上跑任何命令")
  .option("--watch [cmd]", "部署成功后持续盯：带命令则跑该命令(退出码0=健康)，不带则轮询 health")
  .option("--duration <dur>", "--watch 的观察时长，如 30m / 90s / 1h，默认 10m", "10m")
  .option("--no-preflight", "跳过部署前置体检（目录/docker/磁盘/git remote 快查）")
  .action(async (project: string, opts) => {
    // 前端一体：走独立通道（本地 build + 传产物），不跑服务器 deploy 命令
    if (opts.frontend) {
      console.log(`==> 前端部署 ${project} …`);
      const r = await deployFrontend(cfg(), project);
      for (const s of r.steps) console.log("  " + s);
      for (const h of r.health) console.log(`  健康 ${h.url} → ${h.httpCode} ${h.ok ? "✓" : "✗"}`);
      if (r.success) console.log(`✅ ${project} 前端已上线`);
      else { console.error(`❌ 前端部署失败：${r.error ?? "未知"}`); process.exitCode = 1; }
      return;
    }

    console.log(`==> 部署 ${project} …`);
    const r = await deploy(cfg(), project, { dryRun: opts.dryRun, skipPreflight: opts.preflight === false });
    for (const c of r.preflight ?? []) if (!c.ok) console.log(`  ${c.blocker ? "✗" : "⚠"} 体检 ${c.name}：${c.detail}`);
    if (r.output) console.log(r.output);
    if (opts.dryRun) return;
    for (const hk of r.hooks ?? []) console.log(`  [${hk.phase}Deploy] ${hk.cmd} → ${hk.code === 0 ? "✓" : "✗ 退出 " + hk.code}`);
    for (const h of r.health) console.log(`  健康 ${h.url} → ${h.httpCode} ${h.ok ? "✓" : "✗"}`);
    if (r.warnings?.length) {
      console.log("  ⚠ 健康过了但日志疑似报错：");
      for (const w of r.warnings) console.log(`    ${w.container}: ${w.sample}`);
    }
    if (r.success) {
      console.log(`✅ ${project} 部署成功${r.gitRev ? " @ " + r.gitRev : ""}`);
      // --watch：部署后持续盯一段时间（灰度收尾）
      if (opts.watch !== undefined) {
        console.log(`\n==> 盯 ${opts.duration}（Ctrl+C 停）…`);
        const w = await watch(cfg(), project, {
          cmd: typeof opts.watch === "string" ? opts.watch : undefined,
          durationMs: parseDuration(opts.duration),
          onTick: (l) => console.log("  " + l),
        });
        console.log(w.failures ? `⚠ 观察期内 ${w.failures}/${w.ticks} 次异常，考虑 vl rollback ${project}` : `✅ 观察期 ${w.ticks} 次全绿`);
      }
    } else {
      console.error(`❌ ${project} 部署失败：${r.error ?? "未知"}`);
      if (r.failLogs?.length) for (const f of r.failLogs) console.error(`  容器 ${f.container} [${f.state}]:\n${f.logs}`);
      process.exitCode = 1;
    }
  });

program
  .command("restart <project>")
  .description("重启项目容器（docker restart）+ 健康检查；只重启不拉代码")
  .option("--only <list>", "只重启这些容器（逗号分隔），其余不动（如改 poller 只重 worker）")
  .action(async (project: string, opts) => {
    const only = opts.only ? String(opts.only).split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    console.log(`==> 重启 ${project}${only ? " [" + only.join(", ") + "]" : ""} …`);
    const r = await restart(cfg(), project, { only });
    for (const c of r.restarted) console.log(`  ${c.container}: ${c.ok ? "✓ 已重启" : "✗ " + c.output}`);
    for (const h of r.health) console.log(`  健康 ${h.url} → ${h.httpCode} ${h.ok ? "✓" : "✗"}`);
    if (r.success) {
      console.log(`✅ ${project} 已重启`);
    } else {
      console.error(`❌ ${project} 重启失败：${r.error ?? "未知"}`);
      process.exitCode = 1;
    }
  });

program
  .command("run <project> <cmd>")
  .description("在项目所在服务器上跑即席命令（自动带 host/key）。--container 则 docker exec 进容器跑")
  .option("--container <name>", "在指定容器内执行（自动 docker exec）")
  .option("--cwd <dir>", "工作目录（不填则项目 dir；容器模式下为容器内 -w 目录）")
  .option("--timeout <sec>", "超时秒数，默认 120（构建/迁移可调大）", "120")
  .action(async (project: string, cmd: string, opts) => {
    const r = await runOnProject(cfg(), project, cmd, {
      container: opts.container,
      cwd: unmangle(opts.cwd, "--cwd"),
      timeoutMs: Math.max(1, Number(opts.timeout) || 120) * 1000,
    });
    if (r.stdout) process.stdout.write(r.stdout.endsWith("\n") ? r.stdout : r.stdout + "\n");
    if (r.stderr) process.stderr.write(r.stderr.endsWith("\n") ? r.stderr : r.stderr + "\n");
    if (r.code !== 0) {
      console.error(`(退出码 ${r.code})`);
      process.exitCode = r.code ?? 1;
    }
  });

program
  .command("push <project>")
  .description("把本地代码文件夹上传到项目的服务器目录（不用 git；自动跳过 node_modules 等）")
  .option("--from <dir>", "本地代码目录（不填则用项目 localSource 或当前目录）")
  .action(async (project: string, opts) => {
    console.log(`==> 推送 ${project} 的本地代码 …`);
    const r = await pushCode(cfg(), project, unmangle(opts.from, "--from"));
    for (const s of r.steps) console.log("  " + s);
    if (r.success) console.log(`✅ ${project} 代码已上传`);
    else { console.error(`❌ ${r.error}`); process.exitCode = 1; }
  });

program
  .command("rollback <project> [rev]")
  .description("回滚到上一个（或指定）提交并重启 + 健康检查。危险操作，默认二次确认")
  .option("--dry-run", "只显示将回滚到哪个版本，不执行")
  .option("-y, --yes", "跳过二次确认")
  .action(async (project: string, rev: string | undefined, opts) => {
    if (opts.dryRun) {
      const r = await rollback(cfg(), project, rev, { dryRun: true });
      console.log(r.output || r.error || "");
      if (r.error) process.exitCode = 1;
      return;
    }
    if (!opts.yes) {
      const ok = await confirm(`确认回滚 ${project} 到 ${rev || "HEAD~1"}？会 git reset --hard + 重启容器 [y/N] `);
      if (!ok) { console.log("已取消（非交互环境请加 -y）"); return; }
    }
    console.log(`==> 回滚 ${project} …`);
    const r = await rollback(cfg(), project, rev);
    if (r.output) console.log(r.output);
    for (const h of r.health) console.log(`  健康 ${h.url} → ${h.httpCode} ${h.ok ? "✓" : "✗"}`);
    if (r.success) console.log(`✅ ${project} 已回滚${r.gitRev ? " @ " + r.gitRev : ""}`);
    else { console.error(`❌ 回滚失败：${r.error ?? "未知"}`); process.exitCode = 1; }
  });

program
  .command("env <project> <action> [pairs...]")
  .description("管理远端 .env：env <项目> set KEY=VAL [KEY2=VAL2 …]（改前自动备份）")
  .option("--restart", "改完后重启项目容器 + 健康检查")
  .option("--file <path>", "指定 .env 绝对路径（默认 <dir>/.env 或 project.envFile）")
  .option("--dry-run", "只显示将改哪些键，不写入")
  .option("-y, --yes", "跳过二次确认")
  .action(async (project: string, action: string, pairs: string[], opts) => {
    if (action !== "set") {
      console.error("目前只支持：vl env <项目> set KEY=VAL …");
      process.exitCode = 1;
      return;
    }
    const kv: Record<string, string> = {};
    for (const p of pairs) {
      const i = p.indexOf("=");
      if (i <= 0) { console.error(`格式应为 KEY=VAL：${p}`); process.exitCode = 1; return; }
      kv[p.slice(0, i)] = p.slice(i + 1);
    }
    if (opts.dryRun) {
      const r = await setEnv(cfg(), project, kv, { file: unmangle(opts.file, "--file"), dryRun: true });
      if (r.error) { console.error("❌ " + r.error); process.exitCode = 1; return; }
      console.log(`将写入 ${r.file}：`);
      for (const c of r.changed) console.log(`  ${c.action === "add" ? "+" : "~"} ${c.key}`);
      return;
    }
    if (!opts.yes) {
      const ok = await confirm(`确认改 ${project} 的 .env（${Object.keys(kv).join(", ")}）${opts.restart ? " 并重启" : ""}？[y/N] `);
      if (!ok) { console.log("已取消（非交互环境请加 -y）"); return; }
    }
    const r = await setEnv(cfg(), project, kv, { file: unmangle(opts.file, "--file"), restart: opts.restart });
    if (!r.success) { console.error(`❌ ${r.error ?? "未知"}`); process.exitCode = 1; return; }
    console.log(`✅ 已更新 ${r.file}`);
    for (const c of r.changed) console.log(`  ${c.action === "add" ? "+" : "~"} ${c.key}`);
    if (r.backup) console.log(`  备份：${r.backup}`);
    if (r.warning) console.log(`  ⚠ ${r.warning}`);
    for (const c of r.restarted ?? []) console.log(`  restart ${c.container}: ${c.ok ? "✓" : "✗"}`);
    for (const h of r.health ?? []) console.log(`  健康 ${h.url} → ${h.httpCode} ${h.ok ? "✓" : "✗"}`);
  });

program
  .command("status [project]")
  .description("看项目状态（git 版本 + 容器 + 健康检查）；不填则看全部")
  .action(async (project?: string) => {
    const c = cfg();
    const names = project ? [project] : Object.keys(c.projects);
    for (const name of names) {
      const s = await status(c, name);
      const head = s.reachable ? "🟢" : "🔴";
      console.log(`${head} ${name} [${s.server}]${s.gitRev ? " @ " + s.gitRev : ""}${s.error ? "  " + s.error : ""}`);
      for (const ct of s.containers) console.log(`    容器 ${ct.name}: ${ct.state}`);
      for (const h of s.health) console.log(`    健康 ${h.url} → ${h.httpCode} ${h.ok ? "✓" : "✗"}`);
    }
  });

const serverCmd = program.command("server").description("管理服务器");
serverCmd
  .command("add <alias>")
  .description("接入新服务器：自动装公钥（免密）+ 可选建部署用户 + 写进清单")
  .requiredOption("--host <host>", "服务器 IP/域名")
  .option("--user <user>", "初次登录用户", "root")
  .option("--password <pw>", "初次登录密码（一次性，装公钥用；不填则用现有 key 登录）")
  .option("--port <port>", "SSH 端口", "22")
  .option("--key <path>", "本地私钥路径（不填则用 vibe-launch 自管的专用 key，会自动生成）")
  .option("--deploy-user <name>", "顺便创建专用部署用户并加 docker 组")
  .option("--auth <method>", "认证方式：key（装专用钥匙免密，推荐）| password（存密码）| manual（拿不到密码时，生成命令贴进控制台自助装公钥）", "key")
  .option("--note <note>", "备注，如 海外/国内")
  .action(async (alias: string, opts) => {
    const auth: "key" | "password" | "manual" =
      opts.auth === "password" ? "password" : opts.auth === "manual" ? "manual" : "key";
    const args = {
      alias,
      host: opts.host,
      user: opts.user,
      password: opts.password,
      port: Number(opts.port),
      identityFile: opts.key,
      deployUser: opts.deployUser,
      auth,
      note: opts.note,
    };
    console.log(`==> 接入服务器 ${alias} (${opts.host}) …`);
    let r = await onboard(args);

    // 手动/扫码模式：还没连上就把安装命令交给用户，去控制台贴执行，TTY 下引导按回车重验。
    if (auth === "manual" && !r.success && r.manualInstall) {
      console.log(`\n拿不到密码没关系。把下面这段【整段复制】，贴进你服务器的控制台`);
      console.log(`（云厂商网页终端 / VNC / 扫码登录进去的那个 shell）里执行，装上 vibe-launch 的公钥：\n`);
      console.log(`  ${r.manualInstall.snippet}\n`);
      while (process.stdin.isTTY && !r.success) {
        const a = await question("贴好并执行后，按回车验证连通（输 q 放弃）: ");
        if (/^q(uit)?$/i.test(a)) break;
        r = await onboard(args);
        if (!r.success) console.log("  ✗ 还没连上——确认公钥已装好、host/user/端口无误，再按回车重试。");
      }
      if (!process.stdin.isTTY && !r.success) {
        console.log("装好公钥后，重跑同一条 `server add ... --auth manual` 即可验证并落库。");
      }
    }

    for (const s of r.steps) console.log(`  ${s}`);
    if (r.success) console.log(`✅ ${alias} 接入完成，以后免密直连（user=${r.finalUser}）`);
    else {
      console.error(`❌ 接入失败：${r.error}`);
      process.exitCode = 1;
    }
  });

const projectCmd = program.command("project").description("管理项目");
projectCmd
  .command("add <name>")
  .description("登记一个部署项目（部署到哪台、怎么部署、容器、健康检查）")
  .requiredOption("--server <alias>", "部署到哪台服务器（先 server add）")
  .requiredOption("--deploy <cmd>", "部署命令（服务器上跑），如 'git pull && docker restart x'")
  .option("--dir <dir>", "服务器上的工作目录")
  .option("--containers <list>", "容器名，逗号分隔")
  .option("--health <list>", "健康检查 URL，逗号分隔")
  .option("--restart-cmd <cmd>", "非容器项目(systemd/裸进程)的重启命令，如 'sudo systemctl restart my-svc'")
  .option("--proxy-domain <domain>", "反代域名（配了则登记 proxy 段，之后 vl proxy apply 生效）")
  .option("--proxy-upstream <host:port>", "反代上游，如 127.0.0.1:8000（与 --proxy-domain 一起用）")
  .action((name: string, opts) => {
    const c = loadConfig();
    const split = (s?: string) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : undefined);
    const proxy = opts.proxyDomain
      ? { domain: opts.proxyDomain, upstream: opts.proxyUpstream || "127.0.0.1:8000" }
      : undefined;
    addProject(c, name, {
      server: opts.server,
      dir: unmangle(opts.dir, "--dir"),
      deploy: opts.deploy,
      containers: split(opts.containers),
      health: split(opts.health),
      restartCmd: opts.restartCmd,
      proxy,
    });
    const path = saveConfig(c);
    console.log(`✅ 项目 ${name} 已登记 → ${opts.server}（写入 ${path}）`);
  });
projectCmd
  .command("rm <name>")
  .description("从清单删除项目（只删记录，不动服务器上的任何东西）")
  .action((name: string) => {
    const c = loadConfig();
    removeProject(c, name);
    const path = saveConfig(c);
    console.log(`✅ 已从清单删除项目 ${name}（写入 ${path}）`);
  });

program
  .command("auth")
  .description("用浏览器授权 GitHub（device flow），存 token 供 setup-git 用")
  .option("--logout", "清除已存的 token")
  .option("--status", "看当前是否已授权")
  .action(async (opts) => {
    if (opts.logout) {
      clearToken();
      console.log("已登出（token 已清除）");
      return;
    }
    if (opts.status) {
      console.log(getStoredToken() ? "✅ 已授权（本地存有 token）" : "未授权，运行 vibe-launch auth");
      return;
    }
    await deviceLogin(["repo"], (s) => console.log(s));
    console.log("✅ GitHub 授权成功，token 已保存到 ~/.vibe-launch/github-token.json");
  });

program
  .command("setup-git <project>")
  .description("把项目目录转成 git checkout：装 git + 生成 deploy key + 加到 GitHub 仓库(只读) + 配好免密拉取")
  .requiredOption("--repo <owner/repo>", "GitHub 仓库（owner/repo 或完整 git URL）")
  .option("--branch <branch>", "分支", "main")
  .option("--adopt", "目录非空且非 git 时，先备份再转换（用仓库覆盖被跟踪文件，保留未跟踪文件）")
  .option("--gh <path>", "gh 可执行路径", "gh")
  .option("--token <pat>", "GitHub PAT（需 repo / Administration:write 权限。也可设环境变量 GITHUB_TOKEN）")
  .action(async (project: string, opts) => {
    // 优化：既没 token 又没 gh 时，就地浏览器授权（device flow），就不用装 gh 了。有 gh 的走原路不打扰。
    const hasToken = opts.token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || getStoredToken();
    const hasGh = (() => { try { execFileSync(opts.gh || "gh", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
    if (!hasToken && !hasGh && process.stdin.isTTY) {
      console.log("需要 GitHub 授权来把 deploy key 加到仓库（浏览器点一下即可，用完自动保存本地）…");
      try { await deviceLogin(["repo"], (s) => console.log("  " + s)); }
      catch (e) { console.error(`授权未完成：${(e as Error).message}（也可 --token 或装 gh 后重试）`); }
    }
    console.log(`==> setup-git ${project}（仓库 ${opts.repo}）…`);
    const r = await setupGit(cfg(), {
      project,
      repo: opts.repo,
      branch: opts.branch,
      adopt: opts.adopt,
      ghPath: opts.gh,
      token: opts.token,
    });
    for (const s of r.steps) console.log(`  ${s}`);
    if (r.success) {
      console.log(`✅ ${project} 已就绪（git ${r.gitRev ?? "?"}）`);
      console.log(`   现在把部署命令设成 'git pull && …'（project add --deploy）再 vibe-launch deploy`);
    } else {
      console.error(`❌ setup-git 失败：${r.error}`);
      process.exitCode = 1;
    }
  });

program
  .command("suggest <server> <dir>")
  .description("探测目录的项目类型，给出推荐的壳子部署命令 + 端口 + 健康检查（部署新项目前用）")
  .option("--name <name>", "项目/容器名", "app")
  .option("--port <port>", "对外端口", "8080")
  .action(async (server: string, dir: string, opts) => {
    const r = await suggestDeploy(cfg(), server, unmangle(dir, "<dir>") ?? dir, opts.name, Number(opts.port) || 8080);
    console.log(`类型: ${r.type}  端口: ${r.port}  健康检查: ${r.health.join(", ") || "(无)"}`);
    console.log(`\n推荐部署命令:\n  ${r.deploy || "(未识别)"}`);
    if (r.notes.length) { console.log("\n说明:"); for (const n of r.notes) console.log("  · " + n); }
  });

program
  .command("tunnel <target>")
  .description("开 SSH 隧道：把服务器内网服务(PG/Redis…)映射到本地，免开公网端口")
  .option("--service <name>", "服务预设：pg(5432) / redis(6379) / mysql(3306)")
  .option("--remote-host <host>", "服务器侧目标地址（默认 127.0.0.1）")
  .option("--remote-port <port>", "服务器侧目标端口（不填则由 --service 推断）")
  .option("--local-port <port>", "本地监听端口（默认 = 远程端口）")
  .action(async (target: string, opts) => {
    try {
      await openTunnel(
        cfg(),
        {
          target,
          service: opts.service,
          remoteHost: opts.remoteHost,
          remotePort: opts.remotePort ? Number(opts.remotePort) : undefined,
          localPort: opts.localPort ? Number(opts.localPort) : undefined,
        },
        (s) => console.log(s)
      );
    } catch (e) {
      console.error(`❌ 隧道失败：${(e as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command("ui")
  .description("启动本地可视化操作台（浏览器里看状态 + 部署/接入/登记，纯本地）；同时常驻采集监测样本")
  .option("--port <port>", "监听端口", "7777")
  .option("--no-open", "不自动打开浏览器")
  .option("--no-metrics", "不常驻采集监测样本")
  .option("--metrics-interval <sec>", "监测采集周期秒数（最小 10）", "60")
  .action(async (opts) => {
    const { startUi } = await import("./ui/server.js");
    await startUi(Number(opts.port) || 7777, opts.open !== false, {
      enabled: opts.metrics !== false,
      intervalSec: Number(opts.metricsInterval) || 60,
    });
  });

const proxyCmd = program.command("proxy").description("反代（Caddy）：装 + 接线 + 声明式站点（域名→上游）");
proxyCmd
  .command("setup <server>")
  .description("在服务器装 Caddy + 接线（Caddyfile import）+ 起服务；检测 80/443 冲突")
  .option("--caddy-url <url>", "自定义 Caddy 下载地址（国内可指镜像绕开被墙；也可用环境变量 VL_CADDY_URL）")
  .action(async (server: string, opts) => {
    console.log(`==> proxy setup ${server} …`);
    const r = await setupProxy(cfg(), server, { caddyUrl: opts.caddyUrl });
    for (const s of r.steps) console.log(`  ${s}`);
    if (r.success) console.log(`✅ ${server} 已就绪，可 vl proxy apply <项目>`);
    else { console.error(`❌ ${r.error}`); process.exitCode = 1; }
  });
proxyCmd
  .command("apply <project>")
  .description("把项目 proxy 段（域名→上游）生成 Caddy 站点块并 reload 生效")
  .action(async (project: string) => {
    console.log(`==> proxy apply ${project} …`);
    const r = await applyProxy(cfg(), project);
    for (const s of r.steps) console.log(`  ${s}`);
    if (r.success) console.log(`✅ ${project} 反代已上线（${r.domain}）`);
    else { console.error(`❌ ${r.error}`); process.exitCode = 1; }
  });
proxyCmd
  .command("rm <project>")
  .description("删掉项目的 Caddy 站点块并 reload")
  .action(async (project: string) => {
    const r = await removeProxy(cfg(), project);
    for (const s of r.steps) console.log(`  ${s}`);
    if (!r.success) { console.error(`❌ ${r.error}`); process.exitCode = 1; }
  });
proxyCmd
  .command("ls <server>")
  .description("列出该服务器上 vibe-launch 管理的站点块")
  .action(async (server: string) => {
    const sites = await listProxy(cfg(), server);
    if (!sites.length) { console.log("（无 vibe-launch 管理的站点块）"); return; }
    for (const s of sites) {
      console.log(`# ${s.project}`);
      console.log(s.content.split("\n").map((l) => "  " + l).join("\n"));
    }
  });

program
  .command("doctor <server>")
  .description("网络体检：探 Docker Hub/GitHub/Caddy/npm/PyPI 可达性 + docker 镜像配置（国内排查）")
  .action(async (server: string) => {
    console.log(`==> 体检 ${server} …`);
    const r = await doctor(cfg(), server);
    if (r.error) { console.error(`❌ ${r.error}`); process.exitCode = 1; return; }
    console.log(`  Docker：${r.docker}${r.curl ? "" : "   ⚠ 服务器没装 curl，探测受限"}`);
    console.log(`  DNS：${r.dns.join(", ") || "(未配! 多半就是全 000 的原因)"}`);
    console.log(`  现有镜像：${r.currentMirrors.join(", ") || "(未配)"}`);
    for (const p of r.probes)
      console.log(`  ${p.ok ? "✓" : "✗"} ${p.name.padEnd(11)} ${String(p.code).padStart(3)}  ${String(p.timeMs).padStart(5)}ms  ${p.url}${p.reason ? "   ← " + p.reason : ""}`);
    if (r.dns.length === 0 && r.probes.every((p) => !p.ok))
      console.log(`  → 全部不通且没有 DNS：先修这台机的 DNS（/etc/resolv.conf 加 nameserver），再谈镜像`);
    else if (r.probes.find((p) => p.name === "Docker Hub" && !p.ok))
      console.log(`  → Docker Hub 不可达，建议：vl docker-mirror ${server}（云机优先用云内网镜像）`);
  });

program
  .command("docker-mirror <server>")
  .description("配 Docker registry 镜像加速（改 daemon.json + 重启 docker，该机所有容器短暂重启）")
  .option("--mirror <url...>", "镜像地址，可多个（不填用默认公共源；公共源常失效，配完请 vl doctor 复验）")
  .option("--dry-run", "只显示将写入的 daemon.json，不改")
  .option("-y, --yes", "跳过二次确认")
  .action(async (server: string, opts) => {
    const mirrors: string[] = opts.mirror || [];
    if (opts.dryRun) {
      const r = await setDockerMirror(cfg(), server, mirrors, { dryRun: true });
      if (r.error) { console.error(`❌ ${r.error}`); process.exitCode = 1; return; }
      console.log(`将写入 ${r.file}（registry-mirrors: ${r.mirrors.join(", ")}）：\n${r.content}`);
      return;
    }
    if (!opts.yes) {
      const ok = await confirm(`确认给 ${server} 配镜像加速？会改 daemon.json 并【重启 docker】（该机所有容器短暂重启一次）[y/N] `);
      if (!ok) { console.log("已取消（非交互环境请加 -y）"); return; }
    }
    console.log(`==> 配 docker 镜像 ${server} …`);
    const r = await setDockerMirror(cfg(), server, mirrors);
    if (r.success) {
      console.log(`✅ 已配镜像并重启 docker（${r.mirrors.join(", ")}）`);
      console.log(`   建议 vl doctor ${server} 复验 Docker Hub 是否已提速（公共源常失效）`);
    } else { console.error(`❌ ${r.error}`); process.exitCode = 1; }
  });

program
  .command("lint")
  .description("检查清单配置的常见错误（Windows 路径 dir / 占位 deploy / 连不上的 server 等）")
  .action(() => {
    const issues = lintConfig(cfg());
    if (!issues.length) { console.log("✅ 配置没发现问题"); return; }
    for (const i of issues) console.log(`${i.level === "error" ? "✗" : "⚠"} ${i.target.padEnd(16)} ${i.message}`);
    if (issues.some((i) => i.level === "error")) process.exitCode = 1;
  });

program
  .command("advise")
  .description("看当前建议：监测/配置发现的问题 + 对应怎么办（磁盘满/Swap高/健康失败/崩溃循环/配置错等）")
  .action(() => {
    const a = advise(cfg());
    if (!a.length) { console.log("✅ 暂无待处理建议"); return; }
    for (const x of a) console.log(`${x.level === "error" ? "✗" : "⚠"} ${x.target}　${x.problem}\n    → ${x.fix}${x.action?.cmd ? "：" + x.action.cmd : ""}`);
  });

program
  .command("log")
  .description("看操作日志（deploy/restart/rollback/env/run/proxy/接入/删容器…，便于追踪排查）")
  .option("--limit <n>", "条数", "40")
  .option("--target <name>", "只看某项目/服务器")
  .action((opts) => {
    const ops = readOps(Number(opts.limit) || 40, opts.target);
    if (!ops.length) { console.log("（暂无操作记录）"); return; }
    for (const o of ops.slice().reverse()) { // 时间正序：最新在最下，像 tail
      const t = new Date(o.ts).toLocaleString();
      console.log(`${t}  ${o.ok ? "✓" : "✗"} ${o.action.padEnd(15)} ${o.target}${o.detail ? "  " + o.detail : ""}`);
    }
  });

program
  .command("monitor")
  .description("常驻采集监测样本（服务器指标 + 项目状态）落 ~/.vibe-launch/metrics/；开着 vl ui 也会自动采")
  .option("--interval <sec>", "采集周期秒数（最小 10）", "60")
  .action(async (opts) => {
    const iv = Math.max(10, Number(opts.interval) || 60) * 1000;
    console.log(`==> 监测采集中，每 ${iv / 1000}s 一轮（Ctrl+C 停）…`);
    startCollector(cfg(), iv, (s) => {
      const t = new Date().toLocaleTimeString();
      const down = s.filter((x) => x.reachable === false).map((x) => x.name);
      const bad = s.filter((x) => x.kind === "project" && x.healthOk === false).map((x) => x.name);
      console.log(`  ${t} 采 ${s.length} 样本${down.length ? "  ⚠ 连不上: " + down.join(",") : ""}${bad.length ? "  ⚠ 健康红: " + bad.join(",") : ""}`);
    });
    await new Promise(() => {}); // 常驻
  });

const configCmd = program.command("config").description("配置备份/恢复（纯本地清单，防换电脑/重装丢失）");
configCmd
  .command("export [file]")
  .description("完整备份（配置 + SSH 密钥）到文件，换电脑可直接恢复。含私钥/密码，妥善保管、别外传")
  .action((file?: string) => {
    const text = exportBundle();
    if (file) { writeFileSync(file, text); console.log(`✅ 已完整备份到 ${file}（含 SSH 私钥，妥善保管、别外传）`); }
    else process.stdout.write(text);
  });
configCmd
  .command("import <file>")
  .description("从备份恢复配置 + SSH 密钥（覆盖前自动把当前配置备份成 .vlbak）")
  .action((file: string) => {
    const p = importBundle(readFileSync(file, "utf8"));
    console.log(`✅ 已从 ${file} 恢复配置与密钥 → ${p}（原配置备份在 ${p}.vlbak）`);
  });

const notifyCmd = program.command("notify").description("告警 webhook：监测到问题自动推送（企业微信/飞书/Discord/钉钉/Slack）");
notifyCmd
  .command("set <webhook>")
  .description("设置告警 webhook 地址（存进清单）")
  .action((webhook: string) => {
    const c = loadConfig();
    c.notify = { ...c.notify, webhook };
    const p = saveConfig(c);
    console.log(`✅ 已设置告警 webhook（写入 ${p}）。监测到问题会自动推送。`);
  });
notifyCmd
  .command("test")
  .description("给已配的 webhook 发一条测试消息")
  .option("--webhook <url>", "临时指定 webhook（不填用清单里的）")
  .action(async (opts) => {
    const wh = opts.webhook || cfg().notify?.webhook;
    if (!wh) { console.error("还没配 webhook：vl notify set <url>，或加 --webhook"); process.exitCode = 1; return; }
    const r = await sendNotify(wh, "vibe-launch 测试消息：告警通道已打通 ✅");
    if (r.ok) console.log("✅ 已发送，去你的群里看看收到没");
    else { console.error(`❌ 发送失败：${r.error}`); process.exitCode = 1; }
  });

program
  .command("mcp")
  .description("启动 MCP server（给 Claude Code / Cursor / Codex 等 AI 工具调用）")
  .action(async () => {
    const { startMcp } = await import("./mcp.js");
    await startMcp();
  });

// 无子命令时给新手一个上手提示（而不是干巴巴的 help）
program.action(() => {
  console.log(
    "vibe-launch —— 把项目部署到你的服务器（纯本地）\n\n" +
      "新手推荐：先开可视化操作台，点点就能上手\n" +
      "  vibe-launch ui\n\n" +
      "或命令行三步：\n" +
      '  1) vibe-launch server add prod --host <IP> --password <密码>\n' +
      '  2) vibe-launch project add myapp --server prod --deploy "git pull && docker restart myapp"\n' +
      "  3) vibe-launch deploy myapp\n\n" +
      "全部命令：vibe-launch --help"
  );
});

program.parseAsync().catch((e) => {
  console.error("错误:", (e as Error).message);
  process.exit(1);
});
