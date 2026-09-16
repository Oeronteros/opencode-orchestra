# OpenCode Orchestra

[![npm version](https://img.shields.io/npm/v/@oeronteros-1/opencode-orchestra)](https://www.npmjs.com/package/@oeronteros-1/opencode-orchestra)
[![license](https://img.shields.io/npm/l/@oeronteros-1/opencode-orchestra)](LICENSE)
[![OpenCode](https://img.shields.io/badge/OpenCode-plugin-4f46e5)](https://opencode.ai/docs/plugins/)

[English](README.md) · [Русский](README.ru.md) · **简体中文**

OpenCode Orchestra 将复杂请求转化为可控的多智能体工作流。它会对任务进行分类、选择已连接的模型、调度专门的智能体、合并证据、实施修改、验证结果，并在本地记录成本与使用情况。

- 一个主智能体，以及一组权限受限的专用智能体
- 自动发现模型、预算模式、按智能体覆盖模型，以及 fallback 链
- 依赖感知执行，并严格限制并发数、委派深度和文件所有权
- 可选的隔离 Git worktree，用于并行编辑
- 本地控制面板，展示实时活动、token、成本、模型、智能体和 MCP 状态
- 诊断、MCP 冒烟测试、有界自主循环，以及离线语音输入

## 快速开始

要求：[OpenCode](https://opencode.ai/)、Bun 1.2 或更高版本，以及 OpenCode 支持的模型提供商。

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
```

安装程序是幂等的。修改 OpenCode 配置前会创建备份，并保留已有的插件和 MCP 配置；只有显式传入 `--force` 时才会替换现有条目。

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

## 安装

默认安装程序会配置 Orchestra 插件，并尝试准备以下配套工具：

- [Superpowers](https://github.com/obra/superpowers) 技能；
- [Context7](https://github.com/upstash/context7)，用于获取最新的库文档；
- [Codebase Memory](https://github.com/DeusData/codebase-memory-mcp)，用于仓库索引和影响分析；
- [MemoryGraph](https://github.com/memory-graph/memory-graph)，用于持久化决策和可复用知识；
- 官方 Git MCP，并限制在当前仓库中；
- ast-grep MCP，用于结构化代码搜索；
- Playwright MCP，用于浏览器检查；
- 在支持的平台上安装本地语音浮窗和 Whisper 模型。

可选配套工具安装失败不会阻止核心插件配置。若本地 MCP provisioning 失败，安装程序不会写入一个无法工作的命令。

常用安装选项：

```text
--no-context7
--no-codebase-memory
--no-memorygraph
--no-git
--no-ast-grep
--no-playwright
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

## 模型路由

默认的 `auto` 策略会发现已连接 OpenCode 提供商公开的模型，并识别工具调用、推理、视觉、图像输出和上下文大小等能力。自动发现只填充空模型池，不会覆盖非空的手动模型池。

如果模型目录暂时不可用，Orchestra 不会为智能体设置模型，从而保留用户当前的 OpenCode 模型。

### 预算模式

| 模式 | 路由策略 |
|---|---|
| `eco` | 优先免费模型，并限制高级模型升级 |
| `balanced` | 优先订阅或免费模型，并允许有限的高级模型升级 |
| `quality` | 优先更强的 lead 模型，并允许付费候选 |
| `ebobo` | 优先 frontier 裁决，并始终调用 judge |

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

运行时会直接对 evidence、review、merge 和 judge 子智能体执行 fallback。主 `orch-lead` 以及工作区感知的 editor/integrator 仍使用 OpenCode 原生调度路径。

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

只有未被引用的最后一行 `MORE: <剩余工作>` 才能授权下一次迭代。`DONE: <摘要>` 只记录智能体声称已完成，并不代表独立验证通过。权限请求和未知回复会暂停循环；错误或新的用户消息会停止循环。

循环状态保存在内存中，OpenCode 重启后会丢失。当前，非空 `verifyCommand` 会失败关闭，因为运行时尚不支持权限安全的 shell 验证；请让 lead 使用常规工具运行验证。

## 语音输入

标准安装程序会为 Linux x64 和 Windows x64 安装预构建的本地语音浮窗，并下载 Whisper `ggml-base.bin` 模型。音频不会发送到远程转写服务。

在终端 UI 中启动：

```bash
voice-overlay
```

对于 OpenCode Web，请在不同终端中运行：

```bash
opencode web --port 4096
opencode-orch web
```

然后打开 `http://127.0.0.1:4097`。麦克风按钮会显示在提交按钮旁边，识别出的文本会插入草稿，但不会自动发送。

平台要求和故障排除请参阅 [voice-overlay/README.md](voice-overlay/README.md)。

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
| `voice-web`、`web` | 为 OpenCode Web 添加内联离线麦克风代理 |
| `doctor` | 诊断配置、MCP 和本地工具路径 |
| `mcp-smoke` | 启动已启用的本地 MCP，并测试 `initialize`、`tools/list` 和安全调用 |
| `update` | 检查 npm 上是否有新版本 |
| `completion` | 输出 `zsh`、`bash` 或 `pwsh` 补全脚本 |

```bash
bunx @oeronteros-1/opencode-orchestra@latest doctor --json
bunx @oeronteros-1/opencode-orchestra@latest mcp-smoke --directory . --json
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
- 开发和 Node 工具需要 Node.js 22+
- 只有安装 PyPI MemoryGraph 配套工具时才需要 Python 3.10+
- 基于 worktree 的并行编辑和 Git MCP 需要 Git

```bash
npm ci
npm run check
npm run test:mcp-live
npm run build
npm pack --dry-run
```

常规测试套件是自包含的。`test:mcp-live` 会启动外部 MCP 工具，适用于已经安装这些配套工具的环境。

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
