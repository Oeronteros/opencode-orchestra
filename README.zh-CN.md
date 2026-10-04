# OpenCode Orchestra

[![npm version](https://img.shields.io/npm/v/@oeronteros-1/opencode-orchestra)](https://www.npmjs.com/package/@oeronteros-1/opencode-orchestra)
[![license](https://img.shields.io/npm/l/@oeronteros-1/opencode-orchestra)](LICENSE)
[![OpenCode](https://img.shields.io/badge/OpenCode-plugin-4f46e5)](https://opencode.ai/docs/plugins/)

[English](README.md) · [Русский](README.ru.md) · **简体中文**

OpenCode Orchestra 将复杂请求转化为可控的多智能体工作流。它会对任务进行分类、选择已连接的模型、调度专门的智能体、合并证据、实施修改、验证结果，并在本地记录成本与使用情况。

**OpenCode Orchestra 面向 OpenCode v2**，通过插件 `setup` API 加载。OpenCode 1.18.29 及更新版本仍保留兼容入口。

- 一个主智能体，以及一组权限受限的专用智能体
- 自动发现模型、预算模式、按智能体覆盖模型，以及 fallback 链
- 依赖感知执行，并严格限制并发数、委派深度和文件所有权
- 可选的隔离 Git worktree，用于并行编辑
- 带持久配置文件的托管 Chrome，使用 Playwright 执行 UI 工作流，使用 DevTools 进行诊断
- 本地控制面板，展示实时活动、token、成本、模型、智能体和 MCP 状态
- 诊断、MCP 冒烟测试、有界自主循环，以及离线语音输入

## 快速开始

要求：[OpenCode v2](https://opencode.ai/)、Bun 1.2 或更高版本、Node.js 22.12 或更高版本，以及 OpenCode 支持的模型提供商。托管浏览器还需要 OpenCode 2.0.16 或更高版本，以及单独安装的 Chrome。

```bash
bunx @oeronteros-1/opencode-orchestra@latest install
```

重启 OpenCode，然后运行：

```text
/orchestra 找出登录偶发失败的原因，修复问题并运行相关测试
```

常用状态命令：

```text
/orchestra-status
/plugin-status
/orchestra-resume
```

安装程序是幂等的。修改 OpenCode 配置前会创建备份，并保留已有的插件和 MCP 配置。`--force` 会替换安装程序管理的配套 MCP 条目；现有浏览器 MCP 和 `orchestra.jsonc` 仍会保留。新配置通过 `browser.mode: "auto"` 启用托管浏览器；现有配置未包含浏览器部分时，浏览器保持关闭。

### OpenCode v2 支持与迁移

在 OpenCode v2 中，插件通过 `setup` API 加载。由于 v2 插件无法通过 `agent.transform` 创建智能体，安装程序会先在配置中加入 Orchestra 智能体名称。从 OpenCode 1.x 升级后，请重新运行 `install`。OpenCode 1.18.29 及更新版本仍保留旧兼容入口。OpenCode v2 会在加载时规范化受支持的 v1 配置字段，因此无需强制重写配置。参见[官方迁移指南](https://opencode.ai/v2/docs/build/plugins/migrate-v1)。

## 控制面板

控制面板完全在本地运行，使用随机 token 保护，并默认只监听 `127.0.0.1`。它展示智能体实时活动、使用趋势、模型和智能体明细、估算或提供商上报的成本、MCP 健康状态、异常情况，以及可导出的报告。

```bash
bunx @oeronteros-1/opencode-orchestra@latest dashboard
```

![OpenCode Orchestra 控制面板概览](docs/assets/dashboard-overview.png)

![OpenCode Orchestra 智能体负载](docs/assets/dashboard-agents.png)

除非显式启用 `telemetry.storeTexts`，否则提示词和回复文本不会持久化。

## 工作原理

```text
请求
  → 任务分类与能力分析
  → 使用 TaskContract 密封依赖感知计划
  → 在共享限制下并行运行证据智能体
  → 一次保留来源信息的合并
  → 在高风险或争议未解决时调用可选 judge
  → 实施、集成和整体验证
  → 本地遥测与成本统计
```

在 `ebobo` 模式下，被分类为 research 的任务会使用受限研究智能体群。采用默认的八节点上限时，四个 worker 独立探索不同假设，两个第二轮 worker 接收全部第一轮结果，并把精力重新分配给最有希望的存活方向；随后 `orch-merge` 汇总共享假设账本，`orch-judge` 独立验证候选结果。数学证明、猜想、科学假设、失败路径、反例和可复用的中间结果都会带着节点来源在各轮之间传递。judge 给出的暂定或未解决结论不会被视为完成。

`orch-lead` 是公开的主智能体。它可以编辑当前工作区、运行验证，并协调其余团队。内部 workers 默认不会出现在常规智能体补全中，且拥有更严格的权限。

| 智能体 | 职责 | 写入文件 |
|---|---|---:|
| `orch-lead` | 规划、协调、实施和最终验证 | 是 |
| `orch-repo` | 仓库结构、Git 历史、依赖关系和影响范围 | 否 |
| `orch-docs` | 官方文档和上游源码 | 否 |
| `orch-tests` | 复现路径、测试覆盖和验证命令 | 否 |
| `orch-research` | 标准、实现和生态研究 | 否 |
| `orch-critic` | 独立审查和假设检查 | 否 |
| `orch-security` | 信任边界、授权、密钥和数据处理 | 否 |
| `orch-visual-reference` | UI 参考、交互模式和动效 | 否 |
| `orch-visual-generate` | 探索性视觉生成 | 仅生成资源 |
| `orch-visual-review` | 截图、层级、无障碍和视觉回归审查 | 否 |
| `orch-editor` | 在指定 worktree 中隔离实施 | 仅指定范围 |
| `orch-integrator` | 确定性、失败关闭式地集成已验证提交 | 仅 Git 集成 |
| `orch-merge` | 合并证据，同时保留来源和不确定性 | 否 |
| `orch-judge` | 对高风险或未解决争议进行裁决 | 否 |

### 执行保护

- `parallelWorkers` 是整个任务树的硬并发上限。
- `maxWorkers` 限制整个任务树中唯一 worker 节点的数量。
- `maxDelegationDepth` 限制嵌套委派深度。
- 每个调度节点都会收到密封的 TaskContract，其中包含目标、输入、完成标准、允许路径、独占资源和委派预算。
- 声明同一可变资源的独立节点会串行执行。
- 依赖失败会阻塞下游节点，避免部分执行继续漂移。

默认限制为 8 个 workers、8 个并发 workers，委派深度为 2。这些限制由运行时强制执行，而不仅仅依赖提示词。

### 重启后恢复

Orchestra 会把密封计划、节点状态、依赖结果和已验证的 Git 提交保存在本地 `.orchestra/orchestration/runs.json`。重启后，运行中或排队中的仓库节点会恢复为待处理状态；已经完成的节点不会重复执行。中断的浏览器节点会被阻塞，需要检查网站状态后显式重试，避免自动重复外部修改。

```text
/orchestra-resume
/orchestra-resume <原始-session-id>
```

不带参数时会恢复最近的未完成运行。状态文件位于本地，但包含 worker 结果；如果结果可能包含敏感信息，应像保护仓库一样保护该目录。

### 已验证完成

最终检查前，`orch-lead` 通过 `orchestration_set_verification` 注册精确命令和预期产物。命令仍由普通 `bash` 工具执行，因此继续受 OpenCode 权限控制。只有匹配的调用成功后，runtime 才会通过命令 gate；产物则直接在 workspace 中检查。

`orchestration_complete` 会区分工作中、已声明、验证失败和已验证四种状态。默认情况下，没有 gate、存在未完成节点或失败节点时，运行都不能标记为已验证。

### 单任务预算

除了模型选择模式，还可以设置成本、token 和运行时间的硬限制。`0` 表示不限制：

```jsonc
{
  "orchestration": {
    "taskBudget": {
      "maxCostUSD": 2,
      "maxTokens": 120000,
      "maxMinutes": 15,
      "unknownPricing": "warn"
    }
  }
}
```

执行前，Orchestra 会估算并预留整个 DAG 的预算；估算已超限的计划不会启动。每次 worker 调用之间，runtime 会检查 ledger 中的实际成本和 token；时间从运行开始计算，并在重启后继续。`unknownPricing: "block"` 会在价格未知时停止，`"warn"` 则明确把未知价格调用排除在 USD 总额之外。

### 执行图与自适应团队

`ebobo` 为最高质量仲裁保留完整的有界团队；最小初始团队适用于其他预算模式。

Dashboard 的 **Runs** 页面会显示持久化的依赖图、节点合同、输出、失败、完成 gate 和任务预算。可以取消运行中的分支，也可以重试失败、阻塞或已取消的分支；重试会使下游结果失效，旧尝试的延迟响应不能覆盖新结果。

节点处于等待或运行状态时，lead 可以通过 `orchestration_relay_context` 发送有界补充说明。补充说明在进程重启和分支重试后仍会保留；对于正在运行的 dispatch，系统会要求同一个 worker 会话返回完整修订结果，然后才把节点标记为成功。

Orchestra 默认从两个专家和一个综合节点开始，并保留其余 worker 名额。只有出现带证据的运行时信号时，`orchestration_adapt` 才会创建新版本计划，例如复现失败、证据矛盾、授权边界、文档缺口、性能或视觉回归、低置信度或无进展。可通过 `orchestration.adaptive.initialWorkers`、`maxExtensions` 和 `minEvidenceItems` 配置。

Bounded loop 依据成功节点、已验证提交和通过的 gate 判断进展；仅改写 `MORE` 的措辞不会重置无进展限制。

### 内置评测

`opencode-orchestra eval --json` 输出版本化的五个核心场景，并比较 solo、eco、balanced、quality 和 ebobo 的结构化路由覆盖。通过 `--results results.json` 可汇总实际成功率、耗时、USD 成本和 token。`--write baseline.json` 保存基线；之后使用 `--baseline baseline.json`，当成功率下降超过五个百分点，或平均时间/成本增加超过 20% 时，命令以状态码 2 退出。

### 可复用的已验证知识

只有 `orchestration_complete` 返回已验证后，`orchestra_knowledge_record` 才能保存决策、精确测试命令或约束，并记录证据、来源运行、计划版本、Git revision 和相关路径。`orchestra_route` 与 `orchestra_knowledge_query` 只复用有效记录。记录过期、相关路径存在未提交修改，或这些路径在来源 revision 后发生变化时，会被标记为 stale。默认本地文件为 `.orchestra/knowledge/verified.json`，数量由 `orchestration.knowledge.maxEntries` 限制。

## 安装

默认安装程序会配置 Orchestra 插件，并尝试准备以下配套工具：

- [Superpowers](https://github.com/obra/superpowers) 技能；
- [Context7](https://github.com/upstash/context7)，用于获取最新的库文档；
- [Codebase Memory](https://github.com/DeusData/codebase-memory-mcp)，用于仓库索引和影响分析；
- [MemoryGraph](https://github.com/memory-graph/memory-graph)，用于持久化决策和可复用知识；
- 官方 Git MCP，并限制在当前仓库中；
- [GitHub MCP](https://github.com/github/github-mcp-server)，用于远程仓库、Issue 和 Pull Request；
- ast-grep MCP，用于结构化代码搜索；
- 固定版本的 Playwright MCP 和 Chrome DevTools MCP 包，用于托管浏览器；
- 在支持的平台上安装本地语音浮窗和 Whisper 模型。

可选配套工具安装失败不会阻止核心插件配置。Codebase Memory 或 MemoryGraph 准备失败时，不会写入无法工作的命令。Git 和 ast-grep 即使预热失败也可能被配置，因为 `uvx` 会在启动时重试。浏览器 MCP 是包依赖，由 OpenCode v2 运行时按需注册；安装程序不会下载 Chrome 本身。

只需连接 GitHub MCP 一次：安装 [GitHub CLI](https://cli.github.com/)，然后**在 OpenCode 内**输入：

```text
/github-connect
```

如果尚未登录，命令会打开浏览器完成 GitHub CLI 登录，然后把令牌保存到 `~/.config/opencode-orchestra/github-token`，并让 OpenCode 从该文件读取。令牌以明文保存在该文件中；在 Unix 上文件仅允许所有者访问。之后请重启 OpenCode。也可以直接在启动 OpenCode 的环境中设置 `GITHUB_PERSONAL_ACCESS_TOKEN`。令牌需要具备相应仓库和操作的权限。

常用安装选项：

```text
--no-context7
--no-github
--no-codebase-memory
--no-memorygraph
--no-git
--no-ast-grep
--no-playwright
--browser-mode MODE
--no-superpowers
--no-voice
--no-deps
--dry-run
--force
--config-dir DIR
```

在不写入文件或下载依赖的情况下预览更改：

```bash
bunx @oeronteros-1/opencode-orchestra@latest install --dry-run
```

`--browser-mode` 接受 `off`、`auto`、`playwright` 或 `devtools`，仅影响新创建的 Orchestra 配置。`--no-playwright` 将新配置设为 `off`；与 `--browser-mode devtools` 组合时仅启用 DevTools。与 `auto` 或 `playwright` 组合会报错。`--no-deps` 跳过配套工具的准备，但浏览器 MCP 仍是 npm 包的依赖项。

## 托管浏览器

Orchestra 使用自己的 Chrome 配置文件，无需浏览器扩展。在 `auto` 模式下，UI 导航和表单优先使用 Playwright；深度诊断和性能分析使用 Chrome DevTools。两个后端连接到同一个托管浏览器。普通文档研究继续使用网页搜索、webfetch 和 Context7。

对于现有安装，请在全局或项目 `orchestra.jsonc` 中加入以下配置以启用浏览器：

```jsonc
{
  "browser": {
    "mode": "auto",
    "profile": "default",
    "profiles": ["default", "work-account"],
    "sharedProfiles": [],
    "headless": false
  }
}
```

修改配置后重启 OpenCode。在项目目录中运行：

```bash
bunx @oeronteros-1/opencode-orchestra@latest browser status --directory .
bunx @oeronteros-1/opencode-orchestra@latest browser login --directory . --profile default
bunx @oeronteros-1/opencode-orchestra@latest browser profiles --directory .
bunx @oeronteros-1/opencode-orchestra@latest browser select --directory . --profile work-account
```

在 `browser login` 打开的 Chrome 窗口中直接登录，然后关闭 Chrome 或按 Ctrl+C，再在 OpenCode 中使用该配置文件。Cookie 和 localStorage 会跨浏览器重启保留，但网站仍可能使登录失效。配置文件按仓库隔离，Git worktree 共享仓库身份。账户名称必须列在 `browser.profiles` 中；跨项目共享需要显式配置 `sharedProfiles`。`browser select` 写入项目覆盖配置，重启 OpenCode 后生效。

浏览器场景串行执行，并要求只有一个页面标签。密封任务合同限制 origins 和操作，OpenCode 权限仍然生效。现有用户浏览器 MCP 会阻止创建重复的托管服务器。浏览器 Code Mode 已禁用。缺少 Chrome 或配置文件被占用时，浏览器场景会失败，但仓库编排仍然可用。

可通过 `browser.executable` 指定 Chrome 的绝对路径；OpenCode 在 Bun 下运行时，可通过 `browser.nodeExecutable` 指定真正的 Node。配置文件存储、权限、后端切换、产物和故障排除请参阅 [docs/browser.md](docs/browser.md)。

## 模型路由

默认的 `auto` 策略会发现已连接 OpenCode 提供商公开的模型，并识别工具调用、推理、视觉、图像输出和上下文大小等能力。自动发现只填充空模型池，不会覆盖非空的手动模型池。

如果模型目录暂时不可用，Orchestra 不会为智能体设置模型，从而保留用户当前的 OpenCode 模型。

### 预算模式

| 模式 | 路由策略 |
|---|---|
| `eco` | 优先免费模型，并限制高级模型升级 |
| `balanced` | 优先订阅或免费模型，并允许有限的高级模型升级 |
| `quality` | 优先更强的 lead 模型，并允许付费候选 |
| `ebobo` | 对 research 任务启用受限研究智能体群，优先 frontier 裁决，并始终调用 judge |

预算模式会影响模型选择、付费调用限制和升级策略，但不会提高运行时 worker 上限。

### 按智能体指定模型和 fallback

```jsonc
{
  "$schema": "https://unpkg.com/@oeronteros-1/opencode-orchestra@latest/schema/opencode-orchestra.schema.json",
  "budget": "balanced",
  "models": {
    "strategy": "auto",
    "agents": {
      "orch-lead": "provider/primary-model",
      "orch-repo": "provider/code-model",
      "orch-judge": "provider/frontier-model"
    },
    "fallback": {
      "enabled": true,
      "maxRetries": 2,
      "agents": {
        "orch-repo": ["provider/backup-one", "provider/backup-two"]
      }
    }
  }
}
```

`models.agents` 中的精确覆盖拥有最高优先级。遇到限流、超时或提供商 5xx 等可重试错误时，可以切换到下一个兼容模型。认证、权限和无效请求错误会立即停止 fallback 链。

运行时会直接对所有 Orchestra 子智能体执行 fallback 和生命周期记账。调度 editor 时，运行时会从已封存的基础版本创建独立 Git worktree；只有在每个 editor commit 都通过验证后，integrator 才会在主 checkout 中运行。只有主 `orch-lead` 保留在 OpenCode 原生路径上。

## 并行编辑

并行 editor 属于实验性功能，默认关闭：

```jsonc
{
  "orchestration": {
    "parallelEditors": 3,
    "worktreeRoot": ".orchestra/worktrees"
  }
}
```

每个 editor 会获得互不重叠的路径所有权和独立的 Git worktree。集成之前，Orchestra 会验证实际提交 diff、提交祖先关系和所有权边界。Integrator 会构建确定性的冲突图，并选择集成全部已验证提交，或者一个也不集成。

发生所有权违规、祖先验证失败或 Git 冲突时，集成会失败关闭，并保留 worktrees 供诊断。即使集成成功，lead 仍必须运行整体验证。

## Bounded Loop

Bounded Loop 允许 `orch-lead` 在多个受控迭代中持续处理同一个目标。该功能需要显式启用：

```jsonc
{
  "orchestration": {
    "loop": {
      "enabled": true,
      "maxIterations": 10,
      "maxMinutes": 30,
      "noProgressLimit": 3
    }
  }
}
```

```text
/loop 修复失败的测试
/loop --file docs/plan.md
/loop status
/loop stop
```

只有未被引用的最后一行 `MORE: <剩余工作>` 才能授权下一次迭代。启用强制验证时，只有 `orchestration_complete` 成功后，`DONE: <摘要>` 才会完成循环；否则循环进入 `unverified` 状态。权限请求和未知回复会暂停循环；错误或新的用户消息会停止循环。

bounded loop 本身的状态保存在内存中，OpenCode 重启后会丢失。非空 `verifyCommand` 仍会失败关闭；安全验证通过已注册的 gate 和 OpenCode 常规权限工具执行。

## 语音输入

Windows 和 Linux 上的 OpenCode 2 支持统一快捷键：启动 `bunx @oeronteros-1/opencode-orchestra@latest voice-overlay`，将光标放在 TUI、Desktop 或浏览器的输入框，然后按 **Ctrl+Alt+Space** 开始录音，再按一次停止并粘贴本地识别结果。不会自动发送，也不需要固定服务器端口。录音期间请保持原窗口、标签页和输入框；窗口或焦点改变时，文本会保留，可使用相同快捷键重试。录音时可最小化窗口，快捷键仍然有效。自动插入开关默认开启；关闭后结果保留在预览和剪贴板，可用同一快捷键手动插入。Linux X11 需要 xclip、EWMH 和 XTEST，终端使用 Ctrl+Shift+V。源码已加入 Wayland 支持：GNOME 扩展、Plasma portal 与 kdotool、Sway/Hyprland 的 wl-clipboard、wtype 和 IPC。需要更新的 Linux 构建及[桌面配置](voice-overlay/linux/README.md)；目前尚未发布。焦点检查失败时，识别文本保留在浮窗中。

标准安装程序会为 Linux x64 和 Windows x64 安装预构建的本地语音浮窗，并下载 Whisper `ggml-base.bin` 模型。音频不会发送到远程转写服务。

对于旧版 **OpenCode 1.x** TUI，使用外部语音编辑器启动：

```bash
bunx @oeronteros-1/opencode-orchestra@latest voice-tui
```

按 **Ctrl+X，然后 E** 或运行 `/editor` 开始录音，再按相同快捷键或 Enter 停止。文本会返回该会话的草稿，不会自动发送；Ctrl+C 取消录音并保留原草稿。启动器为该 OpenCode 进程设置 `EDITOR` 和 `VISUAL`，无需单独窗口或固定端口。外部编辑器可通过 `ORCHESTRA_VOICE_DEVICE` 选择麦克风，或在手动安装 small 模型后设置 `ORCHESTRA_VOICE_MODEL=small`。

对于 OpenCode Web，请在不同终端中运行：

```bash
opencode web --port 4096
bunx @oeronteros-1/opencode-orchestra@latest web
```

然后打开 `http://127.0.0.1:4097`。麦克风按钮会显示在提交按钮旁边，默认将识别文本插入草稿。设置中也可显式选择插入并发送。如果录音或转写期间切换会话，结果会保留在可编辑的恢复面板中；恢复结果不会自动发送。

平台要求和故障排除请参阅 [voice-overlay/README.md](voice-overlay/README.md)。

所有语音输入模式（全局快捷键、悬浮窗口、TUI 外部编辑器及网页麦克风）均支持俄语、英语和中文，以及 `base`、`small` 和 `large-v3-turbo-q5_0` 模型。使用 `opencode-orchestra voice-model large-v3-turbo-q5_0` 安装 Turbo 模型（约 547 MiB，校验 SHA-256），也可将模型名替换为 `small`。在悬浮窗口或网页麦克风设置中选择模型和语音语言；`auto` 会为每段录音自动检测语言。短录音或混合语言录音可能需要明确指定语言。

TUI 外部编辑器使用 `ORCHESTRA_VOICE_MODEL=base|small|large-v3-turbo-q5_0` 和 `ORCHESTRA_VOICE_LANGUAGE=ru|en|zh|auto`，每个变量选择一个值，默认值为 `base` 和 `ru`。悬浮窗口和网页麦克风分别保存自己的设置。

## 配置

全局配置：

```text
~/.config/opencode/orchestra.jsonc
```

项目配置：

```text
<project>/.opencode/orchestra.jsonc
```

项目配置覆盖全局配置，显式插件选项覆盖前两者。同时支持 `OPENCODE_CONFIG_DIR` 和 `--config-dir`。

推荐的初始配置：

```jsonc
{
  "$schema": "https://unpkg.com/@oeronteros-1/opencode-orchestra@latest/schema/opencode-orchestra.schema.json",
  "budget": "balanced",
  "models": {
    "strategy": "auto",
    "agents": {},
    "fallback": { "enabled": true, "maxRetries": 2, "agents": {} }
  },
  "browser": { "mode": "auto", "profile": "default", "profiles": ["default"] },
  "orchestration": {
    "parallelWorkers": 8,
    "maxWorkers": 8,
    "maxDelegationDepth": 2,
    "parallelEditors": 0,
    "exposeWorkers": false
  },
  "permissions": { "autoAcceptAll": false },
  "telemetry": {
    "enabled": true,
    "directory": ".orchestra",
    "storeTexts": false
  },
  "pricing": {
    "estimate": true,
    "warnThresholdUSD": 0.5,
    "openrouter": { "enabled": false, "ttlHours": 12 }
  }
}
```

完整配置契约和数值范围请参阅 [schema/opencode-orchestra.schema.json](schema/opencode-orchestra.schema.json)。更完整的示例位于 [examples/.opencode/orchestra.jsonc](examples/.opencode/orchestra.jsonc)。

`permissions.autoAcceptAll` 会在启用时自动允许所有 OpenCode 权限请求。该功能默认关闭，只应在可信工作区中使用。

## CLI 参考

| 命令 | 用途 |
|---|---|
| `install` | 配置 OpenCode 并准备配套 MCP |
| `dashboard` | 启动本地遥测控制面板 |
| `browser status`、`browser profiles` | 检查托管浏览器要求和已配置的账户名称 |
| `browser login`、`browser restart` | 在可见的托管 Chrome 中打开所选配置文件 |
| `browser select` | 在项目配置中选择已配置的账户 |
| `browser reset --profile NAME --confirm NAME` | 删除未锁定配置文件的登录和网站数据 |
| `voice-overlay` | 启动离线语音浮窗和全局快捷键 |
| `voice-tui [args]` | 使用语音编辑器启动旧版 OpenCode 1.x |
| `voice-editor <file>` | 将识别文本写入 OpenCode `/editor` 提供的草稿文件 |
| `voice-web`、`web` | 为 OpenCode Web 添加内联离线麦克风代理 |
| `doctor` | 诊断配置、MCP 和本地工具路径 |
| `mcp-smoke` | 启动已启用的本地 MCP，并测试 `initialize`、`tools/list` 和安全调用 |
| `eval` | 比较可复现的 solo 与 Orchestra 结果并检查基线 |
| `update` | 检查 npm 上是否有新版本 |
| `completion` | 输出 `zsh`、`bash` 或 `pwsh` 补全脚本 |

```bash
bunx @oeronteros-1/opencode-orchestra@latest doctor --json
bunx @oeronteros-1/opencode-orchestra@latest mcp-smoke --directory . --json
bunx @oeronteros-1/opencode-orchestra@latest eval --results results.json --json
bunx @oeronteros-1/opencode-orchestra@latest update
bunx @oeronteros-1/opencode-orchestra@latest completion pwsh
```

`doctor` 离线运行且不会修改任何内容。`mcp-smoke` 会启动已配置的本地 MCP 进程并执行真实协议握手；远程和已禁用条目会标记为 skipped。

## 定价与遥测

Orchestra 按以下顺序解析价格：

1. 模型候选中显式配置的价格；
2. 提供商上报的价格；
3. 内置价格快照或已配置的私有 endpoint；
4. 可选的公开 OpenRouter 目录 fallback。

未知价格会保持未知，绝不会被静默视为免费。订阅模型与免费和付费模型会分开统计。

本地 ledger 会记录 token、成本、模型和智能体标识符、MCP 成功率和延迟聚合、路由决策，以及已清理的可靠性事件。它不会保存 MCP 原始参数或输出。提示词和回复文本存储必须显式启用。

## 安全与隐私

- Dashboard 和语音服务默认只绑定 loopback。
- Dashboard URL 包含随机访问 token。
- 遥测数据默认保存在本地 `.orchestra` 目录。
- 除非设置 `telemetry.storeTexts: true`，否则不持久化消息文本。
- 可靠性事件不会保留提供商原始错误文本。
- 只读 workers 不能编辑文件，也不能使用不受保护的原生委派。
- 官方 Git MCP 被限制在当前仓库中。
- 危险的 Git reset 操作被禁止；修改操作需要相应智能体权限。
- 配置无效时，Orchestra 会回退到安全默认值，并且不会覆盖无效文件。

## 环境要求与开发

- 推荐安装流程需要 Bun 1.2+
- 开发和 Node 工具需要 Node.js 22.12+
- 托管浏览器需要 OpenCode 2.0.16+ 和单独安装的 Chrome
- 只有安装 PyPI MemoryGraph 配套工具时才需要 Python 3.10+
- 基于 worktree 的并行编辑和 Git MCP 需要 Git

```bash
npm ci
npm run check
npm run build
npm pack --dry-run
```

常规测试套件是自包含的；实时浏览器检查在未显式启用时会跳过。可选集成检查：

```bash
npm run test:mcp-live
npm run test:browser-live
npm run test:browser-e2e
```

`test:mcp-live` 启动外部 MCP，需要已安装的配套工具。`test:browser-live` 使用临时测试配置文件和本地测试站点；缺少 Chrome 时报告 skipped。`test:browser-e2e` 运行仓库的 Playwright 回归测试。可为任一浏览器检查设置 `ORCHESTRA_TEST_CHROME`，指向 Chrome 的绝对路径；E2E 也可以通过 `npx playwright install chromium` 显式安装 Playwright Chromium。

语音浮窗需要单独安装依赖并检查：

```bash
npm --prefix voice-overlay ci
npm --prefix voice-overlay run typecheck
npm --prefix voice-overlay test
npm --prefix voice-overlay run build:frontend
```

Dashboard 开发使用 `npm run dev:dashboard`。原生语音开发命令 `npm run dev:voice` 和 `npm run build:voice` 还需要 Rust、平台 Tauri 依赖和 [voice-overlay/README.md](voice-overlay/README.md) 中描述的语音 sidecar。

## 故障排除

首先运行：

```bash
bunx @oeronteros-1/opencode-orchestra@latest doctor
```

如果本地 MCP 已配置但无法启动，请运行：

```bash
bunx @oeronteros-1/opencode-orchestra@latest mcp-smoke --directory .
```

使用 `--json` 获取机器可读的诊断结果。在 Windows 上，Orchestra 会识别 `.exe`、`.cmd` 和 `.bat` shim，并只在必要时使用安全的 `cmd.exe` fallback。

## 许可证

[MIT](LICENSE)
