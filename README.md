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
dsh plugin --profile web add "$PWD/dsh-external-agents-0.2.0.tgz"
dsh plugin --profile desktop add "$PWD/dsh-external-agents-0.2.0.tgz"
```

使用桌面发行版自带的 0.2.2-rc.3 CLI。桌面 profile 需先由应用初始化，安装前完全退出该实例，之后重新打开。

## 对话与权限

工具、文件改动、审批和提问使用 DSH 原有界面。停止按钮会取消 ACP 回合。完全放开预设保留对应执行权限，受限会话中的 ACP 审批请求交回 DSH。各 CLI 仍负责实际沙箱。同一个工作区内，Codex 的 workspace-write 模式允许它直接写入。Codex 默认使用本机配置的 provider，新会话可以在使用同一 provider 的 Codex 客户端恢复。插件给自己的 Codex 子进程关闭 hooks，并将审批交给用户。

生成中放宽权限时，Kimi Code 会尝试在当前回合切换。Codex 或热切未获确认的 Kimi 会在下一轮同步新权限。收紧外部 Agent 的执行模式会停止旧回合，并在会话顶部显示「按新权限继续」。继续时会带入对话摘要，由 Agent 检查进度后处理剩余工作。

会话绑定保存在当前 DSH 数据目录的 `external-agents/bindings`。关闭并重开后，插件优先重连已有 ACP 会话。换 Agent 或重连失败时会带入可见历史的摘要，并提示外部 Agent 从新上下文开始。模型和推理等级以 ACP 广告为准，选项可能随账号、工作目录和版本变化。ACP 会话空闲五分钟后释放子进程，下一轮按原绑定恢复。

## 配置与范围

打开 **插件 → 外部 Agent → 设置**，可调整 DSH 技能共享、MCP 共享、Codex 连接方式和无进展提醒。提醒默认 5 分钟，可设为 1 到 120 分钟，从下一轮生效。提醒显示正在等待工具、审批或回复，当前任务可以继续运行。活动回合由 Agent 完成、用户停止或实际连接关闭结束。连接断开后可在原 DSH 会话继续，交接优先保留原任务和用户补充要求。模型菜单将 Kimi Code 和 Codex 放在带「外部 Agent」前缀的小组中，每个可选模型都有插件标签。

也可以通过 DSH profile patch 的 `external-agents` 条目配置：

```yaml
- id: external-agents
  config:
    injectDshSkills: true
    injectDshMcp: true
    codexTransport: native
    idleWarningMinutes: 5
```

`commandOverrides` 可以为 `kimi-code` 或 `codex` 指定 `command` 和 `args`，用于非标准安装路径。

显式设置 `codexTransport: https` 会使用 `dsh-openai-http`。Codex 客户端恢复这些会话时也需要注册该 provider。

可转发且无需凭证的 MCP 默认带入，不能转发的项目会列在对话提示里。

外部 Agent 通过本机只读 MCP 发现当前 DSH 会话的技能目录，再按名称读取所需技能的正文。`injectDshSkills` 控制这条自动读取路径。在 DSH 中手动选中技能时，DSH 会直接把该技能的正文放入当前回合。升级前建立的 ACP 会话在下一轮切换到按需加载，并带入 DSH 对话摘要；DSH 会话记录保留。

登录凭证由 CLI 保管。思考过程和 TUI 属于后续范围。

外部 CLI 意外退出时，DSH 插件日志记录退出码或信号。启动失败和 CLI 标准错误输出中的已知错误码也会记录，日志只保留这些诊断字段。

## 派发子智能体

1. 在 DSH 的「子智能体 → 模型选择」设置中，开启「允许 Agent 为子智能体选择模型」，授权「外部 Agent」分组里的 Kimi Code 或 Codex 模型，然后新建会话。
2. 在主会话使用带有原生子智能体工具的 DSH 智能体，要求它把任务派给指定的外部 Agent。派发沿用 DSH 的 `subagent` 工具、模型授权和角色预设。预设可由 DSH 部署允许选择，省略角色预设时沿用 DSH 自身的预设继承。
3. 主会话用 `send_message` 向同一个子智能体继续发消息。子智能体可以在完成后被唤醒，DSH 会把每次完成的结果交回主会话。

外部 Agent 收到子智能体预设中的角色指令和派发消息，按子会话的权限运行。需要额外权限或用户作答时，子智能体可在结果中说明限制，由主会话处理。DSH 技能仍按子会话的作用域读取，部署级 MCP 共享设置用于主会话。
