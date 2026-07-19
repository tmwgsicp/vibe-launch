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

/** proxy setup：确保服务器装了 Caddy + 接好 import 接线 + 起服务；检测 80/443 冲突。
 *  opts.caddyUrl：自定义 Caddy 二进制/压缩包下载地址（国内可指镜像绕开 caddyserver.com/cloudsmith 被墙）。
 *  也可用环境变量 VL_CADDY_URL。 */
export async function setupProxy(config: Config, target: string, opts: { caddyUrl?: string } = {}): Promise<ProxyStepResult> {
  const server = getServerOf(config, target);
  const res: ProxyStepResult = { server: target, success: false, steps: [] };
  try {
    const caddyUrl = opts.caddyUrl || process.env.VL_CADDY_URL || undefined;
    // 自定义 URL 会拼进服务器 shell，做基础校验挡注入（只允许 http(s) + 无 shell 元字符）
    if (caddyUrl && (!/^https?:\/\//.test(caddyUrl) || /[\s"'`]|\$\(/.test(caddyUrl)))
      throw new Error(`非法的 --caddy-url：${caddyUrl}（需 http(s):// 且不含空格/引号/反引号/$()）`);
    const S = await sudoPrefix(server);

    // 1. 装 Caddy（已装则跳过）：官方源 apt / copr dnf / 兜底静态二进制 + systemd unit
    const has = (await runOnServer(server, "command -v caddy >/dev/null 2>&1 && echo yes || echo no")).stdout.trim();
    if (has === "yes") {
      res.steps.push("✓ Caddy 已安装");
    } else {
      res.steps.push("服务器没 Caddy，安装中（官方源 / 兜底静态二进制，可能较久）…");
      const inst = await runOnServer(server, installCaddyScript(S, caddyUrl), undefined, 300000);
      if (!inst.stdout.includes("INSTALLED")) {
        // 把脚本回吐的连通性探测 + 各步骤报错原样带出，别再吞
        const diag = inst.stdout.replace(/\bFAILED\b/g, "").trim() || inst.stderr.trim();
        throw new Error(
          "自动安装 Caddy 失败。国内服务器常见原因：caddyserver.com / dl.cloudsmith.io 下载被墙或超时。\n" +
            "破解办法：① 手动装好 Caddy 再重跑本命令（会自动跳过安装、只做接线）；" +
            "② proxy setup --caddy-url <国内可达的二进制地址>（或设环境变量 VL_CADDY_URL）。\n" +
            "── 服务器诊断 ──\n" + diag.slice(-1500)
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

/** 跨发行版装 Caddy 的脚本：官方 apt 源 → dnf copr → 兜底静态二进制 + systemd unit。S 是 sudo 前缀。
 *  所有步骤的报错都收进日志 /tmp/vl-caddy-install.log，失败时连同连通性探测一起回吐（别再 2>/dev/null 吞掉）。
 *  caddyUrl：自定义二进制/压缩包地址（国内镜像）。已 setupProxy 校验过合法性，这里单引号包裹再防一层。 */
function installCaddyScript(S: string, caddyUrl?: string): string {
  // 默认走官方下载 API（双引号让 $A 展开，URL 由我们固定、安全）；自定义 URL 单引号包裹不展开、防注入
  const DL = caddyUrl ? `'${caddyUrl}'` : `"https://caddyserver.com/api/download?os=linux&arch=$A"`;
  return [
    `L=/tmp/vl-caddy-install.log; : > "$L"`,
    `if command -v caddy >/dev/null 2>&1; then echo INSTALLED; exit 0; fi`,
    // 连通性探测：把国内网络问题直接摆出来（是超时/被墙还是别的）
    `echo "== 连通性探测（HTTP 码，000/TIMEOUT=不通）==" >>"$L"`,
    `for u in https://dl.cloudsmith.io https://caddyserver.com https://github.com; do`,
    `  c=$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 8 --max-time 15 "$u" 2>>"$L" || echo TIMEOUT); echo "  $u -> $c" >>"$L";`,
    `done`,
    // Debian/Ubuntu：官方 cloudsmith 源
    `if command -v apt-get >/dev/null 2>&1; then`,
    `  echo "== 尝试 apt（Caddy 官方源）==" >>"$L"`,
    `  { ${S}apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg; ` +
      `curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | ${S}gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg; ` +
      `curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | ${S}tee /etc/apt/sources.list.d/caddy-stable.list; ` +
      `${S}apt-get update -qq && ${S}apt-get install -y -qq caddy; } >>"$L" 2>&1`,
    `  if command -v caddy >/dev/null 2>&1; then echo INSTALLED; exit 0; fi`,
    `fi`,
    // Fedora/RHEL：copr
    `if command -v dnf >/dev/null 2>&1; then`,
    `  echo "== 尝试 dnf copr ==" >>"$L"`,
    `  { ${S}dnf install -y -q 'dnf-command(copr)'; ${S}dnf copr enable -y @caddy/caddy; ${S}dnf install -y -q caddy; } >>"$L" 2>&1`,
    `  if command -v caddy >/dev/null 2>&1; then echo INSTALLED; exit 0; fi`,
    `fi`,
    // 兜底：下载静态二进制（或 .tar.gz）+ 建 caddy 用户 + systemd unit
    `ARCH=$(uname -m); case "$ARCH" in x86_64|amd64) A=amd64;; aarch64|arm64) A=arm64;; armv7l) A=armv7;; *) A=amd64;; esac`,
    `echo "== 尝试静态二进制 ==" >>"$L"`,
    `if curl -fSL ${DL} -o /tmp/caddy.dl >>"$L" 2>&1; then`,
    // 是 tar.gz 就解出 caddy，否则当作裸二进制
    `  if tar -tzf /tmp/caddy.dl >/dev/null 2>&1; then ${S}tar -xzf /tmp/caddy.dl -C /tmp caddy >>"$L" 2>&1; ${S}install -m 0755 /tmp/caddy /usr/local/bin/caddy >>"$L" 2>&1; else ${S}install -m 0755 /tmp/caddy.dl /usr/local/bin/caddy >>"$L" 2>&1; fi`,
    `  rm -f /tmp/caddy.dl /tmp/caddy`,
    `  ${S}groupadd --system caddy 2>/dev/null || true`,
    `  ${S}useradd --system --gid caddy --home-dir /var/lib/caddy --shell /usr/sbin/nologin caddy 2>/dev/null || ${S}useradd -r -d /var/lib/caddy caddy 2>/dev/null || true`,
    `  ${S}mkdir -p /etc/caddy /var/lib/caddy && ${S}chown -R caddy:caddy /var/lib/caddy 2>/dev/null || true`,
    `  if command -v systemctl >/dev/null 2>&1; then`,
    `    printf '%s\\n' '[Unit]' 'Description=Caddy' 'After=network.target network-online.target' 'Requires=network-online.target' '' '[Service]' 'User=caddy' 'Group=caddy' 'ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile' 'ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --force' 'TimeoutStopSec=5s' 'LimitNOFILE=1048576' 'PrivateTmp=true' 'ProtectSystem=full' 'AmbientCapabilities=CAP_NET_BIND_SERVICE' '' '[Install]' 'WantedBy=multi-user.target' | ${S}tee /etc/systemd/system/caddy.service >/dev/null`,
    `    ${S}systemctl daemon-reload 2>/dev/null || true`,
    `  fi`,
    `  if command -v caddy >/dev/null 2>&1; then echo INSTALLED; exit 0; fi`,
    `fi`,
    // 全败：回吐诊断（连通性 + 各步骤最后的报错）
    `echo FAILED`,
    `echo "---- 服务器安装诊断（tail）----"; tail -40 "$L"`,
  ].join("\n");
}
