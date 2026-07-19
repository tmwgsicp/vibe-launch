// vl env set：改远端 .env（默认 <dir>/.env）。upsert 键值、改前自动备份 .vlbak、可选重启容器 + 健康检查。
// 灰度调参最常用："改一个 env → 重启 → 盯一会儿"。值走 base64 传输，避免特殊字符/引号破坏 .env。
import type { Config } from "./types.js";
import { getProject } from "./config.js";
import { runOnServer, waitHealthy } from "./ssh.js";

import { shQuote as q } from "./sh.js";
import { reloadServices } from "./reload.js";
import { recordOp } from "./oplog.js";
const validKey = (k: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k);

export interface EnvSetResult {
  project: string;
  server: string;
  file: string;
  changed: { key: string; action: "add" | "update" }[];
  backup?: string;
  restarted?: { container: string; ok: boolean }[];
  health?: { url: string; httpCode: string; ok: boolean }[];
  /** 请求了 --restart 但项目没配 containers/restartCmd：.env 写了但没能重启生效，如实告警而非假成功。 */
  warning?: string;
  success: boolean;
  error?: string;
}

export async function setEnv(
  config: Config,
  projectName: string,
  kv: Record<string, string>,
  opts: { file?: string; restart?: boolean; dryRun?: boolean } = {}
): Promise<EnvSetResult> {
  const { project, server, serverName } = getProject(config, projectName);
  const res: EnvSetResult = { project: projectName, server: serverName, file: "", changed: [], success: false };
  try {
    const keys = Object.keys(kv);
    if (!keys.length) throw new Error("没有要设置的键值");
    for (const k of keys) if (!validKey(k)) throw new Error(`非法环境变量名：${k}`);

    const file = opts.file || project.envFile || (project.dir ? project.dir.replace(/\/+$/, "") + "/.env" : "");
    if (!file || !file.startsWith("/")) throw new Error("无法确定 .env 路径（项目没配 dir/envFile，也没传 --file 绝对路径）");
    res.file = file;

    // 读现有内容
    const cur = await runOnServer(server, `[ -f ${q(file)} ] && cat ${q(file)} || echo __NOFILE__`);
    const existed = !cur.stdout.startsWith("__NOFILE__");
    const lines = existed ? cur.stdout.replace(/\n$/, "").split("\n") : [];

    // upsert：命中的键就地改（保留注释和顺序），没命中的追加到末尾
    const seen = new Set<string>();
    const out: string[] = [];
    for (const line of lines) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (m && Object.prototype.hasOwnProperty.call(kv, m[1])) {
        out.push(`${m[1]}=${kv[m[1]]}`);
        if (!seen.has(m[1])) { res.changed.push({ key: m[1], action: "update" }); seen.add(m[1]); }
      } else {
        out.push(line);
      }
    }
    for (const k of keys) {
      if (!seen.has(k)) { out.push(`${k}=${kv[k]}`); res.changed.push({ key: k, action: "add" }); }
    }
    const content = out.join("\n") + "\n";

    if (opts.dryRun) {
      res.success = true;
      return res; // changed 已填好，调用方据此打印将改哪些键
    }

    // 备份 + 写入（base64，二进制安全，避免值里的 # " ' $ 破坏 shell）
    const b64 = Buffer.from(content, "utf8").toString("base64");
    const backup = file + ".vlbak";
    const w = await runOnServer(
      server,
      `[ -f ${q(file)} ] && cp ${q(file)} ${q(backup)}; printf %s ${q(b64)} | base64 -d > ${q(file)} && echo __OK__`
    );
    if (!w.stdout.includes("__OK__")) throw new Error(`写入失败：${(w.stderr || w.stdout).trim()}`);
    if (existed) res.backup = backup;

    // 可选重启 + 健康检查（让新 env 生效）。容器→docker restart，systemd→restartCmd，都没配→告警不假成功。
    if (opts.restart) {
      const reload = await reloadServices(server, project);
      if (reload.noTarget) {
        res.warning = ".env 已写入，但项目没配 containers/restartCmd，无法自动重启 —— 新值尚未生效。请手动重启或配 restartCmd。";
      } else {
        res.restarted = reload.actions.map((a) => ({ container: a.target, ok: a.ok }));
        res.health = [];
        for (const url of project.health ?? []) {
          const code = await waitHealthy(server, url);
          res.health.push({ url, httpCode: code, ok: /^2\d\d$/.test(code) });
        }
      }
    }
    res.success = true;
    recordOp("env-set", projectName, true, "keys: " + Object.keys(kv).join(",") + (res.warning ? "（未重启）" : ""));
    return res;
  } catch (e) {
    res.error = (e as Error).message;
    recordOp("env-set", projectName, false, res.error);
    return res;
  }
}
