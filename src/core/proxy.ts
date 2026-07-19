// 声明式反代（vl proxy）：把项目配置里的 proxy 段（域名→上游）落成一个 Caddy 站点块，reload 生效。
// 为什么 Caddy：自动 HTTPS（证书签发/续期零配置）、配置极简、单二进制 —— 比 OpenResty 轻得多。
// 管理方式：主 /etc/caddy/Caddyfile 里一行 `import /etc/caddy/vibe-launch.d/*.caddy`，
// 每个项目一个 <project>.caddy 站点块。透明、可手查、不自造反代面板（那是 1Panel 的活）。
//
// 共存：一台机 80/443 只能一个主人。裸机让 Caddy 独占（本模块）；已被 1Panel/nginx 占的机器，
// setup 会检测到冲突并告警 —— 那种场景走"喂现有反代"（尚未实现），别硬上 Caddy 抢端口。
import type { Config, ProxyConfig, ServerConfig } from "./types.js";
import { getProject, getServerOf } from "./config.js";
import { runOnServer } from "./ssh.js";
import { shQuote as q } from "./sh.js";

const SITE_DIR = "/etc/caddy/vibe-launch.d";
const CADDYFILE = "/etc/caddy/Caddyfile";
const IMPORT_LINE = "import /etc/caddy/vibe-launch.d/*.caddy";

// 域名：字母数字 + . - *（通配），且必须含点。上游：host:port。项目名（当文件名）：安全字符集。
const validDomain = (d: string) => /^[A-Za-z0-9.*-]+$/.test(d) && d.includes(".");
const validUpstream = (u: string) => /^[A-Za-z0-9.\-]+:\d{1,5}$/.test(u);
const safeName = (n: string) => /^[A-Za-z0-9._-]+$/.test(n);

/** 取 sudo 前缀：非 root 用户加 sudo，root 则空。 */
async function sudoPrefix(server: ServerConfig): Promise<string> {
  const uid = (await runOnServer(server, "id -u")).stdout.trim();
  return uid === "0" ? "" : "sudo ";
}

/** 校验并规整 proxy 配置，返回站点块内容。 */
function siteBlock(proj: string, p: ProxyConfig): string {
  const domains = p.domain.trim().split(/[\s,]+/).filter(Boolean);
  if (!domains.length) throw new Error("proxy.domain 为空");
  for (const d of domains) if (!validDomain(d)) throw new Error(`非法域名：${d}`);
  if (!p.upstream || !validUpstream(p.upstream)) throw new Error(`非法上游（应为 host:port）：${p.upstream}`);
  const tls = p.tls !== false;
  // tls=false 时给每个域名加 http:// 前缀，关掉 Caddy 的自动 HTTPS
  const addr = tls ? domains.join(", ") : domains.map((d) => `http://${d}`).join(", ");
  return `# managed by vibe-launch (project: ${proj}) — 勿手改，用 vl proxy apply/rm\n${addr} {\n\treverse_proxy ${p.upstream}\n}\n`;
}

export interface ProxyStepResult {
  server: string;
  success: boolean;
  steps: string[];
  error?: string;
}

