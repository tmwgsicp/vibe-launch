// vibe-launch 本地可视化操作台后端：Node http + 复用 core 函数暴露 JSON API，
// 服务内嵌的单页前端。纯本地、无账号、只监听 127.0.0.1。
import * as http from "node:http";
import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { shQuote } from "../core/sh.js";
import { loadConfig, saveConfig, addProject, getConfigPath, updateServer, removeServer, updateProject, removeProject } from "../core/config.js";
import { deploy } from "../core/deploy.js";
import { status } from "../core/status.js";
import { onboard, manualSnippet } from "../core/onboard.js";
import { setupGit } from "../core/setup-git.js";
import { getServerStats } from "../core/serverstats.js";
import { runOnServer, connectSSH, enableSshPool } from "../core/ssh.js";
import { createTunnel, type TunnelHandle } from "../core/tunnel.js";
import { getHistory } from "../core/history.js";
import { preDeploy } from "../core/predeploy.js";
import { rollback } from "../core/rollback.js";
import { runOnProject } from "../core/run.js";
import { deployFrontend } from "../core/frontend.js";
import { VERSION } from "../version.js";
import { checkExposure } from "../core/portcheck.js";
import { setupProxy, applyProxy, removeProxy, listProxy } from "../core/proxy.js";
import { browseDirs, readProjectFile, writeProjectFile, writeProjectFileBase64, listProjectDir } from "../core/files.js";
import { listContainers, removeContainer, pruneContainers, startContainer, stopContainer, inspectContainer } from "../core/containers.js";
import { fsList, fsRead, fsDownload, fsWriteB64, fsDelete, fsRename, fsMkdir } from "../core/fileops.js";
import { INDEX_HTML } from "./index-html.js";

// UI 进程内管理的活跃隧道（id -> 句柄）
const TUNNELS = new Map<string, TunnelHandle>();

/** 容器名白名单校验（HTTP 入参直拼 docker 命令前必须过这关，杜绝注入）。 */
const validCt = (n: unknown): n is string => typeof n === "string" && /^[A-Za-z0-9_.-]+$/.test(n);

function json(res: http.ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const s = Buffer.concat(chunks).toString("utf8");
  return s ? JSON.parse(s) : {};
}

function tryOpen(url: string): void {
  try {
    if (process.platform === "win32") execFile("cmd", ["/c", "start", "", url], () => {});
    else if (process.platform === "darwin") execFile("open", [url], () => {});
    else execFile("xdg-open", [url], () => {});
  } catch {
    /* 非致命 */
  }
}

