/**
 * Single source of truth for dashboard copy.
 *
 * Lives under `lib/` so the Node test harness (tsconfig.test.json) can compile
 * and assert on it without pulling in React or i18next. `i18n.ts` adapts these
 * flat records into i18next resources.
 *
 * Plural keys follow the i18next v21+ suffix convention (`key_one`,
 * `key_few`, `key_many`, `key_other`) and must cover every category
 * `Intl.PluralRules` yields for integer counts in that language.
 */

export const LOCALE_CODES = ["ru", "en"] as const
export type LocaleCode = (typeof LOCALE_CODES)[number]

/**
 * Pluralised copy is kept apart from the singular records because the set of
 * required suffixes is language-specific: Russian integers need one/few/many,
 * English only one/other. Singular records stay in lockstep via the type on
 * `enStrings`; plural families are checked by test/i18n.test.ts.
 */
const ruPlurals = {
  rangeDays_one: "{{count}} день",
  rangeDays_few: "{{count}} дня",
  rangeDays_many: "{{count}} дней",
  liveAgents_one: "{{count}} агент",
  liveAgents_few: "{{count}} агента",
  liveAgents_many: "{{count}} агентов",
}

const enPlurals = {
  rangeDays_one: "{{count}} day",
  rangeDays_other: "{{count}} days",
  liveAgents_one: "{{count}} agent",
  liveAgents_other: "{{count}} agents",
}

