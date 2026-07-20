// 加载 / 校验 YAML 配置
import { readFileSync, existsSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { parse, stringify } from "yaml";
import type { Config, ProjectConfig } from "./types.js";

/** vibe-launch 自管的专用 deploy key（集中 + 自动，不用你的个人 master key） */
export const MANAGED_KEY_REF = "~/.vibe-launch/id_ed25519";

/** 按优先级找配置文件 */
function resolveConfigPath(explicit?: string): string {
  const candidates = [
    explicit,
    process.env.VIBE_LAUNCH_CONFIG,
    resolve(process.cwd(), "vibe-launch.yaml"),
    resolve(process.cwd(), "vibe-launch.yml"),
    join(homedir(), ".vibe-launch", "config.yaml"),
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    `找不到配置文件。请在以下任一位置创建 vibe-launch.yaml：\n` +
      `  ./vibe-launch.yaml  或  ~/.vibe-launch/config.yaml\n` +
      `  或用 VIBE_LAUNCH_CONFIG 指定。参考 vibe-launch.example.yaml`
  );
}

export function loadConfig(explicit?: string): Config {
  const path = resolveConfigPath(explicit);
  let raw: Config;
  try {
    raw = parse(readFileSync(path, "utf8")) as Config;
  } catch (e) {
    throw new Error(`配置文件解析失败 (${path}): ${(e as Error).message}`);
  }
  if (!raw || typeof raw !== "object") throw new Error(`配置文件为空: ${path}`);
  raw.servers ??= {};
  raw.projects ??= {};

  // 基础校验：每个 project 的 server 必须存在
  for (const [name, proj] of Object.entries(raw.projects)) {
    if (!proj.server) throw new Error(`项目 ${name} 缺少 server`);
    if (!raw.servers[proj.server])
      throw new Error(`项目 ${name} 引用的 server "${proj.server}" 在 servers 里不存在`);
    if (!proj.deploy) throw new Error(`项目 ${name} 缺少 deploy 命令`);
  }
  return raw;
}

/** 写配置时用：已有配置则返回其路径，否则返回默认可写位置 */
export function getConfigPath(): string {
  try {
    return resolveConfigPath();
  } catch {
    return join(homedir(), ".vibe-launch", "config.yaml");
  }
}

/** 把内存里的 config 写回磁盘 */
export function saveConfig(config: Config): string {
  const path = getConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  // 配置里可能含明文服务器密码，落盘即锁成「仅属主可读写」(0600)，避免同机其它用户读到。
  writeFileSync(path, stringify(config), { mode: 0o600 });
  // writeFileSync 的 mode 仅在新建文件时生效；已存在的旧文件补一次 chmod 收紧权限。
  try { chmodSync(path, 0o600); } catch { /* Windows 无 POSIX 权限位 / 无权限时忽略 */ }
  return path;
}

/** 导出当前配置的原始文本（含服务器密码等敏感信息，妥善保管）。 */
export function exportConfigText(): string {
  return readFileSync(resolveConfigPath(), "utf8");
}

/** 从备份文本恢复配置：校验后写回，覆盖前把当前配置备份成 .vlbak。 */
export function importConfigText(text: string): string {
  let parsed: Config;
  try { parsed = parse(text) as Config; } catch (e) { throw new Error(`备份不是合法 YAML：${(e as Error).message}`); }
  if (!parsed || typeof parsed !== "object") throw new Error("备份内容为空或格式不对");
  parsed.servers ??= {};
  parsed.projects ??= {};
  for (const [name, proj] of Object.entries(parsed.projects)) {
    if (!proj?.server) throw new Error(`备份里项目 ${name} 缺 server`);
    if (!parsed.servers[proj.server]) throw new Error(`备份里项目 ${name} 引用的 server "${proj.server}" 不存在`);
    if (!proj.deploy) throw new Error(`备份里项目 ${name} 缺 deploy 命令`);
  }
  const path = getConfigPath();
  if (existsSync(path)) { try { writeFileSync(path + ".vlbak", readFileSync(path)); } catch { /* 备份失败不阻断 */ } }
  return saveConfig(parsed);
}

/** 登记一个项目（project add） */
export function addProject(config: Config, name: string, proj: ProjectConfig): void {
  if (!proj.server) throw new Error("缺少 server");
  if (!config.servers[proj.server]) throw new Error(`server "${proj.server}" 不存在，先 vibe-launch server add`);
  if (!proj.deploy) throw new Error("缺少 deploy 命令");
  config.projects[name] = proj;
}

/** 编辑服务器：改字段 + 可选改别名（改名会级联更新引用它的项目）。 */
export function updateServer(
  config: Config,
  name: string,
  patch: Partial<import("./types.js").ServerConfig>,
  newName?: string
): void {
  const cur = config.servers[name];
  if (!cur) throw new Error(`服务器 "${name}" 不存在`);
  // 只应用"有传值"的字段，避免 undefined 把现有值(如 identityFile)冲掉
  const merged = { ...cur };
  for (const [kk, vv] of Object.entries(patch)) if (vv !== undefined) (merged as Record<string, unknown>)[kk] = vv;
  // 清掉空字符串字段，避免写一堆空值进 yaml
  for (const k of ["note", "identityFile", "password"] as const) {
    if (merged[k] === "" || merged[k] == null) delete (merged as Record<string, unknown>)[k];
  }
  // mirrors：null（UI 清空）或整段空则删掉；否则清理空 docker 数组 / 空 caddyUrl
  if (merged.mirrors == null) {
    delete (merged as Record<string, unknown>).mirrors;
  } else {
    const m = merged.mirrors;
    if (!m.docker || !m.docker.length) delete m.docker;
    if (!m.caddyUrl) delete m.caddyUrl;
    if (!m.docker && !m.caddyUrl) delete (merged as Record<string, unknown>).mirrors;
  }
  const target = (newName || name).trim();
  if (target !== name) {
    if (config.servers[target]) throw new Error(`别名 "${target}" 已被占用`);
    delete config.servers[name];
    // 级联：所有引用旧别名的项目改指向新别名
    for (const p of Object.values(config.projects)) if (p.server === name) p.server = target;
  }
  config.servers[target] = merged;
}

/** 删除服务器：若仍有项目引用则拒绝（避免悬空引用）。 */
export function removeServer(config: Config, name: string): void {
  if (!config.servers[name]) throw new Error(`服务器 "${name}" 不存在`);
  const used = Object.entries(config.projects).filter(([, p]) => p.server === name).map(([n]) => n);
  if (used.length) throw new Error(`还有项目引用这台服务器：${used.join(", ")}。请先删除/改派这些项目`);
  delete config.servers[name];
}

/** 编辑项目：改字段 + 可选改名。 */
export function updateProject(
  config: Config,
  name: string,
  patch: Partial<ProjectConfig>,
  newName?: string
): void {
  const cur = config.projects[name];
  if (!cur) throw new Error(`项目 "${name}" 不存在`);
  const merged = { ...cur };
  for (const [kk, vv] of Object.entries(patch)) if (vv !== undefined) (merged as Record<string, unknown>)[kk] = vv;
  if (merged.server && !config.servers[merged.server]) throw new Error(`server "${merged.server}" 不存在`);
  for (const k of ["dir", "restartCmd", "localSource"] as const) {
    if (merged[k] === "" || merged[k] == null) delete (merged as Record<string, unknown>)[k];
  }
  // proxy 传 null（UI 清空域名）或缺 domain 视为移除
  if (merged.proxy == null || !merged.proxy.domain) delete (merged as Record<string, unknown>).proxy;
  const target = (newName || name).trim();
  if (target !== name) {
    if (config.projects[target]) throw new Error(`项目名 "${target}" 已被占用`);
    delete config.projects[name];
  }
  config.projects[target] = merged;
}

export function removeProject(config: Config, name: string): void {
  if (!config.projects[name]) throw new Error(`项目 "${name}" 不存在`);
  delete config.projects[name];
}

export function getProject(config: Config, name: string) {
  const proj = config.projects[name];
  if (!proj) {
    const all = Object.keys(config.projects).join(", ") || "(无)";
    throw new Error(`项目 "${name}" 不存在。已配置的项目: ${all}`);
  }
  return { project: proj, server: config.servers[proj.server], serverName: proj.server };
}

/** 把"服务器别名或项目名"解析成 ServerConfig（tunnel 等用）。 */
export function getServerOf(config: Config, target: string) {
  if (config.servers[target]) return config.servers[target];
  const proj = config.projects[target];
  if (proj && config.servers[proj.server]) return config.servers[proj.server];
  const servers = Object.keys(config.servers).join(", ") || "(无)";
  throw new Error(`找不到服务器/项目 "${target}"。已配置服务器: ${servers}`);
}
