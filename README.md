# OpenCode Orchestra

`@oeronteros-1/opencode-orchestra` — плагин-оркестратор для OpenCode. Он добавляет ведущего агента, небольшую команду скрытых специалистов, арбитра для сложных случаев, автоматический выбор подключённых моделей и готовую интеграцию Context7 + Codebase Memory + MemoryGraph.

## Установка одной командой

Одинаково для Linux, macOS и Windows (PowerShell/Terminal с установленным Bun):

```bash
bunx @oeronteros-1/opencode-orchestra@latest install
```

CLI использует Bun напрямую, поэтому отдельный Node.js для этой команды не требуется.

Команда:

- добавит `@oeronteros-1/opencode-orchestra` в `~/.config/opencode/opencode.json`;
- подключит удалённый Context7 MCP (`https://mcp.context7.com/mcp`);
- установит статический `codebase-memory-mcp`, включит автоматическую индексацию и подключит его к OpenCode;
- установит MemoryGraph (`memorygraphMCP`) в изолированное окружение через `uv` и подключит локальную SQLite-память;
- сохранит все пользовательские MCP и плагины без удаления или переименования;
- создаст `~/.config/opencode/orchestra.jsonc` с автоматическим выбором моделей;
- сделает резервную копию существующего конфига перед изменением;
- не потребует API-ключей, Docker или административных прав для стандартной локальной конфигурации.

Установщик идемпотентен. Существующие настройки MCP он сохраняет; заменить их стандартными значениями можно только через `--force`.

На Linux и macOS используются официальные shell-инсталляторы Codebase Memory и uv. На Windows загружаются официальные PowerShell-инсталляторы, исполняемые с временным `ExecutionPolicy Bypass`; Codebase Memory устанавливается в `%LOCALAPPDATA%`, а пути к `uv` и MemoryGraph определяются автоматически. Сам установщик Orchestra не изменяет системные каталоги.

```bash
bunx @oeronteros-1/opencode-orchestra@latest install --help
```

Полезные флаги: `--no-context7`, `--no-codebase-memory`, `--no-memorygraph`, `--no-deps`, `--force`, `--dry-run`, `--config-dir DIR`.

## Модели без ручной настройки

По умолчанию используется `models.strategy: "auto"`. При запуске плагин получает через OpenCode список реально подключённых провайдеров и моделей, определяет доступные возможности (reasoning, tools, vision, image output, размер контекста) и заполняет только пустые пулы.

Если каталог моделей временно недоступен, поле `model` у агента не задаётся и OpenCode использует текущую пользовательскую модель. Плагин не меняет primary-модель сессии.

Минимальный глобальный конфиг создаётся автоматически:

```jsonc
{
  "$schema": "https://unpkg.com/@oeronteros-1/opencode-orchestra@latest/schema/opencode-orchestra.schema.json",
  "budget": "balanced",
  "models": {
    "strategy": "auto",
    "agents": {}
  }
}
```

### Точная модель для отдельного агента

Переопределение в `models.agents` имеет наивысший приоритет:

```jsonc
{
  "models": {
    "strategy": "auto",
    "agents": {
      "orch-lead": "anthropic/claude-sonnet-4-5",
      "orch-repo": "openai/gpt-5-mini",
      "orch-judge": "openai/gpt-5"
    }
  }
}
```

Доступные имена: `orch-lead`, `orch-repo`, `orch-docs`, `orch-tests`, `orch-research`, `orch-critic`, `orch-security`, `orch-visual-reference`, `orch-visual-generate`, `orch-visual-review`, `orch-judge`.

### Ручные пулы

Непустой ручной пул не заменяется автоподбором. Можно настроить только нужную категорию, сохранив auto для остальных:

```jsonc
{
  "budget": "balanced",
  "models": {
    "strategy": "auto",
    "worker": {
      "code": [
        {
          "id": "provider/model-id",
          "cost": "subscription",
          "tier": "worker",
          "priority": 90,
          "capabilities": ["code", "large-context"],
          "scores": { "code": 9 }
        }
      ]
    }
  }
}
```

Для полностью ручного режима задайте `models.strategy: "manual"`. Полный пример находится в [`examples/.opencode/orchestra.jsonc`](examples/.opencode/orchestra.jsonc).

## Приоритет выбора модели

Порядок разрешения:

1. точное значение `models.agents[agent-name]`;
2. непустой пользовательский пул;
3. автоматически собранный пул подключённых моделей;
4. текущая модель OpenCode, если подходящего кандидата нет.

Режимы бюджета:

