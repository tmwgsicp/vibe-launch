// 通用文件管理（按 server + 绝对路径操作）：浏览 / 读 / 上传 / 下载 / 删除 / 重命名 / 新建目录。
// 与 files.ts（锁死在项目目录树内、给部署 .env 用）不同，这里是完整文件管理器，可在服务器任意路径操作。
// 服务器是用户自己的、登录用户通常就是 root，所以不做沙箱；但严防命令注入 + 拦截灾难性删除。
import { runOnServer } from "./ssh.js";
import { getServerOf } from "./config.js";
import type { Config } from "./types.js";

const q = (s: string) => JSON.stringify(s);

/** 绝对路径基础校验：必须以 / 开头，无换行/空字节，无 .. 段（防意外跳目录）。 */
function safeAbs(p: string): string {
  const s = (p || "").trim();
  if (!s.startsWith("/")) throw new Error("需要绝对路径（以 / 开头）");
  if (/[\n\r\0]/.test(s)) throw new Error("路径含非法字符");
  if (s.split("/").includes("..")) throw new Error("路径不能含 ..");
  return s.replace(/\/+$/, "") || "/"; // 去尾部斜杠，但保留根
}

// 删除/改名要拦的系统关键目录（精确匹配，防一键点没整台机器）
const CRITICAL = new Set([
  "/", "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib64",
  "/proc", "/root", "/run", "/sbin", "/srv", "/sys", "/usr", "/var",
]);
function assertDestroyable(p: string): string {
  const s = safeAbs(p);
  if (CRITICAL.has(s)) throw new Error(`拒绝操作系统关键目录 ${s}（要动请用 SSH 手动来）`);
  return s;
}

const parentOf = (cwd: string) => (cwd === "/" ? "/" : cwd.replace(/\/[^/]+$/, "") || "/");

export interface FsEntry { name: string; type: "dir" | "file"; size: number; }
export interface FsList { cwd: string; parent: string; entries: FsEntry[]; }

/** 列目录（含点文件）。path 空 = 用 $HOME。 */
export async function fsList(config: Config, serverName: string, path?: string): Promise<FsList> {
  const server = getServerOf(config, serverName);
  const cdTo = path && path.trim() ? q(safeAbs(path)) : "$HOME";
  const cmd =
    `cd ${cdTo} 2>/dev/null && pwd && ` +
    `for e in * .[!.]* ..?*; do [ -e "$e" ] || continue; ` +
    `if [ -d "$e" ]; then echo "d|0|$e"; else echo "f|$(wc -c < "$e" 2>/dev/null || echo 0)|$e"; fi; done 2>/dev/null || echo __ERR__`;
  const out = (await runOnServer(server, cmd)).stdout.split("\n").filter(Boolean);
  if (!out.length || out[0] === "__ERR__") throw new Error("无法访问该目录");
  const cwd = out[0];
  const entries: FsEntry[] = out.slice(1)
    .filter((l) => l !== "__ERR__")
    .map((l): FsEntry => {
      const [t, sz, ...rest] = l.split("|");
      return { type: t === "d" ? "dir" : "file", size: parseInt(sz, 10) || 0, name: rest.join("|") };
    })
    .filter((e) => e.name)
    .sort((a, b) => (a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name)));
  return { cwd, parent: parentOf(cwd), entries };
}

const READ_CAP = 512 * 1024;       // 在线编辑文本上限 512KB
const DOWNLOAD_CAP = 25 * 1024 * 1024; // 下载上限 25MB（更大请用 scp/rsync）

/** 读文本文件（供在线编辑），超 512KB 拒绝。 */
export async function fsRead(config: Config, serverName: string, path: string): Promise<{ path: string; content: string; exists: boolean }> {
  const server = getServerOf(config, serverName);
  const p = safeAbs(path);
  const r = await runOnServer(
    server,
    `if [ ! -f ${q(p)} ]; then echo __NOFILE__; elif [ "$(wc -c < ${q(p)})" -gt ${READ_CAP} ]; then echo __TOOBIG__; else cat ${q(p)}; fi`
  );
  const head = r.stdout.trimEnd();
  if (head === "__NOFILE__") return { path: p, content: "", exists: false };
  if (head === "__TOOBIG__") throw new Error("文件超过 512KB，不支持在线编辑（可下载）");
  return { path: p, content: r.stdout.replace(/\n$/, ""), exists: true };
}

