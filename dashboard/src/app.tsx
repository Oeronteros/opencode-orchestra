import { HugeiconsIcon } from "@hugeicons/react"
import {
  Activity01Icon,
  AiBrain01Icon,
  Chart01Icon,
  CoinsDollarIcon,
  DashboardSquare01Icon,
  Database01Icon,
  Download04Icon,
  LanguageSquareIcon,
  Moon02Icon,
  Refresh01Icon,
  Settings01Icon,
  Sun02Icon,
} from "@hugeicons/core-free-icons"
import { zodResolver } from "@hookform/resolvers/zod"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createRootRoute, createRoute, createRouter, Link, Outlet } from "@tanstack/react-router"
import { columnSizingFeature, createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table"
import { useVirtualizer } from "@tanstack/react-virtual"
import { motion } from "motion/react"
import { useEffect, useMemo, useRef, useState } from "react"
import { Controller, useForm } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { z } from "zod"
import { api, subscribeLive, type ExportFormat, type ExportScope } from "./api"
import { Button } from "./components/ui/button"
import { Card } from "./components/ui/card"
import { Switch } from "./components/ui/switch"
import { downloadExport } from "./export"
import i18n from "./i18n"
import { cn } from "./lib/cn"
import { useUiStore } from "./store"
import type { ActivityRow, AggregateRow, DashboardConfig, GlobalSnapshot, LiveActiveAgent, LiveSnapshot, Snapshot } from "./types"

const EMPTY: never[] = []

function useSnapshot() {
  const selected = useUiStore((state) => state.selectedProject)
  return useQuery({ queryKey: ["snapshot", selected], queryFn: () => api.snapshot(selected === "global" ? undefined : selected), refetchInterval: 2_500, enabled: selected !== "global" })
}

function useDashboardData(range?: string) {
  const selected = useUiStore((state) => state.selectedProject)
  return useQuery<Snapshot | GlobalSnapshot>({ queryKey: ["dashboard", selected, range], queryFn: async () => selected === "global" ? api.global(range) : api.snapshot(selected, range), refetchInterval: 2_500 })
}

function formatNumber(value: number): string {
  return Intl.NumberFormat(undefined, { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value)
}

const tokenRateFormatter = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})

function formatCost(value: number): string {
  return value > 0 ? `$${value.toFixed(value < 1 ? 4 : 2)}` : "—"
}

function pricingLabel(status?: "paid" | "free" | "subscription" | "unknown"): string {
  switch (status) {
    case "free": return "free · $0"
    case "subscription": return "subscription · $0"
    case "unknown": return "unknown price"
    default: return "—"
  }
}

function totalTokens(row: AggregateRow): number {
  return row.tokens.input + row.tokens.output + row.tokens.reasoning
}

