<div align="center">

# 🚀 vibe-launch

### 把 AI 写的项目，一键部署到你的服务器 | MCP 原生 | agentless

[![npm](https://img.shields.io/npm/v/vibe-launch?style=flat-square&logo=npm)](https://www.npmjs.com/package/vibe-launch)
[![License](https://img.shields.io/badge/License-AGPL%203.0-blue?style=flat-square)](https://github.com/tmwgsicp/vibe-launch/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A518-brightgreen?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)

**纯本地 · agentless · AI 可调用（MCP + CLI）的多服务器部署编排器**

</div>

---

> **vibe-tutor 教你怎么做，vibe-launch 替你部署上线。** 补全 vibecoding「从写到上线」的最后一公里。

用你本地的 `~/.ssh` 直连服务器（目标机零安装），把「哪个项目在哪台 / SSH 怎么连 / 一键部署 / 看状态 / 看日志 / 回滚」收进一个轻工具。重活（容器、数据库、反代）交给 1Panel / docker —— 它只管**部署编排 + 可视化 + AI 接口**。

## 安装

```bash
npm install -g vibe-launch
```

## 60 秒上手

```bash
# 1. 接入服务器（自动配好 SSH，之后免密）
vibe-launch server add prod --host 1.2.3.4 --user root --password "你的密码"

# 2. 登记项目
vibe-launch project add myapp --server prod \
  --dir /path/to/app \
  --deploy "git pull && docker restart myapp-api" \
  --containers myapp-api \
  --health http://127.0.0.1:8000/health

# 3. 部署 / 看状态 / 重启
vibe-launch deploy myapp
vibe-launch status
vibe-launch restart myapp
```

## 可视化操作台

```bash
vibe-launch ui      # 本地操作台（localhost:7777）：部署 / 回滚 / 实时日志 / 容器 / 指标 / 端口检测
```

## 给 AI 工具用（MCP）

```bash
vibe-launch mcp
```

在 Claude Code / Cursor 里配置后，对它说「部署 myapp」即可：

```json
{
  "mcpServers": {
    "vibe-launch": { "command": "npx", "args": ["-y", "vibe-launch", "mcp"] }
  }
}
```

暴露 13 个工具：部署 / 重启 / 状态 / 接入 / 登记 / 转 git + 只读诊断（日志 / 部署 diff / 历史 / 指标 / 容器 / 端口暴露检测）。

## 📖 完整文档

setup-git 一条命令转 git 部署、GitHub device flow 授权、SSH 隧道、设计原则等完整说明见 GitHub：

**👉 https://github.com/tmwgsicp/vibe-launch**

## License

[AGPL-3.0-only](https://github.com/tmwgsicp/vibe-launch/blob/main/LICENSE)
