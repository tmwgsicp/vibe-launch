// 加载 / 校验 YAML 配置
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
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
  writeFileSync(path, stringify(config), "utf8");
  return path;
}

/** 登记一个项目（project add） */
export function addProject(config: Config, name: string, proj: ProjectConfig): void {
  if (!proj.server) throw new Error("缺少 server");
  if (!config.servers[proj.server]) throw new Error(`server "${proj.server}" 不存在，先 vibe-launch server add`);
  if (!proj.deploy) throw new Error("缺少 deploy 命令");
  config.projects[name] = proj;
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
