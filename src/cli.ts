#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig, saveConfig, addProject } from "./core/config.js";
import { deploy } from "./core/deploy.js";
import { restart } from "./core/restart.js";
import { status } from "./core/status.js";
import { onboard } from "./core/onboard.js";
import { setupGit } from "./core/setup-git.js";
import { deviceLogin, clearToken, getStoredToken } from "./core/github-auth.js";
import { openTunnel } from "./core/tunnel.js";
import { suggestDeploy } from "./core/scaffold.js";
import { VERSION } from "./version.js";

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
  .description("部署指定项目")
  .action(async (project: string) => {
    console.log(`==> 部署 ${project} …`);
    const r = await deploy(cfg(), project);
    if (r.output) console.log(r.output);
    for (const h of r.health) console.log(`  健康 ${h.url} → ${h.httpCode} ${h.ok ? "✓" : "✗"}`);
    if (r.success) {
      console.log(`✅ ${project} 部署成功${r.gitRev ? " @ " + r.gitRev : ""}`);
    } else {
      console.error(`❌ ${project} 部署失败：${r.error ?? "未知"}`);
      process.exitCode = 1;
    }
  });

program
  .command("restart <project>")
  .description("重启项目容器（docker restart）+ 健康检查；只重启不拉代码")
  .action(async (project: string) => {
    console.log(`==> 重启 ${project} …`);
    const r = await restart(cfg(), project);
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
  .option("--auth <method>", "认证方式：key（装专用钥匙免密，推荐）| password（直接存密码）", "key")
  .option("--note <note>", "备注，如 海外/国内")
  .action(async (alias: string, opts) => {
    console.log(`==> 接入服务器 ${alias} (${opts.host}) …`);
    const r = await onboard({
      alias,
      host: opts.host,
      user: opts.user,
      password: opts.password,
      port: Number(opts.port),
      identityFile: opts.key,
      deployUser: opts.deployUser,
      auth: opts.auth === "password" ? "password" : "key",
      note: opts.note,
    });
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
  .action((name: string, opts) => {
    const c = loadConfig();
    const split = (s?: string) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : undefined);
    addProject(c, name, {
      server: opts.server,
      dir: opts.dir,
      deploy: opts.deploy,
      containers: split(opts.containers),
      health: split(opts.health),
    });
    const path = saveConfig(c);
    console.log(`✅ 项目 ${name} 已登记 → ${opts.server}（写入 ${path}）`);
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
  .description("把项目目录转成 git checkout：装 git + 生成 deploy key + 用 gh 自动加到 GitHub 仓库(只读) + 配好免密拉取")
  .requiredOption("--repo <owner/repo>", "GitHub 仓库（owner/repo 或完整 git URL）")
  .option("--branch <branch>", "分支", "main")
  .option("--adopt", "目录非空且非 git 时，先备份再转换（用仓库覆盖被跟踪文件，保留未跟踪文件）")
  .option("--gh <path>", "gh 可执行路径", "gh")
  .option("--token <pat>", "GitHub PAT（替代 gh；需 repo / Administration:write 权限。也可设环境变量 GITHUB_TOKEN）")
  .action(async (project: string, opts) => {
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
    const r = await suggestDeploy(cfg(), server, dir, opts.name, Number(opts.port) || 8080);
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
  .description("启动本地可视化操作台（浏览器里看状态 + 部署/接入/登记，纯本地）")
  .option("--port <port>", "监听端口", "7777")
  .option("--no-open", "不自动打开浏览器")
  .action(async (opts) => {
    const { startUi } = await import("./ui/server.js");
    await startUi(Number(opts.port) || 7777, opts.open !== false);
  });

program
  .command("mcp")
  .description("启动 MCP server（给 Claude Code / Cursor / Codex 等 AI 工具调用）")
  .action(async () => {
    const { startMcp } = await import("./mcp.js");
    await startMcp();
  });

program.parseAsync().catch((e) => {
  console.error("错误:", (e as Error).message);
  process.exit(1);
});
