// vl run：穿透执行。在项目所在服务器上跑即席命令（自动带 host / port / key）。
// 可选 --container：自动 docker exec 进容器里跑（DB 迁移 / psql / redis-cli / 临时脚本）。
// 结构化动词（deploy / restart / rollback）覆盖常见操作，但事故响应 / 带迁移 / 灰度的长尾千变万化，
// 不可能都预设成命令。给一个直接穿透执行的原语，就能把"手搓几十条 ssh ... docker exec ..."收进 vl。
import type { Config } from "./types.js";
import { getProject } from "./config.js";
import { runOnServer, type ExecResult } from "./ssh.js";
import { shQuote } from "./sh.js";

/** 容器名只可能是 [A-Za-z0-9_.-]，任何别的字符都拒掉，杜绝命令注入。 */
const validContainer = (n: string) => /^[A-Za-z0-9_.-]+$/.test(n);

/** 构造在容器内执行命令的 docker exec 串。容器名校验 + 单引号转义挡注入；命令用 sh -c 单引号包裹保持原样。 */
export function dockerExecCmd(container: string, command: string, cwd?: string): string {
  if (!validContainer(container)) throw new Error(`非法容器名：${container}`);
  const w = cwd ? ` -w ${shQuote(cwd)}` : "";
  return `docker exec${w} ${shQuote(container)} sh -c ${shQuote(command)}`;
}

export interface RunResult {
  project: string;
  server: string;
  container?: string;
  /** 实际下发到服务器的命令（含 docker exec 包装），便于排查。 */
  command: string;
  code: number | null;
  stdout: string;
  stderr: string;
}

/** 在项目对应服务器上跑命令。container 存在则 docker exec 进容器；否则默认 cwd = 项目 dir。 */
export async function runOnProject(
  config: Config,
  projectName: string,
  command: string,
  opts: { container?: string; cwd?: string; timeoutMs?: number } = {}
): Promise<RunResult> {
  const { project, server, serverName } = getProject(config, projectName);
  if (!command || !command.trim()) throw new Error("命令为空");

  let effective: string;
  let cwd: string | undefined;
  if (opts.container) {
    effective = dockerExecCmd(opts.container, command, opts.cwd);
  } else {
    effective = command;
    cwd = opts.cwd ?? project.dir; // 不指定就在项目工作目录跑（git pull / 看文件等最常用）
  }

  const r: ExecResult = await runOnServer(server, effective, cwd, opts.timeoutMs ?? 120000);
  return {
    project: projectName,
    server: serverName,
    container: opts.container,
    command: effective,
    code: r.code,
    stdout: r.stdout,
    stderr: r.stderr,
  };
}
