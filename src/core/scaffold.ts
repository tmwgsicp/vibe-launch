// 部署脚手架：探测服务器上某目录的项目类型，给出推荐的「壳子」部署命令 + 端口 + 健康检查。
// 不是死板模板——是给 AI/用户的起点建议，可直接用也可改。把本会话验证过的几种部署模式沉淀进工具，
// 让弱一点的 AI 或普通用户也能部署，而不必现编 docker run。
import type { Config } from "./types.js";
import { getServerOf } from "./config.js";
import { runOnServer } from "./ssh.js";

const q = (s: string) => JSON.stringify(s);

export interface ScaffoldResult {
  type: string;                 // vitepress / nuxt / next / python / node / static / dockerfile / unknown
  port: number;
  deploy: string;               // 推荐部署命令（壳子；基础镜像复用，无需 docker build/拉镜像）
  health: string[];
  containers: string[];
  notes: string[];
}

export async function suggestDeploy(
  config: Config,
  serverName: string,
  dir: string,
  name: string,
  port = 8080
): Promise<ScaffoldResult> {
  const server = getServerOf(config, serverName);
  const probe = await runOnServer(
    server,
    [
      `cd ${q(dir)} 2>/dev/null || { echo NODIR; exit 0; }`,
      `echo "PKG:$([ -f package.json ] && (cat package.json | tr -d '\\n' | head -c 1800))"`,
      `echo "REQ:$([ -f requirements.txt ] && echo yes)"`,
      `echo "ENTRY:$([ -f app.py ] && echo app.py || ([ -f main.py ] && echo main.py))"`,
      `echo "DOCKER:$([ -f Dockerfile ] && echo yes)"`,
      `echo "HTML:$([ -f index.html ] && echo yes)"`,
    ].join("; ")
  );
  const out = probe.stdout || "";
  if (out.includes("NODIR")) {
    return { type: "unknown", port, deploy: "", health: [], containers: [name], notes: [`目录 ${dir} 不存在（先 setup-git/clone 把代码放进去）`] };
  }
  const pick = (p: string) => (out.split("\n").find((l) => l.startsWith(p)) || "").slice(p.length).trim();
  const pkgRaw = pick("PKG:");
  const hasReq = pick("REQ:") === "yes";
  const entry = pick("ENTRY:");
  const hasDocker = pick("DOCKER:") === "yes";
  const hasHtml = pick("HTML:") === "yes";
  let pkg: any = null;
  try { pkg = pkgRaw ? JSON.parse(pkgRaw) : null; } catch { /* 截断/非法就当没有 */ }
  const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};
  const scripts = (pkg && pkg.scripts) || {};
  const cnNote = "国内服务器在 npm install 前加 `npm config set registry https://registry.npmmirror.com &&`（海外免）；python 同理可用清华源。";
  const portNote = `确认端口 ${port} 没被占用：run_command \`ss -ltn | grep :${port}\``;

  const NODE = "node:20-alpine";
  const buildServe = (buildCmd: string, serveRun: string) =>
    `git pull --ff-only && docker run --rm -v ${dir}:/app -w /app ${NODE} sh -lc '${buildCmd}' && docker rm -f ${name} 2>/dev/null; ${serveRun}`;

  // VitePress（静态）
  if (deps.vitepress || Object.values(scripts).some((s) => String(s).includes("vitepress"))) {
    return {
      type: "vitepress", port, containers: [name], health: [`http://127.0.0.1:${port}`],
      deploy: buildServe(
        "npm install && npm run docs:build",
        `docker run -d --name ${name} --restart unless-stopped -v ${dir}:/app -w /app -p ${port}:${port} ${NODE} sh -lc 'npm run docs:serve -- --port ${port} --host 0.0.0.0'`
      ),
      notes: ["VitePress 静态站：容器内构建 + vitepress serve，零 docker build。", cnNote, portNote],
    };
  }
  // Nuxt（SSR）
  if (deps.nuxt) {
    return {
      type: "nuxt", port, containers: [name], health: [`http://127.0.0.1:${port}`],
      deploy: buildServe(
        "npm install && npm run build",
        `docker run -d --name ${name} --restart unless-stopped -e PORT=${port} -e HOST=0.0.0.0 -v ${dir}:/app -w /app -p ${port}:${port} ${NODE} node .output/server/index.mjs`
      ),
      notes: ["Nuxt SSR：构建出 .output，node 跑 Nitro server。", cnNote, portNote],
    };
  }
  // Next（SSR）
  if (deps.next) {
    return {
      type: "next", port, containers: [name], health: [`http://127.0.0.1:${port}`],
      deploy: buildServe(
        "npm install && npm run build",
        `docker run -d --name ${name} --restart unless-stopped -e PORT=${port} -v ${dir}:/app -w /app -p ${port}:${port} ${NODE} npm run start`
      ),
      notes: ["Next.js SSR：next build 后 next start（读 PORT）。", cnNote, portNote],
    };
  }
  // Python（FastAPI/Flask 等：requirements + 入口）
  if (hasReq && entry) {
    return {
      type: "python", port, containers: [name], health: [`http://127.0.0.1:${port}/healthz`],
      deploy:
        `git pull --ff-only && docker run --rm -v ${dir}:/app -w /app python:3.12 sh -lc 'pip install --no-cache-dir --target=/app/.pydeps -r requirements.txt' && docker rm -f ${name} 2>/dev/null; ` +
        `docker run -d --name ${name} --restart unless-stopped -p 127.0.0.1:${port}:${port} -e PYTHONPATH=/app/.pydeps -v ${dir}:/app -w /app python:3.12 python ${entry}`,
      notes: [
        `Python 壳子：pip 装到挂载目录 /app/.pydeps（PYTHONPATH 复用，不每次重装），跑 ${entry}。`,
        "需要 .env：用 run_command 写到项目目录（gitignore 不会带）。健康检查路径按实际改（默认猜 /healthz）。",
        "若连 PostgreSQL 且服务器是老 docker：PG 容器要加 `--security-opt seccomp=unconfined`，否则写 WAL 报 Operation not permitted。",
        "DB 连接串里密码含 `@` 要转义成 `%40`。", portNote,
      ],
    };
  }
  // 通用 Node（有 start 脚本）
  if (pkg && (scripts.start || deps.express || deps.fastify)) {
    return {
      type: "node", port, containers: [name], health: [`http://127.0.0.1:${port}`],
      deploy: buildServe(
        "npm install",
        `docker run -d --name ${name} --restart unless-stopped -e PORT=${port} -v ${dir}:/app -w /app -p ${port}:${port} ${NODE} npm start`
      ),
      notes: ["通用 Node：npm install 后 npm start（应用需读 PORT 环境变量监听）。", cnNote, portNote],
    };
  }
  // 纯静态（有 index.html、无 package.json）
  if (hasHtml) {
    return {
      type: "static", port, containers: [name], health: [`http://127.0.0.1:${port}`],
      deploy: `git pull --ff-only 2>/dev/null; docker rm -f ${name} 2>/dev/null; docker run -d --name ${name} --restart unless-stopped -v ${dir}:/usr/share/nginx/html:ro -p ${port}:80 nginx:alpine`,
      notes: ["纯静态：nginx:alpine 挂载目录直接服务（一次性拉 nginx 镜像）。", portNote],
    };
  }
  // 有 Dockerfile 但没匹配上：提示用 Dockerfile（注意会 build/拉镜像，是你想避免的）
  if (hasDocker) {
    return {
      type: "dockerfile", port, containers: [name], health: [`http://127.0.0.1:${port}`],
      deploy: `git pull --ff-only && docker build -t ${name}-img . && docker rm -f ${name} 2>/dev/null; docker run -d --name ${name} --restart unless-stopped -p ${port}:${port} ${name}-img`,
      notes: ["只识别到 Dockerfile：用 docker build——注意这会拉基础镜像/构建，正是壳子模式想避免的；能换成上面的挂载式更好。", portNote],
    };
  }
  return { type: "unknown", port, deploy: "", health: [], containers: [name], notes: ["没识别出项目类型，用 run_command 看下目录结构再手配部署命令。"] };
}