function AppShell() {
  const { t } = useTranslation()
  const theme = useUiStore((state) => state.theme)
  const setTheme = useUiStore((state) => state.setTheme)
  const selectedProject = useUiStore((state) => state.selectedProject)
  const setSelectedProject = useUiStore((state) => state.setSelectedProject)
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects, refetchInterval: 5_000 })
  const data = useDashboardData()
  useEffect(() => { document.documentElement.classList.toggle("light", theme === "light") }, [theme])
  useEffect(() => {
    if (projects.data && selectedProject !== "global" && !projects.data.some((project) => project.id === selectedProject)) setSelectedProject("global")
  }, [projects.data, selectedProject, setSelectedProject])
  const nav = [
    { to: "/", label: t("overview"), icon: DashboardSquare01Icon },
    { to: "/activity", label: t("activity"), icon: Activity01Icon },
    { to: "/models", label: t("models"), icon: Chart01Icon },
    { to: "/agents", label: t("agents"), icon: AiBrain01Icon },
    { to: "/settings", label: t("settings"), icon: Settings01Icon },
  ] as const
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><span /><span /><span /></div>
          <div><strong>ORCHESTRA</strong><small>CONTROL PLANE</small></div>
        </div>
        <nav>
          {nav.map((item) => (
            <Link key={item.to} to={item.to} activeOptions={{ exact: item.to === "/" }} className="nav-link" activeProps={{ className: "nav-link active" }}>
              <HugeiconsIcon icon={item.icon} size={19} strokeWidth={1.8} />
              <span>{item.label}</span>
            </Link>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="local-chip"><span className="status-dot" />{t("live")}</div>
          <div className="project-name">{data.data?.project ?? "Orchestra"}</div>
        </div>
      </aside>
      <main className="main-panel">
        <header className="topbar">
          <div>
             <select className="project-select" value={selectedProject} onChange={(event) => setSelectedProject(event.target.value)} aria-label="Выбор проекта">
               <option value="global">Все проекты</option>
               {projects.data?.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
             </select>
             <span className="eyebrow">{data.data?.directory ?? "Loading telemetry…"}</span>
          </div>
          <div className="top-actions">
            <ExportMenu />
            <Button variant="ghost" aria-label="Language" onClick={() => {
              const language = i18n.language === "ru" ? "en" : "ru"
              localStorage.setItem("orchestra-language", language)
              void i18n.changeLanguage(language)
            }}><HugeiconsIcon icon={LanguageSquareIcon} size={18} />{i18n.language.toUpperCase()}</Button>
            <Button variant="ghost" aria-label="Theme" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
              <HugeiconsIcon icon={theme === "dark" ? Sun02Icon : Moon02Icon} size={18} />
            </Button>
          </div>
        </header>
        <div className="content"><Outlet /></div>
      </main>
    </div>
  )
}

function PageIntro({ kicker, title, text }: { kicker: string; title: string; text: string }) {
  return <div className="page-intro"><span className="eyebrow">{kicker}</span><h1>{title}</h1><p>{text}</p></div>
}

function MetricCard({ label, value, note, icon }: { label: string; value: string; note: string; icon: typeof Chart01Icon }) {
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <Card className="metric-card">
        <div className="metric-icon"><HugeiconsIcon icon={icon} size={20} strokeWidth={1.8} /></div>
        <span>{label}</span><strong>{value}</strong><small>{note}</small>
      </Card>
    </motion.div>
  )
}

function EmptyState() {
  const { t } = useTranslation()
  return <div className="empty-state"><HugeiconsIcon icon={Activity01Icon} size={24} /><span>{t("noData")}</span></div>
}

const EXPORT_SCOPES: Array<{ scope: ExportScope; label: string }> = [
  { scope: "activity", label: "Журнал вызовов" },
  { scope: "models", label: "Модели" },
  { scope: "agents", label: "Агенты" },
  { scope: "daily", label: "По дням" },
  { scope: "summary", label: "Сводка" },
]

function ExportMenu() {
  const { t } = useTranslation()
  const selectedProject = useUiStore((state) => state.selectedProject)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<`${ExportScope}:${ExportFormat}` | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = async (scope: ExportScope, format: ExportFormat) => {
    setBusy(`${scope}:${format}`)
    setError(null)
    try {
       await downloadExport(scope, format, selectedProject)
      setOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("exportFailed"))
    } finally {
      setBusy(null)
    }
  }
  if (selectedProject === "global") return null
  return (
    <div className="export-menu">
      <Button variant="outline" onClick={() => setOpen((value) => !value)}>
        <HugeiconsIcon icon={Download04Icon} size={17} />
        {t("export")}
      </Button>
      {open && (
        <>
          <button type="button" className="export-scrim" onClick={() => setOpen(false)} aria-label={t("close")} />
          <div className="export-panel">
            <div className="export-head"><span className="eyebrow">{t("export")}</span><button type="button" className="export-close" onClick={() => setOpen(false)}>×</button></div>
            <div className="export-list">
              {EXPORT_SCOPES.map((item) => (
                <div key={item.scope} className="export-item">
                  <span className="export-item-label">{item.label}</span>
                  <div className="export-item-actions">
                    <Button variant="ghost" disabled={busy !== null} onClick={() => run(item.scope, "csv")}>{busy === `${item.scope}:csv` ? "…" : "CSV"}</Button>
                    <Button variant="ghost" disabled={busy !== null} onClick={() => run(item.scope, "json")}>{busy === `${item.scope}:json` ? "…" : "JSON"}</Button>
                  </div>
                </div>
              ))}
            </div>
            {error !== null && <div className="export-error">{error}</div>}
          </div>
        </>
      )}
    </div>
  )
}