/** 下载文件：返回 base64 + 大小，UI 转成浏览器下载。超 25MB 拒绝。 */
export async function fsDownload(config: Config, serverName: string, path: string): Promise<{ name: string; size: number; b64: string }> {
  const server = getServerOf(config, serverName);
  const p = safeAbs(path);
  const r = await runOnServer(
    server,
    `if [ ! -f ${q(p)} ]; then echo __NOFILE__; elif [ "$(wc -c < ${q(p)})" -gt ${DOWNLOAD_CAP} ]; then echo __TOOBIG__; else base64 ${q(p)} | tr -d '\\n'; fi`
  );
  const head = r.stdout.trimEnd();
  if (head === "__NOFILE__") throw new Error("文件不存在");
  if (head === "__TOOBIG__") throw new Error("文件超过 25MB，请用 scp/rsync 下载");
  const b64 = r.stdout.replace(/\s/g, "");
  return { name: p.split("/").pop() || "download", size: Math.floor((b64.length * 3) / 4), b64 };
}

/** 上传/写入文件到绝对路径（base64，二进制安全）。父目录自动建；已存在先备份 .vlbak。 */
export async function fsWriteB64(config: Config, serverName: string, path: string, b64: string): Promise<{ ok: boolean; path: string }> {
  const server = getServerOf(config, serverName);
  const p = safeAbs(path);
  if (!/^[A-Za-z0-9+/=\r\n]*$/.test(b64)) throw new Error("内容编码异常");
  await runOnServer(server, `mkdir -p "$(dirname ${q(p)})"`);
  const r = await runOnServer(
    server,
    `[ -f ${q(p)} ] && cp ${q(p)} ${q(p)}.vlbak 2>/dev/null; printf %s ${q(b64.replace(/\s/g, ""))} | base64 -d > ${q(p)} && echo __OK__`
  );
  if (!r.stdout.includes("__OK__")) throw new Error((r.stderr || "写入失败").trim());
  return { ok: true, path: p };
}

/** 删除文件或目录（rm -rf）。拦截系统关键目录。 */
export async function fsDelete(config: Config, serverName: string, path: string): Promise<{ ok: boolean }> {
  const server = getServerOf(config, serverName);
  const p = assertDestroyable(path);
  const r = await runOnServer(server, `rm -rf ${q(p)} && echo __OK__`);
  if (!r.stdout.includes("__OK__")) throw new Error((r.stderr || "删除失败").trim());
  return { ok: true };
}

/** 重命名 / 移动。dest 已存在则拒绝（防覆盖）。拦截把关键目录改没。 */
export async function fsRename(config: Config, serverName: string, path: string, dest: string): Promise<{ ok: boolean; path: string }> {
  const server = getServerOf(config, serverName);
  const src = assertDestroyable(path);
  const dst = safeAbs(dest);
  const r = await runOnServer(
    server,
    `if [ -e ${q(dst)} ]; then echo __EXISTS__; else mkdir -p "$(dirname ${q(dst)})" && mv ${q(src)} ${q(dst)} && echo __OK__; fi`
  );
  if (r.stdout.includes("__EXISTS__")) throw new Error("目标已存在");
  if (!r.stdout.includes("__OK__")) throw new Error((r.stderr || "重命名失败").trim());
  return { ok: true, path: dst };
}

/** 新建目录（mkdir -p）。 */
export async function fsMkdir(config: Config, serverName: string, path: string): Promise<{ ok: boolean; path: string }> {
  const server = getServerOf(config, serverName);
  const p = safeAbs(path);
  const r = await runOnServer(server, `mkdir -p ${q(p)} && echo __OK__`);
  if (!r.stdout.includes("__OK__")) throw new Error((r.stderr || "新建失败").trim());
  return { ok: true, path: p };
}
