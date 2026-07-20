// 主动告警：把监测发现的问题推到用户配的 webhook。纯本地、无后端、零新依赖（就是个 POST）。
// 自动适配常见机器人格式：企业微信/钉钉、飞书、Discord、Slack，其余走通用兜底。

/** 按 webhook 地址判断机器人类型，返回对应的 body（大多是 JSON 文本消息）。 */
export function formatWebhook(url: string, text: string): unknown {
  if (/qyapi\.weixin\.qq\.com|oapi\.dingtalk\.com/.test(url)) return { msgtype: "text", text: { content: text } }; // 企业微信 / 钉钉
  if (/open\.feishu\.cn|open\.larksuite\.com/.test(url)) return { msg_type: "text", content: { text } }; // 飞书
  if (/discord(app)?\.com\/api\/webhooks/.test(url)) return { content: text.slice(0, 1900) }; // Discord
  if (/hooks\.slack\.com/.test(url)) return { text }; // Slack
  return { text, content: text, msgtype: "text" }; // 通用兜底：多塞几个常见字段
}

export async function sendNotify(webhook: string, text: string): Promise<{ ok: boolean; error?: string }> {
  if (!/^https?:\/\//.test(webhook)) return { ok: false, error: "webhook 需为 http(s) 地址" };
  try {
    const r = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(formatWebhook(webhook, text)),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
