# External Agents（外部 Agent）

External Agents 通过 ACP（Agent Client Protocol）把本机已登录的 Kimi Code、Codex 和 Antigravity 接入 DeepSeek Harness（DSH）。在 DSH 的桌面端和 Web 端，可以像选择模型一样，从当前会话的菜单切换 Agent。三个 Agent 均支持接收主 Agent 派发的子任务。

- **在原生对话里使用** — 沿用 DSH 的输入框和会话记录，在原有界面查看工具调用和文件改动、处理审批和提问。
- **延续已有工作** — 重新打开对话时优先恢复原有 ACP 会话。切换 Agent 时，新 Agent 会收到可见历史的摘要。
- **复用 Skills 和 MCP** — 外部 Agent 可以按需读取当前会话的 Skills。主会话可共享允许转发且无需凭证的 MCP 服务。登录凭证由各自的 CLI 管理。
- **派发外部子智能体** — 授权相应模型后，主 Agent 可以把任务交给 Kimi Code、Codex 或 Antigravity，按角色预设和子会话权限执行。同一个子智能体可以继续接收补充指令，完成结果会回到主会话。

## 演示视频

展示 ACP 接入、原生模型切换、Skills 与 MCP 共享，以及子智能体委派和结果回传。

https://github.com/user-attachments/assets/5b5c7dfa-9c88-4b5d-8579-40edddd56f8f

[下载 MP4（约 29 秒，静音）](https://raw.githubusercontent.com/zoewys/dsh-external-agents/main/docs/media/external-agents-demo.mp4)

## 安装

需要 Node.js 22+ 和 DSH 0.2.2-rc.5。DSH 0.2.2-rc.3 可继续使用 External Agents 0.2.1。确保本机 CLI 可执行，并先用 `kimi login`、`codex login` 或 `agy acp --login` 登录。Codex 适配器优先使用 PATH 中的 `codex-acp`，否则自动用 npm 拉取固定版本 `@agentclientprotocol/codex-acp@2.6.0`。首次启动需要能访问 npm。

按需安装到 Web 或桌面 profile。

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm pack
dsh plugin --profile web add "$PWD/dsh-external-agents-0.3.2.tgz"
dsh plugin --profile desktop add "$PWD/dsh-external-agents-0.3.2.tgz"
```

安装到桌面 profile 时，使用该桌面发行版自带的 CLI。桌面 profile 需先由应用初始化，安装前完全退出该实例，之后重新打开。

安装后，在 DSH 会话的模型菜单中选择「外部 Agent」分组里的 Kimi Code、Codex 或 Antigravity。首次使用某个 CLI 时，设置向导会给出官方安装和登录命令。完成后点击 **重新检测**，即可在原输入框开始对话。

### Antigravity

安装官方 CLI：`curl -fsSL https://antigravity.google/cli/install.sh | bash`，然后执行 `agy acp --login` 登录已有 Google 账号。插件以 `agy acp --process-per-session` 运行，复用 CLI 保存的登录和账号额度；不会继承进程环境中的 Gemini API key 或 Cloud 认证覆盖。插件不保存 Google 凭证。

在模型菜单选择「外部 Agent · Antigravity」，可使用账号提供的 Gemini 模型，并调整推理等级。自定义 ACP 客户端的合作方模型可用性受 Google 限制，插件只列出 Gemini 模型。支持用户直接聊天、手动调用技能和 DSH 原生子智能体派发；子智能体可接收父会话的补充消息，完成结果由 DSH 回传。定时投递和 Remote Tasks 仍不接受。

受限会话使用 Antigravity 的 `default` 模式，在 DSH 中处理审批；完全放开时由 DSH 自动应答单次审批，仍保留 CLI 自身的权限规则。只读或「仅规划」使用 `plan` 模式并拒绝执行审批。在同一 `default` 模式下，从「工作区内修改」切到「完全权限」会即时更新后续审批；需要从 `plan` 切换到 `default` 的放宽仍在下一轮生效，收紧时暂停当前回合。DSH 单独投递的权限通知会正常结束该步骤，不会重发原任务。支持原 ACP 会话恢复、图片和可转发的 MCP，按对方实际能力启用。

参考：[官方 ACP 接入](https://antigravity.google/docs/ide/extensions/acp)、[Google 使用范围说明](https://antigravity.google/docs/faq)。DSH 子智能体派发属于本插件的集成功能；Google 文档未明确说明个人订阅通过第三方 ACP 客户端自动派发的支持范围，插件不保证该使用方式获得 Google 官方支持。

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

`commandOverrides` 可以为 `kimi-code`、`codex` 或 `antigravity` 指定 `command` 和 `args`，用于非标准安装路径。

显式设置 `codexTransport: https` 会使用 `dsh-openai-http`。Codex 客户端恢复这些会话时也需要注册该 provider。

可转发且无需凭证的 MCP 默认带入，不能转发的项目会列在对话提示里。

外部 Agent 通过本机只读 MCP 发现当前 DSH 会话的技能目录，再按名称读取所需技能的正文。`injectDshSkills` 控制这条自动读取路径。在 DSH 中手动选中技能时，DSH 会直接把该技能的正文放入当前回合。升级前建立的 ACP 会话在下一轮切换到按需加载，并带入 DSH 对话摘要；DSH 会话记录保留。

登录凭证由 CLI 保管。思考过程和 TUI 属于后续范围。

外部 CLI 意外退出时，DSH 插件日志记录退出码或信号。启动失败和 CLI 标准错误输出中的已知错误码也会记录，日志只保留这些诊断字段。

## 派发子智能体

1. 在 DSH 的「子智能体 → 模型选择」设置中，开启「允许 Agent 为子智能体选择模型」，授权「外部 Agent」分组里的 Kimi Code、Codex 或 Antigravity 模型，然后新建会话。
2. 在主会话使用带有原生子智能体工具的 DSH 智能体，要求它把任务派给指定的外部 Agent。派发沿用 DSH 的 `subagent` 工具、模型授权和角色预设。预设可由 DSH 部署允许选择，省略角色预设时沿用 DSH 自身的预设继承。
3. 主会话用 `send_message` 向同一个子智能体继续发消息。子智能体可以在完成后被唤醒，DSH 会把每次完成的结果交回主会话。

外部 Agent 收到子智能体预设中的角色指令和派发消息，按子会话的权限运行。需要额外权限或用户作答时，子智能体可在结果中说明限制，由主会话处理。DSH 技能仍按子会话的作用域读取，部署级 MCP 共享设置用于主会话。