/** proxy setup：确保服务器装了 Caddy + 接好 import 接线 + 起服务；检测 80/443 冲突。 */
export async function setupProxy(config: Config, target: string): Promise<ProxyStepResult> {
  const server = getServerOf(config, target);
  const res: ProxyStepResult = { server: target, success: false, steps: [] };
  try {
    const S = await sudoPrefix(server);

    // 1. 装 Caddy（已装则跳过）：官方源 apt / copr dnf / 兜底静态二进制 + systemd unit
    const has = (await runOnServer(server, "command -v caddy >/dev/null 2>&1 && echo yes || echo no")).stdout.trim();
    if (has === "yes") {
      res.steps.push("✓ Caddy 已安装");
    } else {
      res.steps.push("服务器没 Caddy，安装中（官方源 / 兜底静态二进制）…");
      const inst = await runOnServer(server, installCaddyScript(S), undefined, 300000);
      if (!inst.stdout.includes("INSTALLED")) {
        throw new Error(
          "自动安装 Caddy 失败。请手动装（见 https://caddyserver.com/docs/install）后重试。\n" +
            (inst.stderr || inst.stdout || "").trim().slice(-500)
        );
      }
      res.steps.push("✓ Caddy 已安装");
    }

    // 2. 接线：建站点目录 + 主 Caddyfile 里补 import（幂等）
    await runOnServer(
      server,
      `${S}mkdir -p ${SITE_DIR} && ${S}touch ${CADDYFILE} && ` +
        `(grep -qF ${q(IMPORT_LINE)} ${CADDYFILE} || echo ${q(IMPORT_LINE)} | ${S}tee -a ${CADDYFILE} >/dev/null)`
    );
    res.steps.push(`✓ 已接线（${SITE_DIR}/ + Caddyfile import）`);

    // 3. 起服务（systemd）
    await runOnServer(server, `command -v systemctl >/dev/null 2>&1 && ${S}systemctl enable --now caddy 2>/dev/null || true`);
    res.steps.push("✓ 已启用并启动 Caddy 服务");

    // 4. 80/443 冲突检测（被非 Caddy 进程占则告警：多半是 1Panel/nginx，别硬抢端口）
    const conflict = (
      await runOnServer(server, `${S}ss -ltnp 2>/dev/null | grep -E ':(80|443)\\b' | grep -vi caddy || true`)
    ).stdout.trim();
    if (conflict) {
      res.steps.push("⚠ 80/443 被非 Caddy 进程占用（可能是 1Panel/OpenResty/nginx）：");
      for (const l of conflict.split("\n").slice(0, 4)) res.steps.push("    " + l.trim());
      res.steps.push("  这台机上 Caddy 会抢不到端口。要么迁走占用方，要么这台走'喂现有反代'（暂未支持）。");
    }

    res.success = true;
    return res;
  } catch (e) {
    res.error = (e as Error).message;
    return res;
  }
}

export interface ProxyApplyResult {
  project: string;
  server: string;
  domain: string;
  file: string;
  success: boolean;
  steps: string[];
  error?: string;
}