const ruStrings = {
  // Navigation and shell
  overview: "Обзор",
  activity: "Журнал",
  models: "Модели",
  agents: "Агенты",
  settings: "Настройка",
  live: "Локально",
  liveActive: "Активно",
  controlPlane: "CONTROL PLANE",
  projectSelect: "Выбор проекта",
  allProjects: "Все проекты",
  loadingTelemetry: "Читаю локальную телеметрию…",
  languageToggle: "Язык",
  themeToggle: "Тема",

  // Metrics
  sessions: "Сессии",
  calls: "Вызовы",
  tokens: "Токены",
  cost: "Стоимость",
  sessionsNote: "локальных запусков",
  callsNote: "ответов агентов",
  tokensNote: "{{value}} из кэша",
  tokensNoteWithWrite: "{{read}} из кэша · {{write}} запись",
  costNote: "по данным провайдеров",

  // Overview
  overviewTitle: "Пульс оркестра",
  overviewTextGlobal: "Общая локальная статистика по всем зарегистрированным проектам.",
  overviewTextProject: "Маршрутизация, токены и стоимость — без отправки телеметрии наружу.",
  overviewKickerProjects: "{{value}} PROJECTS",
  overviewKickerMode: "{{mode}} MODE",
  usage: "Использование за 30 дней",
  recent: "Последняя активность",
  noData: "Данные появятся после первого запуска агентов Orchestra.",
  monthProjection: "Прогноз месяца",
  monthToDate: "потрачено за месяц",
  aheadOfPace: "впереди среднего темпа",
  anomaly: "Всплеск расхода",
  anomalyNote: "выше базовой линии",
  chartTitle: "Токены и расходы",
  chartRangeLabel: "Период графика",
  chartCostSeries: "Стоимость",
  rangeAll: "Все",
  memoryLayer: "MEMORY LAYER",
  mcpTitle: "MCP-сервисы",
  mcpConnected: "подключён",
  mcpMissing: "не настроен",
  recentCalls: "Последние вызовы",
  openActivity: "Открыть журнал →",
  projects: "Проекты",
  callsShort: "вызовов",
  tokensShort: "ток",
  modelUnknown: "Модель не определена",
  inProgress: "в процессе",

  // Live panel
  liveOrchestration: "LIVE · ORCHESTRATION",
  liveTitle: "Что происходит сейчас",
  liveWaiting: "ожидание",
  liveNoConnection: "нет соединения",
  liveRunningNow: "Идёт в эту секунду",
  liveEstimatedCost: "оценочная стоимость",
  liveModelPending: "модель…",
  liveGenerating: "генерирует…",
  liveStarting: "начинает отвечать…",
  liveDisconnected: "Соединение потеряно — переподключаюсь…",
  liveIdle: "Соединено · ожидание активности агентов…",

  // Activity page
  activityTitle: "Журнал работы",
  activityKicker: "LOCAL EVENT STREAM",
  activityText: "Метаданные вызовов без содержимого промптов и ответов.",
  activityTruncated: "Показаны последние {{shown}} из {{total}} вызовов. Полный список — через экспорт.",
  colTime: "Время",
  colAgent: "Агент",
  colModel: "Модель",
  colTokens: "Токены",
  colCost: "Цена",
  colPricingSource: "Цена/источник",
  colStatus: "Статус",

  // Export
  export: "Экспорт",
  exportFailed: "Не удалось экспортировать",
  close: "Закрыть",
  exportActivity: "Журнал вызовов",
  exportModels: "Модели",
  exportAgents: "Агенты",
  exportDaily: "По дням",
  exportSummary: "Сводка",

  // Ranking pages
  modelsTitle: "Экономика моделей",
  modelsText: "Фактические токены и стоимость по каждой использованной модели.",
  agentsTitle: "Нагрузка агентов",
  agentsText: "Кто выполняет работу, сколько контекста потребляет и где происходит эскалация.",

  // Settings
  settingsTitle: "Настройка Orchestra",
  settingsKicker: "CONFIGURATION",
  settingsText: "Изменения сохраняются локально с резервной копией текущего JSONC.",
  budgetTitle: "Режим бюджета",
  budgetText: "Один активный runtime-профиль для всей команды.",
  budgetEco: "Бесплатные workers",
  budgetBalanced: "Разумный баланс",
  budgetQuality: "Качество прежде цены",
  budgetEbobo: "Максимальный роинг",
  modelsAssignTitle: "Назначение моделей",
  modelsAssignText: "Выберите подключённую модель отдельно для каждого участника команды.",
  strategyAuto: "Автоподбор",
  strategyManual: "Ручной режим",
  modelsEmpty: "OpenCode не вернул подключённые модели. Проверьте авторизацию провайдера и команду",
  modelForAgent: "Модель для {{name}}",
  modelAutomatic: "Автоматически",
  orchestrationTitle: "Оркестрация",
  orchestrationText: "Параллельность, эскалация и экспериментальные worktree.",
  fieldParallelWorkers: "Параллельные workers",
  fieldParallelEditors: "Параллельные editors",
  fieldMaxWorkers: "Максимум workers",
  fieldMaxPremiumCalls: "Premium вызовов на задачу",
  fieldConfidenceThreshold: "Порог уверенности",
  fieldWorktreeRoot: "Корень worktree",
  fieldPremiumEscalation: "Premium escalation",
  fieldExposeWorkers: "Показывать workers",
  placeholderUnset: "не задан",
  autoAcceptTitle: "Автоматически принимать все разрешения",
  autoAcceptText: "Опасный режим: все запросы разрешений для встроенных, пользовательских и Orchestra-агентов будут одобряться без подтверждения, включая команды и доступ вне проекта. После изменения перезапустите OpenCode.",
  pricingTitle: "Pricing",
  pricingText: "Оценки стоимости и резервный прайс-лист.",
  fieldEndpoint: "Endpoint",
  fieldWarnAboveUsd: "Предупреждать выше USD",
  fieldPriceRefreshHours: "Обновление прайса, часов",
  fieldEstimateCost: "Оценивать стоимость",
  fieldOpenRouterFallback: "OpenRouter fallback",
  fieldOpenRouterTtl: "TTL OpenRouter, часов",
  anomaliesTitle: "Аномалии",
  anomaliesText: "Сколько стандартных отклонений считать всплеском расходов.",
  fieldSigma: "Sigma",
  telemetryTitle: "Локальная телеметрия",
  telemetryText: "Хранить только usage-метаданные. Тексты запросов и ответы не записываются.",
  storeTexts: "Хранить тексты промптов и ответов (для отладки)",
  storeTextsHint: "Опционально, для отладки. По умолчанию выключено — журнал остаётся без промптов и ответов.",
  settingsSaved: "Настройки сохранены",
  saving: "Сохраняю…",
  saveSettings: "Сохранить настройки",

  // Agent roles and groups
  groupCore: "Основные",
  groupDevelopment: "Разработка",
  groupResearch: "Исследование",
  groupVisual: "Визуальные",
  roleLead: "Планирование и координация",
  roleJudge: "Арбитраж сложных решений",
  roleRepo: "Анализ и изменение кода",
  roleTests: "Тесты и верификация",
  roleCritic: "Ревью и поиск проблем",
  roleDocs: "Документация и API",
  roleResearch: "Внешнее исследование",
  roleSecurity: "Безопасность",
  roleVisualReference: "Анализ визуальных референсов",
  roleVisualGenerate: "Генерация изображений",
  roleVisualReview: "Визуальная проверка",
  roleEditor: "Изолированное редактирование",
  roleIntegrator: "Интеграция изменений",
  roleMerge: "Слияние worktree",

  // Utility states
  projectRequired: "PROJECT REQUIRED",
  projectRequiredText: "Выберите конкретный проект в верхней панели.",
  loadFailed: "Не удалось загрузить dashboard:",
  unknownError: "неизвестная ошибка",
}

