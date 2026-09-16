# OpenCode Orchestra

[![npm version](https://img.shields.io/npm/v/@oeronteros-1/opencode-orchestra)](https://www.npmjs.com/package/@oeronteros-1/opencode-orchestra)
[![license](https://img.shields.io/npm/l/@oeronteros-1/opencode-orchestra)](LICENSE)
[![OpenCode](https://img.shields.io/badge/OpenCode-plugin-4f46e5)](https://opencode.ai/docs/plugins/)

[English](README.md) · **Русский** · [简体中文](README.zh-CN.md)

OpenCode Orchestra превращает сложный запрос в контролируемый multi-agent workflow. Плагин классифицирует задачу, выбирает подключённые модели, запускает узких специалистов, объединяет их доказательства, применяет изменения, проверяет результат и ведёт локальный учёт стоимости и использования.

- Один основной агент и команда специалистов с ограниченными правами
- Автоматическое обнаружение моделей, бюджетные режимы, overrides и fallback-цепочки
- Dependency-aware выполнение с жёсткими лимитами параллелизма, глубины и владения
- Опциональные изолированные Git worktrees для параллельных редакторов
- Локальная панель с live-активностью, токенами, стоимостью, моделями, агентами и состоянием MCP
- Диагностика, MCP smoke-тесты, ограниченные автономные циклы и офлайн-голосовой ввод

## Быстрый старт

Требования: [OpenCode](https://opencode.ai/), Bun 1.2 или новее и поддерживаемый провайдер моделей OpenCode.

```bash
bunx @oeronteros-1/opencode-orchestra@latest install
```

Перезапустите OpenCode и выполните:

```text
/orchestra Найди причину периодического сбоя авторизации, исправь её и запусти нужные тесты
```

Команды состояния:

```text
/orchestra-status
/plugin-status
```

Установщик идемпотентен. Перед изменением конфигурации OpenCode он создаёт резервную копию и сохраняет существующие плагины и MCP-записи, если явно не передан `--force`.

## Dashboard

Панель работает локально, защищена случайным токеном и по умолчанию слушает только `127.0.0.1`. Она показывает live-активность агентов, динамику использования, статистику моделей и агентов, расчётную или сообщённую провайдером стоимость, состояние MCP, аномалии и экспортируемые отчёты.

```bash
bunx @oeronteros-1/opencode-orchestra@latest dashboard
```

![Обзор панели OpenCode Orchestra](docs/assets/dashboard-overview.png)

![Нагрузка агентов в панели OpenCode Orchestra](docs/assets/dashboard-agents.png)

Тексты промптов и ответов не сохраняются, пока явно не включён `telemetry.storeTexts`.

## Как это работает

```text
запрос
  → классификация задачи и анализ возможностей
  → запечатанный dependency-aware план с TaskContract
  → параллельные evidence-workers в рамках общих лимитов
  → однократное объединение с сохранением источников
  → опциональный judge для критического риска или неразрешённого спора
  → реализация, интеграция и общая проверка
  → локальная телеметрия и учёт стоимости
```

В режиме `ebobo` задачи профиля research используют ограниченный исследовательский рой. При стандартном лимите в восемь узлов четыре worker-а независимо исследуют разные гипотезы, два worker-а второго раунда получают все результаты первого раунда и направляют усилия на наиболее перспективные уцелевшие подходы, `orch-merge` объединяет общий журнал гипотез, а `orch-judge` независимо проверяет итог. Математические доказательства, гипотезы, научные задачи, неудачные подходы, контрпримеры и повторно используемые промежуточные результаты передаются между раундами с указанием происхождения. Предварительный или неопределённый вердикт judge не считается завершением.

`orch-lead` — публичный основной агент. Он может редактировать текущий workspace, запускать проверки и координировать команду. Внутренние workers по умолчанию скрыты из обычного выбора агентов и имеют более узкие разрешения.

| Агент | Роль | Запись файлов |
|---|---|---:|
| `orch-lead` | Планирование, координация, реализация и итоговая проверка | Да |
| `orch-repo` | Структура репозитория, история Git, зависимости и blast radius | Нет |
| `orch-docs` | Официальная документация и upstream-исходники | Нет |
| `orch-tests` | Воспроизведение, покрытие и команды проверки | Нет |
| `orch-research` | Стандарты, реализации и исследование экосистемы | Нет |
| `orch-critic` | Независимая критика и проверка предположений | Нет |
| `orch-security` | Границы доверия, авторизация, секреты и данные | Нет |
| `orch-visual-reference` | UI-референсы, взаимодействия и motion | Нет |
| `orch-visual-generate` | Исследовательская генерация визуалов | Только созданные assets |
| `orch-visual-review` | Проверка скриншотов, иерархии, доступности и регрессий | Нет |
| `orch-editor` | Изолированная реализация в назначенном worktree | Только назначенная область |
| `orch-integrator` | Детерминированная fail-closed интеграция проверенных коммитов | Только Git-интеграция |
| `orch-merge` | Синтез доказательств с источниками и неопределённостью | Нет |
| `orch-judge` | Арбитраж критического риска или неразрешённого спора | Нет |

### Ограничители выполнения

- `parallelWorkers` задаёт общий жёсткий лимит одновременных workers во всём дереве.
- `maxWorkers` ограничивает число уникальных worker-узлов во всём дереве задачи.
- `maxDelegationDepth` ограничивает глубину вложенной делегации.
- Каждый узел получает запечатанный TaskContract: цель, входы, критерии готовности, разрешённые пути, эксклюзивные ресурсы и бюджет делегирования.
- Независимые узлы, претендующие на один изменяемый ресурс, выполняются последовательно.
- Сбой зависимости блокирует downstream-узлы и не позволяет частичному выполнению незаметно продолжиться.

По умолчанию разрешено восемь workers, восемь параллельных workers и глубина делегации два. Эти лимиты проверяются runtime, а не только промптами.

## Установка

Стандартный установщик настраивает Orchestra и пытается подготовить связанные инструменты:

- навыки [Superpowers](https://github.com/obra/superpowers);
- [Context7](https://github.com/upstash/context7) для актуальной документации библиотек;
- [Codebase Memory](https://github.com/DeusData/codebase-memory-mcp) для индексации репозитория и impact analysis;
- [MemoryGraph](https://github.com/memory-graph/memory-graph) для долговременных решений и повторно используемых знаний;
- официальный Git MCP, ограниченный активным репозиторием;
- ast-grep MCP для структурного поиска;
- Playwright MCP для браузерных проверок;
- локальный voice overlay и модель Whisper на поддерживаемых платформах.

Ошибка установки опциональной зависимости не мешает настроить основной плагин. При неудаче provisioning нерабочая команда локального MCP не записывается.

Основные параметры установки:

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

Просмотр изменений без записи файлов и загрузки зависимостей:

```bash
bunx @oeronteros-1/opencode-orchestra@latest install --dry-run
```

## Маршрутизация моделей

Стратегия `auto` получает модели подключённых провайдеров OpenCode и определяет их полезные возможности: tools, reasoning, vision, image output и размер контекста. Автоподбор заполняет только пустые пулы и не заменяет непустой ручной пул.

Если каталог моделей временно недоступен, Orchestra не задаёт модель агенту, сохраняя текущий выбор пользователя в OpenCode.

### Бюджетные режимы

| Режим | Политика |
|---|---|
| `eco` | Предпочитать бесплатные модели и ограничивать premium escalation |
| `balanced` | Предпочитать subscription/free с ограниченной premium escalation |
| `quality` | Предпочитать сильные lead-модели и разрешать платных кандидатов |
| `ebobo` | Для исследовательских задач включать ограниченный рой, предпочитать frontier arbitration и всегда обращаться к judge |

Бюджет влияет на модели, лимит платных вызовов и эскалацию, но не увеличивает runtime-лимиты агентов.

### Модели отдельных агентов и fallback

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

Точное переопределение в `models.agents` имеет наивысший приоритет. При rate limit, timeout и provider 5xx Orchestra может перейти к следующей совместимой модели. Ошибки аутентификации, разрешений и невалидного запроса останавливают цепочку.

Runtime-fallback выполняется напрямую для evidence-, review-, merge- и judge-subagents. Primary lead и workspace-aware editor/integrator остаются на нативном dispatch OpenCode.

## Параллельное редактирование

Параллельные редакторы экспериментальны и по умолчанию выключены:

```jsonc
{
  "orchestration": {
    "parallelEditors": 3,
    "worktreeRoot": ".orchestra/worktrees"
  }
}
```

Каждый editor получает непересекающееся владение путями и отдельный Git worktree. Перед интеграцией Orchestra проверяет фактический diff коммита, ancestry и границы ownership. Integrator строит детерминированную карту конфликтов и интегрирует либо все проверенные коммиты, либо ни одного.

При нарушении ownership, ошибке ancestry или Git-конфликте интеграция останавливается, а worktrees сохраняются для диагностики. После успешной интеграции lead всё равно обязан выполнить общую проверку.

## Bounded Loop

Bounded Loop позволяет `orch-lead` продолжать одну цель в нескольких контролируемых итерациях. Функция включается явно:

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
/loop Исправь падающие тесты
/loop --file docs/plan.md
/loop status
/loop stop
```

Следующую итерацию разрешает только незаключённая в цитату последняя строка `MORE: <оставшаяся работа>`. `DONE: <итог>` фиксирует заявление агента о завершении, а не результат независимой проверки. Запрос разрешения и неизвестный ответ приостанавливают цикл; ошибка и новое сообщение пользователя останавливают его.

Состояние цикла хранится в памяти и теряется после перезапуска OpenCode. Непустой `verifyCommand` сейчас работает fail-closed, потому что permission-safe shell verification в runtime не поддерживается; попросите lead выполнить проверку обычными инструментами.

## Голосовой ввод

Стандартный установщик ставит локальный voice overlay для Linux x64 и Windows x64 и загружает Whisper-модель `ggml-base.bin`. Аудио не отправляется во внешний сервис распознавания.

Для TUI:

```bash
voice-overlay
```

Для OpenCode Web запустите в разных терминалах:

```bash
opencode web --port 4096
opencode-orch web
```

Откройте `http://127.0.0.1:4097`. Кнопка микрофона появится рядом с отправкой промпта и вставит распознанный текст в черновик без отправки.

Требования платформ и диагностика описаны в [voice-overlay/README.md](voice-overlay/README.md).

## Конфигурация

Глобальный файл:

```text
~/.config/opencode/orchestra.jsonc
```

Файл проекта:

```text
<project>/.opencode/orchestra.jsonc
```

Проектные значения перекрывают глобальные, а явные plugin options перекрывают оба уровня. Поддерживаются `OPENCODE_CONFIG_DIR` и `--config-dir`.

Практический начальный конфиг:

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

Полный контракт и границы значений находятся в [schema/opencode-orchestra.schema.json](schema/opencode-orchestra.schema.json). Расширенный пример: [examples/.opencode/orchestra.jsonc](examples/.opencode/orchestra.jsonc).

`permissions.autoAcceptAll` автоматически подтверждает все запросы разрешений OpenCode. По умолчанию параметр выключен; включайте его только в доверенном workspace.

## CLI

| Команда | Назначение |
|---|---|
| `install` | Настроить OpenCode и подготовить связанные MCP |
| `dashboard` | Запустить локальную панель телеметрии |
| `voice-web`, `web` | Добавить офлайн-микрофон в OpenCode Web через локальный proxy |
| `doctor` | Проверить конфигурацию, MCP и пути локальных инструментов |
| `mcp-smoke` | Запустить локальные MCP и проверить `initialize`, `tools/list` и безопасные вызовы |
| `update` | Проверить наличие новой версии в npm |
| `completion` | Вывести completion для `zsh`, `bash` или `pwsh` |

```bash
bunx @oeronteros-1/opencode-orchestra@latest doctor --json
bunx @oeronteros-1/opencode-orchestra@latest mcp-smoke --directory . --json
bunx @oeronteros-1/opencode-orchestra@latest update
bunx @oeronteros-1/opencode-orchestra@latest completion pwsh
```

`doctor` работает офлайн и ничего не изменяет. `mcp-smoke` запускает настроенные локальные MCP и выполняет настоящий protocol handshake; удалённые и выключенные записи помечаются как skipped.

## Стоимость и телеметрия

Порядок определения цены:

1. явная цена в кандидате модели;
2. цена, сообщённая провайдером;
3. встроенный snapshot или настроенный приватный endpoint;
4. опциональный fallback к публичному каталогу OpenRouter.

Неизвестная цена остаётся неизвестной и никогда не считается бесплатной. Subscription-модели учитываются отдельно от free и paid.

Локальный ledger сохраняет токены, стоимость, идентификаторы моделей и агентов, агрегаты успешности и задержки MCP, решения маршрутизации и очищенные reliability events. Аргументы и сырой вывод MCP не сохраняются. Хранение текстов запросов и ответов включается отдельно.

## Безопасность и приватность

- Dashboard и voice-сервисы по умолчанию доступны только через loopback.
- URL dashboard содержит случайный токен доступа.
- Телеметрия по умолчанию хранится локально в `.orchestra`.
- Текст сообщений не сохраняется без `telemetry.storeTexts: true`.
- Reliability events не содержат сырой текст ошибок провайдера.
- Read-only workers не редактируют файлы и не используют незащищённую нативную делегацию.
- Официальный Git MCP ограничен активным репозиторием.
- Опасные Git reset запрещены, а мутации требуют разрешений соответствующего агента.
- При невалидном конфиге Orchestra переходит на безопасные defaults и не перезаписывает проблемный файл.

## Требования и разработка

- Bun 1.2+ для рекомендуемой установки
- Node.js 22+ для разработки и Node-based tooling
- Python 3.10+ только для PyPI-версии MemoryGraph
- Git для параллельного редактирования через worktrees и Git MCP

```bash
npm ci
npm run check
npm run test:mcp-live
npm run build
npm pack --dry-run
```

Обычный набор тестов самодостаточен. `test:mcp-live` запускает внешние MCP и предназначен для окружения, где соответствующие инструменты установлены.

## Диагностика

Начните с:

```bash
bunx @oeronteros-1/opencode-orchestra@latest doctor
```

Если локальный MCP настроен, но не запускается:

```bash
bunx @oeronteros-1/opencode-orchestra@latest mcp-smoke --directory .
```

`--json` включает машиночитаемый результат. На Windows Orchestra находит `.exe`, `.cmd` и `.bat` shims и использует безопасный fallback через `cmd.exe` только там, где это необходимо.

## Лицензия

[MIT](LICENSE)