function OverviewPage() {
  const { t } = useTranslation()
  const [range, setRange] = useState("30")
  const query = useDashboardData(range)
  const data = query.data
  if (query.isLoading) return <Loading />
  if (!data) return <ErrorState error={query.error} />
  const tokens = data.summary.tokens.input + data.summary.tokens.output + data.summary.tokens.reasoning
  const projection = data.projection
  const latestAnomaly = data.anomalies[data.anomalies.length - 1]
  return <>
    <PageIntro kicker={"global" in data ? `${data.summary.projects} PROJECTS` : `${data.config.budget.toUpperCase()} MODE`} title="Пульс оркестра" text={"global" in data ? "Общая локальная статистика по всем зарегистрированным проектам." : "Маршрутизация, токены и стоимость — без отправки телеметрии наружу."} />
    <div className="metrics-grid">
      <MetricCard label={t("sessions")} value={formatNumber(data.summary.sessions)} note="локальных запусков" icon={Database01Icon} />
      <MetricCard label={t("calls")} value={formatNumber(data.summary.calls)} note="ответов агентов" icon={Activity01Icon} />
      <MetricCard label={t("tokens")} value={formatNumber(tokens)} note={`${formatNumber(data.summary.tokens.cache.read)} из кэша`} icon={AiBrain01Icon} />
      <MetricCard label={t("cost")} value={formatCost(data.summary.cost)} note="по данным провайдеров" icon={CoinsDollarIcon} />
    </div>
    {!("global" in data) && <LivePanel projectId={data.projectId} />}
    <Card className="insight-banner">
      <div><span className="eyebrow">{t("monthProjection")}</span><strong>{formatCost(projection.projected)}</strong><small>{formatCost(projection.monthToDate)} {t("monthToDate")}{projection.isAheadOfPace ? ` · ${t("aheadOfPace")}` : ""}</small></div>
      {latestAnomaly && <div><span className="eyebrow">{t("anomaly")}</span><strong>{new Date(`${latestAnomaly.date}T00:00:00`).toLocaleDateString()} · {formatCost(latestAnomaly.cost)}</strong><small>{t("anomalyNote")} {formatCost(latestAnomaly.threshold)}</small></div>}
    </Card>
    <div className="dashboard-grid">
      <Card className="chart-card">
         <div className="card-heading"><div><span className="eyebrow">{t("usage")}</span><h2>Токены и расходы</h2></div><div className="chart-controls"><select value={range} onChange={(event) => setRange(event.target.value)} aria-label="Период графика"><option value="7">7 дней</option><option value="30">30 дней</option><option value="90">90 дней</option><option value="all">Все</option></select><span className="updated">{new Date(data.updatedAt).toLocaleTimeString()}</span></div></div>
        {data.daily.length ? <div className="chart-wrap"><ResponsiveContainer width="100%" height="100%"><AreaChart data={data.daily}>
          <defs><linearGradient id="tokens" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#8b5cf6" stopOpacity={0.5}/><stop offset="100%" stopColor="#8b5cf6" stopOpacity={0}/></linearGradient></defs>
           <CartesianGrid stroke="rgba(255,255,255,.05)" vertical={false}/><XAxis dataKey="date" tickFormatter={(v) => String(v).slice(5)} stroke="#71717a" tickLine={false} axisLine={false}/><YAxis stroke="#71717a" tickLine={false} axisLine={false} width={48} tickFormatter={formatNumber}/><Tooltip contentStyle={{ background: "#11141b", border: "1px solid rgba(255,255,255,.1)", borderRadius: 12 }}/><Area type="monotone" dataKey="cost" stroke="#f59e0b" fill="#f59e0b" fillOpacity={0.12} name="Стоимость"/><Area type="monotone" dataKey="input" stackId="1" stroke="#8b5cf6" fill="url(#tokens)"/><Area type="monotone" dataKey="output" stackId="1" stroke="#22d3ee" fill="#22d3ee" fillOpacity={0.12}/>
        </AreaChart></ResponsiveContainer></div> : <EmptyState />}
      </Card>
      {!("global" in data) ? <Card className="mcp-card">
        <span className="eyebrow">MEMORY LAYER</span><h2>MCP-сервисы</h2>
        <div className="mcp-list">
          {Object.entries({ context7: "Context7", codebaseMemory: "Codebase Memory", memoryGraph: "MemoryGraph", playwright: "Playwright" }).map(([key, label]) => (
            <div key={key}><span className={cn("status-dot", !data.mcp[key as keyof Snapshot["mcp"]] && "off")} /><span>{label}</span><small>{data.mcp[key as keyof Snapshot["mcp"]] ? "подключён" : "не настроен"}</small></div>
          ))}
        </div>
      </Card> : <ProjectList data={data} />}
    </div>
    {!("global" in data) && <Card className="list-card"><div className="card-heading"><div><span className="eyebrow">{t("recent")}</span><h2>Последние вызовы</h2></div><Link to="/activity" className="text-link">Открыть журнал →</Link></div><RecentRows rows={data.activity.slice(0, 6)} /></Card>}
  </>
}