export async function startUi(port = 7777, open = true): Promise<void> {
  enableSshPool(); // 长驻进程：复用 SSH 连接，翻目录/刷状态近即时

  // ── 本地操作台的安全底座 ──
  // 威胁模型（即便只监听 127.0.0.1 也真实存在）：① 你浏览器里打开的任意恶意网页可向
  // localhost:7777 发跨站请求，而 /api/run 等于在你 5 台生产机上执行任意命令 → 打穿整队；
  // ② DNS rebinding 把攻击者域名解析到 127.0.0.1 绕过同源。故：
  //   · token —— 启动时随机生成，注入页面；每个 /api/* 都要带（恶意站点读不到页面就拿不到 token）
  //   · Host 白名单 —— 只认 localhost/127.0.0.1，挡 DNS rebinding
  //   · Origin 白名单 —— 有 Origin 头时必须同源，挡 CSRF
  const TOKEN = randomBytes(24).toString("base64url");
  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  const tokenOk = (given: unknown): boolean => {
    const a = Buffer.from(String(given ?? ""));
    const b = Buffer.from(TOKEN);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url || "/", `http://localhost:${port}`).pathname;
    const q = new URL(req.url || "/", `http://localhost:${port}`).searchParams;
    try {
      // DNS-rebinding 防护：任意非本机 Host（含解析到 127.0.0.1 的攻击者域名）一律拒
      if (!allowedHosts.has((req.headers.host || "").toLowerCase())) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("forbidden host");
        return;
      }
      // /api/* 一律校验访问令牌 + 同源，挡恶意网页 CSRF / 未授权本地进程
      if (path.startsWith("/api/")) {
        const given = req.headers["x-vl-token"] ?? q.get("token") ?? ""; // header 常规，query 供 SSE/EventSource
        if (!tokenOk(given)) return json(res, 401, { error: "无效或缺失的访问令牌（请从操作台页面发起请求）" });
        const origin = req.headers.origin;
        if (origin) {
          let oh = "";
          try { oh = new URL(origin).host.toLowerCase(); } catch { /* 非法 origin，按拒绝处理 */ }
          if (!allowedHosts.has(oh)) return json(res, 403, { error: "跨站请求被拒绝" });
        }
      }
      // 静态首页（把 token 注入页面，让同源 JS 能读到；恶意跨站页面因同源策略读不到本响应体）
      if (path === "/" || path === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(INDEX_HTML.replace("%%VL_TOKEN%%", TOKEN));
        return;
      }
      // 清单
      if (path === "/api/config" && req.method === "GET") {
        const c = loadConfig();
        return json(res, 200, { servers: c.servers, projects: c.projects, _path: getConfigPath(), _version: VERSION });
      }
      // MCP 能力信息（给 AI 客户端接入用）
      if (path === "/api/mcp-info" && req.method === "GET") {
        return json(res, 200, {
          tools: [
            { name: "list_projects", desc: "列出所有服务器和可部署项目" },
            { name: "get_status", desc: "看项目状态：git 版本 + 容器 + 健康检查" },
            { name: "deploy_project", desc: "部署项目：SSH 跑部署命令 + 健康检查" },
            { name: "restart_project", desc: "重启项目容器 + 健康检查（幂等，不拉代码）" },
            { name: "add_project", desc: "登记一个部署项目" },
            { name: "onboard_server", desc: "接入新服务器：自动装公钥免密" },
            { name: "setup_git", desc: "把项目转成 git checkout + 配 deploy key" },
            { name: "get_logs", desc: "拉容器日志尾部（只读，定位异常）" },
            { name: "preview_deploy", desc: "部署前看将拉取的新提交 diff（只读）" },
            { name: "get_history", desc: "看部署 / 回滚历史（只读）" },
            { name: "get_server_stats", desc: "服务器 CPU/内存/磁盘/负载指标（只读）" },
            { name: "list_containers", desc: "列出容器含已停止（只读）" },
            { name: "check_ports", desc: "数据库端口暴露检测（只读诊断）" },
            { name: "run_command", desc: "在服务器跑任意命令，带 container 则 docker exec 进容器（AI 灵活部署的万能原语）" },
            { name: "suggest_deploy", desc: "探测项目类型，给出推荐壳子部署命令（脚手架）" },
          ],
          config: { mcpServers: { "vibe-launch": { command: "vibe-launch", args: ["mcp"] } } },
          configNpx: { mcpServers: { "vibe-launch": { command: "npx", args: ["-y", "vibe-launch", "mcp"] } } },
        });
      }
      // 状态
      if (path === "/api/status" && req.method === "GET") {
        const c = loadConfig();
        const proj = q.get("project");
        const names = proj ? [proj] : Object.keys(c.projects);
        // 并行 + 单项隔离：一个项目连不上/超时不再拖垮整个状态接口（旧的 for-await 串行会被卡死的项目吊死）
        const settled = await Promise.allSettled(names.map((n) => status(c, n)));
        const out = settled.map((r, i) =>
          r.status === "fulfilled"
            ? r.value
            : { project: names[i], reachable: false, error: String((r.reason && r.reason.message) || r.reason) }
        );
        return json(res, 200, out);
      }
      // 服务器指标（CPU/内存/磁盘/容器）
      if (path === "/api/server-stats" && req.method === "GET") {
        const c = loadConfig();
        const name = q.get("server");
        if (!name || !c.servers[name]) return json(res, 404, { error: "server not found" });
        return json(res, 200, await getServerStats(c.servers[name]));
      }
      // 部署（记历史）。?frontend=1 走前端一体部署；?dryRun=1 只返回执行计划（含钩子）
      if (path.startsWith("/api/deploy/") && req.method === "POST") {
        const name = decodeURIComponent(path.slice("/api/deploy/".length));
        if (q.get("frontend") === "1") return json(res, 200, { __frontend: true, ...(await deployFrontend(loadConfig(), name)) });
        const r = await deploy(loadConfig(), name, { dryRun: q.get("dryRun") === "1" }); // 历史已在 core deploy() 内记录
        return json(res, 200, r);
      }
      // 穿透执行：在项目所在服务器跑即席命令（container 则 docker exec 进容器）
      if (path.startsWith("/api/run/") && req.method === "POST") {
        const name = decodeURIComponent(path.slice("/api/run/".length));
        const b = await readBody(req);
        const r = await runOnProject(loadConfig(), name, b.command || "", {
          container: b.container || undefined,
          cwd: b.cwd || undefined,
          timeoutMs: Math.min(600, Math.max(1, Number(b.timeout) || 120)) * 1000,
        });
        return json(res, 200, r);
      }
      // 部署历史
      if (path === "/api/history" && req.method === "GET") {
        return json(res, 200, getHistory(q.get("project") || undefined, 20));
      }
      // 回滚到指定版本
      if (path.startsWith("/api/rollback/") && req.method === "POST") {
        const name = decodeURIComponent(path.slice("/api/rollback/".length));
        const b = await readBody(req);
        const r = await rollback(loadConfig(), name, b.rev); // 历史已在 core rollback() 内记录
        return json(res, 200, r);
      }
      // 部署前预览：将拉取的新提交
      if (path === "/api/predeploy" && req.method === "GET") {
        const name = q.get("project");
        if (!name) return json(res, 400, { error: "需要 project" });
        return json(res, 200, await preDeploy(loadConfig(), name));
      }
      // 浏览服务器目录（选部署目录用）
      if (path === "/api/browse" && req.method === "GET") {
        const c = loadConfig();
        const sv = q.get("server");
        if (!sv) return json(res, 400, { error: "需要 server" });
        return json(res, 200, await browseDirs(c, sv, q.get("path") || undefined));
      }
      // 项目目录浏览（根锁在 project.dir，可进子目录）
      if (path === "/api/project-dir" && req.method === "GET") {
        const name = q.get("project");
        if (!name) return json(res, 400, { error: "需要 project" });
        return json(res, 200, await listProjectDir(loadConfig(), name, q.get("rel") || undefined));
      }
      // 上传文件（二进制安全，收 base64）到项目目录树内
      if (path === "/api/project-upload" && req.method === "PUT") {
        const b = await readBody(req);
        if (!b.project || !b.name) return json(res, 400, { error: "需要 project + name" });
        return json(res, 200, await writeProjectFileBase64(loadConfig(), b.project, b.name, b.b64 || ""));
      }
      // 项目目录内的文件：读 / 写（约束在项目 dir 树内）
      if (path === "/api/project-file" && req.method === "GET") {
        const name = q.get("project"), file = q.get("name");
        if (!name || !file) return json(res, 400, { error: "需要 project + name" });
        return json(res, 200, await readProjectFile(loadConfig(), name, file));
      }
      if (path === "/api/project-file" && req.method === "PUT") {
        const b = await readBody(req);
        if (!b.project || !b.name) return json(res, 400, { error: "需要 project + name" });
        return json(res, 200, await writeProjectFile(loadConfig(), b.project, b.name, b.content || ""));
      }
      // 数据库端口暴露检测
      if (path === "/api/port-exposure" && req.method === "GET") {
        const c = loadConfig();
        const name = q.get("server");
        if (!name || !c.servers[name]) return json(res, 404, { error: "server not found" });
        return json(res, 200, await checkExposure(c, name));
      }
      // 容器日志
      if (path === "/api/container-logs" && req.method === "GET") {
        const c = loadConfig();
        const sv = q.get("server"), ct = q.get("container"), tail = parseInt(q.get("tail") || "120", 10) || 120;
        if (!sv || !c.servers[sv] || !validCt(ct)) return json(res, 400, { error: "需要 server + 合法容器名" });
        const r = await runOnServer(c.servers[sv], `docker logs --tail ${tail} --timestamps ${shQuote(ct)} 2>&1 | tail -2000`);
        return json(res, 200, { logs: r.stdout || r.stderr || "(无输出)" });
      }
      // 容器日志：实时流（SSE，docker logs -f 经 SSH exec 推送）
      if (path === "/api/container-logs/stream" && req.method === "GET") {
        const c = loadConfig();
        const sv = q.get("server"), ct = q.get("container"), tail = parseInt(q.get("tail") || "200", 10) || 200;
        if (!sv || !c.servers[sv] || !validCt(ct)) return json(res, 400, { error: "需要 server + 合法容器名" });
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const ssh = await connectSSH(c.servers[sv]);
        const conn = (ssh as any).connection;
        const send = (chunk: Buffer) => {
          for (const line of chunk.toString("utf8").split(/\r?\n/)) {
            if (line.length) res.write(`data: ${line.replace(/\r/g, "")}\n\n`);
          }
        };
        let cleaned = false;
        const cleanup = () => { if (cleaned) return; cleaned = true; try { ssh.dispose(); } catch { /* ignore */ } };
        conn.exec(
          `docker logs -f --tail ${tail} --timestamps ${shQuote(ct)} 2>&1`,
          (err: Error | undefined, stream: any) => {
            if (err) { res.write(`data: [错误] ${err.message}\n\n`); res.end(); cleanup(); return; }
            stream.on("data", send);
            stream.stderr.on("data", send);
            stream.on("close", () => { res.end(); cleanup(); });
          }
        );
        req.on("close", () => { cleanup(); });
        return;
      }
      // 容器重启
      if (path === "/api/container-restart" && req.method === "POST") {
        const b = await readBody(req), c = loadConfig();
        if (!b.server || !c.servers[b.server] || !validCt(b.container)) return json(res, 400, { error: "需要 server + 合法容器名" });
        const r = await runOnServer(c.servers[b.server], `docker restart ${shQuote(b.container)}`);
        return json(res, r.code === 0 ? 200 : 500, { ok: r.code === 0, output: (r.stdout || r.stderr).trim() });
      }
      // 容器列表（含已停止）
      if (path === "/api/containers" && req.method === "GET") {
        const c = loadConfig();
        const sv = q.get("server");
        if (!sv || !c.servers[sv]) return json(res, 404, { error: "server not found" });
        return json(res, 200, await listContainers(c, sv));
      }
      // 启动已停止的容器
      if (path === "/api/container-start" && req.method === "POST") {
        const b = await readBody(req), c = loadConfig();
        if (!b.server || !c.servers[b.server] || !b.container) return json(res, 400, { error: "需要 server + container" });
        return json(res, 200, await startContainer(c, b.server, b.container));
      }
      // 停止运行中的容器
      if (path === "/api/container-stop" && req.method === "POST") {
        const b = await readBody(req), c = loadConfig();
        if (!b.server || !c.servers[b.server] || !b.container) return json(res, 400, { error: "需要 server + container" });
        return json(res, 200, await stopContainer(c, b.server, b.container));
      }
      // 容器详情（inspect）
      if (path === "/api/container-inspect" && req.method === "GET") {
        const c = loadConfig();
        const sv = q.get("server"), ct = q.get("container");
        if (!sv || !c.servers[sv] || !ct) return json(res, 400, { error: "需要 server + container" });
        return json(res, 200, await inspectContainer(c, sv, ct));
      }
      // 删除单个容器（不强删运行中的）
      if (path === "/api/container-remove" && req.method === "POST") {
        const b = await readBody(req), c = loadConfig();
        if (!b.server || !c.servers[b.server] || !b.container) return json(res, 400, { error: "需要 server + container" });
        return json(res, 200, await removeContainer(c, b.server, b.container));
      }
      // 一键清理已停止容器
      if (path === "/api/container-prune" && req.method === "POST") {
        const b = await readBody(req), c = loadConfig();
        if (!b.server || !c.servers[b.server]) return json(res, 400, { error: "需要 server" });
        return json(res, 200, await pruneContainers(c, b.server));
      }
      // ── 通用文件管理（server + 绝对路径）──
      if (path === "/api/fs/list" && req.method === "GET") {
        const c = loadConfig(), sv = q.get("server");
        if (!sv || !c.servers[sv]) return json(res, 404, { error: "server not found" });
        return json(res, 200, await fsList(c, sv, q.get("path") || undefined));
      }
      if (path === "/api/fs/read" && req.method === "GET") {
        const c = loadConfig(), sv = q.get("server"), p = q.get("path");
        if (!sv || !c.servers[sv] || !p) return json(res, 400, { error: "需要 server + path" });
        return json(res, 200, await fsRead(c, sv, p));
      }
      if (path === "/api/fs/download" && req.method === "GET") {
        const c = loadConfig(), sv = q.get("server"), p = q.get("path");
        if (!sv || !c.servers[sv] || !p) return json(res, 400, { error: "需要 server + path" });
        return json(res, 200, await fsDownload(c, sv, p));
      }
      if (path === "/api/fs/write" && req.method === "PUT") {
        const b = await readBody(req), c = loadConfig();
        if (!b.server || !c.servers[b.server] || !b.path) return json(res, 400, { error: "需要 server + path" });
        return json(res, 200, await fsWriteB64(c, b.server, b.path, b.b64 || ""));
      }
      if (path === "/api/fs/delete" && req.method === "POST") {
        const b = await readBody(req), c = loadConfig();
        if (!b.server || !c.servers[b.server] || !b.path) return json(res, 400, { error: "需要 server + path" });
        return json(res, 200, await fsDelete(c, b.server, b.path));
      }
      if (path === "/api/fs/rename" && req.method === "POST") {
        const b = await readBody(req), c = loadConfig();
        if (!b.server || !c.servers[b.server] || !b.path || !b.dest) return json(res, 400, { error: "需要 server + path + dest" });
        return json(res, 200, await fsRename(c, b.server, b.path, b.dest));
      }
      if (path === "/api/fs/mkdir" && req.method === "POST") {
        const b = await readBody(req), c = loadConfig();
        if (!b.server || !c.servers[b.server] || !b.path) return json(res, 400, { error: "需要 server + path" });
        return json(res, 200, await fsMkdir(c, b.server, b.path));
      }
      // 隧道：列表 / 开 / 关（UI 进程内管理）
      if (path === "/api/tunnels" && req.method === "GET") {
        return json(res, 200, [...TUNNELS.entries()].map(([id, t]) => ({
          id, target: t.target, service: t.service, localPort: t.localPort,
          remoteHost: t.remoteHost, remotePort: t.remotePort, serverHost: t.serverHost,
        })));
      }
      if (path === "/api/tunnel/start" && req.method === "POST") {
        const b = await readBody(req);
        const h = await createTunnel(loadConfig(), {
          target: b.target, service: b.service, remoteHost: b.remoteHost,
          remotePort: b.remotePort, localPort: b.localPort,
        });
        const id = `${b.target}:${h.localPort}`;
        TUNNELS.set(id, h);
        return json(res, 200, { id, localPort: h.localPort, remoteHost: h.remoteHost, remotePort: h.remotePort });
      }
      if (path === "/api/tunnel/stop" && req.method === "POST") {
        const b = await readBody(req), t = TUNNELS.get(b.id);
        if (t) { t.close(); TUNNELS.delete(b.id); }
        return json(res, 200, { ok: true });
      }
      // 手动/扫码接入：生成"贴进控制台装公钥"的命令（不连服务器；host 无关，只装本工具公钥）
      if (path === "/api/server/manual-snippet" && req.method === "POST") {
        const b = await readBody(req);
        return json(res, 200, manualSnippet(b.identityFile || undefined));
      }
      // 接入服务器
      if (path === "/api/server" && req.method === "POST") {
        const b = await readBody(req);
        const r = await onboard(b);
        return json(res, 200, r);
      }
      // 编辑服务器（改备注/字段/别名，别名变更级联项目）
      if (path.startsWith("/api/server/") && req.method === "PATCH") {
        const name = decodeURIComponent(path.slice("/api/server/".length));
        const b = await readBody(req);
        const c = loadConfig();
        updateServer(c, name, {
          host: b.host, user: b.user, port: b.port, note: b.note, identityFile: b.identityFile,
        }, b.newName);
        const p = saveConfig(c);
        return json(res, 200, { ok: true, path: p });
      }
      // 删除服务器
      if (path.startsWith("/api/server/") && req.method === "DELETE") {
        const name = decodeURIComponent(path.slice("/api/server/".length));
        const c = loadConfig();
        removeServer(c, name);
        return json(res, 200, { ok: true, path: saveConfig(c) });
      }
      // 编辑项目
      if (path.startsWith("/api/project/") && req.method === "PATCH") {
        const name = decodeURIComponent(path.slice("/api/project/".length));
        const b = await readBody(req);
        const c = loadConfig();
        updateProject(c, name, {
          server: b.server, dir: b.dir, deploy: b.deploy, containers: b.containers, restartCmd: b.restartCmd, health: b.health, proxy: b.proxy,
        }, b.newName);
        return json(res, 200, { ok: true, path: saveConfig(c) });
      }
      // 删除项目
      if (path.startsWith("/api/project/") && req.method === "DELETE") {
        const name = decodeURIComponent(path.slice("/api/project/".length));
        const c = loadConfig();
        removeProject(c, name);
        return json(res, 200, { ok: true, path: saveConfig(c) });
      }
      // 登记项目
      if (path === "/api/project" && req.method === "POST") {
        const b = await readBody(req);
        const c = loadConfig();
        addProject(c, b.name, {
          server: b.server,
          dir: b.dir,
          deploy: b.deploy,
          containers: b.containers,
          restartCmd: b.restartCmd,
          health: b.health,
          proxy: b.proxy || undefined,
        });
        const p = saveConfig(c);
        return json(res, 200, { ok: true, path: p });
      }
      // 反代（Caddy）：装/接线 / 应用站点 / 下线 / 列站点
      if (path.startsWith("/api/proxy/setup/") && req.method === "POST") {
        const server = decodeURIComponent(path.slice("/api/proxy/setup/".length));
        const b = await readBody(req);
        return json(res, 200, await setupProxy(loadConfig(), server, { caddyUrl: b.caddyUrl || undefined }));
      }
      if (path.startsWith("/api/proxy/apply/") && req.method === "POST") {
        const name = decodeURIComponent(path.slice("/api/proxy/apply/".length));
        return json(res, 200, await applyProxy(loadConfig(), name));
      }
      if (path.startsWith("/api/proxy/rm/") && req.method === "POST") {
        const name = decodeURIComponent(path.slice("/api/proxy/rm/".length));
        return json(res, 200, await removeProxy(loadConfig(), name));
      }
      if (path === "/api/proxy/ls" && req.method === "GET") {
        const c = loadConfig(), sv = q.get("server");
        if (!sv || !c.servers[sv]) return json(res, 404, { error: "server not found" });
        return json(res, 200, await listProxy(c, sv));
      }
      // 转 git checkout
      if (path.startsWith("/api/setup-git/") && req.method === "POST") {
        const name = decodeURIComponent(path.slice("/api/setup-git/".length));
        const b = await readBody(req);
        const r = await setupGit(loadConfig(), {
          project: name,
          repo: b.repo,
          branch: b.branch,
          adopt: b.adopt,
          token: b.token,
        });
        return json(res, 200, r);
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 500, { error: (e as Error).message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  const url = `http://localhost:${port}`;
  console.log(`🚀 vibe-launch 操作台：${url}`);
  console.log(`   纯本地、只监听 127.0.0.1。Ctrl+C 关闭。`);
  if (open) tryOpen(url);

  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => {
      server.close();
      resolve();
    });
  });
}
