# Linux 安装与运行

Linux 使用浏览器控制台，支持本机 Agent CLI、历史会话、任务队列、审批和手机远程控制。macOS 的原生 `.app`、Finder 入口与 `say` 播报不适用于 Linux。各 Agent 本身是否支持当前发行版及架构，以该 CLI 为准。

## 桌面或带 systemd 的服务器

准备 Node.js 22.13+（或 24+）、npm、Git 和 curl，以运行 Agent CLI 的同一用户安装：

```bash
curl -fsSL https://raw.githubusercontent.com/guuguo/agent-control/main/install.sh | bash -s -- --no-open
```

安装器会创建 `systemd --user` 服务与 `~/.local/bin/agent-control`。服务保留安装时的 PATH，包含选中的 Node 所在目录及用户 CLI 目录，兼容通过 nvm、fnm、Volta 或自定义 npm 目录安装的 CLI。修改 CLI 安装路径后，可运行 `agent-control start` 重新生成服务配置。

```bash
agent-control status
agent-control logs
agent-control restart
```

默认访问 `http://127.0.0.1:43310`，数据在 `${XDG_DATA_HOME:-~/.local/share}/agent-control`，日志在其 `logs/` 下；可通过 `AGENT_CONTROL_DATA_DIR` 指定独立数据目录。

服务器需要在退出 SSH 后及开机未登录时继续运行，可由管理员为运行账号开启 lingering：

```bash
sudo loginctl enable-linger "$(id -un)"
```

这是 systemd 的用户服务驻留设置，安装器不会自动修改。详见 [loginctl 官方说明](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html#enable-linger%20%5BUSER%E2%80%A6%5D)。

## 容器、WSL 或没有可用用户 systemd 的环境

跳过后台服务注册，以前台进程交给现有进程管理器运行：

```bash
curl -fsSL https://raw.githubusercontent.com/guuguo/agent-control/main/install.sh | bash -s -- --no-service --no-open --remote local
~/.local/bin/agent-control run
```

`Failed to connect to bus` 表示当前会话无法连接用户 systemd，不代表 Agent CLI 无法运行；可使用上述前台模式，或先配置该系统的用户服务环境。

没有图形桌面时，可在自己的电脑上建立 SSH 转发，然后在本机浏览器访问同一端口：

```bash
ssh -L 43310:127.0.0.1:43310 user@linux-host
```

手机远程使用控制台中的 Cloudflare、Tailscale 或自托管中继。Linux 不需要为了远程访问把控制台直接监听到公网。

## 验证范围

仓库的 Linux Compatibility 工作流在 Ubuntu 24.04 的 x64 / ARM64、Node.js 22 / 24 上检查服务配置、路径、更新流程和各 Agent 协议。对话测试全部使用 Mock CLI，不消耗真实模型 Token。