function ProjectList({ data }: { data: GlobalSnapshot }) {
  const setSelectedProject = useUiStore((state) => state.setSelectedProject)
  return <Card className="mcp-card"><span className="eyebrow">PROJECTS</span><h2>Проекты</h2><div className="project-list">{data.projects.map((project) => <button type="button" key={project.id} onClick={() => setSelectedProject(project.id)}><span><strong>{project.name}</strong><small>{project.directory}</small></span><span>{formatNumber(project.summary.calls)} calls</span><span>{formatCost(project.summary.cost)}</span></button>)}</div></Card>
}

function RecentRows({ rows }: { rows: ActivityRow[] }) {
  if (!rows.length) return <EmptyState />
  return <div className="recent-list">{rows.map((row) => <div key={row.id}>
    <span className="agent-badge">{row.agent?.replace("orch-", "") ?? "unknown"}</span>
    <div><strong>{row.provider && row.model ? `${row.provider}/${row.model}` : "Модель не определена"}</strong><small>{row.completedAt ? new Date(row.completedAt).toLocaleString() : "в процессе"}</small></div>
    <span>{formatNumber(row.tokens.input + row.tokens.output + row.tokens.reasoning)} tok</span><span>{formatCost(row.cost)}</span>
  </div>)}</div>
}

function useLiveSnapshot(projectId: string) {
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null)
  const [connected, setConnected] = useState(false)
  useEffect(() => {
    let mounted = true
    const handle = subscribeLive(projectId,
      (next) => { if (mounted) { setSnapshot(next); setConnected(true) } },
      () => { if (mounted) setConnected(false) },
    )
    return () => { mounted = false; handle.close() }
  }, [projectId])
  return { snapshot, connected }
}

function liveAgentName(agent?: string): string {
  return agent?.replace("orch-", "") ?? "unknown"
}

function liveCostOfSet(rows: LiveActiveAgent[]): number {
  return rows.reduce((sum, row) => sum + row.cost, 0)
}

