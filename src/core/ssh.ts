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
  });
  return ssh;
}

/** 在服务器上跑一条命令（可指定 cwd）。
 * timeoutMs：命令级硬超时（默认 20s，<=0 关闭）。connectSSH 的 readyTimeout 只管连接握手，
 * 命令本身若卡住（如 dockerd 僵死）execCommand 永不返回，会把 HTTP handler 吊死、前端转圈不停——
 * 这里用 Promise.race 兜底，超时即抛错并断开连接。 */
export async function runOnServer(
  server: ServerConfig,
  command: string,
  cwd?: string,
  timeoutMs = 20000
): Promise<ExecResult> {
  const ssh = await connectSSH(server);
  try {
    const exec = ssh.execCommand(command, cwd ? { cwd } : {});
    if (timeoutMs > 0) {
      let to: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, rej) => {
        to = setTimeout(
          () => rej(new Error(`命令执行超时（${Math.round(timeoutMs / 1000)}s）`)),
          timeoutMs
        );
      });
      try {
        const res = await Promise.race([exec, timeout]);
        return { code: res.code, stdout: res.stdout, stderr: res.stderr };
      } finally {
        if (to) clearTimeout(to);
      }
    }
    const res = await exec;
    return { code: res.code, stdout: res.stdout, stderr: res.stderr };
  } finally {
    ssh.dispose();
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
