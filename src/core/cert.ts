// 证书到期监测：直接从本机 TLS 连域名 443 读证书有效期，算还剩几天。
// agentless —— 连 SSH 都不用（证书是公网可读的）。给"证书快过期"预警（正好对应踩过的 CA 坑）。
import * as tls from "node:tls";
import type { Config } from "./types.js";

export interface CertInfo {
  domain: string;
  daysLeft: number | null; // 距过期天数；null=拿不到
  validTo?: string;
  error?: string;
}

export function checkCert(domain: string, port = 443, timeoutMs = 8000): Promise<CertInfo> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: CertInfo) => { if (done) return; done = true; try { socket.destroy(); } catch { /* ignore */ } resolve(r); };
    const socket = tls.connect(
      { host: domain, port, servername: domain, rejectUnauthorized: false }, // 只读有效期，不校验信任链
      () => {
        const cert = socket.getPeerCertificate();
        if (!cert || !cert.valid_to) return finish({ domain, daysLeft: null, error: "拿不到证书" });
        const days = Math.round((new Date(cert.valid_to).getTime() - Date.now()) / 86400000);
        finish({ domain, daysLeft: days, validTo: cert.valid_to });
      }
    );
    socket.setTimeout(timeoutMs, () => finish({ domain, daysLeft: null, error: "超时" }));
    socket.on("error", (e) => finish({ domain, daysLeft: null, error: (e as Error).message }));
  });
}

/** 从配置里收集要盯的域名：proxy.domain（空格分隔多个）。 */
export function certDomains(config: Config): { project: string; domain: string }[] {
  const out: { project: string; domain: string }[] = [];
  for (const [name, p] of Object.entries(config.projects || {})) {
    if (!p.proxy?.domain) continue;
    for (const d of p.proxy.domain.trim().split(/[\s,]+/).filter(Boolean)) {
      // 通配符/localhost 跳过（连不了）
      if (d.includes("*") || d === "localhost") continue;
      out.push({ project: name, domain: d });
    }
  }
  return out;
}

/** 查所有配置域名的到期天数（并发）。返回 project → 最小剩余天数（最紧的那张证书）。 */
export async function certDaysByProject(config: Config): Promise<Record<string, number>> {
  const doms = certDomains(config);
  const results = await Promise.all(doms.map(async (d) => ({ ...d, info: await checkCert(d.domain) })));
  const min: Record<string, number> = {};
  for (const r of results) {
    if (r.info.daysLeft == null) continue;
    if (!(r.project in min) || r.info.daysLeft < min[r.project]) min[r.project] = r.info.daysLeft;
  }
  return min;
}
