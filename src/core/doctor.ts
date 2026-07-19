// 国内网络优化：① vl doctor —— 只读探常见端点可达性（Docker Hub/GitHub/caddy/npm/pypi），
// 一眼看出这台机"哪些要走镜像"；② setDockerMirror —— 配 /etc/docker/daemon.json 的 registry-mirrors
// 并重启 docker（有副作用：所有容器短暂重启一次）。
//
// ⚠️ 现实提醒（2024 起）：国内多数「公共」docker 镜像源被大面积关停，公共源普遍不稳定。
// 阿里云/腾讯云机器优先用「云内网镜像」最稳；配完务必 vl doctor 复验镜像是否真的可达。
import type { Config, ServerConfig } from "./types.js";
import { getServerOf } from "./config.js";
import { runOnServer } from "./ssh.js";
import { shQuote } from "./sh.js";
import { recordOp } from "./oplog.js";

/** 默认公共镜像源（较 durable 的社区源；仍可能失效，故建议配完用 doctor 复验）。 */
export const DEFAULT_DOCKER_MIRRORS = ["https://docker.m.daocloud.io"];

const PROBES: { name: string; url: string }[] = [
  { name: "Docker Hub", url: "https://registry-1.docker.io/v2/" }, // 通了返回 401（需鉴权）= 可达
  { name: "GitHub", url: "https://github.com" },
  { name: "Caddy 下载", url: "https://caddyserver.com" },
  { name: "npm", url: "https://registry.npmjs.org" },
  { name: "PyPI", url: "https://pypi.org/simple/" },
];

async function sudoPrefix(server: ServerConfig): Promise<string> {
  const uid = (await runOnServer(server, "id -u")).stdout.trim();
  return uid === "0" ? "" : "sudo ";
}

export interface Probe { name: string; url: string; code: string; timeMs: number; ok: boolean }
export interface DoctorResult {
  server: string;
  reachable: boolean;
  docker: string;            // docker 版本或 "none"
  currentMirrors: string[];  // 现有 registry-mirrors
  probes: Probe[];
  error?: string;
}

/** 连通性体检：一次 SSH 探所有端点 + docker 版本 + 现有镜像配置。纯只读。 */
export async function doctor(config: Config, target: string): Promise<DoctorResult> {
  const server = getServerOf(config, target);
  const res: DoctorResult = { server: target, reachable: false, docker: "none", currentMirrors: [], probes: [] };
  try {
    const probeCmd = PROBES.map(
      (p) =>
        `printf 'P|%s|' ${shQuote(p.name)}; curl -sS -o /dev/null -w '%{http_code} %{time_total}' --connect-timeout 8 --max-time 15 ${shQuote(p.url)} 2>/dev/null || printf '000 0'; printf '\\n'`
    ).join("; ");
    const cmd =
      `${probeCmd}; printf 'DOCKER|%s\\n' "$(command -v docker >/dev/null 2>&1 && docker --version 2>/dev/null || echo none)"; ` +
      `printf 'DAEMON|%s\\n' "$(base64 </etc/docker/daemon.json 2>/dev/null | tr -d '\\n')"`;
    const out = (await runOnServer(server, cmd)).stdout;
    res.reachable = true;
    let pi = 0;
    for (const line of out.split("\n")) {
      if (line.startsWith("P|")) {
        const parts = line.slice(2).split("|"); // name | "code time"
        const [code = "000", t = "0"] = (parts[1] || "").trim().split(/\s+/);
        res.probes.push({
          name: parts[0] || PROBES[pi]?.name || "?",
          url: PROBES[pi]?.url || "",
          code,
          timeMs: Math.round(parseFloat(t) * 1000) || 0,
          ok: /^\d{3}$/.test(code) && code !== "000", // 拿到任何 HTTP 响应即可达（401 也算，如 Docker Hub）
        });
        pi++;
      } else if (line.startsWith("DOCKER|")) {
        res.docker = line.slice(7).trim() || "none";
      } else if (line.startsWith("DAEMON|")) {
        const b64 = line.slice(7).trim();
        if (b64) {
          try {
            const j = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
            if (Array.isArray(j["registry-mirrors"])) res.currentMirrors = j["registry-mirrors"];
          } catch { /* daemon.json 非法就忽略 */ }
        }
      }
    }
    return res;
  } catch (e) {
    res.error = (e as Error).message;
    return res;
  }
}

const validMirror = (u: string) => /^https?:\/\/[A-Za-z0-9._:\/-]+$/.test(u);

export interface DockerMirrorResult {
  server: string;
  file: string;
  mirrors: string[];
  content?: string;   // dry-run 时返回将写入的 daemon.json
  restarted: boolean;
  success: boolean;
  error?: string;
}

/** 配 Docker registry 镜像加速：合并进现有 daemon.json（保留其它键）+ 重启 docker。
 *  重启 docker 会让该机所有容器短暂重启一次 —— 调用方负责二次确认。 */
export async function setDockerMirror(
  config: Config,
  target: string,
  mirrors: string[],
  opts: { dryRun?: boolean } = {}
): Promise<DockerMirrorResult> {
  const server = getServerOf(config, target);
  const list = (mirrors.length ? mirrors : DEFAULT_DOCKER_MIRRORS).map((m) => m.trim()).filter(Boolean);
  const res: DockerMirrorResult = { server: target, file: "/etc/docker/daemon.json", mirrors: list, restarted: false, success: false };
  try {
    for (const m of list) if (!validMirror(m)) throw new Error(`非法镜像地址：${m}`);

    // 读现有 daemon.json（base64 免引号），合并 registry-mirrors，保留其它键
    const cur = (await runOnServer(server, `base64 </etc/docker/daemon.json 2>/dev/null | tr -d '\\n'`)).stdout.trim();
    let obj: Record<string, unknown> = {};
    if (cur) {
      try { obj = JSON.parse(Buffer.from(cur, "base64").toString("utf8")); }
      catch { throw new Error("现有 /etc/docker/daemon.json 不是合法 JSON，已中止（请手动检查后再配）"); }
    }
    obj["registry-mirrors"] = list;
    const content = JSON.stringify(obj, null, 2);
    res.content = content;
    if (opts.dryRun) { res.success = true; return res; }

    const S = await sudoPrefix(server);
    const b64 = Buffer.from(content, "utf8").toString("base64");
    const w = await runOnServer(
      server,
      `${S}mkdir -p /etc/docker; [ -f /etc/docker/daemon.json ] && ${S}cp /etc/docker/daemon.json /etc/docker/daemon.json.vlbak; ` +
        `printf %s ${shQuote(b64)} | base64 -d | ${S}tee /etc/docker/daemon.json >/dev/null && echo __OK__`
    );
    if (!w.stdout.includes("__OK__")) throw new Error(`写入 daemon.json 失败：${(w.stderr || w.stdout).trim()}`);

    // 重启 docker 让镜像生效（所有容器会短暂重启）
    const r = await runOnServer(server, `${S}systemctl restart docker 2>&1 || ${S}service docker restart 2>&1`, undefined, 120000);
    res.restarted = r.code === 0;
    if (r.code !== 0) throw new Error(`daemon.json 已写入，但重启 docker 失败：${(r.stderr || r.stdout).trim().slice(0, 300)}`);

    res.success = true;
    recordOp("docker-mirror", target, true, list.join(","));
    return res;
  } catch (e) {
    res.error = (e as Error).message;
    if (!opts.dryRun) recordOp("docker-mirror", target, false, res.error);
    return res;
  }
}
