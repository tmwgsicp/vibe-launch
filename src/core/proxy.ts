// 声明式反代（vl proxy）：把项目配置里的 proxy 段（域名→上游）落成一个站点配置，校验后 reload 生效。
// 一台机 80/443 只能一个主人，按服务器现状自动选引擎：
//   - 已有 1Panel OpenResty（容器占 80/443）→ 直接写进它的 conf.d（vl-<项目>.conf），不装 Caddy、不抢端口；
//   - 否则 → Caddy：主 /etc/caddy/Caddyfile 一行 import，每个项目一个 <project>.caddy。
// 证书：Caddy 默认自动签 Let's Encrypt；也可用 vl proxy cert add 存进来的证书（如 Cloudflare 源站证书）。
// Cloudflare 橙色云朵 + 完全(严格) 下，Let's Encrypt 首签可能走不通，源站证书更稳。OpenResty 引擎只支持自带证书。
import { readFileSync } from "node:fs";
import type { Config, ProxyConfig, ServerConfig } from "./types.js";
import { getProject, getServerOf } from "./config.js";
import { runOnServer } from "./ssh.js";
import { shQuote as q } from "./sh.js";
import { recordOp } from "./oplog.js";

const SITE_DIR = "/etc/caddy/vibe-launch.d";
const CADDYFILE = "/etc/caddy/Caddyfile";
const IMPORT_LINE = "import /etc/caddy/vibe-launch.d/*.caddy";
const CADDY_CERT_DIR = "/etc/caddy/certs";
// 1Panel OpenResty 容器内的路径（宿主路径从 docker inspect 的挂载反查，不写死）
const OR_CONF_IN = "/usr/local/openresty/nginx/conf/conf.d";
const OR_WWW_IN = "/www";
const OR_CERT_SUB = "vibe-launch/certs";

// 域名：字母数字 + . - *（通配），且必须含点。上游：host:port。项目名/证书名（当文件名）：安全字符集。
const validDomain = (d: string) => /^[A-Za-z0-9.*-]+$/.test(d) && d.includes(".");
const validUpstream = (u: string) => /^[A-Za-z0-9.\-]+:\d{1,5}$/.test(u);
const safeName = (n: string) => /^[A-Za-z0-9._-]+$/.test(n) && !n.startsWith(".");

/** 取 sudo 前缀：非 root 用户加 sudo，root 则空。 */
async function sudoPrefix(server: ServerConfig): Promise<string> {
  const uid = (await runOnServer(server, "id -u")).stdout.trim();
  return uid === "0" ? "" : "sudo ";
}

type Engine =
  | { kind: "caddy" }
  | { kind: "openresty"; container: string; confDir: string; wwwDir: string; hostNet: boolean };

/** 看这台机的 80/443 归谁：有 1Panel OpenResty 容器就喂它，否则走 Caddy。 */
async function detectEngine(server: ServerConfig, S: string): Promise<Engine> {
  const r = await runOnServer(
    server,
    `C=$(${S}docker ps --format '{{.Names}}' 2>/dev/null | grep -i openresty | head -1); ` +
      `[ -n "$C" ] && echo "OR|$C|$(${S}docker inspect "$C" --format '{{.HostConfig.NetworkMode}}{{range .Mounts}}|{{.Source}}={{.Destination}}{{end}}')"; true`
  );
  const line = r.stdout.split("\n").find((l) => l.startsWith("OR|"));
  if (!line) return { kind: "caddy" };
  const [, container, net, ...mounts] = line.trim().split("|");
  const src = (dest: string) => mounts.find((m) => m.endsWith("=" + dest))?.split("=")[0];
  const confDir = src(OR_CONF_IN);
  const wwwDir = src(OR_WWW_IN);
  if (!confDir || !wwwDir)
    throw new Error(`发现 OpenResty 容器 ${container}，但不是 1Panel 的目录布局（找不到 conf.d / www 挂载），暂不支持自动写入`);
  return { kind: "openresty", container, confDir, wwwDir, hostNet: net === "host" };
}

/** 证书库在宿主机上的根目录。 */
const certBase = (engine: Engine) => (engine.kind === "caddy" ? CADDY_CERT_DIR : `${engine.wwwDir}/${OR_CERT_SUB}`);

