// 重启项目的运行单元 —— 容器项目走 docker restart，非容器（systemd / 裸进程 / venv）走 restartCmd。
//
// 存在的意义：让 systemd 项目不再是二等公民。此前 restart / env set --restart / rollback 各自
// `for (const name of project.containers ?? [])` 循环，systemd 项目 containers 为空 → 一个都没重启，
// 却因为后面健康检查（往往也没配）默认放行而**报告成功** —— 改了 .env / 回滚了代码，工具说"✅ 成功"，
// 实际新东西根本没生效。三条路径统一收进这里，空目标会被显式标记（noTarget），调用方据此如实报告。
import type { ServerConfig, ProjectConfig } from "./types.js";
import { runOnServer } from "./ssh.js";
import { shQuote as q } from "./sh.js";

export interface ReloadAction {
  /** 容器名，或非容器项目的 "restartCmd"。 */
  target: string;
  ok: boolean;
  output: string;
}

export interface ReloadResult {
  actions: ReloadAction[];
  /** true = 项目既没配 containers 也没配 restartCmd，压根没有可重启对象（不是"重启成功"）。 */
  noTarget: boolean;
}

/**
 * 重启项目的服务。
 * - 有 containers：docker restart 每个（only 只对容器生效 —— 部分重启不打断其它服务）。
 * - 无 containers 有 restartCmd：在 dir 内跑 restartCmd（systemd 等）。only 对它无意义（不透明整条命令）。
 * - 都没有：actions 空 + noTarget=true，让调用方如实报"无可重启对象"，而非假成功。
 */
export async function reloadServices(
  server: ServerConfig,
  project: ProjectConfig,
  only?: string[]
): Promise<ReloadResult> {
  const containers = project.containers ?? [];
  if (containers.length) {
    const targets = only?.length ? containers.filter((c) => only.includes(c)) : containers;
    const actions = await Promise.all(
      targets.map(async (name): Promise<ReloadAction> => {
        const r = await runOnServer(server, `docker restart ${q(name)}`);
        return { target: name, ok: r.code === 0, output: (r.stdout || r.stderr || "").trim() };
      })
    );
    return { actions, noTarget: false };
  }

  if (project.restartCmd && project.restartCmd.trim()) {
    const cmd = project.dir ? `cd ${q(project.dir)} && ${project.restartCmd}` : project.restartCmd;
    const r = await runOnServer(server, cmd);
    return {
      actions: [{ target: "restartCmd", ok: r.code === 0, output: (r.stdout || r.stderr || "").trim() }],
      noTarget: false,
    };
  }

  return { actions: [], noTarget: true };
}