function LivePanel({ projectId }: { projectId: string }) {
  const { t } = useTranslation()
  const { snapshot, connected } = useLiveSnapshot(projectId)
  const active = snapshot?.active ?? []
  const totalCost = liveCostOfSet(active)
  const running = active.length > 0
  const hasPastActivity = (snapshot?.recent.length ?? 0) > 0
  return (
    <Card className="live-card">
      <div className="card-heading">
        <div><span className="eyebrow">LIVE · ORCHESTRATION</span><h2>Что происходит сейчас</h2></div>
        <span className={cn("live-state", running && "active", !connected && "off")}>
          <span className="status-dot" />{running ? t("live") + " · " + active.length : connected ? "ожидание" : "нет соединения"}
        </span>
      </div>
      {active.length ? (
        <div className="live-list">
          {active.map((row: LiveActiveAgent) => <LiveAgentRow key={row.key} row={row} />)}
          <div className="live-total"><span>Идёт в эту секунду</span><strong>{active.length} {active.length === 1 ? "агент" : "агента"}</strong><span>оценочная стоимость</span><strong>{formatCost(totalCost)}</strong></div>
        </div>
      ) : !connected ? (
        <div className="empty-state"><HugeiconsIcon icon={Activity01Icon} size={24} /><span>{t("liveDisconnected")}</span></div>
      ) : hasPastActivity ? (
        <div className="empty-state"><HugeiconsIcon icon={Activity01Icon} size={24} /><span>{t("liveIdle")}</span></div>
      ) : (
        <EmptyState />
      )}
    </Card>
  )
}

function LiveAgentRow({ row }: { row: LiveActiveAgent }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])
  const elapsed = Math.max(0, now - row.startedAt)
  const elapsedSeconds = elapsed / 1000
  const seconds = Math.floor(elapsedSeconds)
  const averageOutputTokensPerSecond = elapsedSeconds > 0 ? row.tokens.output / elapsedSeconds : 0
  return (
    <div className="live-row">
      <span className="agent-badge">{liveAgentName(row.agent)}</span>
      <div className="live-body">
        <div className="live-meta">
          <strong>{liveAgentName(row.agent)}</strong>
          <span>{row.provider && row.model ? row.provider + "/" + row.model : "модель…"}</span>
        </div>
        <p className="live-snippet">{row.text || (row.tokens.output + row.tokens.reasoning > 0 ? "генерирует…" : "начинает отвечать…")}</p>
        <div className="live-stats">
          <span>{seconds + "s"}</span>
          <span>{formatNumber(row.tokens.output) + " output (" + formatNumber(row.tokens.reasoning) + " reasoning)"}</span>
          <span>{"≈" + tokenRateFormatter.format(averageOutputTokensPerSecond) + " tok/s"}</span>
          {row.flags?.length ? <span className="live-warn" title={row.flags.join(", ")}>⚑</span> : null}
        </div>
      </div>
      <span className="live-cost">{formatCost(row.cost)}</span>
    </div>
  )
}
const tableFeatureSet = tableFeatures({ columnSizingFeature })
const activityHelper = createColumnHelper<typeof tableFeatureSet, ActivityRow>()
const activityColumns = activityHelper.columns([
  activityHelper.accessor("completedAt", { header: "Время", cell: ({ getValue }) => getValue() ? new Date(getValue()!).toLocaleString() : "—", size: 180 }),
  activityHelper.accessor("agent", { header: "Агент", cell: ({ getValue }) => getValue()?.replace("orch-", "") ?? "unknown", size: 130 }),
  activityHelper.accessor((row) => row.provider && row.model ? `${row.provider}/${row.model}` : "unknown", { id: "model", header: "Модель", size: 300 }),
  activityHelper.accessor((row) => row.tokens.input + row.tokens.output + row.tokens.reasoning, { id: "tokens", header: "Токены", cell: ({ getValue }) => formatNumber(getValue()), size: 120 }),
  activityHelper.accessor("cost", { header: "Цена", cell: ({ getValue }) => formatCost(getValue()), size: 100 }),
  activityHelper.accessor("pricingStatus", { header: "Цена/источник", cell: ({ row }) => pricingLabel(row.original.pricingStatus), size: 120 }),
  activityHelper.accessor("finish", { header: "Статус", cell: ({ getValue }) => getValue() ?? "—", size: 110 }),
])

function ActivityPage() {
  const selected = useUiStore((state) => state.selectedProject)
  const query = useSnapshot()
  if (selected === "global") return <ProjectRequired title="Журнал работы" />
  if (!query.data) return query.isLoading ? <Loading /> : <ErrorState error={query.error} />
  return <><PageIntro kicker="LOCAL EVENT STREAM" title="Журнал работы" text="Метаданные вызовов без содержимого промптов и ответов." /><Card className="table-card"><VirtualActivityTable data={query.data.activity} /></Card></>
}

