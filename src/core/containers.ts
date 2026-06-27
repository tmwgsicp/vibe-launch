// 容器管理：列出全部容器（含已停止）+ 删除单个 + 一键清理停止容器。
// 删除是生产上不可逆操作，路由层 + UI 层都要确认；这里只做最小安全校验（拒空名、防注入）。
import { runOnServer } from "./ssh.js";
import { getServerOf } from "./config.js";
import type { Config } from "./types.js";

const q = (s: string) => JSON.stringify(s);

export interface ContainerInfo {
  name: string;
  state: string;   // running / exited / created / paused / restarting / dead
  status: string;  // 人类可读，如 "Exited (0) 3 days ago"
  image: string;
  running: boolean;
}

/** 列出服务器上全部容器（docker ps -a），含已停止的。供容器管理 / 清理用。
 * 注意：不加 --size——它会给每个容器逐个算可写层大小，容器多时慢到秒级超时（真机实测 27 个容器 >20s）。 */
export async function listContainers(config: Config, serverName: string): Promise<ContainerInfo[]> {
  const server = getServerOf(config, serverName);
  // 用不可见分隔符 \x1f 防止镜像名/状态里的空格或竖线干扰解析
  const r = await runOnServer(
    server,
    `docker ps -a --no-trunc --format '{{.Names}}\x1f{{.State}}\x1f{{.Status}}\x1f{{.Image}}' 2>/dev/null`
  );
  if (r.code !== 0 && !r.stdout) throw new Error((r.stderr || "docker 不可用").trim());
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((line): ContainerInfo => {
      const [name, state, status, image] = line.split("\x1f");
      return {
        name: name || "",
        state: state || "",
        status: status || "",
        image: image || "",
        running: /^running$/i.test(state || ""),
      };
    })
    .filter((c) => c.name);
}

/** 拉某容器的日志尾部（只读）。给 MCP / 诊断用；tail 限幅 1–2000 防爆。 */
export async function getContainerLogs(
  config: Config,
  serverName: string,
  name: string,
  tail = 200
): Promise<{ container: string; logs: string }> {
  const server = getServerOf(config, serverName);
  const n = assertName(name);
  const t = Math.max(1, Math.min(2000, Math.floor(tail) || 200));
  const r = await runOnServer(server, `docker logs --tail ${t} --timestamps ${q(n)} 2>&1 | tail -${t}`);
  return { container: n, logs: (r.stdout || r.stderr || "(无输出)").trim() };
}

function assertName(name: string): string {
  const n = (name || "").trim();
  // 容器名只可能是 [A-Za-z0-9_.-]，任何别的字符都拒掉，杜绝命令注入
  if (!n || !/^[A-Za-z0-9_.-]+$/.test(n)) throw new Error("非法容器名");
  return n;
}

/** 启动一个已停止的容器（docker start）。 */
export async function startContainer(
  config: Config,
  serverName: string,
  name: string
): Promise<{ ok: boolean; output: string }> {
  const server = getServerOf(config, serverName);
  const n = assertName(name);
  const r = await runOnServer(server, `docker start ${q(n)} 2>&1`);
  const out = (r.stdout || r.stderr || "").trim();
  if (r.code !== 0) throw new Error(out || "启动失败");
  return { ok: true, output: out };
}

/** 停止一个运行中的容器（docker stop，默认 10s 优雅期）。 */
export async function stopContainer(
  config: Config,
  serverName: string,
  name: string
): Promise<{ ok: boolean; output: string }> {
  const server = getServerOf(config, serverName);
  const n = assertName(name);
  const r = await runOnServer(server, `docker stop ${q(n)} 2>&1`);
  const out = (r.stdout || r.stderr || "").trim();
  if (r.code !== 0) throw new Error(out || "停止失败");
  return { ok: true, output: out };
}

export interface ContainerDetail {
  name: string;
  image: string;
  state: string;
  created: string;
  startedAt: string;
  restartCount: number;
  health: string;
  command: string;
  ports: string[];
  mounts: string[];
  ip: string;
}

/** 容器详情（docker inspect）：镜像 / 端口映射 / 挂载 / 重启次数 / 健康 / 命令。只读。 */
export async function inspectContainer(
  config: Config,
  serverName: string,
  name: string
): Promise<ContainerDetail> {
  const server = getServerOf(config, serverName);
  const n = assertName(name);
  const r = await runOnServer(server, `docker inspect ${q(n)} 2>&1`);
  if (r.code !== 0) throw new Error((r.stdout || r.stderr || "inspect 失败").trim());
  let arr: any;
  try { arr = JSON.parse(r.stdout); } catch { throw new Error("解析 inspect 输出失败"); }
  const d = arr && arr[0];
  if (!d) throw new Error("未找到容器");
  const st = d.State || {};
  const portMap = (d.NetworkSettings && d.NetworkSettings.Ports) || {};
  const ports = Object.entries(portMap).flatMap(([k, v]: [string, any]) =>
    Array.isArray(v) && v.length ? v.map((b: any) => `${b.HostIp || "0.0.0.0"}:${b.HostPort} → ${k}`) : [`${k}（未映射）`]
  );
  const mounts = (d.Mounts || []).map(
    (m: any) => `${m.Source || m.Name || ""} → ${m.Destination}${m.RW === false ? "（只读）" : ""}`
  );
  const nets = (d.NetworkSettings && d.NetworkSettings.Networks) || {};
  const ip = Object.values(nets).map((x: any) => x && x.IPAddress).filter(Boolean).join(", ");
  return {
    name: (d.Name || "").replace(/^\//, ""),
    image: (d.Config && d.Config.Image) || "",
    state: st.Running ? "运行中" : st.Status || "",
    created: d.Created || "",
    startedAt: st.StartedAt || "",
    restartCount: d.RestartCount || 0,
    health: (st.Health && st.Health.Status) || "无",
    command: ([] as string[]).concat(d.Config?.Entrypoint || [], d.Config?.Cmd || []).join(" "),
    ports,
    mounts,
    ip,
  };
}

/** 删除单个容器（不加 -f，正在运行的会被 docker 拒绝——避免误删跑着的服务）。 */
export async function removeContainer(
  config: Config,
  serverName: string,
  name: string
): Promise<{ ok: boolean; output: string }> {
  const server = getServerOf(config, serverName);
  const n = assertName(name);
  const r = await runOnServer(server, `docker rm ${q(n)} 2>&1`);
  const out = (r.stdout || r.stderr || "").trim();
  if (r.code !== 0) {
    // 容器在运行时 docker 报 "You cannot remove a running container"，给中文提示
    if (/running container/i.test(out))
      throw new Error("容器正在运行，请先停止或重启完再删（本功能不强删运行中的容器）");
    throw new Error(out || "删除失败");
  }
  return { ok: true, output: out };
}

/** 一键清理所有已停止容器（docker container prune -f）。返回清掉的数量和释放空间。 */
export async function pruneContainers(
  config: Config,
  serverName: string
): Promise<{ ok: boolean; removed: number; reclaimed: string; output: string }> {
  const server = getServerOf(config, serverName);
  const r = await runOnServer(server, `docker container prune -f 2>&1`);
  const out = (r.stdout || r.stderr || "").trim();
  if (r.code !== 0) throw new Error(out || "清理失败");
  // 解析输出里的 "Deleted Containers:" 行数 和 "Total reclaimed space: X"
  const removed = (out.match(/^[0-9a-f]{12,}/gim) || []).length;
  const m = out.match(/Total reclaimed space:\s*(.+)$/im);
  return { ok: true, removed, reclaimed: m ? m[1].trim() : "0B", output: out };
}