/**
 * Typed against the Russian record, so adding a Russian key without an English
 * translation is a compile error rather than a silent runtime fallback.
 */
const enStrings: Record<keyof typeof ruStrings, string> = {
  overview: "Overview",
  activity: "Activity",
  models: "Models",
  agents: "Agents",
  settings: "Settings",
  live: "Local",
  liveActive: "Active",
  controlPlane: "CONTROL PLANE",
  projectSelect: "Select project",
  allProjects: "All projects",
  loadingTelemetry: "Reading local telemetry…",
  languageToggle: "Language",
  themeToggle: "Theme",

  sessions: "Sessions",
  calls: "Calls",
  tokens: "Tokens",
  cost: "Cost",
  sessionsNote: "local runs",
  callsNote: "agent replies",
  tokensNote: "{{value}} from cache",
  tokensNoteWithWrite: "{{read}} from cache · {{write}} write",
  costNote: "as reported by providers",

  overviewTitle: "Orchestra pulse",
  overviewTextGlobal: "Aggregated local statistics across every registered project.",
  overviewTextProject: "Routing, tokens and cost — no telemetry leaves your machine.",
  overviewKickerProjects: "{{value}} PROJECTS",
  overviewKickerMode: "{{mode}} MODE",
  usage: "Usage over 30 days",
  recent: "Recent activity",
  noData: "Data will appear after Orchestra agents run for the first time.",
  monthProjection: "Month projection",
  monthToDate: "spent this month",
  aheadOfPace: "ahead of average pace",
  anomaly: "Spend spike",
  anomalyNote: "above baseline",
  chartTitle: "Tokens and spend",
  chartRangeLabel: "Chart range",
  chartCostSeries: "Cost",
  rangeAll: "All",
  memoryLayer: "MEMORY LAYER",
  mcpTitle: "MCP services",
  mcpConnected: "connected",
  mcpMissing: "not configured",
  recentCalls: "Recent calls",
  openActivity: "Open activity →",
  projects: "Projects",
  callsShort: "calls",
  tokensShort: "tok",
  modelUnknown: "Model not resolved",
  inProgress: "in progress",

  liveOrchestration: "LIVE · ORCHESTRATION",
  liveTitle: "Happening right now",
  liveWaiting: "waiting",
  liveNoConnection: "no connection",
  liveRunningNow: "Running this second",
  liveEstimatedCost: "estimated cost",
  liveModelPending: "model…",
  liveGenerating: "generating…",
  liveStarting: "starting to answer…",
  liveDisconnected: "Connection lost — reconnecting…",
  liveIdle: "Connected · waiting for agent activity…",

  activityTitle: "Activity log",
  activityKicker: "LOCAL EVENT STREAM",
  activityText: "Call metadata without prompt or reply contents.",
  activityTruncated: "Showing the latest {{shown}} of {{total}} calls. Use export for the full list.",
  colTime: "Time",
  colAgent: "Agent",
  colModel: "Model",
  colTokens: "Tokens",
  colCost: "Cost",
  colPricingSource: "Price/source",
  colStatus: "Status",

  export: "Export",
  exportFailed: "Export failed",
  close: "Close",
  exportActivity: "Activity log",
  exportModels: "Models",
  exportAgents: "Agents",
  exportDaily: "Daily",
  exportSummary: "Summary",

  modelsTitle: "Model economics",
  modelsText: "Actual tokens and cost for every model in use.",
  agentsTitle: "Agent workload",
  agentsText: "Who does the work, how much context it consumes and where escalation happens.",

  settingsTitle: "Orchestra settings",
  settingsKicker: "CONFIGURATION",
  settingsText: "Changes are saved locally with a backup of the current JSONC.",
  budgetTitle: "Budget mode",
  budgetText: "One active runtime profile for the whole team.",
  budgetEco: "Free workers",
  budgetBalanced: "Reasonable balance",
  budgetQuality: "Quality over price",
  budgetEbobo: "Maximum roaming",
  modelsAssignTitle: "Model assignment",
  modelsAssignText: "Pick a connected model for each team member individually.",
  strategyAuto: "Automatic",
  strategyManual: "Manual",
  modelsEmpty: "OpenCode returned no connected models. Check your provider authorization and run",
  modelForAgent: "Model for {{name}}",
  modelAutomatic: "Automatic",
  orchestrationTitle: "Orchestration",
  orchestrationText: "Concurrency, escalation and experimental worktrees.",
  fieldParallelWorkers: "Parallel workers",
  fieldParallelEditors: "Parallel editors",
  fieldMaxWorkers: "Max workers",
  fieldMaxPremiumCalls: "Premium calls per task",
  fieldConfidenceThreshold: "Confidence threshold",
  fieldWorktreeRoot: "Worktree root",
  fieldPremiumEscalation: "Premium escalation",
  fieldExposeWorkers: "Expose workers",
  placeholderUnset: "not set",
  autoAcceptTitle: "Auto-accept all permissions",
  autoAcceptText: "Dangerous mode: every permission request for built-in, custom and Orchestra agents is approved without confirmation, including commands and access outside the project. Restart OpenCode after changing this.",
  pricingTitle: "Pricing",
  pricingText: "Cost estimates and the fallback price list.",
  fieldEndpoint: "Endpoint",
  fieldWarnAboveUsd: "Warn above USD",
  fieldPriceRefreshHours: "Price refresh, hours",
  fieldEstimateCost: "Estimate cost",
  fieldOpenRouterFallback: "OpenRouter fallback",
  fieldOpenRouterTtl: "OpenRouter TTL, hours",
  anomaliesTitle: "Anomalies",
  anomaliesText: "How many standard deviations count as a spend spike.",
  fieldSigma: "Sigma",
  telemetryTitle: "Local telemetry",
  telemetryText: "Store usage metadata only. Prompt and reply texts are not recorded.",
  storeTexts: "Store prompt and reply texts (for debugging)",
  storeTextsHint: "Optional, for debugging. Off by default — the log stays free of prompts and replies.",
  settingsSaved: "Settings saved",
  saving: "Saving…",
  saveSettings: "Save settings",

  groupCore: "Core",
  groupDevelopment: "Development",
  groupResearch: "Research",
  groupVisual: "Visual",
  roleLead: "Planning and coordination",
  roleJudge: "Arbitration of hard decisions",
  roleRepo: "Code analysis and changes",
  roleTests: "Tests and verification",
  roleCritic: "Review and problem hunting",
  roleDocs: "Documentation and APIs",
  roleResearch: "External research",
  roleSecurity: "Security",
  roleVisualReference: "Visual reference analysis",
  roleVisualGenerate: "Image generation",
  roleVisualReview: "Visual review",
  roleEditor: "Isolated editing",
  roleIntegrator: "Change integration",
  roleMerge: "Worktree merge",

  projectRequired: "PROJECT REQUIRED",
  projectRequiredText: "Pick a specific project in the top bar.",
  loadFailed: "Failed to load the dashboard:",
  unknownError: "unknown error",
}

/**
 * Singular keys only. Pluralised copy is addressed by its base name plus a
 * `count` option (`t("liveAgents", { count })`), so the suffixed variants are
 * deliberately not part of this union.
 */
export type TranslationKey = keyof typeof ruStrings | "liveAgents" | "rangeDays"

export const LOCALES: Record<LocaleCode, Record<string, string>> = {
  ru: { ...ruStrings, ...ruPlurals },
  en: { ...enStrings, ...enPlurals },
}

export const DEFAULT_LOCALE: LocaleCode = "ru"

/** Narrow an arbitrary stored value (localStorage) to a supported locale. */
export function resolveLocale(value: string | null | undefined): LocaleCode {
  return LOCALE_CODES.includes(value as LocaleCode) ? (value as LocaleCode) : DEFAULT_LOCALE
}
