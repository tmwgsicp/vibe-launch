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

function text(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

export async function startMcp() {
  const server = new McpServer({ name: "vibe-launch", version: "0.7.0" });

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

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("vibe-launch MCP server 已启动 (stdio)");
}
