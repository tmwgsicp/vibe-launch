// 远程目录浏览 + 项目目录内的配置文件读写（给 UI 选部署目录 / 编辑上传 .env 用）。
// 文件读写一律约束在"项目 dir 内、单层文件名"，不开放任意路径写——避免变成通用文件管理器。
import { runOnServer } from "./ssh.js";
import { getProject, getServerOf } from "./config.js";
import type { Config } from "./types.js";

import { shQuote as q } from "./sh.js";

export interface BrowseResult {
  cwd: string;
  parent: string;
  dirs: string[];
}

/** 浏览服务器目录：列出 path 下的子目录（不填 path 用 $HOME）。给"选部署目录"用。 */
export async function browseDirs(config: Config, target: string, path?: string): Promise<BrowseResult> {
  const server = getServerOf(config, target);
  const cdTo = path && path.trim() ? q(path) : "$HOME";
  // find -maxdepth/-mindepth/-type 在 coreutils 和 busybox 都支持，比 ls -p 更通用
  const r = await runOnServer(
    server,
    `cd ${cdTo} 2>/dev/null && pwd && find . -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sed 's|^\\./||' | sort || echo __ERR__`
  );
  const lines = r.stdout.split("\n").filter(Boolean);
  if (!lines.length || lines[lines.length - 1] === "__ERR__") throw new Error("无法访问该目录");
  const cwd = lines[0];
  const dirs = lines.slice(1).map((d) => d.replace(/\/$/, "")).filter((d) => d && d !== ".");
  const parent = cwd === "/" ? "/" : cwd.replace(/\/[^/]+\/?$/, "") || "/";
  return { cwd, parent, dirs };
}

// 约束相对路径：允许子目录(backend/.env)，禁止绝对路径与上跳——锁死在项目目录树内
function safeRel(rel: string): string {
  const r = (rel || "").trim();
  if (!r || r.startsWith("/") || r.includes("\\") || r.split("/").includes(".."))
    throw new Error("只能填项目目录内的相对路径，不能用绝对路径或 ..");
  return r;
}

/** 读项目 dir 内某个文件的文本内容（相对路径，约束在项目目录树内）。 */
export async function readProjectFile(
  config: Config,
  projectName: string,
  name: string
): Promise<{ name: string; content: string; exists: boolean }> {
  const { project, server } = getProject(config, projectName);
  if (!project.dir) throw new Error("项目没配置工作目录");
  const rel = safeRel(name);
  const path = `${project.dir}/${rel}`;
  const r = await runOnServer(server, `if [ -f ${q(path)} ]; then cat ${q(path)}; else echo __NOFILE__; fi`);
  if (r.stdout.trimEnd() === "__NOFILE__") return { name: rel, content: "", exists: false };
  return { name: rel, content: r.stdout.replace(/\n$/, ""), exists: true };
}

/** 写项目 dir 内某个文件（base64 传输免引号地狱；已存在先备份 .vlbak）。父目录自动建。 */
export async function writeProjectFile(
  config: Config,
  projectName: string,
  name: string,
  content: string
): Promise<{ ok: boolean; path: string }> {
  return writeProjectFileBase64(config, projectName, name, Buffer.from(content, "utf8").toString("base64"));
}

/** 上传/写入项目 dir 内文件（直接收 base64，二进制安全；支持子目录相对路径）。 */
export async function writeProjectFileBase64(
  config: Config,
  projectName: string,
  name: string,
  b64: string
): Promise<{ ok: boolean; path: string }> {
  const { project, server } = getProject(config, projectName);
  if (!project.dir) throw new Error("项目没配置工作目录");
  const rel = safeRel(name);
  const path = `${project.dir}/${rel}`;
  if (!/^[A-Za-z0-9+/=\r\n]*$/.test(b64)) throw new Error("内容编码异常");
  await runOnServer(server, `mkdir -p "$(dirname ${q(path)})"`);
  const r = await runOnServer(
    server,
    `[ -f ${q(path)} ] && cp ${q(path)} ${q(path)}.vlbak 2>/dev/null; printf %s ${q(b64.replace(/\s/g, ""))} | base64 -d > ${q(path)} && echo __OK__`
  );
  if (!r.stdout.includes("__OK__")) throw new Error((r.stderr || "写入失败").trim());
  return { ok: true, path };
}

export interface DirEntry {
  name: string;
  type: "dir" | "file";
  size: number;
}

/** 列出项目目录树内某个子目录的内容（rel 可空=项目根）。根锁死在 project.dir，出不去。 */
export async function listProjectDir(
  config: Config,
  projectName: string,
  rel?: string
): Promise<{ root: string; cwd: string; rel: string; entries: DirEntry[] }> {
  const { project, server } = getProject(config, projectName);
  if (!project.dir) throw new Error("项目没配置工作目录");
  const r = rel && rel.trim() ? safeRel(rel) : "";
  const base = r ? `${project.dir}/${r}` : project.dir;
  // 经典 glob 集合列全部(含点文件)，POSIX sh 通用；输出 类型|大小|名字
  const cmd =
    `cd ${q(base)} 2>/dev/null && pwd && ` +
    `for e in * .[!.]* ..?*; do [ -e "$e" ] || continue; ` +
    `if [ -d "$e" ]; then echo "d|0|$e"; else echo "f|$(wc -c < "$e" 2>/dev/null || echo 0)|$e"; fi; done 2>/dev/null`;
  const out = (await runOnServer(server, cmd)).stdout.split("\n").filter(Boolean);
  if (!out.length) throw new Error("无法访问该目录");
  const cwd = out[0];
  // 防越界：真实路径必须仍在项目根内（挡符号链接逃逸）
  if (!(cwd === project.dir || cwd.startsWith(project.dir + "/"))) throw new Error("越界，已拦截");
  const entries: DirEntry[] = out.slice(1).map((l): DirEntry => {
    const [t, sz, ...rest] = l.split("|");
    return { type: t === "d" ? "dir" : "file", size: parseInt(sz, 10) || 0, name: rest.join("|") };
  }).filter((e) => e.name).sort((a, b) => (a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name)));
  return { root: project.dir, cwd, rel: r, entries };
}
