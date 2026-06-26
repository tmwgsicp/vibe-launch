// 数据库端口暴露检测（两路合判，给出"是否装/原生还是容器/绑哪个地址/外网是否真可达"）：
//  - 内部(SSH)：ss/netstat 看谁在监听+绑哪个地址+进程；docker ps 看哪个容器映射了端口
//  - 外部(本机 TCP)：真从公网这侧探一次，确认是否真能连上（含云安全组这层闸）
// 只检测+给针对性关闭指引，不代改防火墙/安全组（风险高、真闸在云安全组，交人决策）。
import * as net from "node:net";
import { getServerOf } from "./config.js";
import { runOnServer } from "./ssh.js";
import type { Config } from "./types.js";

export interface DbService {
  service: string;
  port: number;
  present: boolean;                         // 服务器上有没有进程在监听这个端口
  mode: "container" | "native" | "unknown" | "none";
  bind: "public" | "local" | "none";        // 监听 0.0.0.0/:: vs 仅 127.0.0.1 vs 没监听
  container?: string;                        // 容器名（若是容器）
  reachable: boolean;                        // 外网 TCP 真能连上（隐患）
}

const DB_PORTS: [string, number][] = [
  ["PostgreSQL", 5432],
  ["MySQL", 3306],
  ["MongoDB", 27017],
  ["Redis", 6379],
  ["SQL Server", 1433],
];
const NATIVE_PROCS = /postgres|redis-server|redis|mysqld|mariadb|mongod|sqlservr/i;

function probe(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let settled = false;
    const finish = (v: boolean) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
  });
}

function classifyAddr(addr: string | undefined): "public" | "local" {
  if (!addr) return "public"; // 裸端口默认按全网监听算
  const a = addr.replace(/[[\]]/g, "");
  if (a === "127.0.0.1" || a === "::1" || a === "localhost") return "local";
  return "public"; // *, 0.0.0.0, ::, 具体公网 IP 都算对外
}

interface Listener { addr: string; proc: string; }

/** 解析 ss/netstat 输出：port -> {addr, proc}（取监听态、数字端口的本地地址）。 */
function parseListeners(text: string): Record<number, Listener> {
  const out: Record<number, Listener> = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    // 找"本地地址:数字端口"那个 token（ss 与 netstat 都适用）
    let local: string | undefined;
    for (const t of line.trim().split(/\s+/)) {
      const m = t.match(/^(.*):(\d+)$/);
      if (m) { local = t; break; }
    }
    if (!local) continue;
    const i = local.lastIndexOf(":");
    const port = parseInt(local.slice(i + 1), 10);
    if (!port) continue;
    const addr = local.slice(0, i);
    // 进程名：ss 形如 users:(("postgres",...))；netstat 形如 1234/postgres
    const pm = line.match(/"([^"]+)"/) || line.match(/\b\d+\/(\S+)/);
    out[port] = { addr, proc: pm ? pm[1] : "" };
  }
  return out;
}

interface DockerPub { addr: string; name: string; }

/** 解析 docker ps 的端口映射：port -> {host 绑定地址, 容器名}。 */
function parseDocker(text: string): Record<number, DockerPub> {
  const out: Record<number, DockerPub> = {};
  for (const line of text.split("\n")) {
    if (!line.includes("|")) continue;
    const [, name, ports] = line.split("|");
    if (!ports) continue;
    // 形如 0.0.0.0:5432->5432/tcp, 127.0.0.1:6379->6379/tcp, :::5432->5432/tcp
    const re = /([0-9.]+|\[?::\]?|0\.0\.0\.0)?:?(\d+)->(\d+)\/tcp/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(ports))) {
      const hostAddr = m[1] || "";
      const hostPort = parseInt(m[2], 10);
      if (hostPort) out[hostPort] = { addr: hostAddr, name: (name || "").trim() };
    }
  }
  return out;
}

/** 综合判定一台服务器的常见 DB 端口现状。 */
export async function checkExposure(config: Config, target: string): Promise<{ host: string; services: DbService[] }> {
  const server = getServerOf(config, target);

  // 内部扫描 + 外部探测并行
  const scanP = runOnServer(
    server,
    `echo __SS__; (ss -tlnpH 2>/dev/null || netstat -tlnp 2>/dev/null); echo __DK__; docker ps --format '{{.Image}}|{{.Names}}|{{.Ports}}' 2>/dev/null`
  );
  const probesP = Promise.all(DB_PORTS.map(([, port]) => probe(server.host, port)));
  const [scan, probes] = await Promise.all([scanP, probesP]);

  const out = scan.stdout;
  const ssText = out.slice(out.indexOf("__SS__") + 6, out.indexOf("__DK__") >= 0 ? out.indexOf("__DK__") : undefined);
  const dkText = out.indexOf("__DK__") >= 0 ? out.slice(out.indexOf("__DK__") + 6) : "";
  const listeners = parseListeners(ssText);
  const dockerPubs = parseDocker(dkText);

  const services: DbService[] = DB_PORTS.map(([service, port], idx) => {
    const dk = dockerPubs[port];
    const ss = listeners[port];
    let present = false;
    let mode: DbService["mode"] = "none";
    let bind: DbService["bind"] = "none";
    let container: string | undefined;
    if (dk) {
      present = true; mode = "container"; container = dk.name; bind = classifyAddr(dk.addr);
    } else if (ss) {
      present = true;
      bind = classifyAddr(ss.addr);
      mode = /docker-proxy/i.test(ss.proc) ? "container" : NATIVE_PROCS.test(ss.proc) ? "native" : "unknown";
    }
    return { service, port, present, mode, bind, container, reachable: probes[idx] };
  });

  return { host: server.host, services };
}
