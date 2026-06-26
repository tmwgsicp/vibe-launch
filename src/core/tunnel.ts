// SSH 本地端口转发（隧道）：把服务器内网服务(PG/Redis…)安全映射到本地，
// 这样服务器上 PG/Redis 的公网端口可以彻底关闭，开发时连 localhost 即可。
import * as net from "node:net";
import { connectSSH } from "./ssh.js";
import { getServerOf } from "./config.js";
import type { Config } from "./types.js";

/** 常用服务端口预设 */
const SERVICE_PORTS: Record<string, number> = {
  pg: 5432,
  postgres: 5432,
  postgresql: 5432,
  redis: 6379,
  mysql: 3306,
  mongo: 27017,
  mongodb: 27017,
};

export interface TunnelOptions {
  /** 服务器别名或项目名 */
  target: string;
  /** 服务预设：pg / redis / mysql … */
  service?: string;
  /** 服务器侧目标地址（默认 127.0.0.1，即服务器自身 localhost） */
  remoteHost?: string;
  /** 服务器侧目标端口（不填则由 service 推断） */
  remotePort?: number;
  /** 本地监听端口（默认 = 远程端口） */
  localPort?: number;
}

/** 打开隧道，前台常驻直到 Ctrl+C。log 输出给用户看。 */
export async function openTunnel(
  config: Config,
  opts: TunnelOptions,
  log: (s: string) => void = (s) => console.log(s)
): Promise<void> {
  const server = getServerOf(config, opts.target);

  const remotePort =
    opts.remotePort ?? (opts.service ? SERVICE_PORTS[opts.service.toLowerCase()] : undefined);
  if (!remotePort) {
    throw new Error(`需要 --service(如 pg/redis) 或 --remote-port 指定服务器侧端口`);
  }
  const remoteHost = opts.remoteHost ?? "127.0.0.1";
  const localPort = opts.localPort ?? remotePort;

  log(`连接 ${server.user}@${server.host} …`);
  const ssh = await connectSSH(server);
  const conn = (ssh as any).connection; // 底层 ssh2 Client
  if (!conn) throw new Error("SSH 连接未就绪");

  const localServer = net.createServer((sock) => {
    conn.forwardOut("127.0.0.1", localPort, remoteHost, remotePort, (err: Error, stream: any) => {
      if (err) {
        sock.destroy();
        return;
      }
      sock.pipe(stream);
      stream.pipe(sock);
      stream.on("error", () => sock.destroy());
      sock.on("error", () => stream.destroy());
    });
  });

  await new Promise<void>((resolve, reject) => {
    localServer.once("error", reject);
    localServer.listen(localPort, "127.0.0.1", () => resolve());
  });

  log("");
  log(`🔐 隧道已开：localhost:${localPort}  →  ${server.host} 内网 ${remoteHost}:${remotePort}`);
  log(`   你的工具连 localhost:${localPort} 即可。`);
  log(`   → 服务器上 ${remoteHost}:${remotePort} 的公网端口现在可以关掉了（只留内网 + 本隧道）。`);
  log(`   Ctrl+C 关闭隧道。`);

  // 前台常驻，直到 SIGINT
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      log("\n关闭隧道…");
      localServer.close();
      ssh.dispose();
      resolve();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
