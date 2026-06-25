// GitHub OAuth Device Flow —— 纯本地、无后端、无 secret。
// 工具弹"浏览器打开链接 + 输入码"，用户点一下授权，拿到 token 存本地。
// 同 gh auth login 的机制；client_id 公开、可硬编码。
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

/** vibe-launch 的 GitHub OAuth App（公开 client_id，已开 Device Flow） */
export const CLIENT_ID = "Ov23limSw1mPx1uFc3js";

const TOKEN_PATH = join(homedir(), ".vibe-launch", "github-token.json");
const UA = "vibe-launch";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function getStoredToken(): string | undefined {
  try {
    const t = JSON.parse(readFileSync(TOKEN_PATH, "utf8"))?.token;
    return typeof t === "string" && t ? t : undefined;
  } catch {
    return undefined;
  }
}

export function saveToken(token: string): void {
  mkdirSync(dirname(TOKEN_PATH), { recursive: true });
  writeFileSync(TOKEN_PATH, JSON.stringify({ token }, null, 2), { mode: 0o600 });
}

export function clearToken(): void {
  try {
    unlinkSync(TOKEN_PATH);
  } catch {
    /* 没有就算了 */
  }
}

/** 尽力打开浏览器（失败不报错，用户可手动开） */
function tryOpenBrowser(url: string): void {
  try {
    if (process.platform === "win32") execFile("cmd", ["/c", "start", "", url], () => {});
    else if (process.platform === "darwin") execFile("open", [url], () => {});
    else execFile("xdg-open", [url], () => {});
  } catch {
    /* 非致命 */
  }
}

async function postJson(url: string, body: Record<string, string>): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify(body),
  });
  return res.json();
}

/**
 * 跑完整 device flow：打印验证码 → 轮询 → 拿到 token 存盘并返回。
 * log 默认走 stderr（不污染 stdout 的结构化输出）。
 */
export async function deviceLogin(scopes: string[] = ["repo"], log: (s: string) => void = (s) => console.error(s)): Promise<string> {
  const dc = await postJson("https://github.com/login/device/code", {
    client_id: CLIENT_ID,
    scope: scopes.join(" "),
  });
  if (!dc.device_code || !dc.user_code) {
    throw new Error(`GitHub 拒绝了授权请求：${dc.error_description || dc.error || "未知"}（确认 OAuth App 已开 Device Flow）`);
  }

  log("");
  log("🔐 GitHub 授权：");
  log(`   1) 浏览器打开： ${dc.verification_uri}`);
  log(`   2) 输入验证码： ${dc.user_code}`);
  log(`   （已尝试自动打开浏览器；最多等 ${Math.floor((dc.expires_in || 900) / 60)} 分钟）`);
  log("");
  tryOpenBrowser(dc.verification_uri);

  let intervalMs = ((dc.interval || 5) + 1) * 1000;
  const deadline = Date.now() + (dc.expires_in || 900) * 1000;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const tok = await postJson("https://github.com/login/oauth/access_token", {
      client_id: CLIENT_ID,
      device_code: dc.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (tok.access_token) {
      saveToken(tok.access_token);
      return tok.access_token;
    }
    if (tok.error === "authorization_pending") continue;
    if (tok.error === "slow_down") {
      intervalMs += 5000;
      continue;
    }
    if (tok.error === "expired_token") throw new Error("授权超时，请重新运行 vibe-launch auth");
    if (tok.error === "access_denied") throw new Error("授权被拒绝");
    throw new Error(`授权失败：${tok.error_description || tok.error}`);
  }
  throw new Error("授权超时，请重试");
}
