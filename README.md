# 外部 Agent

在 DeepSeek Harness 0.2.2-rc.3 的 Web 或桌面对话里使用本机 Kimi Code 和 Codex。打开会话的模型菜单，选择相应 Agent 或它公布的模型。首次使用时，设置向导会给出官方安装和登录命令。安装或登录完成后点 **重新检测**，即可继续使用原有输入框。

## 安装

确保本机 CLI 可执行，并先用 `kimi login` 或 `codex login` 登录。Codex 适配器优先使用 PATH 中的 `codex-acp`，否则自动用 npm 拉取固定版本 `@agentclientprotocol/codex-acp@2.6.0`。首次启动需要能访问 npm。

从源码构建并安装到所需 profile：

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm pack
dsh plugin --profile web add "$PWD/dsh-external-agents-0.1.5.tgz"
dsh plugin --profile desktop add "$PWD/dsh-external-agents-0.1.5.tgz"
```

使用桌面发行版自带的 0.2.2-rc.3 CLI。桌面 profile 需先由应用初始化，安装前完全退出该实例，之后重新打开。

## 对话与权限

工具、文件改动、审批和提问使用 DSH 原有界面。停止按钮会取消 ACP 回合。完全放开预设保留对应执行权限，受限会话中的 ACP 审批请求交回 DSH。各 CLI 仍负责实际沙箱。同一个工作区内，Codex 的 workspace-write 模式允许它直接写入。Codex 默认使用本机配置的 provider，新会话可以在使用同一 provider 的 Codex 客户端恢复。插件给自己的 Codex 子进程关闭 hooks，并将审批交给用户。

生成中放宽权限时，Kimi Code 会尝试在当前回合切换。Codex 或热切未获确认的 Kimi 会在下一轮同步新权限。收紧外部 Agent 的执行模式会停止旧回合，并在会话顶部显示「按新权限继续」。继续时会带入对话摘要，由 Agent 检查进度后处理剩余工作。

会话绑定保存在当前 DSH 数据目录的 `external-agents/bindings`。关闭并重开后，插件优先重连已有 ACP 会话。换 Agent 或重连失败时会带入可见历史的摘要，并提示外部 Agent 从新上下文开始。模型和推理等级以 ACP 广告为准，选项可能随账号、工作目录和版本变化。ACP 会话空闲五分钟后释放子进程，下一轮按原绑定恢复。

## 配置与范围

把配置加在 DSH profile patch 的 `external-agents` 条目：

```yaml
- id: external-agents
  config:
    injectDshSkills: true
    injectDshMcp: true
    codexTransport: native
```

`commandOverrides` 可以为 `kimi-code` 或 `codex` 指定 `command` 和 `args`，用于非标准安装路径。

显式设置 `codexTransport: https` 会使用 `dsh-openai-http`。Codex 客户端恢复这些会话时也需要注册该 provider。

可转发且无需凭证的 MCP 默认带入，不能转发的项目会列在对话提示里。

外部 Agent 通过本机只读 MCP 发现当前 DSH 会话的技能目录，再按名称读取所需技能的正文。`injectDshSkills` 控制这条自动读取路径。在 DSH 中手动选中技能时，DSH 会直接把该技能的正文放入当前回合。升级前建立的 ACP 会话在下一轮切换到按需加载，并带入 DSH 对话摘要；DSH 会话记录保留。

登录凭证由 CLI 保管。思考过程、子代理派发和 TUI 属于后续范围。