function VirtualActivityTable({ data }: { data: ActivityRow[] }) {
  const table = useTable({ features: tableFeatureSet, columns: activityColumns, data })
  const rows = table.getRowModel().rows
  const parent = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => parent.current, estimateSize: () => 46, overscan: 8 })
  if (!rows.length) return <EmptyState />
  return <div className="virtual-table"><div className="table-head">{table.getHeaderGroups()[0]?.headers.map((header) => <div key={header.id} style={{ width: header.getSize() }}>{header.isPlaceholder ? null : <table.FlexRender header={header}/>}</div>)}</div><div ref={parent} className="table-scroll"><div style={{ height: virtualizer.getTotalSize(), position: "relative", minWidth: 940 }}>{virtualizer.getVirtualItems().map((item) => {
    const row = rows[item.index]
    if (!row) return null
    return <div className="table-row" key={row.id} data-index={item.index} ref={virtualizer.measureElement} style={{ transform: `translateY(${item.start}px)` }}>{row.getAllCells().map((cell) => <div key={cell.id} style={{ width: cell.column.getSize() }}><table.FlexRender cell={cell}/></div>)}</div>
  })}</div></div></div>
}

function RankingPage({ kind }: { kind: "models" | "agents" }) {
  const query = useDashboardData()
  const rows = query.data?.[kind] ?? EMPTY
  const title = kind === "models" ? "Экономика моделей" : "Нагрузка агентов"
  const text = kind === "models" ? "Фактические токены и стоимость по каждой использованной модели." : "Кто выполняет работу, сколько контекста потребляет и где происходит эскалация."
  return <><PageIntro kicker={kind.toUpperCase()} title={title} text={text} /><Card className="ranking-card">{rows.length ? <div className="ranking-list">{rows.map((row, index) => <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: index * .025 }} key={row.id}>
    <span className="rank">{String(index + 1).padStart(2, "0")}</span><div className="rank-main"><strong>{row.id.replace("orch-", "")}</strong><div className="usage-bar"><span style={{ width: `${Math.max(3, totalTokens(row) / Math.max(...rows.map(totalTokens)) * 100)}%` }} /></div></div><span>{row.calls} calls</span><span>{formatNumber(totalTokens(row))} tok</span><span>{formatCost(row.cost)}</span>
  </motion.div>)}</div> : <EmptyState />}</Card></>
}

const AGENTS = [
  { id: "orch-lead", name: "Lead", role: "Планирование и координация", group: "Основные" },
  { id: "orch-judge", name: "Judge", role: "Арбитраж сложных решений", group: "Основные" },
  { id: "orch-repo", name: "Repository", role: "Анализ и изменение кода", group: "Разработка" },
  { id: "orch-tests", name: "Tests", role: "Тесты и верификация", group: "Разработка" },
  { id: "orch-critic", name: "Critic", role: "Ревью и поиск проблем", group: "Разработка" },
  { id: "orch-docs", name: "Docs", role: "Документация и API", group: "Исследование" },
  { id: "orch-research", name: "Research", role: "Внешнее исследование", group: "Исследование" },
  { id: "orch-security", name: "Security", role: "Безопасность", group: "Исследование" },
  { id: "orch-visual-reference", name: "Visual Reference", role: "Анализ визуальных референсов", group: "Визуальные" },
  { id: "orch-visual-generate", name: "Visual Generate", role: "Генерация изображений", group: "Визуальные" },
  { id: "orch-visual-review", name: "Visual Review", role: "Визуальная проверка", group: "Визуальные" },
  { id: "orch-editor", name: "Editor", role: "Изолированное редактирование", group: "Разработка" },
  { id: "orch-integrator", name: "Integrator", role: "Интеграция изменений", group: "Разработка" },
  { id: "orch-merge", name: "Merge", role: "Слияние worktree", group: "Разработка" },
] as const
const settingsSchema = z.object({
  budget: z.enum(["eco", "balanced", "quality", "ebobo"]),
  models: z.object({ strategy: z.enum(["auto", "manual"]), agents: z.record(z.string(), z.string()) }),
  telemetry: z.object({ enabled: z.boolean(), storeTexts: z.boolean(), anomalySigma: z.number().min(0.5).max(6) }),
  orchestration: z.object({ parallelWorkers: z.number().int().min(1).max(8), parallelEditors: z.number().int().min(0).max(8), maxWorkers: z.number().int().min(1).max(12), premiumEscalation: z.boolean(), maxPremiumCallsPerTask: z.number().int().min(0).max(24), confidenceThreshold: z.number().min(0).max(1), exposeWorkers: z.boolean(), worktreeRoot: z.string().optional() }),
  superpowers: z.object({ compatibility: z.boolean(), injectPrimaryHint: z.boolean() }),
  pricing: z.object({ endpoint: z.string().optional(), refreshIntervalHours: z.number().int().min(0).max(2160), estimate: z.boolean(), warnThresholdUSD: z.number().min(0), openrouter: z.object({ enabled: z.boolean(), ttlHours: z.number().int().min(1).max(720) }), aliases: z.array(z.object({ canonical: z.string(), aliases: z.array(z.string()) })) }),
})