/** proxy apply：把项目的 proxy 段写成站点块 → caddy validate（坏配置回滚）→ reload。 */
export async function applyProxy(config: Config, projectName: string): Promise<ProxyApplyResult> {
  const { project, server, serverName } = getProject(config, projectName);
  const res: ProxyApplyResult = { project: projectName, server: serverName, domain: "", file: "", success: false, steps: [] };
  try {
    if (!safeName(projectName)) throw new Error(`项目名含非法字符，无法作为站点文件名：${projectName}`);
    if (!project.proxy) throw new Error("项目未配置 proxy 段（domain / upstream / tls）");
    const block = siteBlock(projectName, project.proxy);
    res.domain = project.proxy.domain;

    const has = (await runOnServer(server, "command -v caddy >/dev/null 2>&1 && echo yes || echo no")).stdout.trim();
    if (has !== "yes") throw new Error(`服务器还没装 Caddy，先跑：vl proxy setup ${serverName}`);

    const S = await sudoPrefix(server);
    const file = `${SITE_DIR}/${projectName}.caddy`;
    res.file = file;

    // 接线兜底（幂等）：万一没 setup 过也能补上目录 + import
    await runOnServer(
      server,
      `${S}mkdir -p ${SITE_DIR} && ${S}touch ${CADDYFILE} && ` +
        `(grep -qF ${q(IMPORT_LINE)} ${CADDYFILE} || echo ${q(IMPORT_LINE)} | ${S}tee -a ${CADDYFILE} >/dev/null)`
    );

    // 写块（base64 免引号地狱）→ validate；坏了就回滚（有旧块恢复、没有则删），绝不 reload 坏配置
    const b64 = Buffer.from(block, "utf8").toString("base64");
    const script =
      `F=${file}; [ -f "$F" ] && ${S}cp "$F" "$F.vlbak"; ` +
      `printf %s ${q(b64)} | base64 -d | ${S}tee "$F" >/dev/null && ` +
      `if ${S}caddy validate --adapter caddyfile --config ${CADDYFILE} >/tmp/vlcaddyval 2>&1; then ` +
      `  ${S}rm -f "$F.vlbak"; echo __VALID__; ` +
      `else ` +
      `  if [ -f "$F.vlbak" ]; then ${S}mv "$F.vlbak" "$F"; else ${S}rm -f "$F"; fi; ` +
      `  echo __INVALID__; cat /tmp/vlcaddyval; ` +
      `fi`;
    const w = await runOnServer(server, script);
    if (w.stdout.includes("__INVALID__")) {
      throw new Error(`Caddy 配置校验失败（已回滚，未生效）：\n${w.stdout.split("__INVALID__")[1]?.trim().slice(0, 600)}`);
    }
    if (!w.stdout.includes("__VALID__")) throw new Error(`写入站点块失败：${(w.stderr || w.stdout).trim()}`);
    res.steps.push(`✓ 站点块已写入 ${file}`);

    // reload（优雅、零停机）：systemd 优先，退回 caddy reload
    const r = await runOnServer(
      server,
      `${S}systemctl reload caddy 2>/dev/null || ${S}caddy reload --config ${CADDYFILE} 2>&1`
    );
    if (r.code !== 0) throw new Error(`reload 失败：${(r.stderr || r.stdout).trim().slice(0, 400)}`);
    res.steps.push(`✓ 已 reload，${res.domain} 反代到 ${project.proxy.upstream}`);
    res.steps.push(`  提示：确保 ${res.domain} 的 DNS 已指向本机${project.proxy.tls !== false ? "，首次访问 Caddy 会自动签证书（需 80/443 可达）" : ""}`);

    res.success = true;
    return res;
  } catch (e) {
    res.error = (e as Error).message;
    return res;
  }
}

/** proxy rm：删掉项目的站点块并 reload。 */
export async function removeProxy(config: Config, projectName: string): Promise<ProxyApplyResult> {
  const { server, serverName } = getProject(config, projectName);
  const res: ProxyApplyResult = { project: projectName, server: serverName, domain: "", file: "", success: false, steps: [] };
  try {
    if (!safeName(projectName)) throw new Error(`项目名含非法字符：${projectName}`);
    const S = await sudoPrefix(server);
    const file = `${SITE_DIR}/${projectName}.caddy`;
    res.file = file;
    const exists = (await runOnServer(server, `test -f ${file} && echo yes || echo no`)).stdout.trim();
    if (exists !== "yes") {
      res.steps.push("站点块不存在（无需删除）");
      res.success = true;
      return res;
    }
    await runOnServer(server, `${S}rm -f ${file}`);
    res.steps.push(`✓ 已删除 ${file}`);
    const r = await runOnServer(server, `${S}systemctl reload caddy 2>/dev/null || ${S}caddy reload --config ${CADDYFILE} 2>&1`);
    if (r.code !== 0) res.steps.push(`⚠ reload 未成功：${(r.stderr || r.stdout).trim().slice(0, 200)}`);
    else res.steps.push("✓ 已 reload");
    res.success = true;
    return res;
  } catch (e) {
    res.error = (e as Error).message;
    return res;
  }
}

export interface ProxySite {
  project: string;
  content: string;
}

