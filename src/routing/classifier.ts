import type { ProfileName } from "../config/schema.js"

export interface Classification {
  profile: ProfileName
  secondaryProfiles: ProfileName[]
  confidence: number
  matchedSignals: string[]
  securityRelevant: boolean
  critical: boolean
  /** True when no domain signal matched and architecture is only a safe default. */
  fallback?: boolean
}

const SIGNALS: Record<ProfileName, string[]> = {
  architecture: [
    "architecture",
    "architect",
    "design",
    "module",
    "boundary",
    "api",
    "database",
    "billing",
    "integration",
    "архитект",
    "спроект",
    "модул",
    "интеграц",
  ],
  debug: [
    "bug",
    "debug",
    "error",
    "exception",
    "fails",
    "broken",
    "502",
    "crash",
    "race condition",
    "ошиб",
    "падает",
    "не работает",
    "разлогин",
  ],
  ui: [
    "ui",
    "ux",
    "layout",
    "dashboard",
    "responsive",
    "component",
    "visual",
    "animation",
    "интерфейс",
    "дизайн",
    "визуал",
    "адаптив",
  ],
  research: [
    "research",
    "compare",
    "investigate",
    "find examples",
    "documentation",
    "изучи",
    "исслед",
    "сравни",
    "найди примеры",
    "документац",
  ],
  review: [
    "review",
    "audit code",
    "pull request",
    "diff",
    "code quality",
    "ревью",
    "проверь код",
    "оцени изменения",
  ],
  security: [
    "security",
    "vulnerability",
    "auth",
    "oauth",
    "token",
    "cookie",
    "xss",
    "injection",
    "permission",
    "безопас",
    "уязвим",
    "авторизац",
  ],
  performance: [
    "performance",
    "latency",
    "slow",
    "memory",
    "cpu",
    "throughput",
    "optimize",
    "производитель",
    "медлен",
    "оптимиз",
  ],
  migration: [
    "migration",
    "migrate",
    "upgrade",
    "port to",
    "rewrite",
    "миграц",
    "перенести",
    "обновить версию",
  ],
  ops: [
    "deploy",
    "docker",
    "kubernetes",
    "ci/cd",
    "pipeline",
    "infrastructure",
    "production",
    "деплой",
    "инфраструктур",
    "докер",
  ],
}

const CRITICAL_SIGNALS = [
  "production",
  "payment",
  "billing",
  "data loss",
  "breach",
  "security incident",
  "продакш",
  "платеж",
  "потеря данных",
  "утечка",
]

const INTERMITTENT_SIGNALS = ["intermittent", "occasionally", "sometimes", "randomly", "иногда", "периодически", "случайно"]

export function classifyTask(
  task: string,
  enabledProfiles?: Partial<Record<ProfileName, boolean>>,
): Classification {
  const normalized = task.toLowerCase()
  const ranked = (Object.entries(SIGNALS) as Array<[ProfileName, string[]]>)
    .filter(([profile]) => enabledProfiles?.[profile] !== false)
    .map(([profile, signals]) => {
      const matched = signals.filter((signal) => normalized.includes(signal))
      const intermittentDebugBonus =
        profile === "debug" && matched.length > 0 && INTERMITTENT_SIGNALS.some((signal) => normalized.includes(signal))
          ? 2
          : 0
      return { profile, matched, score: matched.length + intermittentDebugBonus }
    })
    .sort((a, b) => b.score - a.score)

  const winner = ranked[0]
  const profile = winner && winner.score > 0 ? winner.profile : "architecture"
  const secondaryProfiles = ranked
    .filter((item) => item.profile !== profile && item.score > 0)
    .slice(0, 2)
    .map((item) => item.profile)
  const topScore = winner?.score ?? 0
  const runnerUp = ranked[1]?.score ?? 0
  const confidence = topScore === 0 ? 0.45 : Math.min(0.95, 0.58 + topScore * 0.1 - runnerUp * 0.03)

  return {
    profile,
    secondaryProfiles,
    confidence: Number(confidence.toFixed(2)),
    matchedSignals: winner?.matched ?? [],
    securityRelevant: profile === "security" || ranked.some((item) => item.profile === "security" && item.score > 0),
    critical: CRITICAL_SIGNALS.some((signal) => normalized.includes(signal)),
    fallback: topScore === 0,
  }
}
