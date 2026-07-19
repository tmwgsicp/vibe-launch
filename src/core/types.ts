// vibe-launch 数据模型

export interface ServerConfig {
  host: string;
  user: string;
  port?: number;
  /** key 认证：私钥路径（支持 ~ 展开）；不填则用专用 key / agent */
  identityFile?: string;
  /** 密码认证：明文密码（存本地 gitignore 的配置里）。key 更安全，二选一。 */
  password?: string;
  /** 备注，如 海外/国内、用途 */
  note?: string;
  /** 国内网络优化：为这台机预设镜像源，配一次即持久化。
   *  docker → docker-mirror 默认取用；caddyUrl → proxy setup 默认取用（省得每次命令行传）。 */
  mirrors?: { docker?: string[]; caddyUrl?: string };
}

export interface ProjectConfig {
  /** 引用 servers 里的 key */
  server: string;
  /** 服务器上的工作目录，部署前 cd 进来 */
  dir?: string;
  /** 可插拔的部署命令（在服务器上跑），如 "git pull && docker restart xxx" */
  deploy: string;
  /** 健康检查 URL（在服务器本地 curl，如 http://127.0.0.1:8001/api/health） */
  health?: string[];
  /** 涉及的容器名，用于 status 看 docker ps */
  containers?: string[];
  /**
   * 非容器项目（systemd / 裸进程 / venv）的重启命令，在 dir 内跑，如 "sudo systemctl restart ir-worker ir-worker-api"。
   * 没配 containers 时，restart / env set --restart / rollback 会走它来重启，让 systemd 项目不再是二等公民。
   * 配了 containers 则以 containers 为准（docker restart），此字段忽略。
   */
  restartCmd?: string;
  /** 部署命令超时（秒）。含构建（npm install / vitepress build / docker build）的部署会久，默认 600s。 */
  deployTimeout?: number;
  /** 部署前钩子（deploy 命令前跑，在 dir 内，逐条串行）：DB 迁移 / 备份 / 建索引。任一失败即中止，不部署。 */
  preDeploy?: string[];
  /** 部署后钩子（deploy 命令成功后跑，在 dir 内，逐条串行）：烟测 / 额外校验。失败即判部署失败。 */
  postDeploy?: string[];
  /** 前端一体部署（vl deploy --frontend）：本地 build → 传产物 → 原子替换 → 重启 web。 */
  frontend?: FrontendConfig;
  /** vl env set 默认改的 .env 绝对路径（不填则用 <dir>/.env）。 */
  envFile?: string;
  /** 反代（vl proxy）：声明"域名 → 上游"，vibe-launch 生成 Caddy 站点块 + reload。裸机 Caddy 独占 80/443。 */
  proxy?: ProxyConfig;
}

export interface ProxyConfig {
  /** 对外域名，如 app.example.com；多个用空格分隔（Caddy 站点地址原生支持）。 */
  domain: string;
  /** 上游地址（vibe-launch 反代到这里），host:port，如 127.0.0.1:8000。 */
  upstream: string;
  /** 自动 HTTPS：true(默认)则 Caddy 自动签发/续期 Let's Encrypt 证书；false 则只听 http。 */
  tls?: boolean;
}

export interface FrontendConfig {
  /** 本地构建命令（在你自己机器上跑），如 "npm run build"。不填则跳过构建、直接传现成产物。 */
  build?: string;
  /** 跑 build / 找 dist 的本地根目录，默认当前工作目录。 */
  cwd?: string;
  /** 本地构建产物目录（相对 cwd 或绝对），如 ".output/public" / "dist"。 */
  dist: string;
  /** 服务器上的目标目录（绝对路径）：产物上传后原子替换到这里。 */
  target: string;
  /** 换完产物后要重启的容器（如 web / nginx）。 */
  restart?: string[];
}

export interface Config {
  servers: Record<string, ServerConfig>;
  projects: Record<string, ProjectConfig>;
}

export interface PreflightCheck {
  name: string;
  ok: boolean;
  blocker: boolean; // true = 不通过就拦部署
  detail: string;
}

export interface DeployResult {
  project: string;
  server: string;
  success: boolean;
  /** 部署前置体检结果（有跑才有）：目录/docker/磁盘/git remote 等快速检查。 */
  preflight?: PreflightCheck[];
  /** 部署命令的输出（截断） */
  output: string;
  gitRev?: string;
  health: { url: string; httpCode: string; ok: boolean }[];
  /** 部署失败时自动抓的容器状态 + 尾部日志，让失败自解释（命令失败/健康失败都带） */
  failLogs?: { container: string; state?: string; logs: string }[];
  /** 部署"成功"但日志里发现疑似报错（健康端点过了≠应用没坏，比如模板 500/连接异常） */
  warnings?: { container: string; sample: string }[];
  /** pre/postDeploy 钩子的执行记录（有配才有），便于回看编排每步结果。 */
  hooks?: { phase: "pre" | "post"; cmd: string; code: number | null; output: string }[];
  error?: string;
}

export interface StatusResult {
  project: string;
  server: string;
  gitRev?: string;
  gitBranch?: string;
  gitRepo?: string; // origin remote URL（无则说明非 git 接管）
  containers: { name: string; state: string }[];
  health: { url: string; httpCode: string; ok: boolean }[];
  reachable: boolean;
  error?: string;
}
