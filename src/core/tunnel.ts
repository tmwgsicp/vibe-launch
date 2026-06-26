// SSH 本地端口转发（隧道）：把服务器内网服务(PG/Redis…)安全映射到本地，
// 这样服务器上 PG/Redis 的公网端口可以彻底关闭，开发时连 localhost 即可。
import * as net from "node:net";
import { connectSSH } from "./ssh.js";
import { getServerOf } from "./config.js";
import type { Config } from "./types.js";

const SERVICE_PORTS: Record<string, number> = {
  pg: 5432, postgres: 5432, postgresql: 5432,
  mysql: 3306, mariadb: 3306,
  mongo: 27017, mongodb: 27017,
  redis: 6379,
  mssql: 1433, sqlserver: 1433, "sql-server": 1433,
};

export interface TunnelOptions {
  target: string;          // 服务器别名或项目名
  service?: string;        // pg / redis / mysql …
  remoteHost?: string;     // 服务器侧目标地址（默认 127.0.0.1）
  remotePort?: number;     // 服务器侧目标端口（不填则由 service 推断）
  localPort?: number;      // 本地监听端口（默认 = 远程端口）
}

export interface TunnelHandle {
  target: string;
  service?: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  serverHost: string;
  close: () => void;
}

/** 建立隧道并立即返回句柄（非阻塞）。UI 用它管理多条隧道；CLI 用 openTunnel 包一层常驻。 */
export async function createTunnel(config: Config, opts: TunnelOptions): Promise<TunnelHandle> {
  const server = getServerOf(config, opts.target);
  const remotePort =
    opts.remotePort ?? (opts.service ? SERVICE_PORTS[opts.service.toLowerCase()] : undefined);
  if (!remotePort) throw new Error(`需要 service(如 pg/redis) 或 remotePort 指定服务器侧端口`);
  const remoteHost = opts.remoteHost ?? "127.0.0.1";
  const localPort = opts.localPort ?? remotePort;

  const ssh = await connectSSH(server);
  const conn = (ssh as any).connection;
  if (!conn) throw new Error("SSH 连接未就绪");

  const localServer = net.createServer((sock) => {
    conn.forwardOut("127.0.0.1", localPort, remoteHost, remotePort, (err: Error, stream: any) => {
      if (err) { sock.destroy(); return; }
      sock.pipe(stream); stream.pipe(sock);
      stream.on("error", () => sock.destroy());
      sock.on("error", () => stream.destroy());
    });
  });

  await new Promise<void>((resolve, reject) => {
    localServer.once("error", reject);
    localServer.listen(localPort, "127.0.0.1", () => resolve());
  });

  return {
    target: opts.target, service: opts.service, localPort, remoteHost, remotePort,
    serverHost: server.host,
    close: () => { try { localServer.close(); } catch {} try { ssh.dispose(); } catch {} },
  };
}

/** CLI：开隧道并前台常驻直到 Ctrl+C。 */
export async function openTunnel(
  config: Config,
  opts: TunnelOptions,
  log: (s: string) => void = (s) => console.log(s)
): Promise<void> {
  log(`连接 …`);
  const h = await createTunnel(config, opts);
  log("");
  log(`🔐 隧道已开：localhost:${h.localPort}  →  ${h.serverHost} 内网 ${h.remoteHost}:${h.remotePort}`);
  log(`   你的工具连 localhost:${h.localPort} 即可。`);
  log(`   → 服务器上 ${h.remoteHost}:${h.remotePort} 的公网端口现在可以关掉了。`);
  log(`   Ctrl+C 关闭隧道。`);
  await new Promise<void>((resolve) => {
    const shutdown = () => { log("\n关闭隧道…"); h.close(); resolve(); };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
