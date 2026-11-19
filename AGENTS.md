# AGENTS.md

## 项目目标

维护独立的多智能体远程控制平台 **Agent Control**（支持 Codex、Claude Code 与 Antigravity 的本机控制台与中继远程控制）。

## 目录地图

- `src/server.mjs`：HTTP/SSE 服务主入口（默认 `127.0.0.1:43310`）与 API 路由。
- `src/provider-hub.mjs`：统一会话聚合、复合 ID（`<provider>:<profileId>:<rawId>`）分发、冲突隔离审批表、统一排队及 `/goal` 自动续跑控制器。
- `src/providers/`：三大智能体适配器与多实例自动发现（`profile-discovery.mjs`、`codex-*`、`claude-*`、`antigravity-*`）。
- `src/remote-bridge.mjs` & `relay/relay-server.mjs`：主机出站 WebSocket 隧道与自托管公网中继。
- `public/`：无构建静态前端（ESM + 响应式 CSS，严格使用相对 URL `./` 以兼容 `/i/<instanceId>/` 中继前缀）。
- `RELEASE_NOTES.md` & `RELEASE_NOTES.en.md`：面向最终用户的中/英双语版本更新说明真源（每次发版或推送用户可见改动时在两份文件顶部用白话同步更新「新增 / 优化 / 修复」要点，「版本与自动更新」弹窗会按当前界面语言自动切换展示）。
- `tests/`：基于 Mock CLI 的零 Token 端到端测试，以及只读本机索引冒烟测试。

## 不可突破的工程边界

1. **端口与数据目录隔离**：保持独立端口（`43310`）、独立数据目录（`~/Library/Application Support/Agent Control/`）及 LaunchAgent 标识（`com.guuguo.agent-control`），不与其他本地控制面板冲突。
2. **只读索引与非侵入元数据**：对 `~/.codex`、`~/.claude`、`~/.gemini` 历史库与转录文件仅做只读解析；重命名与归档统一写入 `<dataDir>/thread-meta.json`，严禁篡改上游引擎原始数据库。
3. **禁止窃取凭证与危险探测**：多实例发现只能读取显式环境变量、`LaunchAgents` 公开路径及账号展示字段（如邮箱/昵称），禁止读取或转发任何 token、API key 或执行 `ps e`。
4. **测试零消耗纪律**：除明确只读发现检查外，任何自动化测试与冒烟测试都必须通过 Mock CLI 驱动真实协议，禁止向真实远端大模型发起对话请求。
5. **Git Commit 英文规范**：新增提交统一使用简洁英文 Conventional Commits（如 `feat(ui): ...`、`fix(codex): ...`、`docs: ...`），严禁对已推送历史做 rebase / force-push（避免破坏客户端 `git pull --ff-only` 自动更新）。

## 常用验证命令

```bash
npm run check
npm test
```