/** 证书在服务器上的位置：引擎读取用的路径 + 宿主机上的目录。 */
function certPaths(engine: Engine, name: string) {
  const inDir = engine.kind === "caddy" ? `${CADDY_CERT_DIR}/${name}` : `${OR_WWW_IN}/${OR_CERT_SUB}/${name}`;
  return { hostDir: `${certBase(engine)}/${name}`, cert: `${inDir}/fullchain.pem`, key: `${inDir}/privkey.pem` };
}

function parseDomains(p: ProxyConfig): string[] {
  const domains = p.domain.trim().split(/[\s,]+/).filter(Boolean);
  if (!domains.length) throw new Error("proxy.domain 为空");
  for (const d of domains) if (!validDomain(d)) throw new Error(`非法域名：${d}`);
  if (!p.upstream || !validUpstream(p.upstream)) throw new Error(`非法上游（应为 host:port）：${p.upstream}`);
  if (p.cert && !safeName(p.cert)) throw new Error(`非法证书名：${p.cert}`);
  return domains;
}

/** Caddy 站点块。tls=false 加 http:// 前缀关掉自动 HTTPS；配了 cert 则用自带证书、不去签。 */
function caddyBlock(proj: string, p: ProxyConfig, engine: Engine): string {
  const domains = parseDomains(p);
  const tls = p.tls !== false;
  const addr = tls ? domains.join(", ") : domains.map((d) => `http://${d}`).join(", ");
  const c = tls && p.cert ? certPaths(engine, p.cert) : null;
  const tlsLine = c ? `\ttls ${c.cert} ${c.key}\n` : "";
  return `# managed by vibe-launch (project: ${proj}) — 勿手改，用 vl proxy apply/rm\n${addr} {\n${tlsLine}\treverse_proxy ${p.upstream}\n}\n`;
}

/** OpenResty server 块，写法对齐 1Panel 自己生成的站点（http 跳 https、WebSocket 头）。 */
function openrestyBlock(proj: string, p: ProxyConfig, engine: Engine): string {
  const domains = parseDomains(p);
  const tls = p.tls !== false;
  if (tls && !p.cert)
    throw new Error("这台机由 1Panel OpenResty 管 80/443，HTTPS 需要自带证书：先 vl proxy cert add，再给项目配 proxy.cert（或 tls=false 只走 http）");
  const lines = [
    `# managed by vibe-launch (project: ${proj}) — 勿手改，用 vl proxy apply/rm`,
    "server {",
    "    listen 80;",
  ];
  if (tls) {
    const c = certPaths(engine, p.cert!);
    lines.push(
      "    listen 443 ssl http2;",
      `    server_name ${domains.join(" ")};`,
      `    ssl_certificate ${c.cert};`,
      `    ssl_certificate_key ${c.key};`,
      "    ssl_protocols TLSv1.3 TLSv1.2;",
      "    ssl_session_cache shared:SSL:10m;",
      "    if ($scheme = http) {",
      "        return 301 https://$host$request_uri;",
      "    }"
    );
  } else {
    lines.push(`    server_name ${domains.join(" ")};`);
  }
  lines.push(
    "    location / {",
    `        proxy_pass http://${p.upstream};`,
    "        proxy_set_header Host $host;",
    "        proxy_set_header X-Real-IP $remote_addr;",
    "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
    "        proxy_set_header X-Forwarded-Proto $scheme;",
    "        proxy_http_version 1.1;",
    "        proxy_set_header Upgrade $http_upgrade;",
    "        proxy_set_header Connection $http_connection;",
    "    }",
    "}"
  );
  return lines.join("\n") + "\n";
}

/** 引擎相关的文件位置与校验/重载命令。 */
function engineOps(engine: Engine, S: string, projectName: string) {
  if (engine.kind === "caddy") {
    return {
      label: "Caddy",
      file: `${SITE_DIR}/${projectName}.caddy`,
      validate: `${S}caddy validate --adapter caddyfile --config ${CADDYFILE}`,
      reload: `${S}systemctl reload caddy 2>/dev/null || ${S}caddy reload --config ${CADDYFILE} 2>&1`,
    };
  }
  const exec = `${S}docker exec ${q(engine.container)} openresty`;
  return {
    label: `1Panel OpenResty（${engine.container}）`,
    file: `${engine.confDir}/vl-${projectName}.conf`,
    validate: `${exec} -t`,
    reload: `${exec} -s reload 2>&1`,
  };
}

