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
}

export interface Config {
  servers: Record<string, ServerConfig>;
  projects: Record<string, ProjectConfig>;
}

export interface DeployResult {
  project: string;
  server: string;
  success: boolean;
  /** 部署命令的输出（截断） */
  output: string;
  gitRev?: string;
  health: { url: string; httpCode: string; ok: boolean }[];
  /** 健康检查失败时自动抓的容器尾部日志，方便直接定位 */
  failLogs?: { container: string; logs: string }[];
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
