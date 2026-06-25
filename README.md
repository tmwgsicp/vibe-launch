<div align="center">

# 🚀 vibe-launch

### 把 AI 写的项目，一键部署到你的服务器

**在 Claude Code / Cursor 里说一句"部署"就上线** · 轻量 · agentless · AI 原生

[![License](https://img.shields.io/badge/License-AGPL%203.0-blue?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A518-brightgreen?style=flat-square&logo=node.js)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-ready-purple?style=flat-square)]()

</div>

---

> **vibe-tutor 教你怎么做，vibe-launch 替你部署上线。** —— 补全 vibecoding "从写到上线" 的最后一公里。

## 这是什么

一个**多服务器部署编排器**：把散落各处的「哪个项目在哪台 / SSH 怎么连 / 一键部署 / 看状态」收进一个轻工具。重活（容器、数据库、反代）交给 1Panel / docker —— 它只管**部署编排 + 清单**。

- 🪶 **agentless**：用你本地 `~/.ssh` 直连服务器，目标机零安装
- 🔌 **部署机制可插拔**：每个项目自配部署命令（`git pull && docker restart` / `docker compose up` / 任意脚本）—— 不锁 1Panel/GitHub
- 🤖 **AI 原生**：MCP 让 Claude Code / Cursor / Codex 直接调用；CLI 给终端和自动化
- 🔑 **SSH 全自动**：一条命令自动生成专用 key、装到服务器、之后免密 —— 不用你手搓 ssh-keygen

## 安装

```bash
npm install -g vibe-launch
```

## 60 秒上手

```bash
# 1. 接入服务器（自动配好 SSH，之后免密）
vibe-launch server add prod --host 1.2.3.4 --user root --password "你的密码"

# 2. 登记项目（部署到哪台、怎么部署、容器、健康检查）
vibe-launch project add myapp --server prod \
  --dir /path/to/app \
  --deploy "git pull && docker restart myapp-api myapp-web" \
  --containers myapp-api,myapp-web \
  --health http://127.0.0.1:8000/health

# 3. 部署 / 看状态
vibe-launch deploy myapp
vibe-launch status
```

## 给 AI 工具用（MCP）

启动 MCP server：

```bash
vibe-launch mcp
```

在 Claude Code / Cursor 里配置后，对它说 **"部署 myapp"**，它会调用 `deploy_project` 工具完成。

| 命令 | MCP 工具 |
|---|---|
| `server add` | `onboard_server` |
| `project add` | `add_project` |
| `deploy <项目>` | `deploy_project` |
| `status [项目]` | `get_status` |

## 设计原则

- **不做 1Panel/k8s 已经做好的事**：不跑容器、不管数据库、不反代、不 build 镜像
- **只做缺的那块**：多服务器多项目的**集中编排 + 清单 + AI 接口**
- **清单 + 专用 key** 都在本地 `~/.vibe-launch/`，透明可控

## License

AGPL-3.0-only
