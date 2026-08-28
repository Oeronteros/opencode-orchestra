# OpenCode Orchestra

[![npm version](https://img.shields.io/npm/v/@oeronteros-1/opencode-orchestra)](https://www.npmjs.com/package/@oeronteros-1/opencode-orchestra) [![license](https://img.shields.io/npm/l/@oeronteros-1/opencode-orchestra)](LICENSE) [![OpenCode](https://img.shields.io/badge/OpenCode-plugin-4f46e5)](https://opencode.ai/docs/plugins/)

`@oeronteros-1/opencode-orchestra` — стабильный плагин-оркестратор для OpenCode. Он добавляет ведущего агента, команду скрытых специалистов, арбитра для сложных случаев, автоматический выбор подключённых моделей, контроль стоимости, локальную телеметрию и интеграцию Context7 + Codebase Memory + MemoryGraph.

## Возможности 1.0

- автоматическая классификация задач и dependency-aware план выполнения;
- режимы бюджета `eco`, `balanced`, `quality` и `ebobo`;
- автоматическое обнаружение моделей с ручными пулами и точными overrides;
- прогноз стоимости, локальный price snapshot и собственный pricing endpoint;
- локальный dashboard, аналитика расходов и CSV/JSON export;
- диагностика `doctor`, проверка обновлений и shell completion;
- идемпотентная установка без удаления пользовательской OpenCode/MCP-конфигурации.

Версия плагина — **1.0.27**. Полный контракт конфигурации описан в [schema/opencode-orchestra.schema.json](schema/opencode-orchestra.schema.json), рабочий пример — в [examples/.opencode/orchestra.jsonc](examples/.opencode/orchestra.jsonc).

## Что нового в 1.0.9–1.0.25

Полноценные разделы с примерами для пользователей.

### 1.0.29 — надёжность и прозрачная маршрутизация (next/unreleased)

- **Graceful degradation при невалидном `orchestra.jsonc`**: если глобальный или проектный конфиг не парсится либо не проходит валидацию схемы, плагин продолжает запуск на безопасных default-значениях, пишет один warning с путём к конфигу и sanitized-причиной и **не перезаписывает** файл. Обнаружение моделей, регистрация проектов, телеметрия и создание агентов/инструментов продолжаются как обычно.
- **Структурированная причина маршрутизации**: `orchestra_route` возвращает `routing.lead.model` вместе с машиночитаемым `routing.lead.reason` (`code`, `text`, `matchedCapabilities`, `score`, `budget`) и `routing.source` (`exact_override`, `manual_pool`, `auto_discovered`, `budget_exclusion`, `no_candidate`). `code` — стабильный идентификатор решения; `text` — диагностическая строка без секретов и промптов.
- **Политика ошибок и capability-aware fallback**: retryable-ошибки (rate-limit/429, timeout/408, provider 5xx/overloaded) переключают на следующий совместимый кандидат; terminal-ошибки (auth/401/403, invalid-request/400/404, неизвестная) останавливают цепочку. Альтернативы фильтруются по capability и бюджету и ранжируются детерминированно: compatibility → priority → tier → бюджетный класс стоимости → id. Плагин **не перехватывает** provider retry: цепочка `fallback.chains` передаётся только для dispatch-failover через `orch-lead`.
- **События надёжности (reliability events)**: ledger записывает sanitized-события `failed`/`retried` только из реально наблюдаемых попыток (модель, класс ошибки, следующая модель, номер попытки, исход). Сырой текст ошибки не сохраняется; список ограничен последними 100 событиями.
- **Routing-проверки `doctor`**: неразрушающие проверки для lead/judge/workers, точных overrides, дубликатов и неизвестных цен (предупреждение, никогда не `free`). Валидный частичный конфиг не считается ошибкой.
- **Карта конфликтов и сохранённые worktrees**: `orch-integrator` строит детерминированную cross-editor карту конфликтов (`editors`, `conflictingPaths`, `ownershipViolations`, `order`, `clean`), работает fail-closed при любом нарушении ownership/ancestry/git-конфликте и сохраняет worktrees для диагностики.

### 1.0.24–1.0.25 — параллельные редакторы и Windows-совместимость

- **Параллельные редакторы**: `orchestration.parallelEditors` включает безопасный fan-out/fan-in для правок: каждый `orch-editor` работает в отдельном experimental Git worktree, а `orch-integrator` проверяет фактический diff и интегрирует коммиты в детерминированном порядке. При конфликте worktrees сохраняются для диагностики; `0` (по умолчанию) отключает режим.
- **Windows-совместимость**: установщик и `doctor` теперь запускают `.cmd`/`.bat` shims и скрипты через `cmd.exe` (например, `uv.cmd` или `memorygraph.cmd` в `~/.local/bin`), а поиск инструментов учитывает переменную `HOME` и варианты `.exe`/`.cmd`. `doctor` дополнительно дедуплицирует кандидатов, когда `uv tool dir` и `~/.local/bin` указывают на одну папку, — диагностика не тратит время на повторные пробы.

### 1.0.21–1.0.23 — установщик и OpenRouter-цены

- **Установщик**: добавляет путь к навыкам Superpowers в `skills.paths` (работает даже там, где git-спека не установилась), приводит `agent.orch-lead` к `mode: "primary"` + `hidden: false` и больше не трогает явные версии/теги плагинов — на `@latest` обновляется только «голое» имя пакета.
- **OpenRouter-фолбэк цен**: для моделей без цены провайдера можно включить `pricing.openrouter.enabled` — публичный каталог OpenRouter (`/api/v1/models`, без API-ключа) кэшируется на `ttlHours` и не ломает офлайн-оценку при недоступности сети.

### 1.0.14–1.0.16 — live-панель и реестр проектов

- **Live-панель в dashboard**: показывает, какие агенты генерируют прямо сейчас, короткий сниппет их вывода, оценочную стоимость и токены. Поток мостится через файловый snapshot + SSE, поэтому работает между процессами плагина и dashboard.
- **Реестр проектов**: плагин регистрирует открытые проекты в `orchestra-projects.json`, dashboard переключается между ними.
- **`/orchestra` закреплён за `orch-lead`**: команда вызывает `orchestra_route`, после чего lead сам выполняет план — диспетчеризация workers, `orch-merge`, правки и проверка.

### 1.0.13 — первичный агент и стабильность

- **Первичный агент `orch-lead`**: ведущий агент не только координирует специалистов, но и сам редактирует файлы, запускает проверку и завершает пользовательскую задачу. Файловые операции разрешены, а shell-команды требуют подтверждения OpenCode. В `/plugin-status` и логах сессии `orch-lead` отображается как главный исполнитель, а не скрытый специалист. Пример вывода:
  ```text
  /plugin-status
  Primary agent: orch-lead (v1.0.25)
  Budget: balanced
  Strategy: auto
  ```
- **Обновление snapshot цен и dashboard**: встроенный price snapshot синхронизирован с текущими тарифами. Dashboard (`dashboard` команда) отображает актуальную стоимость и поддерживает защиту BOM-префиксных конфигов.

### 1.0.11–1.0.12 — BOM-префиксы и диагностика

- **Поддержка BOM в конфигурации**: `doctor` и `dashboard` корректно читают `opencode.json` и `orchestra.jsonc`, даже если файл сохранён с BOM (`﻿`). Ранее такие конфиги могли игнорироваться или приводить к ошибкам чтения.
- **Усиление входной точки (`hardening`)**: установщик и `entrypoint` теперь проверяют структуру `opencode.json` перед записью, создают резервную копию даже при частичных изменениях и не удаляют существующие MCP-записи без явного `--force`.

### 1.0.9–1.0.10 — диагностика и обновления

- `doctor` проверяет пути `uv`, версию MemoryGraph, наличие `auto_index` для Codebase Memory и доступность `Context7`.
- `update` сверяет установленную версию с npm (`@latest`) и предлагает команду обновления без ручного поиска.

Примеры команд из новых версий:`
```bash
bunx @oeronteros-1/opencode-orchestra@latest doctor --json
bunx @oeronteros-1/opencode-orchestra@latest update
bunx @oeronteros-1/opencode-orchestra@latest dashboard --directory . --no-open
```

## Установка одной командой

Одинаково для Linux, macOS и Windows (PowerShell/Terminal с установленным Bun):

```bash
bunx @oeronteros-1/opencode-orchestra@latest install
```

CLI использует Bun напрямую, поэтому отдельный Node.js для этой команды не требуется.

Команда:

- добавит `@oeronteros-1/opencode-orchestra@latest` в OpenCode config (`opencode.json` или `opencode.jsonc`);
- добавит плагин Superpowers (`superpowers@git+https://github.com/obra/superpowers.git`) в массив `plugin`;
- подключит удалённый Context7 MCP (`https://mcp.context7.com/mcp`);
- подключит Playwright MCP для браузерной автоматизации;
- установит статический `codebase-memory-mcp`, включит автоматическую индексацию и подключит его к OpenCode;
- установит MemoryGraph (`memorygraphMCP`) в изолированное окружение через `uv` и подключит локальную SQLite-память;
- сохранит все пользовательские MCP и плагины без удаления или переименования;
- создаст `~/.config/opencode/orchestra.jsonc` с автоматическим выбором моделей;
- сделает резервную копию существующего конфига перед изменением;
- не потребует API-ключей, Docker или административных прав для стандартной локальной конфигурации.

Установщик идемпотентен. Существующие настройки MCP он сохраняет; заменить их стандартными значениями можно только через `--force`.

На Linux и macOS используются официальные shell-инсталляторы Codebase Memory и uv. На Windows загружаются официальные PowerShell-инсталляторы, исполняемые с временным `ExecutionPolicy Bypass`; Codebase Memory устанавливается в `%LOCALAPPDATA%`, а пути к `uv` и MemoryGraph определяются автоматически. Сам установщик Orchestra не изменяет системные каталоги. Поиск инструментов на Windows учитывает `.cmd`/`.bat` shims (`uv.cmd`, `memorygraph.cmd` и т.п.) и запускает их через `cmd.exe`, а переменная `HOME` имеет приоритет при определении `~/.local/bin`.

Superpowers — фреймворк навыков для агентов (obra/superpowers) — добавляется в массив `plugin` официальной git-спекой и устанавливается через плагин-менеджер OpenCode. На некоторых Windows-сборках OpenCode git-спеки могут не установиться из-за проблем с путями кэша и `git.exe`; в этом случае выполните `npm install superpowers@git+https://github.com/obra/superpowers.git --prefix "$HOME\.config\opencode"` и добавьте запись `"~/.config/opencode/node_modules/superpowers"` в `plugin`.

```bash
bunx @oeronteros-1/opencode-orchestra@latest install --help
```

Полезные флаги: `--no-context7`, `--no-codebase-memory`, `--no-memorygraph`, `--no-playwright`, `--no-superpowers`, `--no-deps`, `--force`, `--dry-run`, `--config-dir DIR`.

## Диагностика, обновление и автодополнение

Помимо установки и dashboard, CLI предлагает служебные команды:

```bash
bunx @oeronteros-1/opencode-orchestra@latest doctor
```

Проверяет конфиг OpenCode и `orchestra.jsonc`, регистрацию плагина, доступность настроенных MCP-серверов, пути и версии `uv`, MemoryGraph и Codebase Memory. Флаг `--config-dir DIR` переопределяет каталог конфигурации, а `--json` выводит результат в машиночитаемом виде.

```bash
bunx @oeronteros-1/opencode-orchestra@latest update
```

Сверяет установленную версию плагина с последней опубликованной на npm и подсказывает команду обновления.

```bash
bunx @oeronteros-1/opencode-orchestra@latest completion zsh
bunx @oeronteros-1/opencode-orchestra@latest completion bash
bunx @oeronteros-1/opencode-orchestra@latest completion pwsh
```

Выводит скрипт автодополнения для zsh, bash или pwsh. Например, для zsh:

```bash
bunx @oeronteros-1/opencode-orchestra@latest completion zsh > ~/.zsh/completions/_opencode-orchestra
```

## Модели без ручной настройки

По умолчанию используется `models.strategy: "auto"`. При запуске плагин получает через OpenCode список реально подключённых провайдеров и моделей, определяет доступные возможности (reasoning, tools, vision, image output, размер контекста) и заполняет только пустые пулы.

Если каталог моделей временно недоступен, поле `model` у агента не задаётся и OpenCode использует текущую пользовательскую модель. Плагин не меняет primary-модель сессии.

Минимальный глобальный конфиг создаётся автоматически:

```jsonc
{
  "$schema": "https://unpkg.com/@oeronteros-1/opencode-orchestra@latest/schema/opencode-orchestra.schema.json",
  "budget": "balanced",
  "orchestration": {
    "parallelEditors": 0,
    "worktreeRoot": ".orchestra/worktrees"
  },
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

Доступные имена: `orch-lead`, `orch-repo`, `orch-docs`, `orch-tests`, `orch-research`, `orch-critic`, `orch-security`, `orch-visual-reference`, `orch-visual-generate`, `orch-visual-review`, `orch-editor`, `orch-integrator`, `orch-merge`, `orch-judge`.

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

### Прайс-лист и прогноз стоимости

Плагин поставляет встроенный snapshot цен (`{provider}/{model} → input/output USD за 1M токенов`) и использует его как отдельный сигнал ранжирования — при прочих равных дешевле модель выигрывает. Снапшот можно периодически обновлять с собственного эндпоинта:

```jsonc
{
  "pricing": {
    "endpoint": "https://internal.example.com/prices.json",
    "refreshIntervalHours": 24,
    "estimate": true,
    "warnThresholdUSD": 0.5,
    "openrouter": { "enabled": true, "ttlHours": 12 },
    "aliases": [
      { "canonical": "gpt-5.6-sol", "aliases": ["GPT-5.6 Sol", "CX/GPT-5.6 Sol"] }
    ]
  }
}
```

- `endpoint` — self-hosted JSON `{ "updatedAt": "...", "prices": { "provider/model": { "input": 0.27, "output": 1.1 } } }`; при недоступности остаётся встроенный snapshot;
- `refreshIntervalHours` — период опроса (0 отключает);
- `estimate` — включает прогноз стоимости до запуска в ответе `orchestra_route`;
- `warnThresholdUSD` — порог, выше которого роутер добавляет предупреждение «эта задача в `quality` обойдётся примерно в $X»;
- `openrouter.enabled` — опциональный fallback на публичный каталог OpenRouter (`/api/v1/models`, без API-ключа) для моделей, у которых нет цены провайдера; список кэшируется на `ttlHours` часов, офлайн-оценка не зависит от сети;
- `aliases` — ручные псевдонимы моделей: raw-имя посредника (`CX/GPT-5.6 Sol`) сводится к канонической модели. Пользовательский alias имеет высший приоритет над всеми внешними источниками цен.

Как определяется стоимость: raw model ID нормализуется (регистр, разделители, префикс провайдера, namespace-обёртки, `:free`-суффиксы), затем цена ищется в порядке: явная цена из конфига → псевдонимы → snapshot провайдера → OpenRouter. Совпадение по ключевым словам/нечёткое сравнение защищено от ложных срабатываний: похожие модели семейства (`GPT-5.6`, `GPT-5.6 Mini`, `GPT-5.6 Sol`) не схлопываются. Итог всегда один из четырёх статусов: `paid` (цена известна), `free` ($0, токены считаются), `subscription` ($0 + статус подписки) или `unknown` (токены считаются, стоимость — `null`, никогда не выдаётся за бесплатную). Токены и биллинг — две независимые величины.

Resolver формирует упорядоченный список fallback-кандидатов из доступных пользователю моделей, предпочитая схожую стоимость и совместимые capabilities. Цепочка передаётся lead в поле `fallback`; execution-слой может переключиться на следующий кандидат при ошибке провайдера. Если текущая версия OpenCode не предоставляет provider-interception, сам плагин не перехватывает вызов и не обещает автоматический retry. Прогноз стоимости — информативное поле: выполнение не блокируется, а предупреждение помогает подтвердить расходы заранее.

### Структурированная причина маршрутизации

`orchestra_route` возвращает `routing` с выбранной моделью lead и машиночитаемой причиной вместо необходимости разбирать прозу:

```jsonc
{
  "routing": {
    "lead": {
      "model": "anthropic/claude-sonnet-4-5",
      "reason": {
        "code": "capability_match",
        "text": "id=anthropic/claude-sonnet-4-5 cost=subscription capability=explicit score=100",
        "matchedCapabilities": ["reasoning"],
        "score": 100,
        "budget": "balanced"
      }
    },
    "source": "manual_pool",
    "budget": "balanced"
  }
}
```

- `code` — стабильный идентификатор решения: `frontier`, `preferred_tier`, `preferred_cost`, `capability_match`, `price`, `priority`, `exact_override`. Это машиночитаемый контракт; `text` — диагностическая строка, не являющаяся контрактом совместимости.
- `matchedCapabilities` — capability, по которым модель подошла (пусто для `exact_override`); `score` — итоговый скоринг победителя; `budget` — режим бюджета.
- `text` не содержит секретов, промптов, токенов и содержимого файлов.

`source` показывает происхождение выбора: `exact_override` (точное `models.agents["orch-lead"]`), `manual_pool` (ручной пул при `strategy: "manual"`), `auto_discovered` (автособранный пул подключённых моделей), `budget_exclusion` (пул заблокирован бюджетом/лимитом платных вызовов) и `no_candidate` (пул пуст — используется текущая модель OpenCode).

### Политика ошибок

Ошибки классифицируются по policy-классам, а не по сырому тексту:

| Класс | Политика |
| --- | --- |
| Rate limit / 429 | переключиться на следующий совместимый кандидат |
| Timeout / 408 | переключиться на следующий совместимый кандидат |
| Provider 5xx / overloaded | переключиться на следующий совместимый кандидат |
| Auth / 401 / 403 | остановиться — ошибка конфигурации |
| Invalid request / 400 / 404 / unsupported capability | остановиться — ошибка маршрутизации или запроса |
| Неизвестная ошибка | остановиться, если явно не классифицирована как retryable |

Каждая последовательность ограничена максимальным числом попыток, не повторяет одну и ту же модель и сохраняет исходную ошибку. Лимиты платных вызовов остаются авторитетными.

### Capability-aware fallback

Fallback-цепочка строится только из worker-пулов (`code`, `reasoning`, `research`, `vision`, `image`). Кандидаты фильтруются по budget-eligibility (платные исключаются при исчерпании лимита), а явно несовместимые с требуемой capability отсеиваются до выбора победителя. Неизвестные по capability модели остаются в цепочке, но ранжируются ниже. Альтернативы упорядочиваются детерминированно: compatibility → priority → tier → бюджетный класс стоимости → id. `fallback.chains` в ответе `orchestra_route` содержит `enabled`, `maxRetries` и усечённую до `maxRetries + 1` цепочку на каждую capability. Плагин не перехватывает вызовы провайдера: цепочка предназначена для безопасного dispatch-failover через `orch-lead`.

### События надёжности

Там, где Orchestra может наблюдать выполнение, ledger записывает событие надёжности только из реально наблюдаемых попыток: `attempt`, `model`, `errorKind` (policy-класс, не сырой текст), `outcome` (`failed`/`retried`/`succeeded`), `nextModel` и `at`. Переход `retried` фиксируется только при последующей наблюдаемой попытке после retryable-ошибки; события ограничены последними 100, строки обрезаются, а неопознанные записи отбрасываются. Креды, промпты и тела ответов провайдера никогда не сохраняются. Если вызовы провайдера перехватить нельзя, эквивалентные policy-метаданные возвращаются в `orch-lead`, но фейковое событие выполнения не записывается.

### Routing-проверки `doctor`

`doctor` добавляет неразрушающие routing-проверки с стабильными идентификаторами и severity:

- пустой пул роли — `info` («текущая модель OpenCode»);
- недоступный точный agent override или невалидный формат `provider/model` — `warning`;
- роль без совместимого кандидата или заблокированная бюджетом — `warning`;
- дубликаты кандидатов — `warning`;
- неизвестная цена победителя — `warning` (никогда не трактуется как `free`);
- валидный частичный конфиг (пустые пулы, отсутствующие секции) не считается ошибкой и не блокирует запуск.

Проверки не изменяют файлы конфигурации.

### Карта конфликтов и сохранённые worktrees

Перед интеграцией `orch-integrator` выводит фактические изменённые пути из git и строит cross-editor карту конфликтов: `editors` (id, commit, изменённые пути, ownership-нарушения), `conflictingPaths` (пути, затронутые более чем одним редактором), `ownershipViolations`, детерминированный `order` интеграции и флаг `clean`. Любое нарушение ownership, провал ancestry-проверки или git-конфликт останавливает автоматическую интеграцию — интегратор интегрирует всё или ничего и **сохраняет worktrees** для диагностики. Чистый текстовый merge не считается доказательством семантической корректности.

## Агенты и команды

Плагин добавляет один публичный primary-агент `orch-lead`, скрытых workers, скрытый reduce-агент `orch-merge` и скрытый `orch-judge`. Workers не могут редактировать файлы или делегировать работу дальше; lead может вызывать только агентов Orchestra, после чего сам реализует изменения и проверяет результат.

`orch-lead` строит dependency-aware DAG: независимые ветки одного уровня запускаются параллельно через OpenCode Task tool в пределах `parallelWorkers`, downstream-узлы ждут свои зависимости, а после всех веток `orch-merge` один раз объединяет результаты с сохранением источников, конфликтов и неопределённости. Затем `orch-lead` редактирует файлы и запускает релевантную проверку. Для безопасной параллельной реализации можно явно задать непересекающиеся ownership partitions и включить `orchestration.parallelEditors`: каждый `orch-editor` работает в отдельном experimental Git worktree, коммитит изменения, а `orch-integrator` проверяет фактический diff и интегрирует коммиты в детерминированном порядке. При конфликте worktrees сохраняются для диагностики; значение `0` (по умолчанию) полностью отключает editor mode. Это явный fan-out/fan-in pipeline, а не последовательный список рекомендаций.

### `orch-judge` — арбитр для критических решений

`orch-judge` — скрытый арбитр, вызываемый только в двух случаях: при критическом риске (`security`, `migration`, `performance`) или при неразрешённом разногласии между workers (`orch-merge` сообщает конфликт с высокой неопределённостью). В режиме `ebobo` вызов обязательный; в `eco` и `balanced` — только при необходимости. Пример конфигурации ручного пула для арбитра:
```jsonc
{
  "models": {
    "judge": [{ "id": "openai/gpt-5", "cost": "subscription", "tier": "frontier" }]
  }
}
```

Команды OpenCode:

```text
/orchestra <задача>
/orchestra-status
/plugin-status
```

`/orchestra <задача>` закреплена за `orch-lead`: команда сначала вызывает `orchestra_route`, затем lead сам выполняет возвращённый план без делегирования самому себе. Workers по умолчанию скрыты из `@`-автодополнения (`orchestration.exposeWorkers: false`), но доступны lead через Task tool и отображаются в локальном dashboard и `/orchestra-status`.

`/orchestra-status` показывает статистику текущей Orchestra-сессии, а `/plugin-status` — версию загруженного плагина, бюджет, стратегию моделей и состояние companion MCP.

Профили: `architecture`, `debug`, `ui`, `research`, `review`, `security`, `performance`, `migration`, `ops`.

## Context7, Codebase Memory и MemoryGraph

Context7 остаётся удалённым MCP для актуальной документации библиотек. OAuth отключён; при наличии ключа можно самостоятельно добавить заголовок `CONTEXT7_API_KEY`.

Codebase Memory отвечает за знания, которые можно восстановить из исходников: символы, вызовы, зависимости, маршруты и impact analysis. Установщик использует официальный Linux-инсталлятор с `--skip-config`, чтобы тот не создавал конкурирующие агенты и инструкции, после чего включает `auto_index`. Индекс хранится локально в `~/.cache/codebase-memory-mcp/`.

MemoryGraph отвечает за знания, которых нет непосредственно в коде: принятые архитектурные решения, проверенные исправления и повторно используемые паттерны. Используется core-профиль с локальным SQLite в `~/.memorygraph/`. Lead вызывает `recall_memories` не более одного раза в начале релевантной задачи и сохраняет только проверенные устойчивые знания.

Пакет ставится с PyPI (`memorygraphMCP`, Python ≥3.10, SQLite работает без настройки). GitHub-ветка `main` того же репозитория переписана на TypeScript/Bun и не совместима с PyPI-пакетом, поэтому установщик опирается именно на PyPI-дистрибутив. Если persistent-установка через `uv tool install` не удалась, используется фолбэк `uvx memorygraph`; при полном провале MCP-запись в конфиг не пишется — причина сбоя видна в выводе установщика и doctor.

Разделение намеренное:

- Codebase Memory — актуальная структура репозитория;
- MemoryGraph — история решений и связей между ними;
- Context7 — актуальные внешние API и документация.

Если зависимости уже установлены, повторный запуск использует существующие исполняемые файлы. `--no-deps` только записывает MCP-конфигурацию и ожидает, что команды `codebase-memory-mcp` и `memorygraph` уже доступны.

## Локальный и проектный конфиг

Глобальный конфиг: `~/.config/opencode/orchestra.jsonc` (или `$XDG_CONFIG_HOME/opencode/orchestra.jsonc`). Проектный `.opencode/orchestra.jsonc` накладывается поверх глобального. Переменная `OPENCODE_CONFIG_DIR` также поддерживается.

Оба файла могут содержать BOM-префикс (`\ufeff`); `doctor` и `dashboard` с 1.0.11+ читают такие конфиги корректно без ручного удаления префикса. Если `doctor` ранее игнорировал ваш конфиг, повторите проверку с обновлённой версией.

## Требования и разработка

Для установки рекомендуется Bun 1.2+. Для Node-based tooling и разработки требуется Node.js 22+.

```bash
npm ci
npm run check
npm run build
npm pack --dry-run
```

Перед публикацией `prepublishOnly` запускает полный check, а `prepack` пересобирает plugin и dashboard. Рабочая команда релиза: `npm publish --access public`. Перед ней проверьте содержимое tarball и создайте Git tag `v1.0.0`.

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
- виртуализированный журнал activity; тексты промптов и ответов отключены по умолчанию и сохраняются только при явном `telemetry.storeTexts: true`;
- live-панель: какие агенты генерируют прямо сейчас, сниппет их вывода, оценочная стоимость и токены;
- статус Context7, Codebase Memory, MemoryGraph;
- настройку режимов `eco`, `balanced`, `quality`, `ebobo` и моделей отдельных агентов;
- месячный прогноз, детектирование аномалий и экспорт activity/models/agents/daily/summary в CSV или JSON.

Настройки сохраняются в `orchestra.jsonc` с резервной копией. Существующие MCP-записи dashboard не удаляет и не перезаписывает.

Полезные параметры: `--directory DIR`, `--config-dir DIR`, `--host HOST`, `--port PORT`, `--no-open`.

## Обновление с 0.5.x

Повторно выполните установщик:

```bash
bunx @oeronteros-1/opencode-orchestra@latest install
```

Миграция `orchestra.jsonc` не требуется. Установщик сохранит существующие plugin options и MCP entries, обновит bare/pinned Orchestra entry до `@latest`, добавит Superpowers (если его ещё нет) и создаст backup перед изменением основного OpenCode config. После обновления перезапустите OpenCode и выполните `/plugin-status`.

## Безопасность и приватность

- dashboard по умолчанию слушает только `127.0.0.1` и защищён случайным токеном;
- telemetry хранится локально в `.orchestra`;
- тексты сообщений не сохраняются без `telemetry.storeTexts: true`;
- pricing endpoint настраивается пользователем и не требуется для offline-оценки; OpenRouter-фолбэк опционален (`pricing.openrouter.enabled`, по умолчанию выключен) и тоже не обязателен для offline-оценки;
- перед публикацией или баг-репортом не прикладывайте локальный ledger, если включали сохранение текстов;
- установщик (`install`) и `entrypoint` с 1.0.9 усилены: резервная копия создаётся даже при частичных изменениях, BOM-префиксы (`﻿`) в `opencode.json` и `orchestra.jsonc` корректно обрабатываются `doctor` и `dashboard`, а существующие MCP-записи не удаляются без явного `--force`.

## License

MIT