- `eco` — сильный приоритет бесплатных workers; judge вызывается только при критическом несогласии;
- `balanced` — бесплатные workers, subscription-first lead, frontier judge при низкой уверенности или споре;
- `quality` — разрешает передовые платные модели для lead и workers, предпочитает сильные `lead/frontier` модели и вызывает frontier judge для критических, неуверенных или спорных решений;
- `ebobo` — максимальный режим: до 8 параллельных и 12 суммарных workers, весь доступный состав специалистов, frontier-first выбор моделей и обязательный `orch-judge`. Платные модели не штрафуются.

В `ebobo` «топовая» модель определяется без жёсткой привязки к бренду: приоритет получают подключённые модели класса `frontier`, затем `lead`, а внутри класса учитываются capabilities, контекст и пользовательский priority. Точное назначение через `models.agents` всё равно имеет высший приоритет.

Это взаимоисключающие runtime-режимы одного поля, а не варианты установки:

```jsonc
{
  "budget": "ebobo"
}
```

Цена из каталога — сигнал ранжирования, а не гарантия фактического тарифа. Для подписочных моделей можно явно указать `cost: "subscription"` в ручном пуле.

## Агенты и команды

Плагин добавляет один публичный `orch-lead`, скрытых workers и скрытый `orch-judge`. Workers не могут делегировать работу дальше; lead может вызывать только агентов Orchestra.

Команды OpenCode:

```text
/orchestra <задача>
/orchestra-status
```

Профили: `architecture`, `debug`, `ui`, `research`, `review`, `security`, `performance`, `migration`, `ops`.

## Context7, Codebase Memory и MemoryGraph

Context7 остаётся удалённым MCP для актуальной документации библиотек. OAuth отключён; при наличии ключа можно самостоятельно добавить заголовок `CONTEXT7_API_KEY`.

Codebase Memory отвечает за знания, которые можно восстановить из исходников: символы, вызовы, зависимости, маршруты и impact analysis. Установщик использует официальный Linux-инсталлятор с `--skip-config`, чтобы тот не создавал конкурирующие агенты и инструкции, после чего включает `auto_index`. Индекс хранится локально в `~/.cache/codebase-memory-mcp/`.

MemoryGraph отвечает за знания, которых нет непосредственно в коде: принятые архитектурные решения, проверенные исправления и повторно используемые паттерны. Используется core-профиль с локальным SQLite в `~/.local/share/memorygraph/`. Lead вызывает `recall_memories` не более одного раза в начале релевантной задачи и сохраняет только проверенные устойчивые знания.

Разделение намеренное:

- Codebase Memory — актуальная структура репозитория;
- MemoryGraph — история решений и связей между ними;
- Context7 — актуальные внешние API и документация.

Если зависимости уже установлены, повторный запуск использует существующие исполняемые файлы. `--no-deps` только записывает MCP-конфигурацию и ожидает, что команды `codebase-memory-mcp` и `memorygraph` уже доступны.

## Локальный и проектный конфиг

Глобальный конфиг: `~/.config/opencode/orchestra.jsonc` (или `$XDG_CONFIG_HOME/opencode/orchestra.jsonc`). Проектный `.opencode/orchestra.jsonc` накладывается поверх глобального. Переменная `OPENCODE_CONFIG_DIR` также поддерживается.

## Разработка

```bash
npm install
npm run check
npm run build
npm pack --dry-run
```

Перед публикацией пакет автоматически собирается через `prepack`.

## Документация

- [OpenCode plugins](https://opencode.ai/docs/plugins/)
- [OpenCode MCP servers](https://opencode.ai/docs/mcp-servers/)
- [OpenCode agents](https://opencode.ai/docs/agents/)
- [Context7](https://github.com/upstash/context7)
- [Codebase Memory MCP](https://github.com/DeusData/codebase-memory-mcp)
- [MemoryGraph](https://github.com/memory-graph/memory-graph)
- [uv](https://docs.astral.sh/uv/)

## Локальный dashboard

Dashboard входит в тот же npm-пакет и запускается из корня нужного проекта:

```bash
bunx @oeronteros-1/opencode-orchestra@latest dashboard
```

Команда поднимает защищённый случайным токеном сервер на `127.0.0.1`, открывает локальный сайт и показывает:

- число сессий и вызовов;
- input, output, reasoning и cache-токены;
- фактическую стоимость, которую возвращает провайдер;
- расходы и нагрузку по моделям и агентам;
- виртуализированный журнал activity без текстов промптов и ответов;
- статус Context7, Codebase Memory, MemoryGraph и сохранённого пользователем Supermemory;
- настройку режимов `eco`, `balanced`, `quality`, `ebobo` и моделей отдельных агентов.

Настройки сохраняются в `orchestra.jsonc` с резервной копией. Существующие MCP-записи dashboard не удаляет и не перезаписывает.

Полезные параметры: `--directory DIR`, `--config-dir DIR`, `--host HOST`, `--port PORT`, `--no-open`.

## License

MIT
