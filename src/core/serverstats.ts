// 采集服务器轻量指标：一次 SSH 跑几条 O(1) 命令（loadavg/free/df/uptime/docker），
// 服务器开销毫秒级。用于操作台的服务器监控卡片。
import { runOnServer } from "./ssh.js";
import type { ServerConfig } from "./types.js";

export interface ServerStats {
  reachable: boolean;
  load?: [number, number, number]; // 1/5/15 分钟
  cores?: number;
  cpuModel?: string;
  memUsedMb?: number;
  memTotalMb?: number;
  swapUsedMb?: number;
  swapTotalMb?: number;
  netRxBytes?: number; // 累计收字节（非 lo），采集端算速率
  netTxBytes?: number; // 累计发字节
  diskUsedMb?: number;
  diskTotalMb?: number;
  uptime?: string;
  containersRunning?: number;
  containersTotal?: number;
  os?: string;       // 发行版，如 CentOS Linux 7
  kernel?: string;   // 内核版本，uname -r
  arch?: string;     // 架构，x86_64/aarch64
  hostname?: string;
  dockerVer?: string;
  error?: string;
}

// 一条命令把所有指标打出来，各行带前缀好解析。
// 普适性优先：只依赖 procfs + POSIX 工具，不依赖 free/uptime -p 等"发行版可能没有/格式不一"的命令。
//  - 内存：读 /proc/meminfo（所有 Linux 都有），used = total - available（缺 MemAvailable 时退回 free+buffers+cached），单位 kB
//  - 磁盘：df -Pk（-P=POSIX 输出避免换行，-k=KB 通用，busybox 也支持），单位 kB
//  - CPU 型号：x86 取 "model name"，ARM 退回 "Hardware"/"Model"
//  - 运行时长：uptime -p（GNU）失败则用 /proc/uptime 现算（busybox 也能跑）
//  - 核数：nproc 失败退回数 /proc/cpuinfo 的 processor 行
const STATS_CMD = [
  `echo "L:$(cut -d' ' -f1-3 /proc/loadavg)"`,
  `echo "C:$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null || echo 1)"`,
  `echo "P:$(sed -n 's/^model name[[:space:]]*: //p; s/^Hardware[[:space:]]*: //p; s/^Model[[:space:]]*: //p' /proc/cpuinfo | head -1)"`,
  `echo "M:$(awk '/^MemTotal:/{t=$2}/^MemAvailable:/{av=$2}/^MemFree:/{f=$2}/^Buffers:/{b=$2}/^Cached:/{c=$2}END{a=(av!=""?av:f+b+c);print (t-a), t}' /proc/meminfo)"`,
  `echo "W:$(awk '/^SwapTotal:/{t=$2}/^SwapFree:/{fr=$2}END{print (t-fr)+0, t+0}' /proc/meminfo)"`,
  `echo "N:$(awk 'NR>2{gsub(/:/," ");if($1!="lo"){rx+=$2;tx+=$10}}END{print rx+0, tx+0}' /proc/net/dev 2>/dev/null)"`,
  `echo "D:$(df -Pk / 2>/dev/null | awk 'NR==2{print $3, $2}')"`,
  `echo "U:$(uptime -p 2>/dev/null | sed 's/^up //' || awk '{d=int($1/86400);h=int(($1%86400)/3600);m=int(($1%3600)/60);printf (d?d" 天 ":"")(h?h" 小时 ":"")m" 分钟"}' /proc/uptime)"`,
  `echo "K:$(docker ps -q 2>/dev/null | wc -l) $(docker ps -aq 2>/dev/null | wc -l)"`,
  `echo "O:$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || cat /etc/redhat-release 2>/dev/null || uname -o 2>/dev/null)"`,
  `echo "R:$(uname -r)"`,
  `echo "A:$(uname -m)"`,
  `echo "H:$(hostname 2>/dev/null || cat /proc/sys/kernel/hostname 2>/dev/null)"`,
  `echo "V:$(docker version -f '{{.Server.Version}}' 2>/dev/null)"`,
].join("; ");

const kbToMb = (kb: number) => (isNaN(kb) ? NaN : Math.round(kb / 1024));

export async function getServerStats(server: ServerConfig): Promise<ServerStats> {
  try {
    const r = await runOnServer(server, STATS_CMD);
    if (r.code !== 0 && !r.stdout) {
      return { reachable: false, error: (r.stderr || "无输出").trim() };
    }
    const lines = r.stdout.split("\n");
    const pick = (p: string) => (lines.find((l) => l.startsWith(p)) || "").slice(p.length).trim();

    const load = pick("L:").split(/\s+/).map(Number);
    const mem = pick("M:").split(/\s+/).map(Number).map(kbToMb);   // meminfo 是 kB → MB
    const swap = pick("W:").split(/\s+/).map(Number).map(kbToMb);  // 同 kB → MB
    const net = pick("N:").split(/\s+/).map(Number);               // 累计字节
    const disk = pick("D:").split(/\s+/).map(Number).map(kbToMb);  // df -Pk 是 kB → MB
    const k = pick("K:").split(/\s+/).map(Number);
    const cores = parseInt(pick("C:"), 10);

    return {
      reachable: true,
      load: load.length === 3 && load.every((n) => !isNaN(n)) ? [load[0], load[1], load[2]] : undefined,
      cores: isNaN(cores) ? undefined : cores,
      memUsedMb: !isNaN(mem[0]) ? mem[0] : undefined,
      memTotalMb: !isNaN(mem[1]) ? mem[1] : undefined,
      swapUsedMb: !isNaN(swap[0]) ? swap[0] : undefined,
      swapTotalMb: !isNaN(swap[1]) ? swap[1] : undefined,
      netRxBytes: !isNaN(net[0]) ? net[0] : undefined,
      netTxBytes: !isNaN(net[1]) ? net[1] : undefined,
      diskUsedMb: !isNaN(disk[0]) ? disk[0] : undefined,
      diskTotalMb: !isNaN(disk[1]) ? disk[1] : undefined,
      uptime: pick("U:") || undefined,
      containersRunning: !isNaN(k[0]) ? k[0] : undefined,
      containersTotal: !isNaN(k[1]) ? k[1] : undefined,
      cpuModel: pick("P:") || undefined,
      os: pick("O:") || undefined,
      kernel: pick("R:") || undefined,
      arch: pick("A:") || undefined,
      hostname: pick("H:") || undefined,
      dockerVer: pick("V:") || undefined,
    };
  } catch (e) {
    return { reachable: false, error: (e as Error).message };
  }
}