export interface ProxyStepResult {
  server: string;
  success: boolean;
  steps: string[];
  error?: string;
}

/** proxy setup：1Panel 机器只做识别（无需安装）；其余机器装 Caddy + 接 import + 起服务，并检测 80/443 冲突。
 *  opts.caddyUrl：自定义 Caddy 二进制/压缩包下载地址（国内可指镜像绕开 caddyserver.com/cloudsmith 被墙）。
 *  也可用环境变量 VL_CADDY_URL。 */
export async function setupProxy(config: Config, target: string, opts: { caddyUrl?: string } = {}): Promise<ProxyStepResult> {
  const server = getServerOf(config, target);
  const res: ProxyStepResult = { server: target, success: false, steps: [] };
  try {
    const S = await sudoPrefix(server);
    const engine = await detectEngine(server, S);
    if (engine.kind === "openresty") {
      res.steps.push(`✓ 检测到 1Panel OpenResty（${engine.container}）管着 80/443，vl proxy 会直接写进它的 conf.d，不装 Caddy`);
      res.steps.push(`  站点文件：${engine.confDir}/vl-<项目>.conf`);
      if (!engine.hostNet) res.steps.push("  ⚠ 容器不是 host 网络，上游写 127.0.0.1 访问不到宿主服务，请用宿主内网 IP");
      res.steps.push("  HTTPS 需自带证书：vl proxy cert add <服务器> <名字> --cert … --key …，再给项目配 proxy.cert");
      res.success = true;
      recordOp("proxy-setup", target, true, "openresty");
      return res;
    }

    // 优先级：命令行显式 > 服务器预设(server.mirrors.caddyUrl) > 环境变量 > 默认官方源
    const caddyUrl = opts.caddyUrl || server.mirrors?.caddyUrl || process.env.VL_CADDY_URL || undefined;
    // 自定义 URL 会拼进服务器 shell，做基础校验挡注入（只允许 http(s) + 无 shell 元字符）
    if (caddyUrl && (!/^https?:\/\//.test(caddyUrl) || /[\s"'`]|\$\(/.test(caddyUrl)))
      throw new Error(`非法的 --caddy-url：${caddyUrl}（需 http(s):// 且不含空格/引号/反引号/$()）`);

    // 1. 先查 80/443：被别的进程（宿主机 nginx 等）占着就停，不装不启，别留一个抢不到端口的 Caddy
    const conflict = (
      await runOnServer(server, `${S}ss -ltnp 2>/dev/null | grep -E ':(80|443)\\b' | grep -vi caddy || true`)
    ).stdout.trim();
    if (conflict) {
      throw new Error(
        "80/443 已被其它进程占用，未安装 Caddy：\n" +
          conflict.split("\n").slice(0, 4).map((l) => "    " + l.trim()).join("\n") +
          "\n  要么迁走占用方，要么把站点交给现有的 nginx 手工配置。"
      );
    }

    // 2. 装 Caddy（已装则跳过）：官方源 apt / copr dnf / 兜底静态二进制 + systemd unit
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
      // 安装包自带的 Caddyfile 是一个 :80 欢迎页，会白占 80 端口；刚装的就换成只 import 我们的站点
      await runOnServer(
        server,
        `grep -q '/usr/share/caddy' ${CADDYFILE} 2>/dev/null && ` +
          `printf '%s\\n' '# managed by vibe-launch：站点在 vibe-launch.d/，用 vl proxy apply/rm 管理' ${q(IMPORT_LINE)} | ${S}tee ${CADDYFILE} >/dev/null; true`
      );
    }

    // 3. 接线：建站点目录 + 主 Caddyfile 里补 import（幂等）
    await runOnServer(
      server,
      `${S}mkdir -p ${SITE_DIR} && ${S}touch ${CADDYFILE} && ` +
        `(grep -qF ${q(IMPORT_LINE)} ${CADDYFILE} || echo ${q(IMPORT_LINE)} | ${S}tee -a ${CADDYFILE} >/dev/null)`
    );
    res.steps.push(`✓ 已接线（${SITE_DIR}/ + Caddyfile import）`);

    // 4. 起服务（systemd）。apt 装完已用默认配置起了，所以是 reload-or-restart 而不只 --now
    await runOnServer(
      server,
      `command -v systemctl >/dev/null 2>&1 && ${S}systemctl enable caddy 2>/dev/null && ${S}systemctl reload-or-restart caddy 2>/dev/null || true`
    );
    res.steps.push("✓ 已启用并启动 Caddy 服务");

    res.success = true;
    recordOp("proxy-setup", target, true);
    return res;
  } catch (e) {
    res.error = (e as Error).message;
    recordOp("proxy-setup", target, false, res.error);
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

/** proxy apply：把项目的 proxy 段写成站点配置 → 校验（坏配置回滚）→ reload。 */
export async function applyProxy(config: Config, projectName: string): Promise<ProxyApplyResult> {
  const { project, server, serverName } = getProject(config, projectName);
  const res: ProxyApplyResult = { project: projectName, server: serverName, domain: "", file: "", success: false, steps: [] };
  try {
    if (!safeName(projectName)) throw new Error(`项目名含非法字符，无法作为站点文件名：${projectName}`);
    if (!project.proxy) throw new Error("项目未配置 proxy 段（domain / upstream / tls）");
    res.domain = project.proxy.domain;

    const S = await sudoPrefix(server);
    const engine = await detectEngine(server, S);
    const ops = engineOps(engine, S, projectName);
    res.file = ops.file;
    let block: string;

    if (engine.kind === "caddy") {
      block = caddyBlock(projectName, project.proxy, engine);
      const has = (await runOnServer(server, "command -v caddy >/dev/null 2>&1 && echo yes || echo no")).stdout.trim();
      if (has !== "yes") throw new Error(`服务器还没装 Caddy，先跑：vl proxy setup ${serverName}`);
      // 接线兜底（幂等）：万一没 setup 过也能补上目录 + import
      await runOnServer(
        server,
        `${S}mkdir -p ${SITE_DIR} && ${S}touch ${CADDYFILE} && ` +
          `(grep -qF ${q(IMPORT_LINE)} ${CADDYFILE} || echo ${q(IMPORT_LINE)} | ${S}tee -a ${CADDYFILE} >/dev/null)`
      );
    } else {
      block = openrestyBlock(projectName, project.proxy, engine);
      // 1Panel 里已有同域名站点就拒绝：两个 server 块抢一个域名，生效哪个说不准
      for (const d of parseDomains(project.proxy)) {
        const re = `server_name[^;]*[[:space:]]${d.replace(/[.*]/g, (m) => "\\" + m)}([[:space:];]|$)`;
        const dup = (
          await runOnServer(server, `${S}grep -lE ${q(re)} ${q(engine.confDir)}/*.conf 2>/dev/null | grep -vF ${q(ops.file)} || true`)
        ).stdout.trim();
        if (dup) throw new Error(`域名 ${d} 已在 1Panel 站点里配置（${dup.split("\n")[0]}），先在 1Panel 删掉该站点，或换个域名`);
      }
    }

    if (project.proxy.tls !== false && project.proxy.cert) {
      const c = certPaths(engine, project.proxy.cert);
      const ok = (await runOnServer(server, `${S}test -s ${q(c.hostDir)}/fullchain.pem && ${S}test -s ${q(c.hostDir)}/privkey.pem && echo yes || echo no`)).stdout.trim();
      if (ok !== "yes") throw new Error(`服务器上没有证书 ${project.proxy.cert}，先跑：vl proxy cert add ${serverName} ${project.proxy.cert} --cert … --key …`);
      // 证书可能是装 Caddy 之前存的（当时还没有 caddy 用户），私钥 600 归 root 时 Caddy 读不到
      if (engine.kind === "caddy") await runOnServer(server, `id caddy >/dev/null 2>&1 && ${S}chown -R caddy:caddy ${q(c.hostDir)}; true`);
    }

    // 写块（base64 免引号地狱）→ 校验；坏了就回滚（有旧块恢复、没有则删），绝不 reload 坏配置
    const b64 = Buffer.from(block, "utf8").toString("base64");
    const script =
      `F=${q(ops.file)}; [ -f "$F" ] && ${S}cp "$F" "$F.vlbak"; ` +
      `printf %s ${q(b64)} | base64 -d | ${S}tee "$F" >/dev/null && ` +
      `if ${ops.validate} >/tmp/vlproxyval 2>&1; then ` +
      `  ${S}rm -f "$F.vlbak"; echo __VALID__; ` +
      `else ` +
      `  if [ -f "$F.vlbak" ]; then ${S}mv "$F.vlbak" "$F"; else ${S}rm -f "$F"; fi; ` +
      `  echo __INVALID__; cat /tmp/vlproxyval; ` +
      `fi`;
    const w = await runOnServer(server, script);
    if (w.stdout.includes("__INVALID__")) {
      throw new Error(`${ops.label} 配置校验失败（已回滚，未生效）：\n${w.stdout.split("__INVALID__")[1]?.trim().slice(0, 600)}`);
    }
    if (!w.stdout.includes("__VALID__")) throw new Error(`写入站点配置失败：${(w.stderr || w.stdout).trim()}`);
    res.steps.push(`✓ 站点配置已写入 ${ops.file}（${ops.label}）`);

    const r = await runOnServer(server, ops.reload);
    if (r.code !== 0) throw new Error(`reload 失败：${(r.stderr || r.stdout).trim().slice(0, 400)}`);
    res.steps.push(`✓ 已 reload，${res.domain} 反代到 ${project.proxy.upstream}`);
    const autoCert = engine.kind === "caddy" && project.proxy.tls !== false && !project.proxy.cert;
    res.steps.push(`  提示：确保 ${res.domain} 的 DNS 已指向本机${autoCert ? "，首次访问 Caddy 会自动签证书（需 80/443 可达；Cloudflare 橙色云朵下建议改用 proxy.cert）" : ""}`);

    res.success = true;
    recordOp("proxy-apply", projectName, true, res.domain + " → " + project.proxy.upstream);
    return res;
  } catch (e) {
    res.error = (e as Error).message;
    recordOp("proxy-apply", projectName, false, res.error);
    return res;
  }
}

/** proxy rm：删掉项目的站点配置并 reload。 */
export async function removeProxy(config: Config, projectName: string): Promise<ProxyApplyResult> {
  const { server, serverName } = getProject(config, projectName);
  const res: ProxyApplyResult = { project: projectName, server: serverName, domain: "", file: "", success: false, steps: [] };
  try {
    if (!safeName(projectName)) throw new Error(`项目名含非法字符：${projectName}`);
    const S = await sudoPrefix(server);
    const ops = engineOps(await detectEngine(server, S), S, projectName);
    res.file = ops.file;
    const exists = (await runOnServer(server, `${S}test -f ${q(ops.file)} && echo yes || echo no`)).stdout.trim();
    if (exists !== "yes") {
      res.steps.push("站点配置不存在（无需删除）");
      res.success = true;
      return res;
    }
    await runOnServer(server, `${S}rm -f ${q(ops.file)}`);
    res.steps.push(`✓ 已删除 ${ops.file}`);
    const r = await runOnServer(server, ops.reload);
    if (r.code !== 0) res.steps.push(`⚠ reload 未成功：${(r.stderr || r.stdout).trim().slice(0, 200)}`);
    else res.steps.push("✓ 已 reload");
    res.success = true;
    recordOp("proxy-rm", projectName, true);
    return res;
  } catch (e) {
    res.error = (e as Error).message;
    recordOp("proxy-rm", projectName, false, res.error);
    return res;
  }
}

export interface ProxySite {
  project: string;
  content: string;
}

/** proxy ls：列出某服务器上 vibe-launch 管理的站点配置。 */
export async function listProxy(config: Config, target: string): Promise<ProxySite[]> {
  const server = getServerOf(config, target);
  const S = await sudoPrefix(server);
  const engine = await detectEngine(server, S);
  const glob = engine.kind === "caddy" ? `${SITE_DIR}/*.caddy` : `${q(engine.confDir)}/vl-*.conf`;
  const r = await runOnServer(
    server,
    `for f in ${glob}; do [ -e "$f" ] || continue; n=$(basename "$f"); n=\${n%.caddy}; n=\${n%.conf}; echo "===VL===\${n#vl-}"; cat "$f"; done 2>/dev/null`
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

export interface CertResult {
  server: string;
  name: string;
  dir: string;
  success: boolean;
  steps: string[];
  error?: string;
}

/** proxy cert add：把证书（如 Cloudflare 源站证书）存到服务器，供 proxy.cert 引用。
 *  来源二选一：本地文件（certFile/keyFile），或服务器上已有的目录（fromDir，含 fullchain.pem + privkey.pem，
 *  如 1Panel 站点的 ssl 目录）。私钥只写文件、不回显、不进操作日志。 */
export async function addCert(
  config: Config,
  target: string,
  name: string,
  src: { certFile?: string; keyFile?: string; fromDir?: string }
): Promise<CertResult> {
  const server = getServerOf(config, target);
  const res: CertResult = { server: target, name, dir: "", success: false, steps: [] };
  try {
    if (!safeName(name)) throw new Error(`非法证书名：${name}（只允许字母数字 . _ -）`);
    const S = await sudoPrefix(server);
    const engine = await detectEngine(server, S);
    const { hostDir } = certPaths(engine, name);
    res.dir = hostDir;
    const D = q(hostDir);
    let w;
    if (src.fromDir) {
      if (!src.fromDir.startsWith("/")) throw new Error("--from 需要服务器上的绝对路径");
      const F = q(src.fromDir.replace(/\/+$/, ""));
      w = await runOnServer(
        server,
        `${S}test -s ${F}/fullchain.pem && ${S}test -s ${F}/privkey.pem || { echo __MISSING__; exit 0; }; ` +
          `${S}mkdir -p ${D} && ${S}cp ${F}/fullchain.pem ${D}/fullchain.pem && ${S}cp ${F}/privkey.pem ${D}/privkey.pem && echo __OK__`
      );
      if (w.stdout.includes("__MISSING__")) throw new Error(`${src.fromDir} 下没有 fullchain.pem / privkey.pem`);
    } else {
      if (!src.certFile || !src.keyFile) throw new Error("需要 --cert 和 --key（本地 PEM 文件），或 --from <服务器上的证书目录>");
      const cert = readFileSync(src.certFile, "utf8");
      const key = readFileSync(src.keyFile, "utf8");
      if (!cert.includes("-----BEGIN CERTIFICATE-----")) throw new Error(`${src.certFile} 不是 PEM 证书`);
      if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(key)) throw new Error(`${src.keyFile} 不是 PEM 私钥`);
      const b = (s: string) => q(Buffer.from(s, "utf8").toString("base64"));
      w = await runOnServer(
        server,
        `${S}mkdir -p ${D} && printf %s ${b(cert)} | base64 -d | ${S}tee ${D}/fullchain.pem >/dev/null && ` +
          `(umask 077; printf %s ${b(key)} | base64 -d | ${S}tee ${D}/privkey.pem >/dev/null) && echo __OK__`
      );
    }
    if (!w.stdout.includes("__OK__")) throw new Error(`写入证书失败：${(w.stderr || w.stdout).trim().slice(0, 300)}`);
    // 私钥只给属主读；Caddy 以 caddy 用户运行，目录归它
    await runOnServer(
      server,
      `${S}chmod 600 ${D}/privkey.pem; ` + (engine.kind === "caddy" ? `id caddy >/dev/null 2>&1 && ${S}chown -R caddy:caddy ${D}; true` : "true")
    );
    const info = (await runOnServer(server, `${S}openssl x509 -in ${D}/fullchain.pem -noout -subject -enddate 2>/dev/null`)).stdout.trim();
    res.steps.push(`✓ 证书 ${name} 已存到 ${hostDir}`);
    if (info) for (const l of info.split("\n")) res.steps.push("  " + l.trim());
    res.steps.push(`  项目里配 proxy.cert: ${name}，再 vl proxy apply <项目>`);
    res.success = true;
    recordOp("proxy-cert", target, true, name);
    return res;
  } catch (e) {
    res.error = (e as Error).message;
    recordOp("proxy-cert", target, false, res.error);
    return res;
  }
}

/** proxy cert ls：列出服务器上 vibe-launch 存的证书（名字 + 到期时间）。 */
export async function listCerts(config: Config, target: string): Promise<{ name: string; info: string }[]> {
  const server = getServerOf(config, target);
  const S = await sudoPrefix(server);
  const engine = await detectEngine(server, S);
  const base = q(certBase(engine));
  const r = await runOnServer(
    server,
    `for d in ${base}/*/; do [ -f "$d/fullchain.pem" ] || continue; echo "$(basename "$d")|$(${S}openssl x509 -in "$d/fullchain.pem" -noout -enddate 2>/dev/null)"; done 2>/dev/null`
  );
  return r.stdout
    .split("\n")
    .filter((l) => l.includes("|"))
    .map((l) => {
      const [name, info] = l.split("|");
      return { name, info: info.trim() };
    });
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

// 供测试：只生成配置文本，不连服务器
export const _render = { caddyBlock, openrestyBlock };
