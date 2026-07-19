// 接入新服务器：自动配 SSH（装公钥，免密）+ 可选建部署用户 + 写进清单
import { NodeSSH } from "node-ssh";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { loadConfig, saveConfig, MANAGED_KEY_REF } from "./config.js";
import type { Config, ServerConfig } from "./types.js";
import { shQuote } from "./sh.js";

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

export interface OnboardOptions {
  alias: string;
  host: string;
  /** 初次登录用户（如 root） */
  user: string;
  /** 初次登录密码（一次性，用来装公钥）；不填则用现有 key 登录 */
  password?: string;
  port?: number;
  /** 本地私钥，默认 ~/.ssh/id_ed25519；没有会自动生成 */
  identityFile?: string;
  /** 可选：创建专用部署用户并加 docker 组 */
  deployUser?: string;
  note?: string;
  /** 认证方式：key=装专用钥匙后免密（推荐、更安全）；password=直接存密码登录 */
  auth?: "key" | "password";
}

export interface OnboardResult {
  alias: string;
  success: boolean;
  steps: string[];
  finalUser: string;
  error?: string;
}

/** 确保本地有密钥对，返回公钥内容 */
function ensureKeypair(identityFile: string, steps: string[]): string {
  const priv = expandHome(identityFile);
  const pub = priv + ".pub";
  if (!existsSync(priv)) {
    steps.push(`本地没有密钥，生成新的 ${identityFile}`);
    mkdirSync(dirname(priv), { recursive: true });
    execFileSync("ssh-keygen", ["-t", "ed25519", "-f", priv, "-N", "", "-q"]);
  }
  if (!existsSync(pub)) throw new Error(`找不到公钥 ${pub}`);
  return readFileSync(pub, "utf8").trim();
}

export async function onboard(opts: OnboardOptions): Promise<OnboardResult> {
  const steps: string[] = [];
  const identityFile = opts.identityFile ?? MANAGED_KEY_REF;
  const port = opts.port ?? 22;
  const result: OnboardResult = {
    alias: opts.alias,
    success: false,
    steps,
    finalUser: opts.deployUser || opts.user,
  };

  try {
    // 密码认证模式：只验证密码能连，然后存进配置（不装 key）
    if (opts.auth === "password") {
      if (!opts.password) throw new Error("auth=password 需要 --password");
      const t = new NodeSSH();
      await t.connect({ host: opts.host, username: opts.user, port, password: opts.password });
      const who = await t.execCommand("whoami");
      t.dispose();
      steps.push(`✓ 密码登录验证通过（whoami=${who.stdout.trim()}）`);
      result.finalUser = opts.user;
      let cfg: Config;
      try { cfg = loadConfig(); } catch { cfg = { servers: {}, projects: {} }; }
      cfg.servers[opts.alias] = {
        host: opts.host, user: opts.user,
        ...(port !== 22 ? { port } : {}),
        password: opts.password,
        ...(opts.note ? { note: opts.note } : {}),
      } as ServerConfig;
      const p = saveConfig(cfg);
      steps.push(`已写入清单 ${p}（⚠️ 密码明文存本地配置，建议改用 key）`);
      result.success = true;
      return result;
    }

    const pubkey = ensureKeypair(identityFile, steps);

    // 用密码（或现有 key）登录一次
    const ssh = new NodeSSH();
    await ssh.connect({
      host: opts.host,
      username: opts.user,
      port,
      ...(opts.password ? { password: opts.password } : { privateKeyPath: expandHome(identityFile) }),
    });
    steps.push(`已用 ${opts.user} 登录 ${opts.host}`);

    const installFor = async (user: string, sudo: boolean) => {
      const home = sudo ? `/home/${user}` : "$HOME";
      const S = sudo ? "sudo " : "";
      const script =
        `${S}mkdir -p ${home}/.ssh && ` +
        `echo ${shQuote(pubkey)} | ${S}tee -a ${home}/.ssh/authorized_keys >/dev/null && ` +
        `${S}chmod 700 ${home}/.ssh && ${S}chmod 600 ${home}/.ssh/authorized_keys` +
        (sudo ? ` && sudo chown -R ${user}:${user} ${home}/.ssh` : "");
      const r = await ssh.execCommand(script);
      if (r.code !== 0) throw new Error(`装公钥失败: ${r.stderr || r.stdout}`);
    };

    if (opts.deployUser && opts.deployUser !== opts.user) {
      steps.push(`创建部署用户 ${opts.deployUser} + 加 docker 组`);
      await ssh.execCommand(
        `sudo useradd -m -s /bin/bash ${opts.deployUser} 2>/dev/null; sudo usermod -aG docker ${opts.deployUser} 2>/dev/null; true`
      );
      await installFor(opts.deployUser, true);
      steps.push(`公钥已装到 ${opts.deployUser}`);
    } else {
      await installFor(opts.user, false);
      steps.push(`公钥已装到 ${opts.user}`);
    }
    ssh.dispose();

    // 验证免密登录
    const verify = new NodeSSH();
    await verify.connect({
      host: opts.host,
      username: result.finalUser,
      port,
      privateKeyPath: expandHome(identityFile),
    });
    const who = await verify.execCommand("whoami");
    verify.dispose();
    steps.push(`✓ 免密登录验证通过（whoami=${who.stdout.trim()}）`);

    // 写进清单
    let config: Config;
    try {
      config = loadConfig();
    } catch {
      config = { servers: {}, projects: {} };
    }
    config.servers[opts.alias] = {
      host: opts.host,
      user: result.finalUser,
      ...(port !== 22 ? { port } : {}),
      identityFile,
      ...(opts.note ? { note: opts.note } : {}),
    } as ServerConfig;

    const path = saveConfig(config);
    steps.push(`已写入清单 ${path}`);

    result.success = true;
    return result;
  } catch (e) {
    result.error = (e as Error).message;
    return result;
  }
}
