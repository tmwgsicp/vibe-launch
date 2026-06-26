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
| `setup-git <项目>` | `setup_git` |
| `deploy <项目>` | `deploy_project` |
| `status [项目]` | `get_status` |

## 让项目用 git 部署（一条命令搞定）

想让服务器 `git pull` 拉私有仓库部署，难点是「服务器怎么有权限拉代码」。`setup-git` 一条命令全自动：

```bash
vibe-launch setup-git myapp --repo yourname/yourrepo
```

它会在服务器上：
1. **装 git**（没有就自动装；老到 git 1.8/CentOS7 也兼容）
2. **生成专用 deploy key**（每个项目一把，只读）
3. **自动把 key 加到 GitHub 仓库的 Deploy Keys** —— 你不用手动碰 GitHub 设置
4. **配好 ssh 别名 + remote**，免密拉取

> **加 key 到 GitHub 需要授权**，三选一（自动选，优先级从上到下）：
> - `vibe-launch auth` —— **浏览器点一下授权**（device flow，最省事，不用装 gh、不用手动建 token）
> - 本地已登录的 `gh`（零配置）
> - `--token <PAT>` 或环境变量 `GITHUB_TOKEN`（需 `repo` / `Administration:write` 权限）

### 浏览器授权（device flow）

```bash
vibe-launch auth          # 弹出"打开链接 + 输入码"，授权后存 token 本地
vibe-launch auth --status # 看是否已授权
vibe-launch auth --logout # 清除 token
```

纯本地、无后端、无 secret —— 同 `gh auth login` 的机制。

> 三种 key 各司其职、互不相干：① 你本地连服务器的 SSH key　② 你本地推代码到 GitHub 的认证（`gh`）　③ 服务器拉代码的 deploy key（这条命令自动配的）。

之后把部署命令设成 `git pull && ...` 即可：

```bash
vibe-launch project add myapp --server prod --dir /path/to/app \
  --deploy "git pull && docker restart myapp-api myapp-web"
vibe-launch deploy myapp
```

目录已经有手写代码（非 git）？加 `--adopt`，它会**先备份**再转成 git checkout（用仓库覆盖被跟踪文件，保留 `.env`/构建产物等未跟踪文件）。

## 安全访问：SSH 隧道（免开公网 DB 端口）

数据库/缓存**不该暴露在公网**。生产让 app 走内网容器访问 PG/Redis；你本地开发要连库时，用隧道：

```bash
vibe-launch tunnel prod --service pg      # 本地 localhost:5432 → 服务器内网 PG
vibe-launch tunnel prod --service redis   # 本地 localhost:6379 → 服务器内网 Redis
vibe-launch tunnel prod --remote-port 8001 --local-port 18001   # 任意端口
```

走的是已有的 SSH 端口（key 加密）。你的 DB 工具连 `localhost` 即可，**服务器上 PG/Redis 的公网端口可以彻底关闭**，攻击面大降。`Ctrl+C` 关闭隧道。

## 设计原则

- **不做 1Panel/k8s 已经做好的事**：不跑容器、不管数据库、不反代、不 build 镜像
- **只做缺的那块**：多服务器多项目的**集中编排 + 清单 + AI 接口**
- **清单 + 专用 key** 都在本地 `~/.vibe-launch/`，透明可控

## License

AGPL-3.0-only
