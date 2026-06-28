// MCP server：把部署能力暴露给 Claude Code / Cursor / Codex 等 AI 工具
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, saveConfig, addProject } from "./core/config.js";
import { deploy } from "./core/deploy.js";
import { restart } from "./core/restart.js";
import { status } from "./core/status.js";
import { onboard } from "./core/onboard.js";
import { setupGit } from "./core/setup-git.js";
import { getHistory } from "./core/history.js";
import { preDeploy } from "./core/predeploy.js";
import { checkExposure } from "./core/portcheck.js";
import { getServerStats } from "./core/serverstats.js";
import { listContainers, getContainerLogs } from "./core/containers.js";
import { enableSshPool, runOnServer } from "./core/ssh.js";
import { suggestDeploy } from "./core/scaffold.js";
import { VERSION } from "./version.js";

function text(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

export async function startMcp() {
  enableSshPool(); // 长驻进程：复用 SSH 连接
  const server = new McpServer({ name: "vibe-launch", version: VERSION });

  server.tool(
    "list_projects",
    "列出所有可部署的项目和服务器（清单）",
    async () => text({ servers: loadConfig().servers, projects: loadConfig().projects })
  );

  server.tool(
    "deploy_project",
    "部署指定项目：SSH 到它所在服务器，跑配置好的部署命令，再做健康检查。返回成功与否、输出、git 版本、健康检查结果。",
    { project: z.string().describe("项目名，见 list_projects") },
    async ({ project }) => {
      const r = await deploy(loadConfig(), project);
      return { ...text(r), isError: !r.success };
    }
  );

  server.tool(
    "restart_project",
    "重启项目配置的容器（docker restart）再做健康检查。只重启、不拉代码、不构建 —— 幂等安全。用于容器假死、改了 .env/配置要重新加载。返回每个容器的重启结果 + 健康检查。",
    { project: z.string().describe("项目名，见 list_projects") },
    async ({ project }) => {
      const r = await restart(loadConfig(), project);
      return { ...text(r), isError: !r.success };
    }
  );

  server.tool(
    "get_status",
    "看项目当前状态：git 版本 + 容器状态 + 健康检查。省略 project 则看全部。",
    { project: z.string().optional().describe("项目名；省略看全部") },
    async ({ project }) => {
      const c = loadConfig();
      const names = project ? [project] : Object.keys(c.projects);
      const out = [];
      for (const n of names) out.push(await status(c, n));
      return text(out);
    }
  );

  server.tool(
    "add_project",
    "登记一个部署项目：部署到哪台服务器、用什么命令部署、容器名、健康检查 URL。",
    {
      name: z.string().describe("项目名"),
      server: z.string().describe("部署到哪台服务器的别名（需先 onboard_server）"),
      deploy: z.string().describe("部署命令（服务器上跑），如 'git pull && docker restart x'"),
      dir: z.string().optional().describe("服务器上的工作目录"),
      containers: z.array(z.string()).optional().describe("容器名列表"),
      health: z.array(z.string()).optional().describe("健康检查 URL 列表"),
    },
    async ({ name, ...proj }) => {
      const c = loadConfig();
      addProject(c, name, proj);
      const path = saveConfig(c);
      return text({ ok: true, name, path });
    }
  );

  server.tool(
    "onboard_server",
    "接入一台新服务器：自动把本地公钥装上去（之后免密 SSH）+ 可选创建部署用户 + 写进清单。",
    {
      alias: z.string().describe("给服务器起的别名"),
      host: z.string().describe("IP/域名"),
      user: z.string().default("root").describe("初次登录用户"),
      password: z.string().optional().describe("初次登录密码（一次性装公钥用；不填则用现有 key）"),
      port: z.number().optional().describe("SSH 端口，默认 22"),
      deployUser: z.string().optional().describe("顺便创建的专用部署用户"),
      auth: z.enum(["key", "password"]).optional().describe("认证方式：key=装钥匙免密(推荐)，password=存密码"),
      note: z.string().optional().describe("备注，如 海外/国内"),
    },
    async (args) => {
      const r = await onboard(args);
      return { ...text(r), isError: !r.success };
    }
  );

  server.tool(
    "setup_git",
    "把项目目录在服务器上转成 git checkout：装 git + 生成专用 deploy key + 用本地 gh 把 key 加到 GitHub 仓库(只读) + 配好免密拉取。之后该项目就能 git pull 部署。需要项目已配 dir，且本地 gh 已登录。",
    {
      project: z.string().describe("项目名（需先 add_project 且配了 dir）"),
      repo: z.string().describe("GitHub 仓库：owner/repo 或完整 git URL"),
      branch: z.string().optional().describe("分支，默认 main"),
      adopt: z
        .boolean()
        .optional()
        .describe("目录非空且非 git 时先备份再转换（用仓库覆盖被跟踪文件，保留 .env/.output 等未跟踪文件）"),
      token: z
        .string()
        .optional()
        .describe("GitHub PAT（替代 gh；需 repo / Administration:write 权限。也可设环境变量 GITHUB_TOKEN）"),
    },
    async ({ project, repo, branch, adopt, token }) => {
      const r = await setupGit(loadConfig(), { project, repo, branch, adopt, token });
      return { ...text(r), isError: !r.success };
    }
  );

  // ── 只读诊断工具：让 AI 看见操作台能看到的数据，形成"部署→查健康→读日志→决策"闭环 ──
  server.tool(
    "get_logs",
    "拉某容器的日志尾部（只读）。健康检查失败、容器异常时用它定位原因。",
    {
      server: z.string().describe("服务器别名，见 list_projects"),
      container: z.string().describe("容器名"),
      tail: z.number().optional().describe("行数，默认 200，最多 2000"),
    },
    async ({ server, container, tail }) => {
      try { return text(await getContainerLogs(loadConfig(), server, container, tail ?? 200)); }
      catch (e) { return { ...text({ error: (e as Error).message }), isError: true }; }
    }
  );

  server.tool(
    "preview_deploy",
    "部署前预览：列出本次部署将拉取的新提交（git fetch 后比对，只读、不动工作区）。决定要不要部署前用。",
    { project: z.string().describe("项目名，见 list_projects") },
    async ({ project }) => {
      try { return text(await preDeploy(loadConfig(), project)); }
      catch (e) { return { ...text({ error: (e as Error).message }), isError: true }; }
    }
  );

  server.tool(
    "get_history",
    "看部署 / 回滚历史（只读）。省略 project 看全部。",
    {
      project: z.string().optional().describe("项目名；省略看全部"),
      limit: z.number().optional().describe("条数，默认 20"),
    },
    async ({ project, limit }) => text(getHistory(project, limit ?? 20))
  );

  server.tool(
    "get_server_stats",
    "看服务器实时指标：CPU / 内存 / 磁盘 / 负载 / 容器数 / 运行时长（只读，一次 SSH 采集）。",
    { server: z.string().describe("服务器别名") },
    async ({ server }) => {
      const c = loadConfig();
      if (!c.servers[server]) return { ...text({ error: `服务器 ${server} 不存在` }), isError: true };
      return text(await getServerStats(c.servers[server]));
    }
  );

  server.tool(
    "list_containers",
    "列出服务器上全部容器（含已停止），看状态 / 镜像（只读）。",
    { server: z.string().describe("服务器别名") },
    async ({ server }) => {
      try { return text(await listContainers(loadConfig(), server)); }
      catch (e) { return { ...text({ error: (e as Error).message }), isError: true }; }
    }
  );

  server.tool(
    "check_ports",
    "检测服务器上的数据库端口（PG / Redis / MySQL / Mongo / SQL Server）是否暴露公网（只读诊断，含针对性关闭指引）。",
    { server: z.string().describe("服务器别名") },
    async ({ server }) => {
      try { return text(await checkExposure(loadConfig(), server)); }
      catch (e) { return { ...text({ error: (e as Error).message }), isError: true }; }
    }
  );

  server.tool(
    "suggest_deploy",
    "探测服务器上某目录的项目类型（VitePress / Nuxt / Next / Python / Node / 静态），返回推荐的「壳子」部署命令 + 端口 + 健康检查 + 注意事项。部署新项目前先用它拿起点，可改后传给 add_project。基础镜像复用，不 docker build/拉镜像。",
    {
      server: z.string().describe("服务器别名"),
      dir: z.string().describe("服务器上的项目目录（已 clone/setup-git）"),
      name: z.string().optional().describe("项目/容器名，默认 app"),
      port: z.number().optional().describe("对外端口，默认 8080"),
    },
    async ({ server, dir, name, port }) => {
      const c = loadConfig();
      if (!c.servers[server]) return { ...text({ error: `服务器 ${server} 不存在` }), isError: true };
      try { return text(await suggestDeploy(c, server, dir, name || "app", port || 8080)); }
      catch (e) { return { ...text({ error: (e as Error).message }), isError: true }; }
    }
  );

  // ── 万能原语：在服务器上跑任意命令 ──
  // AI 原生的关键。结构化动词覆盖常见安全操作，但部署的长尾（探测环境 / 构建 / 起容器 /
  // 排障 / 改配置）千变万化，不可能都预设成工具。给 AI 一个直接执行命令的原语，它就能
  // 像人一样灵活把项目部署起来，而不是被死板的预设框住。强大且有副作用，AI 应按需谨慎用。
  server.tool(
    "run_command",
    "在指定服务器上执行任意 shell 命令，返回 stdout/stderr/退出码。这是灵活部署的万能原语：" +
      "探测环境(docker ps/inspect、ls、检查端口)、构建、起/改容器、看配置、排障等结构化工具没覆盖的，都用它。" +
      "有副作用、权限大，请明确目的后再用；只读探测随意，破坏性操作(删除/重启线上)要谨慎。",
    {
      server: z.string().describe("服务器别名，见 list_projects"),
      command: z.string().describe("要在服务器上执行的 shell 命令"),
      cwd: z.string().optional().describe("工作目录（可选）"),
      timeout: z.number().optional().describe("超时秒数，默认 120；构建类可调大，最多 600"),
    },
    async ({ server, command, cwd, timeout }) => {
      const c = loadConfig();
      if (!c.servers[server]) return { ...text({ error: `服务器 ${server} 不存在` }), isError: true };
      const tmo = Math.min(600, Math.max(1, timeout ?? 120)) * 1000;
      try {
        const r = await runOnServer(c.servers[server], command, cwd, tmo);
        return { ...text({ code: r.code, stdout: r.stdout, stderr: r.stderr }), isError: r.code !== 0 };
      } catch (e) {
        return { ...text({ error: (e as Error).message }), isError: true };
      }
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("vibe-launch MCP server 已启动 (stdio)");
}