function SettingsPage() {
  const { t } = useTranslation()
  const query = useSnapshot()
  const selected = useUiStore((state) => state.selectedProject)
  const client = useQueryClient()
  const form = useForm<DashboardConfig>({ resolver: zodResolver(settingsSchema), defaultValues: query.data?.config })
  useEffect(() => { if (query.data) form.reset(query.data.config) }, [query.data, form])
  const save = useMutation({ mutationFn: (config: DashboardConfig) => api.saveConfig(config, selected), onSuccess: async () => { await client.invalidateQueries({ queryKey: ["snapshot"] }) } })
  if (selected === "global") return <ProjectRequired title="Настройка Orchestra" />
  if (!query.data) return query.isLoading ? <Loading /> : <ErrorState error={query.error} />
  return <><PageIntro kicker="CONFIGURATION" title="Настройка Orchestra" text="Изменения сохраняются локально с резервной копией текущего JSONC." />
    <form onSubmit={form.handleSubmit((value) => save.mutate(value))} className="settings-stack">
      <Card className="settings-card"><div className="setting-title"><div><h2>Режим бюджета</h2><p>Один активный runtime-профиль для всей команды.</p></div></div><Controller name="budget" control={form.control} render={({ field }) => <div className="budget-grid">{(["eco", "balanced", "quality", "ebobo"] as const).map((mode) => <button type="button" key={mode} className={cn("budget-option", field.value === mode && "selected")} onClick={() => field.onChange(mode)}><strong>{mode}</strong><span>{({ eco: "Бесплатные workers", balanced: "Разумный баланс", quality: "Качество прежде цены", ebobo: "Максимальный роинг" })[mode]}</span></button>)}</div>} /></Card>
      <Card className="settings-card model-settings"><div className="setting-title"><div><h2>Назначение моделей</h2><p>Выберите подключённую модель отдельно для каждого участника команды.</p></div><select {...form.register("models.strategy")}><option value="auto">Автоподбор</option><option value="manual">Ручной режим</option></select></div>{query.data.availableModels.length === 0 && <div className="model-empty">OpenCode не вернул подключённые модели. Проверьте авторизацию провайдера и команду <code>opencode models</code>.</div>}<div className="agent-model-list">{AGENTS.map((agent) => <div className="agent-model-row" key={agent.id}><div className="agent-identity"><strong>{agent.name}</strong><span>{agent.role}</span><small>{agent.id}</small></div><select aria-label={`Модель для ${agent.name}`} {...form.register(`models.agents.${agent.id}`)}><option value="">Автоматически</option>{query.data.availableModels.map((model) => <option key={model} value={model}>{model}</option>)}</select></div>)}</div></Card>
       <Card className="settings-card"><div className="setting-title"><div><h2>Оркестрация</h2><p>Параллельность, эскалация и экспериментальные worktree.</p></div></div><div className="settings-fields">{([ ["parallelWorkers","Параллельные workers"],["parallelEditors","Параллельные editors"],["maxWorkers","Максимум workers"],["maxPremiumCallsPerTask","Premium вызовов на задачу"],["confidenceThreshold","Порог уверенности"] ] as const).map(([name,label]) => <label key={name}>{label}<input type="number" step={name === "confidenceThreshold" ? "0.01" : "1"} {...form.register(`orchestration.${name}`, { valueAsNumber: true })} /></label>)}<label>Корень worktree<input {...form.register("orchestration.worktreeRoot")} placeholder="не задан" /></label><label className="check-setting">Premium escalation<Controller name="orchestration.premiumEscalation" control={form.control} render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} />} /></label><label className="check-setting">Показывать workers<Controller name="orchestration.exposeWorkers" control={form.control} render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} />} /></label></div></Card>
       <Card className="settings-card"><div className="setting-title"><div><h2>Pricing</h2><p>Оценки стоимости и резервный прайс-лист.</p></div></div><div className="settings-fields"><label>Endpoint<input {...form.register("pricing.endpoint")} placeholder="не задан" /></label><label>Предупреждать выше USD<input type="number" step="0.01" {...form.register("pricing.warnThresholdUSD", { valueAsNumber: true })} /></label><label>Обновление прайса, часов<input type="number" {...form.register("pricing.refreshIntervalHours", { valueAsNumber: true })} /></label><label className="check-setting">Оценивать стоимость<Controller name="pricing.estimate" control={form.control} render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} />} /></label><label className="check-setting">OpenRouter fallback<Controller name="pricing.openrouter.enabled" control={form.control} render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} />} /></label><label>TTL OpenRouter, часов<input type="number" {...form.register("pricing.openrouter.ttlHours", { valueAsNumber: true })} /></label></div></Card>
       <Card className="settings-card"><div className="setting-title"><div><h2>Аномалии</h2><p>Сколько стандартных отклонений считать всплеском расходов.</p></div></div><label className="settings-field">Sigma<input type="number" min="0.5" max="6" step="0.1" {...form.register("telemetry.anomalySigma", { valueAsNumber: true })} /></label></Card>
       <Card className="settings-card inline-setting"><div><h2>Локальная телеметрия</h2><p>Хранить только usage-метаданные. Тексты запросов и ответы не записываются.</p></div><Controller name="telemetry.enabled" control={form.control} render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} />} /></Card>
      <Card className="settings-card inline-setting"><div><h2>{t("storeTexts")}</h2><p>Опционально, для отладки. По умолчанию выключено — журнал остаётся без промптов и ответов.</p></div><Controller name="telemetry.storeTexts" control={form.control} render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} />} /></Card>
      <div className="form-actions"><span>{save.isError ? (save.error as Error).message : save.isSuccess ? "Настройки сохранены" : query.data.configPath}</span><Button type="submit" disabled={save.isPending}>{save.isPending ? "Сохраняю…" : "Сохранить настройки"}</Button></div>
    </form>
  </>
}

function ProjectRequired({ title }: { title: string }) {
  return <><PageIntro kicker="PROJECT REQUIRED" title={title} text="Выберите конкретный проект в верхней панели." /><Card><EmptyState /></Card></>
}

function Loading() { return <div className="loading"><HugeiconsIcon icon={Refresh01Icon} size={24} className="spin" />Читаю локальную телеметрию…</div> }
function ErrorState({ error }: { error: unknown }) { return <div className="error-state">Не удалось загрузить dashboard: {error instanceof Error ? error.message : "unknown error"}</div> }

const rootRoute = createRootRoute({ component: AppShell })
const overviewRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: OverviewPage })
const activityRoute = createRoute({ getParentRoute: () => rootRoute, path: "/activity", component: ActivityPage })
const modelsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/models", component: () => <RankingPage kind="models" /> })
const agentsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/agents", component: () => <RankingPage kind="agents" /> })
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage })

export const router = createRouter({ routeTree: rootRoute.addChildren([overviewRoute, activityRoute, modelsRoute, agentsRoute, settingsRoute]) })

declare module "@tanstack/react-router" {
  interface Register { router: typeof router }
}
