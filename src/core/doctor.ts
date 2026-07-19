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

export interface Probe { name: string; url: string; code: string; timeMs: number; ok: boolean; reason?: string }
export interface DoctorResult {
  server: string;
  reachable: boolean;
  docker: string;            // docker 版本或 "none"
  curl: boolean;             // 服务器有没有 curl（doctor 靠它探测）
  dns: string[];             // /etc/resolv.conf 里的 nameserver
  currentMirrors: string[];  // 现有 registry-mirrors
  probes: Probe[];
  error?: string;
}

/** 把 curl 退出码 + 错误映射成人话，直接说清"为什么不通"（别再吞报错）。 */
function curlReason(rc: number, code: string, err: string): string {
  if (/^\d{3}$/.test(code) && code !== "000") return "";
  if (rc === 6) return "DNS 解析失败（这台机解析不了域名，查 /etc/resolv.conf）";
  if (rc === 7) return "连接失败（拒绝/无路由/被 RST，可能无外网或防火墙拦）";
  if (rc === 28) return "连接超时（典型被墙/丢包）";
  if ([35, 51, 53, 58, 59, 60, 77, 83].includes(rc)) return "TLS/证书问题";
  if (rc === 5) return "代理解析失败";
  const e = (err || "").replace(/^curl:\s*/i, "").trim();
  return e ? e.slice(0, 80) : rc ? "curl 退出码 " + rc : "无 HTTP 响应";
}

/** 连通性体检：一次 SSH 探所有端点（带真实失败原因）+ curl/DNS/docker/现有镜像。纯只读。 */
export async function doctor(config: Config, target: string): Promise<DoctorResult> {
  const server = getServerOf(config, target);
  const res: DoctorResult = { server: target, reachable: false, docker: "none", curl: false, dns: [], currentMirrors: [], probes: [] };
  try {
    // 每个探测捕获 curl 退出码($?) + 首行错误，别再 2>/dev/null 吞掉真实原因
    const probeLines = PROBES.map(
      (p) =>
        `out=$(curl -sS -o /dev/null -w '%{http_code} %{time_total}' --connect-timeout 8 --max-time 15 ${shQuote(p.url)} 2>/tmp/vle); rc=$?; ` +
        `err=$(tr -d '\\r\\n' </tmp/vle 2>/dev/null | head -c 120); printf 'P|%s|%s|%s|%s\\n' ${shQuote(p.name)} "$out" "$rc" "$err"`
    ).join("\n");
    const cmd =
      `if command -v curl >/dev/null 2>&1; then printf 'CURL|yes\\n';\n${probeLines}\nelse printf 'CURL|no\\n'; fi; ` +
      `printf 'DNS|%s\\n' "$(grep -h '^nameserver' /etc/resolv.conf 2>/dev/null | awk '{print $2}' | tr '\\n' ' ')"; ` +
      `printf 'DOCKER|%s\\n' "$(command -v docker >/dev/null 2>&1 && docker --version 2>/dev/null || echo none)"; ` +
      `printf 'DAEMON|%s\\n' "$(base64 </etc/docker/daemon.json 2>/dev/null | tr -d '\\n')"`;
    const out = (await runOnServer(server, cmd)).stdout;
    res.reachable = true;
    let pi = 0;
    for (const line of out.split("\n")) {
      if (line.startsWith("P|")) {
        const parts = line.split("|"); // P | name | "code time" | rc | err…
        const [code = "000", t = "0"] = (parts[2] || "").trim().split(/\s+/);
        const rc = parseInt(parts[3] || "0", 10) || 0;
        const err = parts.slice(4).join("|");
        const ok = /^\d{3}$/.test(code) && code !== "000"; // 拿到任何 HTTP 响应即可达（401 也算，如 Docker Hub）
        res.probes.push({
          name: parts[1] || PROBES[pi]?.name || "?",
          url: PROBES[pi]?.url || "",
          code,
          timeMs: Math.round(parseFloat(t) * 1000) || 0,
          ok,
          reason: ok ? undefined : curlReason(rc, code, err),
        });
        pi++;
      } else if (line.startsWith("CURL|")) {
        res.curl = line.slice(5).trim() === "yes";
      } else if (line.startsWith("DNS|")) {
        res.dns = line.slice(4).trim().split(/\s+/).filter(Boolean);
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
    // curl 没装：doctor 探不了，明确告知（而不是一排 000 让人误判成没网）
    if (!res.curl && !res.probes.length) {
      for (const p of PROBES) res.probes.push({ name: p.name, url: p.url, code: "—", timeMs: 0, ok: false, reason: "服务器没装 curl，doctor 无法探测（vl run <项目> \"安装 curl\"）" });
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
  // 优先级：命令行显式 > 服务器预设(server.mirrors.docker) > 默认公共源
  const configured = server.mirrors?.docker ?? [];
  const chosen = mirrors.length ? mirrors : configured.length ? configured : DEFAULT_DOCKER_MIRRORS;
  const list = chosen.map((m) => m.trim()).filter(Boolean);
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
