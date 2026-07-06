<div align="center">

# 🚀 vibe-launch

### 把 AI 写的项目，一键部署到你的服务器 | MCP 原生 | agentless | 多服务器编排

**一句"部署"就上线 | SSH 全自动免密 | 可视化操作台 | git 部署闭环 | 安全隧道**

[![GitHub stars](https://img.shields.io/github/stars/tmwgsicp/vibe-launch?style=for-the-badge&logo=github)](https://github.com/tmwgsicp/vibe-launch/stargazers)
[![License](https://img.shields.io/badge/License-AGPL%203.0-blue?style=for-the-badge)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A518-brightgreen?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-ready-purple?style=for-the-badge)]()

> **100% 开源，完全免费。** 纯本地工具 —— 无账号、无后端、无 secret，清单和密钥都在你自己机器上，透明可控。

</div>

---

> **vibe-tutor 教你怎么做，vibe-launch 替你部署上线。** —— 补全 vibecoding「从写到上线」的最后一公里。

## 🎯 解决什么问题？

AI 帮你把项目写完了，但**部署上线**还是一道坎：

- ❌ 手搓 `ssh-keygen`、配免密、上 GitHub 加 deploy key —— 每台服务器、每个项目都来一遍
- ❌ 多个项目散在多台机器，「哪个在哪台、当初怎么部署的」全靠脑子记
- ❌ 想让 AI 顺手帮你部署，可它碰不到你的服务器
- ❌ 数据库端口图省事开了公网，悄悄变成攻击面
- ❌ 部署完不知道成没成，一出问题就 SSH 上去翻半天日志

**vibe-launch 帮你：**

- ✅ **一条命令接入服务器** —— 自动装专用 key，之后免密直连
- ✅ **一份本地清单** 管住所有服务器和项目，谁在哪台、怎么部署一目了然
- ✅ **MCP 原生** —— 在 Claude Code / Cursor 里说一句「部署 X」就上线
- ✅ **SSH 隧道** 把内网数据库映射到本地，公网端口彻底关掉
- ✅ **可视化操作台** —— 部署 / 回滚 / 日志 / 状态一眼看全

## ✨ 核心特性

- 🪶 **agentless** —— 用你本地 `~/.ssh` 直连，目标服务器零安装
- 🤖 **AI 原生** —— MCP 让 Claude Code / Cursor / Codex 直接调用；CLI 给终端和自动化
- 🔑 **SSH 全自动** —— 一条命令生成专用 key、装到服务器、之后免密，不用手搓 `ssh-keygen`
- 🔌 **部署机制可插拔** —— 每个项目自配部署命令（`git pull && docker restart` / `docker compose up` / 任意脚本），不锁 1Panel / GitHub
- 📥 **git 部署闭环** —— 一条命令把服务器目录转成 git checkout + 自动配只读 deploy key，之后 `git pull` 部署
- 🖥️ **可视化操作台** —— 状态 / 部署 / 回滚 / 实时日志 / 端口检测 / 文件管理，纯本地浏览器里点
- 🔒 **安全隧道** —— 内网 PG / Redis 映射到本地，公网 DB 端口可彻底关闭
- 🌍 **跨发行版** —— 指标采集只依赖 procfs + POSIX，CentOS 7 老到 git 1.8 也兼容

## 📦 安装

```bash
npm install -g vibe-launch
```

> 需要 Node ≥ 18。装好后 `vibe-launch`（或简写 `vl`）即可用。

## 🚀 60 秒上手

```bash
# 1. 接入服务器（自动配好 SSH，之后免密）
vibe-launch server add prod --host 1.2.3.4 --user root --password "你的密码"

# 2. 登记项目（部署到哪台、怎么部署、容器、健康检查）
vibe-launch project add myapp --server prod \
  --dir /path/to/app \
  --deploy "git pull && docker restart myapp-api myapp-web" \
  --containers myapp-api,myapp-web \
  --health http://127.0.0.1:8000/health

# 3. 部署 / 看状态 / 重启
vibe-launch deploy myapp
vibe-launch status
vibe-launch restart myapp     # 只重启容器 + 健康检查，不拉代码
```

## 🛠 复杂运维：从"手搓 SSH"收进 vl

常规「部署当前代码」`deploy` 就够；但**事故响应 / 带 DB 迁移 / 灰度上线**这类要细粒度控制、穿透执行、步骤间验证的活，也不用再手搓一堆 `ssh … docker exec …`：

```bash
# 穿透执行：在项目所在服务器上跑即席命令（自动带 host/key）
vibe-launch run myapp "git -C /path/to/app log -3"
vibe-launch run myapp --container myapp-api "python manage.py migrate"   # 自动 docker exec 进容器
vibe-launch run myapp --container myapp-pg "psql -U app -c 'select count(*) from users'"

# 选择性重启：poller 改动只重 worker，不打断 api 用户
vibe-launch restart myapp --only myapp-worker

# 部署前后钩子（写在项目配置里）：先迁移 → pull → 重启 → 烟测，一条 deploy 全编排
vibe-launch deploy myapp --dry-run            # 先看编排计划，不执行

# 灰度收尾：部署后持续盯，异常就秒回滚
vibe-launch deploy myapp --watch --duration 30m
vibe-launch env myapp set FEATURE_X=on --restart    # 改远端 .env（自动备份）+ 重启
vibe-launch rollback myapp                     # 回退上一个提交 + 重启（默认二次确认）

# 前端一体：本地 build → 传产物 → 原子替换 → 重启 web（走项目 frontend 配置）
vibe-launch deploy myapp --frontend
```

> `preDeploy` / `postDeploy` / `frontend` / `envFile` 都是项目配置里的可选段，见 [`vibe-launch.example.yaml`](vibe-launch.example.yaml)。危险操作（`rollback` / `env set`）带 `--dry-run` 预览和二次确认（脚本里加 `-y` 跳过）。

## 🖥️ 可视化操作台

```bash
vibe-launch ui          # 起本地操作台 + 自动开浏览器（localhost:7777）
```

> 起 `vibe-launch ui` 后浏览器里看：**总览 / 服务器 / 项目 / MCP / 设置** 五个页签。

一个完整的运维面板，纯本地、只监听 `127.0.0.1`、无需账号。「看比说高效」的那些事都在这里：

- **总览** —— 项目状态网格（git 版本 / 容器 / 健康检查）+ 服务器健康一眼概况
- **服务器** —— 内存 / 磁盘 / 负载彩色条 + 容器数 + 运行时长 + OS / 内核 / CPU 信息（一次 SSH 采集）
- **一键部署** —— 实时输出；**部署前看更新**（列出将拉取的新提交 diff）；健康检查失败自动拉容器尾部日志
- **回滚** —— 部署历史里每条「回滚到此」，git reset 到旧版本 + 重启 + 健康检查
- **容器** —— 列表（含已停止）/ 重启 / 删除 / 清理；**实时日志流**（关键词高亮 / 只看错误 / 导出 `.log`）
- **端口暴露检测** —— 探 PG / Redis / MySQL / Mongo / SQL Server 公网可达性，区分容器 vs 原生、仅本地 vs 公网，给针对性关闭指引
- **隧道** —— 界面里一键开 PG / Redis 隧道、管理活跃隧道
- **文件** —— 项目目录 / 服务器任意路径浏览，`.env` 等配置在线编辑（存前自动备份）、二进制上传下载

> 重活（容器编排、数据库、反代、防火墙全功能、Web 终端）是 1Panel 的地盘 —— vibe-launch 只做**部署闭环 + 「看比说高效」的可视化**，不做又一个服务器面板。

## 🤖 给 AI 工具用（MCP）

启动 MCP server：

```bash
vibe-launch mcp
```

在 Claude Code / Cursor 里配置后，对它说 **「部署 myapp」**，它会调用 `deploy_project` 工具完成。

```json
{
  "mcpServers": {
    "vibe-launch": { "command": "npx", "args": ["-y", "vibe-launch", "mcp"] }
  }
}
```

| 命令 | MCP 工具 |
|---|---|
| `server add` | `onboard_server` |
| `project add` | `add_project` |
| `setup-git <项目>` | `setup_git` |
| `deploy <项目>` | `deploy_project` |
| `restart <项目>` | `restart_project` |
| `status [项目]` | `get_status` |

外加 6 个**只读诊断**工具，让 AI 看见操作台能看到的数据，形成「部署 → 查健康 → 读日志 → 决策」闭环：

| MCP 工具 | 作用 |
|---|---|
| `get_logs` | 拉容器日志尾部，定位健康检查失败原因 |
| `preview_deploy` | 部署前看将拉取的新提交 diff |
| `get_history` | 看部署 / 回滚历史 |
| `get_server_stats` | 服务器 CPU / 内存 / 磁盘 / 负载指标 |
| `list_containers` | 列出容器（含已停止） |
| `check_ports` | 数据库端口暴露检测 |

> MCP 只暴露**安全幂等的动词 + 只读诊断**。盯实时日志流、开隧道、回滚、删容器、文件读写这类交互 / 有副作用的操作只在操作台（`ui`）里，不进 MCP —— 不让 AI 自动碰。

## 🔗 让项目用 git 部署（一条命令搞定）

想让服务器 `git pull` 拉私有仓库部署，难点是「服务器怎么有权限拉代码」。`setup-git` 一条命令全自动：

```bash
vibe-launch setup-git myapp --repo yourname/yourrepo
```

它会在服务器上：

1. **装 git**（没有就自动装；老到 git 1.8 / CentOS 7 也兼容）
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

目录已经有手写代码（非 git）？加 `--adopt`，它会**先备份**再转成 git checkout（用仓库覆盖被跟踪文件，保留 `.env` / 构建产物等未跟踪文件）。

## 🔒 安全访问：SSH 隧道（免开公网 DB 端口）

数据库 / 缓存**不该暴露在公网**。生产让 app 走内网容器访问 PG / Redis；你本地开发要连库时，用隧道：

```bash
vibe-launch tunnel prod --service pg      # 本地 localhost:5432 → 服务器内网 PG
vibe-launch tunnel prod --service redis   # 本地 localhost:6379 → 服务器内网 Redis
vibe-launch tunnel prod --remote-port 8001 --local-port 18001   # 任意端口
```

走的是已有的 SSH 端口（key 加密）。你的 DB 工具连 `localhost` 即可，**服务器上 PG / Redis 的公网端口可以彻底关闭**，攻击面大降。`Ctrl+C` 关闭隧道。

## 🧭 设计原则

- **不做 1Panel / k8s 已经做好的事** —— 不跑容器、不管数据库、不反代、不 build 镜像
- **只做缺的那块** —— 多服务器多项目的**集中编排 + 清单 + AI 接口**
- **清单 + 专用 key** 都在本地 `~/.vibe-launch/`，透明可控

## 🧩 vibecoding 工具家族

从写到上线，一条龙：

- 📘 **[vibecoding 教程](https://vibecoding.waytomaster.com)** —— AI 编程方法论，从想法到上线
- 🎓 **[Vibe Tutor](https://github.com/tmwgsicp/vibe-tutor)** —— AI 编程方法论导师（14 步流程 + 7 大陷阱检测）
- 🚀 **vibe-launch** —— 你在这里：替你把项目部署上线

## 💬 联系方式

<table>
  <tr>
    <td align="center">
      <img src="assets/qrcode/wechat.jpg" width="200"><br>
      <b>个人微信</b><br>
      <em>技术交流 · 商务合作</em>
    </td>
    <td align="center">
      <img src="assets/qrcode/sponsor.jpg" width="200"><br>
      <b>赞赏支持</b><br>
      <em>开源不易，感谢支持</em>
    </td>
  </tr>
</table>

- **GitHub Issues**：[提交问题](https://github.com/tmwgsicp/vibe-launch/issues)
- **邮箱**：creator@waytomaster.com

## 🙏 致谢

- [commander](https://github.com/tj/commander.js) —— CLI 框架
- [ssh2 / node-ssh](https://github.com/mscdex/ssh2) —— SSH 直连
- [Model Context Protocol SDK](https://github.com/modelcontextprotocol) —— AI 工具接口

---

## License

[AGPL-3.0-only](LICENSE)

<div align="center">

**如果觉得有用，点个 ⭐ Star 支持一下！**

[![Star History Chart](https://api.star-history.com/svg?repos=tmwgsicp/vibe-launch&type=Date)](https://star-history.com/#tmwgsicp/vibe-launch&Date)

Made with ❤️ by [tmwgsicp](https://github.com/tmwgsicp)

</div>