/** proxy ls：列出某服务器上 vibe-launch 管理的站点块。 */
export async function listProxy(config: Config, target: string): Promise<ProxySite[]> {
  const server = getServerOf(config, target);
  const r = await runOnServer(
    server,
    `for f in ${SITE_DIR}/*.caddy; do [ -e "$f" ] || continue; echo "===VL===$(basename "$f" .caddy)"; cat "$f"; done 2>/dev/null`
  );
  const out: ProxySite[] = [];
  for (const chunk of r.stdout.split("===VL===")) {
    const nl = chunk.indexOf("\n");
    if (nl < 0) continue;
    const project = chunk.slice(0, nl).trim();
    if (project) out.push({ project, content: chunk.slice(nl + 1).replace(/\n$/, "") });
  }
  return out;
}

/** 跨发行版装 Caddy 的脚本：官方 apt 源 → dnf copr → 兜底静态二进制 + systemd unit。S 是 sudo 前缀。 */
function installCaddyScript(S: string): string {
  return [
    `if command -v caddy >/dev/null 2>&1; then echo INSTALLED; exit 0; fi`,
    // Debian/Ubuntu：官方 cloudsmith 源
    `if command -v apt-get >/dev/null 2>&1; then`,
    `  ${S}apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg >/dev/null 2>&1 || true`,
    `  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | ${S}gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null || true`,
    `  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | ${S}tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null 2>&1 || true`,
    `  ${S}apt-get update -qq >/dev/null 2>&1 || true; ${S}apt-get install -y -qq caddy >/dev/null 2>&1 || true`,
    `  if command -v caddy >/dev/null 2>&1; then echo INSTALLED; exit 0; fi`,
    `fi`,
    // Fedora/RHEL：copr
    `if command -v dnf >/dev/null 2>&1; then`,
    `  ${S}dnf install -y -q 'dnf-command(copr)' >/dev/null 2>&1 || true; ${S}dnf copr enable -y @caddy/caddy >/dev/null 2>&1 || true; ${S}dnf install -y -q caddy >/dev/null 2>&1 || true`,
    `  if command -v caddy >/dev/null 2>&1; then echo INSTALLED; exit 0; fi`,
    `fi`,
    // 兜底：官方下载 API 拉静态二进制 + 建 caddy 用户 + systemd unit
    `ARCH=$(uname -m); case "$ARCH" in x86_64|amd64) A=amd64;; aarch64|arm64) A=arm64;; armv7l) A=armv7;; *) A=amd64;; esac`,
    `if curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=$A" -o /tmp/caddy.dl 2>/dev/null; then`,
    `  ${S}install -m 0755 /tmp/caddy.dl /usr/local/bin/caddy && rm -f /tmp/caddy.dl`,
    `  ${S}groupadd --system caddy 2>/dev/null || true`,
    `  ${S}useradd --system --gid caddy --home-dir /var/lib/caddy --shell /usr/sbin/nologin caddy 2>/dev/null || ${S}useradd -r -d /var/lib/caddy caddy 2>/dev/null || true`,
    `  ${S}mkdir -p /etc/caddy /var/lib/caddy && ${S}chown -R caddy:caddy /var/lib/caddy 2>/dev/null || true`,
    `  if command -v systemctl >/dev/null 2>&1; then`,
    `    printf '%s\\n' '[Unit]' 'Description=Caddy' 'After=network.target network-online.target' 'Requires=network-online.target' '' '[Service]' 'User=caddy' 'Group=caddy' 'ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile' 'ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --force' 'TimeoutStopSec=5s' 'LimitNOFILE=1048576' 'PrivateTmp=true' 'ProtectSystem=full' 'AmbientCapabilities=CAP_NET_BIND_SERVICE' '' '[Install]' 'WantedBy=multi-user.target' | ${S}tee /etc/systemd/system/caddy.service >/dev/null`,
    `    ${S}systemctl daemon-reload 2>/dev/null || true`,
    `  fi`,
    `  if command -v caddy >/dev/null 2>&1; then echo INSTALLED; exit 0; fi`,
    `fi`,
    `echo FAILED`,
  ].join("\n");
}
