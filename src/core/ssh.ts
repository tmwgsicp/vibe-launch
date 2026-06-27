// agentless SSH 执行：用本地 ~/.ssh 直接连服务器
import { NodeSSH } from "node-ssh";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ServerConfig } from "./types.js";

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/** 选私钥：identityFile > ~/.ssh/id_ed25519 > id_rsa；都没有则交给 agent */
function pickPrivateKeyPath(server: ServerConfig): string | undefined {
  if (server.identityFile) return expandHome(server.identityFile);
  // 优先 vibe-launch 自管的专用 key
  const managed = join(homedir(), ".vibe-launch", "id_ed25519");
  if (existsSync(managed)) return managed;
  for (const name of ["id_ed25519", "id_rsa"]) {
    const p = join(homedir(), ".ssh", name);
    if (existsSync(p)) return p;
  }
  return undefined;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** 用 server 的认证(密码/专用 key/agent)建立 SSH 连接。runOnServer / tunnel 共用。 */
export async function connectSSH(server: ServerConfig): Promise<NodeSSH> {
  const ssh = new NodeSSH();
  // 认证方式：配了密码用密码，否则用 key（专用 key / ~/.ssh / agent）
  const auth = server.password
    ? { password: server.password }
    : (() => {
        const k = pickPrivateKeyPath(server);
        return k ? { privateKeyPath: k } : { agent: process.env.SSH_AUTH_SOCK || undefined };
      })();
  await ssh.connect({
    host: server.host,
    username: server.user,
    port: server.port ?? 22,
    ...auth,
    readyTimeout: 20000,
    // 保活：池里的长连接每 15s 发一次心跳，连发 3 次无应答即判定断开——
    // 既防 NAT/服务器空闲超时悄悄掐断，也能让死连接被及时发现并重连。
    keepaliveInterval: 15000,
    keepaliveCountMax: 3,
  });
  return ssh;
}

// ── SSH 连接池 ──
// 默认关闭（CLI 一次性命令不需要池，且保留连接会吊住事件循环导致进程不退出）。
// 长驻进程（操作台 ui / MCP server）启动时调 enableSshPool() 打开：连一次保持热连接，
// 后续命令只开 channel 不再重新握手——文件管理器翻目录、刷状态等从"每次几百毫秒握手"降到近即时。
interface PoolEntry {
  ssh?: NodeSSH;                 // 已就绪的连接
  connecting?: Promise<NodeSSH>; // 正在握手（用于合并并发首连）
  idle?: NodeJS.Timeout;         // 空闲关闭计时器
}
const POOL = new Map<string, PoolEntry>();
let POOLING = false;
const IDLE_MS = 5 * 60 * 1000;

export function enableSshPool(): void {
  POOLING = true;
}

const keyOf = (s: ServerConfig) => `${s.user}@${s.host}:${s.port ?? 22}`;

function isAlive(ssh: NodeSSH): boolean {
  try {
    return typeof (ssh as any).isConnected === "function" ? (ssh as any).isConnected() : !!(ssh as any).connection;
  } catch {
    return false;
  }
}

function evict(key: string, ssh?: NodeSSH): void {
  const ent = POOL.get(key);
  if (!ent) return;
  if (ssh && ent.ssh && ent.ssh !== ssh) return; // 已被换成新连接，别误删
  if (ent.idle) clearTimeout(ent.idle);
  if (ent.ssh) { try { ent.ssh.dispose(); } catch { /* ignore */ } }
  POOL.delete(key);
}

/** 取一条可用连接。并发首连合并（singleflight）：同一服务器多个请求同时来时只握手一次，
 * 其余等同一个 Promise——避免 overview/展开行并发拉数据时对同一台机器开出多条连接。 */
async function acquire(server: ServerConfig): Promise<NodeSSH> {
  if (!POOLING) return connectSSH(server);
  const key = keyOf(server);
  let ent = POOL.get(key);
  if (ent) {
    if (ent.ssh && isAlive(ent.ssh)) {
      if (ent.idle) { clearTimeout(ent.idle); ent.idle = undefined; }
      return ent.ssh;
    }
    if (ent.connecting) return ent.connecting; // 复用进行中的握手
    evict(key); // 有 entry 但连接已死，清掉重连
  }
  ent = {};
  POOL.set(key, ent);
  ent.connecting = connectSSH(server)
    .then((ssh) => {
      ent!.ssh = ssh;
      ent!.connecting = undefined;
      // 连接被对端/网络掐断（含 keepalive 判死）时自动移出池，下次 acquire 会重连
      const raw: any = (ssh as any).connection;
      if (raw && typeof raw.on === "function") {
        raw.on("close", () => { if (POOL.get(key) === ent) POOL.delete(key); });
        raw.on("end", () => { if (POOL.get(key) === ent) POOL.delete(key); });
      }
      return ssh;
    })
    .catch((e) => { if (POOL.get(key) === ent) POOL.delete(key); throw e; });
  return ent.connecting;
}

function release(server: ServerConfig, ssh: NodeSSH): void {
  if (!POOLING) { try { ssh.dispose(); } catch { /* ignore */ } return; }
  const key = keyOf(server);
  const ent = POOL.get(key);
  if (ent && ent.ssh === ssh) {
    if (ent.idle) clearTimeout(ent.idle);
    ent.idle = setTimeout(() => evict(key, ssh), IDLE_MS);
    (ent.idle as any).unref?.(); // 空闲计时器不单独吊住进程退出
  }
}

const isConnError = (e: unknown): boolean =>
  /not connected|no response|closed|ended|ECONNRESET|EHOSTUNREACH|ETIMEDOUT|EPIPE/i.test((e as Error)?.message || "");

/** 在服务器上跑一条命令（可指定 cwd）。
 * 连接池开启时复用热连接（见上）；命令出错/超时的连接会被丢弃，连接级错误自动重连重试一次。
 * timeoutMs：命令级硬超时（默认 20s，<=0 关闭）。connectSSH 的 readyTimeout 只管握手，
 * 命令本身卡住（如 dockerd 僵死）execCommand 永不返回，这里用 Promise.race 兜底。 */
export async function runOnServer(
  server: ServerConfig,
  command: string,
  cwd?: string,
  timeoutMs = 20000,
  _allowRetry = true
): Promise<ExecResult> {
  const ssh = await acquire(server);
  let bad = false;
  try {
    const exec = ssh.execCommand(command, cwd ? { cwd } : {});
    let res;
    if (timeoutMs > 0) {
      let to: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, rej) => {
        to = setTimeout(() => rej(new Error(`命令执行超时（${Math.round(timeoutMs / 1000)}s）`)), timeoutMs);
      });
      try {
        res = await Promise.race([exec, timeout]);
      } finally {
        if (to) clearTimeout(to);
      }
    } else {
      res = await exec;
    }
    return { code: res.code, stdout: res.stdout, stderr: res.stderr };
  } catch (e) {
    bad = true;
    // 池里的连接断了：丢弃，用全新连接重试一次（只重试连接级错误，不重试命令超时）
    if (POOLING && _allowRetry && isConnError(e)) {
      evict(keyOf(server), ssh);
      return runOnServer(server, command, cwd, timeoutMs, false);
    }
    throw e;
  } finally {
    if (!POOLING) { try { ssh.dispose(); } catch { /* ignore */ } }
    else if (bad) evict(keyOf(server), ssh); // 出错/超时的连接不留池里
    else release(server, ssh);               // 健康连接保持热，计划空闲关闭
  }
}

/** 在服务器本地探一个健康检查 URL，返回 http_code（curl 优先，没装则退回 wget）。 */
export async function curlOnServer(server: ServerConfig, url: string): Promise<string> {
  const u = JSON.stringify(url);
  // curl 能直接给状态码；wget 只给成功/失败，故 2xx→200、其余→000
  const cmd =
    `if command -v curl >/dev/null 2>&1; then curl -fsS -o /dev/null -w '%{http_code}' --max-time 10 ${u} || echo 000; ` +
    `elif command -v wget >/dev/null 2>&1; then wget -q -O /dev/null -T 10 ${u} && echo 200 || echo 000; ` +
    `else echo 000; fi`;
  const r = await runOnServer(server, cmd);
  return (r.stdout || "000").trim().split(/\s+/).pop() || "000";
}
