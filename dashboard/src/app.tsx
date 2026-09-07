import { HugeiconsIcon } from "@hugeicons/react"
import {
  Activity01Icon,
  AiBrain01Icon,
  ArrowUpDownIcon,
  Chart01Icon,
  CoinsDollarIcon,
  DashboardSquare01Icon,
  Database01Icon,
  Download04Icon,
  LanguageSquareIcon,
  Moon02Icon,
  Refresh01Icon,
  Search01Icon,
  Settings01Icon,
  Sun02Icon,
} from "@hugeicons/core-free-icons"
import { zodResolver } from "@hookform/resolvers/zod"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createRootRoute, createRoute, createRouter, Link, Outlet } from "@tanstack/react-router"
import { columnSizingFeature, createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table"
import { useVirtualizer } from "@tanstack/react-virtual"
import { motion, AnimatePresence, useReducedMotion } from "motion/react"
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react"
import { Controller, useForm, useWatch } from "react-hook-form"
import type { TFunction } from "i18next"
import { useTranslation } from "react-i18next"
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { z } from "zod"
import { api, subscribeLive, type ExportFormat, type ExportScope } from "./api"
import { Button } from "./components/ui/button"
import { Card } from "./components/ui/card"
import { Switch } from "./components/ui/switch"
import { ModelCombobox } from "./components/model-combobox"
import { downloadExport } from "./export"
import i18n, { nextLanguage, setLanguage } from "./i18n"
import { cn } from "./lib/cn"
import type { TranslationKey } from "./lib/locales"
import { splitTokens } from "./lib/tokens"
import { snapshotResetDecision, type SnapshotResetState } from "./lib/snapshot-reset"
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

function totalTokens(row: AggregateRow): number {
  return splitTokens(row.tokens).total
}

function formatTokensInOut(tokens: AggregateRow["tokens"]): string {
  const split = splitTokens(tokens)
  return `${formatNumber(split.input)} ↓ / ${formatNumber(split.output)} ↑`
}

function formatTokensInOutCompact(tokens: AggregateRow["tokens"] | ActivityRow["tokens"]): string {
  const split = splitTokens(tokens)
  return `${formatNumber(split.input)} ↓ · ${formatNumber(split.output)} ↑`
}

/* ═══════════════════════════════════════════════════════
   ANIMATED MESH BACKGROUND
   ═══════════════════════════════════════════════════════ */

function MeshBackground() {
  return (
    <div className="mesh-bg" aria-hidden="true">
      <motion.div
        className="absolute w-[600px] h-[600px] -top-[200px] -right-[100px] rounded-full"
        style={{
          background: "radial-gradient(circle, rgba(139, 92, 246, 0.15), transparent 70%)",
          filter: "blur(80px)",
        }}
        animate={{
          x: [0, 20, -10, 30, 0],
          y: [0, -30, 20, 10, 0],
          scale: [1, 1.02, 0.98, 1.01, 1],
        }}
        transition={{ duration: 20, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute w-[500px] h-[500px] -bottom-[150px] -left-[100px] rounded-full"
        style={{
          background: "radial-gradient(circle, rgba(34, 211, 238, 0.1), transparent 70%)",
          filter: "blur(80px)",
        }}
        animate={{
          x: [0, -20, 10, -30, 0],
          y: [0, 20, -10, -20, 0],
          scale: [1, 0.98, 1.02, 0.99, 1],
        }}
        transition={{ duration: 25, repeat: Infinity, ease: "easeInOut", delay: -5 }}
      />
    </div>
  )
}

/* ═══════════════════════════════════════════════════════
   APP SHELL
   ═══════════════════════════════════════════════════════ */

function AppShell() {
  const { t } = useTranslation()
  const theme = useUiStore((state) => state.theme)
  const setTheme = useUiStore((state) => state.setTheme)
  const selectedProject = useUiStore((state) => state.selectedProject)
  const setSelectedProject = useUiStore((state) => state.setSelectedProject)
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects, refetchInterval: 5_000 })
  // Use the same default range as OverviewPage so the shell and the page share
  // one React Query cache entry instead of polling the same snapshot twice.
  const data = useDashboardData("30")
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
    <>
      <MeshBackground />
      <div className="app-shell">
        <aside className="sidebar">
          <div className="brand">
            <motion.div
              className="brand-mark"
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
            >
              <span /><span /><span />
            </motion.div>
            <div>
              <strong>ORCHESTRA</strong>
              <small>CONTROL PLANE</small>
            </div>
          </div>
          <nav>
            {nav.map((item, index) => (
              <motion.div
                key={item.to}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: index * 0.05, duration: 0.3 }}
              >
                <Link
                  to={item.to}
                  activeOptions={{ exact: item.to === "/" }}
                  className="nav-link"
                  activeProps={{ className: "nav-link active" }}
                >
                  <HugeiconsIcon icon={item.icon} size={19} strokeWidth={1.8} />
                  <span>{item.label}</span>
                </Link>
              </motion.div>
            ))}
          </nav>
          <div className="sidebar-foot">
            <div className="local-chip">
              <span className="status-dot" />
              {t("live")}
            </div>
            <div className="project-name">{data.data?.project ?? "Orchestra"}</div>
          </div>
        </aside>
        <main className="main-panel">
          <header className="topbar">
            <div>
              <select
                className="project-select"
                value={selectedProject}
                onChange={(event) => setSelectedProject(event.target.value)}
                aria-label={t("projectSelect")}
              >
                <option value="global">{t("allProjects")}</option>
                {projects.data?.map((project) => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </select>
              <span className="eyebrow">{data.data?.directory ?? t("loadingTelemetry")}</span>
            </div>
            <div className="top-actions">
              <ExportMenu />
              <Button
                variant="ghost"
                aria-label={t("languageToggle")}
                onClick={() => setLanguage(nextLanguage(i18n.language))}
              >
                <HugeiconsIcon icon={LanguageSquareIcon} size={18} />
                {i18n.language.toUpperCase()}
              </Button>
              <Button
                variant="ghost"
                aria-label={t("themeToggle")}
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              >
                <motion.div
                  key={theme}
                  initial={{ rotate: -90, opacity: 0 }}
                  animate={{ rotate: 0, opacity: 1 }}
                  transition={{ duration: 0.3 }}
                >
                  <HugeiconsIcon icon={theme === "dark" ? Sun02Icon : Moon02Icon} size={18} />
                </motion.div>
              </Button>
            </div>
          </header>
          <div className="content">
            <AnimatePresence mode="wait">
              <Outlet />
            </AnimatePresence>
          </div>
        </main>
      </div>
    </>
  )
}

/* ═══════════════════════════════════════════════════════
   PAGE INTRO — Premium Typography
   ═══════════════════════════════════════════════════════ */

function PageIntro({ kicker, title, text }: { kicker: string; title: string; text: string }) {
  return (
    <motion.div
      className="page-intro"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
    >
      <span className="eyebrow">{kicker}</span>
      <h1>{title}</h1>
      <p>{text}</p>
    </motion.div>
  )
}

function TiltSurface({ children, className, intensity = 7 }: { children: ReactNode; className?: string; intensity?: number }) {
  const reduceMotion = useReducedMotion()

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (reduceMotion || event.pointerType === "touch") return
    const bounds = event.currentTarget.getBoundingClientRect()
    const x = (event.clientX - bounds.left) / bounds.width
    const y = (event.clientY - bounds.top) / bounds.height
    event.currentTarget.style.setProperty("--pointer-x", `${(x * 100).toFixed(1)}%`)
    event.currentTarget.style.setProperty("--pointer-y", `${(y * 100).toFixed(1)}%`)
    event.currentTarget.style.setProperty("--tilt-x", `${((0.5 - y) * intensity).toFixed(2)}deg`)
    event.currentTarget.style.setProperty("--tilt-y", `${((x - 0.5) * intensity).toFixed(2)}deg`)
  }

  const resetTilt = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.style.setProperty("--pointer-x", "50%")
    event.currentTarget.style.setProperty("--pointer-y", "50%")
    event.currentTarget.style.setProperty("--tilt-x", "0deg")
    event.currentTarget.style.setProperty("--tilt-y", "0deg")
  }

  return (
    <div
      className={cn("tilt-surface", className)}
      onPointerMove={handlePointerMove}
      onPointerLeave={resetTilt}
    >
      {children}
    </div>
  )
}

function OrchestraHero({ kicker, title, text, calls, callsLabel }: { kicker: string; title: string; text: string; calls: string; callsLabel: string }) {
  const reduceMotion = useReducedMotion()

  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (reduceMotion || event.pointerType === "touch") return
    const bounds = event.currentTarget.getBoundingClientRect()
    const x = (event.clientX - bounds.left) / bounds.width
    const y = (event.clientY - bounds.top) / bounds.height
    event.currentTarget.style.setProperty("--hero-x", `${(x * 100).toFixed(1)}%`)
    event.currentTarget.style.setProperty("--hero-y", `${(y * 100).toFixed(1)}%`)
    event.currentTarget.style.setProperty("--hero-rx", `${((0.5 - y) * 5).toFixed(2)}deg`)
    event.currentTarget.style.setProperty("--hero-ry", `${((x - 0.5) * 7).toFixed(2)}deg`)
  }

  const resetHero = (event: ReactPointerEvent<HTMLElement>) => {
    event.currentTarget.style.setProperty("--hero-x", "72%")
    event.currentTarget.style.setProperty("--hero-y", "38%")
    event.currentTarget.style.setProperty("--hero-rx", "0deg")
    event.currentTarget.style.setProperty("--hero-ry", "0deg")
  }

  const orbitTransition = (duration: number, reverse = false) => ({
    duration,
    repeat: Infinity,
    ease: "linear" as const,
    ...(reverse ? { repeatType: "loop" as const } : {}),
  })

  return (
    <motion.section
      className="overview-hero"
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.55 }}
      onPointerMove={handlePointerMove}
      onPointerLeave={resetHero}
    >
      <div className="hero-copy">
        <div className="hero-live-pill"><span className="status-dot" />{kicker}</div>
        <h1>{title}</h1>
        <p>{text}</p>
        <div className="hero-signal">
          <span>{calls}</span>
          <small>{callsLabel}</small>
          <i aria-hidden="true" />
        </div>
      </div>
      <div className="orchestra-visual" aria-hidden="true">
        <div className="orchestra-stage">
          <div className="stage-horizon" />
          <div className="orbit-plane orbit-plane-a">
            <motion.div
              className="orbit-spinner"
              animate={reduceMotion ? undefined : { rotate: 360 }}
              transition={orbitTransition(18)}
            >
              <span className="orbit-node node-lead">LEAD</span>
              <span className="orbit-node node-code">CODE</span>
              <span className="orbit-node node-test">TEST</span>
            </motion.div>
          </div>
          <div className="orbit-plane orbit-plane-b">
            <motion.div
              className="orbit-spinner"
              animate={reduceMotion ? undefined : { rotate: -360 }}
              transition={orbitTransition(24, true)}
            >
              <span className="orbit-node node-research">RESEARCH</span>
              <span className="orbit-node node-review">REVIEW</span>
            </motion.div>
          </div>
          <div className="orchestra-core">
            <div className="core-halo" />
            <div className="core-shell">
              <span /><span /><span /><span />
            </div>
            <small>ORCHESTRA</small>
          </div>
          <span className="stage-particle particle-a" />
          <span className="stage-particle particle-b" />
          <span className="stage-particle particle-c" />
        </div>
      </div>
    </motion.section>
  )
}

/* ═══════════════════════════════════════════════════════
   METRIC CARD — Glassmorphism + Shimmer
   ═══════════════════════════════════════════════════════ */

function MetricCard({ label, value, note, icon, index = 0 }: { 
  label: string; 
  value: string; 
  note: string; 
  icon: typeof Chart01Icon;
  index?: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.1, duration: 0.4 }}
    >
      <TiltSurface className="metric-tilt" intensity={9}>
        <Card className="metric-card depth-card group">
          <div className="metric-icon">
            <HugeiconsIcon icon={icon} size={20} strokeWidth={1.8} />
          </div>
          <span>{label}</span>
          <strong>{value}</strong>
          <small>{note}</small>
          {/* Shimmer effect on hover */}
          <div className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none">
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/[0.03] to-transparent animate-[shimmer_3s_ease-in-out_infinite] bg-[length:200%_100%]" />
          </div>
        </Card>
      </TiltSurface>
    </motion.div>
  )
}

/* ═══════════════════════════════════════════════════════
   EMPTY STATE
   ═══════════════════════════════════════════════════════ */

function EmptyState() {
  const { t } = useTranslation()
  return (
    <motion.div
      className="empty-state"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: 0.2 }}
    >
      <HugeiconsIcon icon={Activity01Icon} size={24} />
      <span>{t("noData")}</span>
    </motion.div>
  )
}

/* ═══════════════════════════════════════════════════════
   EXPORT MENU
   ═══════════════════════════════════════════════════════ */

// Labels are translation keys, resolved at render time so a language switch
// re-labels the menu without reloading.
const EXPORT_SCOPES: Array<{ scope: ExportScope; labelKey: TranslationKey }> = [
  { scope: "activity", labelKey: "exportActivity" },
  { scope: "models", labelKey: "exportModels" },
  { scope: "agents", labelKey: "exportAgents" },
  { scope: "daily", labelKey: "exportDaily" },
  { scope: "summary", labelKey: "exportSummary" },
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
      setError(null)
      setOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("exportFailed"))
    } finally {
      setBusy(null)
    }
  }
  useEffect(() => {
    if (!open) return
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("keydown", handleEscape)
    return () => document.removeEventListener("keydown", handleEscape)
  }, [open])
  if (selectedProject === "global") return null
  return (
    <div className="export-menu">
      <Button variant="outline" onClick={() => setOpen((value) => !value)}>
        <HugeiconsIcon icon={Download04Icon} size={17} />
        {t("export")}
      </Button>
      <AnimatePresence>
        {open && (
          <>
            <motion.button
              type="button"
              className="export-scrim"
              onClick={() => setOpen(false)}
              aria-label={t("close")}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            />
            <motion.div
              className="export-panel"
              initial={{ opacity: 0, y: -10, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.95 }}
              transition={{ duration: 0.2 }}
            >
              <div className="export-head">
                <span className="eyebrow">{t("export")}</span>
                <button type="button" className="export-close" onClick={() => setOpen(false)}>×</button>
              </div>
              <div className="export-list">
                {EXPORT_SCOPES.map((item, index) => (
                  <motion.div
                    key={item.scope}
                    className="export-item"
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: index * 0.05 }}
                  >
                    <span className="export-item-label">{t(item.labelKey)}</span>
                    <div className="export-item-actions">
                      <Button
                        variant="ghost"
                        disabled={busy !== null}
                        onClick={() => run(item.scope, "csv")}
                      >
                        {busy === `${item.scope}:csv` ? "…" : "CSV"}
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={busy !== null}
                        onClick={() => run(item.scope, "json")}
                      >
                        {busy === `${item.scope}:json` ? "…" : "JSON"}
                      </Button>
                    </div>
                  </motion.div>
                ))}
              </div>
              {error !== null && (
                <motion.div
                  className="export-error"
                  initial={{ opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                >
                  {error}
                </motion.div>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════
   OVERVIEW PAGE
   ═══════════════════════════════════════════════════════ */

function OverviewPage() {
  const { t } = useTranslation()
  const [range, setRange] = useState("30")
  const [chartSeries, setChartSeries] = useState({ input: true, output: true, cost: true })
  const query = useDashboardData(range)
  const data = query.data
  if (query.isLoading) return <Loading />
  if (!data) return <ErrorState error={query.error} />
  const tokenSplit = splitTokens(data.summary.tokens)
  const tokenCacheNote = tokenSplit.cacheWrite > 0
    ? t("tokensNoteWithWrite", { read: formatNumber(tokenSplit.cacheRead), write: formatNumber(tokenSplit.cacheWrite) })
    : t("tokensNote", { value: formatNumber(tokenSplit.cacheRead) })
  const projection = data.projection
  const latestAnomaly = data.anomalies[data.anomalies.length - 1]
  const chartTotals = data.daily.reduce(
    (totals, day) => ({ input: totals.input + day.input, output: totals.output + day.output, cost: totals.cost + day.cost }),
    { input: 0, output: 0, cost: 0 },
  )
  const toggleChartSeries = (series: keyof typeof chartSeries) => {
    setChartSeries((current) => {
      const activeCount = Object.values(current).filter(Boolean).length
      if (current[series] && activeCount === 1) return current
      return { ...current, [series]: !current[series] }
    })
  }
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
    >
      <OrchestraHero
        kicker={"global" in data ? t("overviewKickerProjects", { value: data.summary.projects }) : t("overviewKickerMode", { mode: data.config.budget.toUpperCase() })}
        title={t("overviewTitle")}
        text={"global" in data ? t("overviewTextGlobal") : t("overviewTextProject")}
        calls={formatNumber(data.summary.calls)}
        callsLabel={t("calls")}
      />
      <div className="metrics-grid">
        <MetricCard label={t("sessions")} value={formatNumber(data.summary.sessions)} note={t("sessionsNote")} icon={Database01Icon} index={0} />
        <MetricCard label={t("calls")} value={formatNumber(data.summary.calls)} note={t("callsNote")} icon={Activity01Icon} index={1} />
        <MetricCard label={t("tokens")} value={formatTokensInOut(data.summary.tokens)} note={tokenCacheNote} icon={AiBrain01Icon} index={2} />
        <MetricCard label={t("cost")} value={formatCost(data.summary.cost)} note={t("costNote")} icon={CoinsDollarIcon} index={3} />
      </div>
      {!("global" in data) && <LivePanel projectId={data.projectId} />}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
      >
        <Card className="insight-banner">
          <div>
            <span className="eyebrow">{t("monthProjection")}</span>
            <strong>{formatCost(projection.projected)}</strong>
            <small>{formatCost(projection.monthToDate)} {t("monthToDate")}{projection.isAheadOfPace ? ` · ${t("aheadOfPace")}` : ""}</small>
          </div>
          {latestAnomaly && (
            <div>
              <span className="eyebrow">{t("anomaly")}</span>
              <strong>{new Date(`${latestAnomaly.date}T00:00:00`).toLocaleDateString()} · {formatCost(latestAnomaly.cost)}</strong>
              <small>{t("anomalyNote")} {formatCost(latestAnomaly.threshold)}</small>
            </div>
          )}
        </Card>
      </motion.div>
      <div className="dashboard-grid">
        <motion.div
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.4 }}
        >
          <TiltSurface className="dashboard-tilt chart-tilt" intensity={1.5}>
          <Card className="chart-card depth-card">
            <div className="card-heading">
              <div>
                <span className="eyebrow">{t("usage")}</span>
                <h2>{t("chartTitle")}</h2>
              </div>
              <div className="chart-controls">
                <select
                  value={range}
                  onChange={(event) => setRange(event.target.value)}
                  aria-label={t("chartRangeLabel")}
                >
                  {[7, 30, 90].map((days) => (
                    <option key={days} value={String(days)}>{t("rangeDays", { count: days })}</option>
                  ))}
                  <option value="all">{t("rangeAll")}</option>
                </select>
                <span className="updated">{new Date(data.updatedAt).toLocaleTimeString()}</span>
              </div>
            </div>
            {data.daily.length ? (
              <>
              <div className="chart-series" aria-label={t("chartTitle")}>
                {([
                  { key: "input", label: t("chartInputSeries"), value: formatNumber(chartTotals.input) },
                  { key: "output", label: t("chartOutputSeries"), value: formatNumber(chartTotals.output) },
                  { key: "cost", label: t("chartCostSeries"), value: formatCost(chartTotals.cost) },
                ] as const).map((series) => (
                  <button
                    type="button"
                    key={series.key}
                    className={cn("chart-series-pill", `series-${series.key}`, !chartSeries[series.key] && "muted")}
                    aria-pressed={chartSeries[series.key]}
                    onClick={() => toggleChartSeries(series.key)}
                  >
                    <i aria-hidden="true" />
                    <span>{series.label}</span>
                    <strong>{series.value}</strong>
                  </button>
                ))}
              </div>
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={data.daily}>
                    <defs>
                      <linearGradient id="tokens" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#8b5cf6" stopOpacity={0.5} />
                        <stop offset="100%" stopColor="#8b5cf6" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="costGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.3} />
                        <stop offset="100%" stopColor="#f59e0b" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="outputGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#22d3ee" stopOpacity={0.3} />
                        <stop offset="100%" stopColor="#22d3ee" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="rgba(255,255,255,.055)" strokeDasharray="3 7" vertical={false} />
                    <XAxis
                      dataKey="date"
                      tickFormatter={(v) => String(v).slice(5)}
                      stroke="#52525b"
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      yAxisId="tokens"
                      stroke="#52525b"
                      tickLine={false}
                      axisLine={false}
                      width={48}
                      tickFormatter={formatNumber}
                    />
                    <YAxis
                      yAxisId="cost"
                      orientation="right"
                      stroke="#8a7045"
                      tickLine={false}
                      axisLine={false}
                      width={48}
                      tickFormatter={(value) => formatCost(Number(value))}
                    />
                    <Tooltip
                      cursor={{ stroke: "rgba(167,139,250,.24)", strokeWidth: 1 }}
                      contentStyle={{
                        background: "rgba(12, 15, 22, 0.95)",
                        border: "1px solid rgba(255,255,255,.1)",
                        borderRadius: 12,
                        backdropFilter: "blur(16px)",
                        boxShadow: "0 16px 64px rgba(0,0,0,0.5)",
                      }}
                      formatter={(value, name) => [
                        name === t("chartCostSeries") ? formatCost(Number(value)) : formatNumber(Number(value)),
                        name,
                      ]}
                    />
                    {chartSeries.cost && <Area
                      type="monotone"
                      dataKey="cost"
                      yAxisId="cost"
                      stroke="#f59e0b"
                      fill="url(#costGrad)"
                      strokeWidth={2}
                      name={t("chartCostSeries")}
                      dot={false}
                      activeDot={{ r: 4, fill: "#f59e0b", stroke: "rgba(245,158,11,.25)", strokeWidth: 6 }}
                      animationDuration={700}
                    />}
                    {chartSeries.input && <Area
                      type="monotone"
                      dataKey="input"
                      yAxisId="tokens"
                      stackId="1"
                      stroke="#8b5cf6"
                      fill="url(#tokens)"
                      strokeWidth={2}
                      name={t("chartInputSeries")}
                      dot={false}
                      activeDot={{ r: 4, fill: "#8b5cf6", stroke: "rgba(139,92,246,.25)", strokeWidth: 6 }}
                      animationDuration={700}
                    />}
                    {chartSeries.output && <Area
                      type="monotone"
                      dataKey="output"
                      yAxisId="tokens"
                      stackId="1"
                      stroke="#22d3ee"
                      fill="url(#outputGrad)"
                      strokeWidth={2}
                      name={t("chartOutputSeries")}
                      dot={false}
                      activeDot={{ r: 4, fill: "#22d3ee", stroke: "rgba(34,211,238,.22)", strokeWidth: 6 }}
                      animationDuration={700}
                    />}
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              </>
            ) : (
              <EmptyState />
            )}
          </Card>
          </TiltSurface>
        </motion.div>
        <motion.div
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.5 }}
        >
          <TiltSurface className={cn("dashboard-tilt", "global" in data && "projects-tilt")} intensity={"global" in data ? 1.25 : 4}>
          {!("global" in data) ? (
            <Card className="mcp-card depth-card">
              <span className="eyebrow">{t("memoryLayer")}</span>
              <h2>{t("mcpTitle")}</h2>
              <div className="mcp-list">
                {Object.entries({ context7: "Context7", codebaseMemory: "Codebase Memory", memoryGraph: "MemoryGraph", git: "Git", astGrep: "ast-grep", playwright: "Playwright" }).map(([key, label], index) => {
                  const usage = data.mcpUsage.find((row) => row.server === key)
                  return (
                    <motion.div
                      key={key}
                      initial={{ opacity: 0, x: 10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.5 + index * 0.05 }}
                    >
                      <span className={cn("status-dot", (!data.mcp[key as keyof Snapshot["mcp"]] || usage?.lastOutcome === "failure") && "off")} />
                      <span>{label}</span>
                      <small>
                        {data.mcp[key as keyof Snapshot["mcp"]] ? t("mcpConnected") : t("mcpMissing")}
                        {usage ? ` · ${usage.calls}× · ${Math.round((usage.successes / Math.max(1, usage.calls)) * 100)}% · ${usage.averageLatencyMs}ms` : ""}
                      </small>
                    </motion.div>
                  )
                })}
              </div>
            </Card>
          ) : (
            <ProjectList data={data} />
          )}
          </TiltSurface>
        </motion.div>
      </div>
      {!("global" in data) && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.6 }}
        >
          <Card className="list-card">
            <div className="card-heading">
              <div>
                <span className="eyebrow">{t("recent")}</span>
                <h2>{t("recentCalls")}</h2>
              </div>
              <Link to="/activity" className="text-link">{t("openActivity")}</Link>
            </div>
            <RecentRows rows={data.activity.slice(0, 6)} />
          </Card>
        </motion.div>
      )}
    </motion.div>
  )
}

/* ═══════════════════════════════════════════════════════
   PROJECT LIST
   ═══════════════════════════════════════════════════════ */

function ProjectList({ data }: { data: GlobalSnapshot }) {
  const { t } = useTranslation()
  const setSelectedProject = useUiStore((state) => state.setSelectedProject)
  return (
    <Card className="mcp-card depth-card">
      <span className="eyebrow">PROJECTS</span>
      <h2>{t("projects")}</h2>
      <div className="project-list">
        {data.projects.map((project, index) => (
          <motion.button
            type="button"
            key={project.id}
            onClick={() => setSelectedProject(project.id)}
            initial={{ opacity: 0, x: 10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: index * 0.05 }}
          >
            <span>
              <strong>{project.name}</strong>
              <small>{project.directory}</small>
            </span>
            <span>{formatNumber(project.summary.calls)} {t("callsShort")}</span>
            <span>{formatCost(project.summary.cost)}</span>
          </motion.button>
        ))}
      </div>
    </Card>
  )
}

/* ═══════════════════════════════════════════════════════
   RECENT ROWS
   ═══════════════════════════════════════════════════════ */

function RecentRows({ rows }: { rows: ActivityRow[] }) {
  const { t } = useTranslation()
  if (!rows.length) return <EmptyState />
  return (
    <div className="recent-list">
      {rows.map((row, index) => (
        <motion.div
          key={row.id}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: index * 0.05 }}
        >
          <span className="agent-badge">{row.agent?.replace("orch-", "") ?? "unknown"}</span>
          <div>
            <strong>{row.provider && row.model ? `${row.provider}/${row.model}` : t("modelUnknown")}</strong>
            <small>{row.completedAt ? new Date(row.completedAt).toLocaleString() : t("inProgress")}</small>
          </div>
          <span>{formatTokensInOutCompact(row.tokens)} {t("tokensShort")}</span>
          <span>{formatCost(row.cost)}</span>
        </motion.div>
      ))}
    </div>
  )
}

/* ═══════════════════════════════════════════════════════
   LIVE SNAPSHOT
   ═══════════════════════════════════════════════════════ */

function useLiveSnapshot(projectId: string) {
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null)
  const [connected, setConnected] = useState(false)
  const disconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    let mounted = true
    const handle = subscribeLive(projectId,
      (next) => {
        if (mounted) {
          setSnapshot(next)
          setConnected(true)
          if (disconnectTimer.current) {
            clearTimeout(disconnectTimer.current)
            disconnectTimer.current = null
          }
        }
      },
      () => {
        if (mounted) {
          if (disconnectTimer.current) clearTimeout(disconnectTimer.current)
          disconnectTimer.current = setTimeout(() => {
            if (mounted) setConnected(false)
          }, 3_000)
        }
      },
    )
    return () => {
      mounted = false
      if (disconnectTimer.current) clearTimeout(disconnectTimer.current)
      handle.close()
    }
  }, [projectId])
  return { snapshot, connected }
}

function liveAgentName(agent?: string): string {
  return agent?.replace("orch-", "") ?? "unknown"
}

function liveCostOfSet(rows: LiveActiveAgent[]): number {
  return rows.reduce((sum, row) => sum + row.cost, 0)
}

/* ═══════════════════════════════════════════════════════
   LIVE PANEL — Premium Animations
   ═══════════════════════════════════════════════════════ */

function LivePanel({ projectId }: { projectId: string }) {
  const { t } = useTranslation()
  const { snapshot, connected } = useLiveSnapshot(projectId)
  const active = snapshot?.active ?? []
  const totalCost = liveCostOfSet(active)
  const running = active.length > 0
  const hasPastActivity = (snapshot?.recent.length ?? 0) > 0
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.2 }}
    >
      <Card className="live-card">
        <div className="card-heading">
          <div>
            <span className="eyebrow">{t("liveOrchestration")}</span>
            <h2>{t("liveTitle")}</h2>
          </div>
          <span className={cn("live-state", running && "active", !connected && "off")} role="status" aria-live="polite">
            <span className="status-dot" aria-hidden="true" />
            {running ? t("liveActive") + " · " + active.length : connected ? t("liveWaiting") : t("liveNoConnection")}
          </span>
        </div>
        {active.length ? (
          <div className="live-list">
            {active.map((row: LiveActiveAgent, index: number) => (
              <motion.div
                key={row.key}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: index * 0.1 }}
              >
                <LiveAgentRow row={row} />
              </motion.div>
            ))}
            <div className="live-total">
              <span>{t("liveRunningNow")}</span>
              <strong>{t("liveAgents", { count: active.length })}</strong>
              <span>{t("liveEstimatedCost")}</span>
              <strong>{formatCost(totalCost)}</strong>
            </div>
          </div>
        ) : !connected ? (
          <div className="empty-state">
            <HugeiconsIcon icon={Activity01Icon} size={24} />
            <span>{t("liveDisconnected")}</span>
          </div>
        ) : hasPastActivity ? (
          <div className="empty-state">
            <HugeiconsIcon icon={Activity01Icon} size={24} />
            <span>{t("liveIdle")}</span>
          </div>
        ) : (
          <EmptyState />
        )}
      </Card>
    </motion.div>
  )
}

function LiveAgentRow({ row }: { row: LiveActiveAgent }) {
  const { t } = useTranslation()
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])
  const elapsed = Math.max(0, now - row.startedAt)
  const elapsedSeconds = elapsed / 1000
  const seconds = Math.floor(elapsedSeconds)
  const generationSeconds = (row.generationMs ?? 0) / 1000
  const averageOutputTokensPerSecond = generationSeconds > 0 ? row.tokens.output / generationSeconds : 0
  return (
    <div className="live-row">
      <span className="agent-badge">{liveAgentName(row.agent)}</span>
      <div className="live-body">
        <div className="live-meta">
          <strong>{liveAgentName(row.agent)}</strong>
          <span>{row.provider && row.model ? row.provider + "/" + row.model : t("liveModelPending")}</span>
        </div>
        <p className="live-snippet">{row.text ? (row.text.length > 240 ? `…${row.text.slice(-240)}` : row.text) : (row.tokens.output + row.tokens.reasoning > 0 ? t("liveGenerating") : t("liveStarting"))}</p>
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

/* ═══════════════════════════════════════════════════════
   ACTIVITY TABLE
   ═══════════════════════════════════════════════════════ */

const tableFeatureSet = tableFeatures({ columnSizingFeature })
const activityHelper = createColumnHelper<typeof tableFeatureSet, ActivityRow>()

type ActivityRange = "1" | "7" | "30" | "90" | "all"
type ActivitySortKey = "time" | "cost" | "tokens" | "duration"
type ActivityStatusGroup = "completed" | "tools" | "warning" | "error" | "unknown"

function activityTimestamp(row: ActivityRow): number {
  return row.completedAt ?? row.createdAt ?? 0
}

function activityDuration(row: ActivityRow): number {
  return row.createdAt && row.completedAt ? Math.max(0, row.completedAt - row.createdAt) : 0
}

function formatActivityDuration(value: number, t: TFunction): string {
  if (!value) return "—"
  if (value < 1_000) return `${Math.round(value)} ${t("activityMilliseconds")}`
  if (value < 60_000) return `${Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value / 1_000)} ${t("activitySeconds")}`
  return `${Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value / 60_000)} ${t("activityMinutes")}`
}

function activityStatusGroup(finish?: string): ActivityStatusGroup {
  const value = finish?.toLocaleLowerCase()
  if (!value) return "unknown"
  if (["stop", "end_turn", "completed", "success"].includes(value)) return "completed"
  if (["tool-calls", "tool_calls", "tool_use"].includes(value)) return "tools"
  if (["length", "max_tokens", "content-filter", "content_filter"].includes(value)) return "warning"
  if (["error", "failed", "cancelled", "canceled", "aborted"].includes(value)) return "error"
  return "unknown"
}

function activityStatusLabel(finish: string | undefined, t: TFunction): string {
  switch (activityStatusGroup(finish)) {
    case "completed": return t("activityStatusCompleted")
    case "tools": return t("activityStatusTools")
    case "warning": return finish === "length" || finish === "max_tokens" ? t("activityStatusLimit") : t("activityStatusFiltered")
    case "error": return t("activityStatusError")
    default: return finish || t("activityStatusUnknown")
  }
}

function activityPricingLabel(status: ActivityRow["pricingStatus"], t: TFunction): string {
  switch (status) {
    case "paid": return t("activityPricePaid")
    case "free": return t("activityPriceFree")
    case "subscription": return t("activityPriceSubscription")
    default: return t("activityPriceUnknown")
  }
}

function activityRowKey(row: ActivityRow): string {
  return `${row.sessionID}:${row.id}`
}

/**
 * Columns are built per language rather than once at module scope, so headers
 * follow a language switch. Callers memoize on the active language to keep the
 * column identities stable between renders.
 */
function buildActivityColumns(t: TFunction) {
  return activityHelper.columns([
    activityHelper.accessor((row) => activityTimestamp(row), {
      id: "time",
      header: t("colTime"),
      cell: ({ row }) => {
        const timestamp = activityTimestamp(row.original)
        if (!timestamp) return "—"
        const date = new Date(timestamp)
        return <span className="activity-time"><strong>{date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</strong><small>{date.toLocaleDateString()}</small></span>
      },
      size: 150,
    }),
    activityHelper.accessor("agent", {
      header: t("colAgent"),
      cell: ({ getValue }) => <span className="activity-agent">{getValue()?.replace("orch-", "") ?? t("rankingUnknown")}</span>,
      size: 125,
    }),
    activityHelper.accessor((row) => row.provider && row.model ? `${row.provider}/${row.model}` : "unknown", {
      id: "model",
      header: t("colModel"),
      cell: ({ row }) => <span className="activity-model"><strong>{row.original.model ?? t("rankingUnknown")}</strong><small>{row.original.provider ?? t("activityProviderUnknown")}</small></span>,
      size: 235,
    }),
    activityHelper.accessor((row) => splitTokens(row.tokens).total, {
      id: "tokens",
      header: t("colTokens"),
      cell: ({ row }) => {
        const tokens = splitTokens(row.original.tokens)
        return <span className="activity-tokens" title={`${t("activityInputTokens")}: ${formatNumber(tokens.input)} · ${t("activityOutputTokens")}: ${formatNumber(tokens.output)}`}><b>{formatNumber(tokens.input)} ↓</b><b>{formatNumber(tokens.output)} ↑</b></span>
      },
      size: 170,
    }),
    activityHelper.accessor("cost", {
      header: t("colCost"),
      cell: ({ row }) => <span className="activity-price"><strong>{formatCost(row.original.cost)}</strong><small className={cn(row.original.pricingStatus ? `price-${row.original.pricingStatus}` : "price-unknown")}>{activityPricingLabel(row.original.pricingStatus, t)}</small></span>,
      size: 145,
    }),
    activityHelper.accessor("finish", {
      header: t("colStatus"),
      cell: ({ row }) => {
        const group = activityStatusGroup(row.original.finish)
        return <span className={`activity-status status-${group}`} title={row.original.finish}>{activityStatusLabel(row.original.finish, t)}</span>
      },
      size: 150,
    }),
  ])
}

function ActivityPage() {
  const { t } = useTranslation()
  const selected = useUiStore((state) => state.selectedProject)
  const query = useSnapshot()
  if (selected === "global") return <ProjectRequired title={t("activityTitle")} />
  if (!query.data) return query.isLoading ? <Loading /> : <ErrorState error={query.error} />
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
    >
      <PageIntro kicker={t("activityKicker")} title={t("activityTitle")} text={t("activityText")} />
      {query.data.activityTruncated && (
        <div className="truncation-note">
          {t("activityTruncated", { shown: formatNumber(query.data.activity.length), total: formatNumber(query.data.activityTotal) })}
        </div>
      )}
      <ActivityExplorer data={query.data.activity} total={query.data.activityTotal} />
    </motion.div>
  )
}

function ActivityExplorer({ data, total }: { data: ActivityRow[]; total: number }) {
  const { t } = useTranslation()
  const [range, setRange] = useState<ActivityRange>("7")
  const [search, setSearch] = useState("")
  const [agent, setAgent] = useState("all")
  const [model, setModel] = useState("all")
  const [status, setStatus] = useState<ActivityStatusGroup | "all">("all")
  const [pricing, setPricing] = useState<"all" | "known" | "unknown">("all")
  const [sort, setSort] = useState<ActivitySortKey>("time")
  const [direction, setDirection] = useState<"asc" | "desc">("desc")
  const [selectedKey, setSelectedKey] = useState<string>()

  const agents = useMemo(() => [...new Set(data.map((row) => row.agent ?? "unknown"))].sort(), [data])
  const models = useMemo(() => [...new Set(data.map((row) => row.provider && row.model ? `${row.provider}/${row.model}` : "unknown"))].sort(), [data])
  const selectedRow = useMemo(() => data.find((row) => activityRowKey(row) === selectedKey), [data, selectedKey])

  const rows = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase()
    const cutoff = range === "all" ? 0 : Date.now() - Number(range) * 24 * 60 * 60 * 1_000
    const filtered = data.filter((row) => {
      const rowModel = row.provider && row.model ? `${row.provider}/${row.model}` : "unknown"
      const pricingKnown = row.pricingStatus !== undefined && row.pricingStatus !== "unknown"
      if (cutoff && activityTimestamp(row) < cutoff) return false
      if (agent !== "all" && (row.agent ?? "unknown") !== agent) return false
      if (model !== "all" && rowModel !== model) return false
      if (status !== "all" && activityStatusGroup(row.finish) !== status) return false
      if (pricing === "known" && !pricingKnown) return false
      if (pricing === "unknown" && pricingKnown) return false
      if (!needle) return true
      return `${row.sessionID} ${row.id} ${row.agent ?? ""} ${row.provider ?? ""} ${row.model ?? ""} ${row.finish ?? ""}`.toLocaleLowerCase().includes(needle)
    })
    return filtered.sort((a, b) => {
      const metric = (row: ActivityRow) => sort === "time" ? activityTimestamp(row) : sort === "cost" ? row.cost : sort === "tokens" ? splitTokens(row.tokens).total : activityDuration(row)
      const delta = metric(a) - metric(b)
      if (delta !== 0) return direction === "asc" ? delta : -delta
      return activityTimestamp(b) - activityTimestamp(a)
    })
  }, [agent, data, direction, model, pricing, range, search, sort, status])

  const summary = useMemo(() => rows.reduce((result, row) => ({
    cost: result.cost + row.cost,
    unknown: result.unknown + (!row.pricingStatus || row.pricingStatus === "unknown" ? 1 : 0),
    sessions: result.sessions.add(row.sessionID),
  }), { cost: 0, unknown: 0, sessions: new Set<string>() }), [rows])
  const filtersActive = Boolean(search || agent !== "all" || model !== "all" || status !== "all" || pricing !== "all" || range !== "7")

  const resetFilters = () => {
    setSearch("")
    setAgent("all")
    setModel("all")
    setStatus("all")
    setPricing("all")
    setRange("7")
    setSort("time")
    setDirection("desc")
  }

  return (
    <>
      <div className="activity-toolbar">
        <label className="ranking-search activity-search">
          <HugeiconsIcon icon={Search01Icon} size={17} aria-hidden="true" />
          <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("activitySearch")} />
        </label>
        <div className="ranking-range" role="group" aria-label={t("activityPeriod")}>
          {(["1", "7", "30", "90", "all"] as ActivityRange[]).map((value) => (
            <button type="button" key={value} className={cn(range === value && "active")} aria-pressed={range === value} onClick={() => setRange(value)}>
              {value === "1" ? t("activityToday") : value === "all" ? t("rankingAllTime") : t("rangeDays", { count: Number(value) })}
            </button>
          ))}
        </div>
      </div>
      <div className="activity-filters">
        <label><span>{t("colAgent")}</span><select value={agent} onChange={(event) => setAgent(event.target.value)}><option value="all">{t("activityAllAgents")}</option>{agents.map((value) => <option value={value} key={value}>{value.replace("orch-", "")}</option>)}</select></label>
        <label><span>{t("colModel")}</span><select value={model} onChange={(event) => setModel(event.target.value)}><option value="all">{t("activityAllModels")}</option>{models.map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
        <label><span>{t("colStatus")}</span><select value={status} onChange={(event) => setStatus(event.target.value as ActivityStatusGroup | "all")}><option value="all">{t("activityAllStatuses")}</option><option value="completed">{t("activityStatusCompleted")}</option><option value="tools">{t("activityStatusTools")}</option><option value="warning">{t("activityStatusWarning")}</option><option value="error">{t("activityStatusError")}</option><option value="unknown">{t("activityStatusUnknown")}</option></select></label>
        <label><span>{t("activityPricing")}</span><select value={pricing} onChange={(event) => setPricing(event.target.value as "all" | "known" | "unknown")}><option value="all">{t("activityAllPrices")}</option><option value="known">{t("activityKnownPrice")}</option><option value="unknown">{t("activityUnknownPrice")}</option></select></label>
        <label><span>{t("activitySort")}</span><select value={sort} onChange={(event) => setSort(event.target.value as ActivitySortKey)}><option value="time">{t("colTime")}</option><option value="cost">{t("colCost")}</option><option value="tokens">{t("colTokens")}</option><option value="duration">{t("activityDuration")}</option></select></label>
        <button type="button" className="activity-direction" onClick={() => setDirection((value) => value === "desc" ? "asc" : "desc")} aria-label={direction === "desc" ? t("activitySortDescending") : t("activitySortAscending")} title={direction === "desc" ? t("activitySortDescending") : t("activitySortAscending")}>
          <HugeiconsIcon icon={ArrowUpDownIcon} size={16} aria-hidden="true" /><span>{direction === "desc" ? "↓" : "↑"}</span>
        </button>
      </div>
      <div className="activity-summary">
        <div><span>{t("calls")}</span><strong>{formatNumber(rows.length)}</strong><small>{t("activityOfTotal", { total: formatNumber(total) })}</small></div>
        <div><span>{t("sessions")}</span><strong>{formatNumber(summary.sessions.size)}</strong><small>{t("activityInSelection")}</small></div>
        <div><span>{t("cost")}</span><strong>{formatCost(summary.cost)}</strong><small>{rows.length ? t("activityAverageCost", { value: formatCost(summary.cost / rows.length) }) : t("activityInSelection")}</small></div>
        <div className={cn(summary.unknown > 0 && "has-warning")}><span>{t("activityUnknownPrice")}</span><strong>{formatNumber(summary.unknown)}</strong><small>{t("activityNeedsAttention")}</small></div>
      </div>
      <div className="activity-results-line">
        <span>{t("activityResults", { count: formatNumber(rows.length) })}</span>
        {filtersActive && <button type="button" onClick={resetFilters}>{t("activityResetFilters")}</button>}
      </div>
      <Card className="table-card activity-table-card">
        {rows.length || !data.length ? (
          <VirtualActivityTable data={rows} selectedKey={selectedKey} onSelect={(row) => setSelectedKey(activityRowKey(row))} />
        ) : (
          <div className="ranking-empty-search activity-empty-search">
            <HugeiconsIcon icon={Search01Icon} size={22} />
            <span>{t("activityNoMatches")}</span>
            <button type="button" onClick={resetFilters}>{t("activityResetFilters")}</button>
          </div>
        )}
      </Card>
      <AnimatePresence>
        {selectedRow && <ActivityDetail row={selectedRow} onClose={() => setSelectedKey(undefined)} />}
      </AnimatePresence>
    </>
  )
}

function ActivityDetail({ row, onClose }: { row: ActivityRow; onClose: () => void }) {
  const { t } = useTranslation()
  const tokens = splitTokens(row.tokens)
  const status = activityStatusGroup(row.finish)
  return (
    <motion.div className="activity-detail-backdrop" role="presentation" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.aside className="activity-detail" role="dialog" aria-modal="true" aria-labelledby="activity-detail-title" initial={{ x: 48, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 48, opacity: 0 }} transition={{ type: "spring", stiffness: 340, damping: 32 }} onClick={(event) => event.stopPropagation()}>
        <div className="activity-detail-head">
          <div><span>{t("activityCallDetails")}</span><h2 id="activity-detail-title">{row.model ?? t("rankingUnknown")}</h2></div>
          <button type="button" onClick={onClose} aria-label={t("close")}>×</button>
        </div>
        <div className="activity-detail-hero">
          <span className={`activity-status status-${status}`}>{activityStatusLabel(row.finish, t)}</span>
          <strong>{formatCost(row.cost)}</strong>
          <small>{activityPricingLabel(row.pricingStatus, t)}</small>
        </div>
        <dl className="activity-detail-grid">
          <div><dt>{t("colAgent")}</dt><dd>{row.agent?.replace("orch-", "") ?? t("rankingUnknown")}</dd></div>
          <div><dt>{t("activityProvider")}</dt><dd>{row.provider ?? t("rankingUnknown")}</dd></div>
          <div><dt>{t("activityStarted")}</dt><dd>{row.createdAt ? new Date(row.createdAt).toLocaleString() : "—"}</dd></div>
          <div><dt>{t("activityCompleted")}</dt><dd>{row.completedAt ? new Date(row.completedAt).toLocaleString() : "—"}</dd></div>
          <div><dt>{t("activityDuration")}</dt><dd>{formatActivityDuration(activityDuration(row), t)}</dd></div>
          <div><dt>{t("activityFinishReason")}</dt><dd><code>{row.finish ?? "—"}</code></dd></div>
        </dl>
        <section className="activity-token-detail">
          <h3>{t("activityTokenBreakdown")}</h3>
          <div><span>{t("activityInputTokens")}</span><strong>{formatNumber(tokens.input)}</strong></div>
          <div><span>{t("activityOutputTokens")}</span><strong>{formatNumber(tokens.output)}</strong></div>
          <div><span>{t("activityReasoningTokens")}</span><strong>{formatNumber(row.tokens.reasoning)}</strong></div>
          <div><span>{t("activityCacheRead")}</span><strong>{formatNumber(row.tokens.cache.read)}</strong></div>
          <div><span>{t("activityCacheWrite")}</span><strong>{formatNumber(row.tokens.cache.write)}</strong></div>
        </section>
        <dl className="activity-identifiers">
          <div><dt>{t("activitySessionId")}</dt><dd><code>{row.sessionID}</code></dd></div>
          <div><dt>{t("activityCallId")}</dt><dd><code>{row.id}</code></dd></div>
        </dl>
        <p className="activity-privacy">{t("activityPrivacyNote")}</p>
      </motion.aside>
    </motion.div>
  )
}

function VirtualActivityTable({ data, selectedKey, onSelect }: { data: ActivityRow[]; selectedKey?: string; onSelect: (row: ActivityRow) => void }) {
  const { t, i18n: instance } = useTranslation()
  // Rebuild only when the language changes, not on every render.
  const columns = useMemo(() => buildActivityColumns(t), [instance.language, t])
  const table = useTable({ features: tableFeatureSet, columns, data })
  const rows = table.getRowModel().rows
  const parent = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => parent.current, estimateSize: () => 64, overscan: 8 })
  if (!rows.length) return <EmptyState />
  return (
    <div className="virtual-table">
      <div ref={parent} className="table-scroll">
        <div className="table-inner">
          <div className="table-head">
            {table.getHeaderGroups()[0]?.headers.map((header) => (
              <div key={header.id} style={{ width: header.getSize() }}>
                {header.isPlaceholder ? null : <table.FlexRender header={header} />}
              </div>
            ))}
          </div>
          <div className="table-body" style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index]
              if (!row) return null
              const key = activityRowKey(row.original)
              return (
                <div
                  className={cn("table-row", selectedKey === key && "selected")}
                  key={key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  style={{ transform: `translateY(${item.start}px)` }}
                  role="button"
                  tabIndex={0}
                  aria-label={t("activityOpenCall", { model: row.original.model ?? t("rankingUnknown") })}
                  onClick={() => onSelect(row.original)}
                  onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(row.original) } }}
                >
                  {row.getAllCells().map((cell) => (
                    <div key={cell.id} data-column={cell.column.id} data-label={typeof cell.column.columnDef.header === "string" ? cell.column.columnDef.header : ""} style={{ width: cell.column.getSize() }}>
                      <table.FlexRender cell={cell} />
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════
   RANKING PAGE
   ═══════════════════════════════════════════════════════ */

type RankingSortKey = "calls" | "tokens" | "cost"
type RankingSortDirection = "asc" | "desc"

function rankingMetric(row: AggregateRow, key: RankingSortKey): number {
  if (key === "calls") return row.calls
  if (key === "tokens") return totalTokens(row)
  return row.cost
}

function modelIdentity(id: string): { provider?: string; name: string } {
  if (id === "unknown") return { name: id }
  const separator = id.indexOf("/")
  return separator > 0 ? { provider: id.slice(0, separator), name: id.slice(separator + 1) } : { name: id }
}

function humanizeAgentId(id: string): string {
  return id
    .replace(/^orch-/, "")
    .split("-")
    .map((part) => part ? part[0].toUpperCase() + part.slice(1) : part)
    .join(" ")
}

function RankingPage({ kind }: { kind: "models" | "agents" }) {
  const { t } = useTranslation()
  const [range, setRange] = useState("all")
  const [search, setSearch] = useState("")
  const [sort, setSort] = useState<{ key: RankingSortKey; direction: RankingSortDirection }>({ key: "cost", direction: "desc" })
  const query = useDashboardData(range)
  const sourceRows = query.data?.[kind] ?? EMPTY
  const title = kind === "models" ? t("modelsTitle") : t("agentsTitle")
  const text = kind === "models" ? t("modelsText") : t("agentsText")
  const sortLabel = sort.key === "calls" ? t("calls") : sort.key === "tokens" ? t("tokens") : t("cost")

  const rows = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase()
    const filtered = needle
      ? sourceRows.filter((row) => {
          const agent = kind === "agents" ? AGENTS.find((item) => item.id === row.id) : undefined
          const role = agent ? t(agent.roleKey) : ""
          return `${row.id} ${agent?.name ?? ""} ${role}`.toLocaleLowerCase().includes(needle)
        })
      : [...sourceRows]
    return filtered.sort((a, b) => {
      const delta = rankingMetric(a, sort.key) - rankingMetric(b, sort.key)
      if (delta !== 0) return sort.direction === "asc" ? delta : -delta
      return b.cost - a.cost || b.tokens.output - a.tokens.output || a.id.localeCompare(b.id)
    })
  }, [kind, search, sort, sourceRows, t])

  const summary = useMemo(() => rows.reduce(
    (total, row) => ({ calls: total.calls + row.calls, cost: total.cost + row.cost }),
    { calls: 0, cost: 0 },
  ), [rows])
  const maxMetric = useMemo(() => rows.reduce((max, row) => Math.max(max, rankingMetric(row, sort.key)), 0), [rows, sort.key])
  const metricTotal = useMemo(() => rows.reduce((total, row) => total + rankingMetric(row, sort.key), 0), [rows, sort.key])
  const topThreeShare = useMemo(() => {
    if (metricTotal <= 0) return 0
    const top = [...rows].sort((a, b) => rankingMetric(b, sort.key) - rankingMetric(a, sort.key)).slice(0, 3)
    return top.reduce((total, row) => total + rankingMetric(row, sort.key), 0) / metricTotal
  }, [metricTotal, rows, sort.key])

  const changeSort = (key: RankingSortKey) => {
    setSort((current) => current.key === key
      ? { key, direction: current.direction === "desc" ? "asc" : "desc" }
      : { key, direction: "desc" })
  }

  const formatRankingMetric = (row: AggregateRow): string => {
    if (sort.key === "cost") return formatCost(row.cost)
    return formatNumber(rankingMetric(row, sort.key))
  }

  if (query.isLoading) return <Loading />
  if (!query.data) return <ErrorState error={query.error} />

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
    >
      <PageIntro kicker={kind.toUpperCase()} title={title} text={text} />
      <div className="ranking-toolbar">
        <label className="ranking-search">
          <HugeiconsIcon icon={Search01Icon} size={17} aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={kind === "models" ? t("rankingSearchModels") : t("rankingSearchAgents")}
          />
        </label>
        <div className="ranking-range" role="group" aria-label={t("rankingPeriod")}>
          {["7", "30", "90", "all"].map((value) => (
            <button
              type="button"
              key={value}
              className={cn(range === value && "active")}
              aria-pressed={range === value}
              onClick={() => setRange(value)}
            >
              {value === "all" ? t("rankingAllTime") : t("rangeDays", { count: Number(value) })}
            </button>
          ))}
        </div>
      </div>
      <div className="ranking-summary">
        <div><span>{t("rankingPositions")}</span><strong>{formatNumber(rows.length)}</strong></div>
        <div><span>{t("calls")}</span><strong>{formatNumber(summary.calls)}</strong></div>
        <div><span>{t("cost")}</span><strong>{formatCost(summary.cost)}</strong></div>
        <div><span>{t("rankingTopThree")}</span><strong>{Math.round(topThreeShare * 100)}%</strong><small>{sortLabel}</small></div>
      </div>
      <Card className="ranking-card ranking-card-upgraded">
        {rows.length ? (
          <>
            <div className="ranking-head" role="row">
              <span>#</span>
              <span>{kind === "models" ? t("rankingModel") : t("rankingAgent")}</span>
              {(["calls", "tokens", "cost"] as const).map((key) => {
                const label = key === "calls" ? t("calls") : key === "tokens" ? t("tokens") : t("cost")
                const active = sort.key === key
                return (
                  <button
                    type="button"
                    key={key}
                    className={cn(active && "active")}
                    onClick={() => changeSort(key)}
                    aria-label={t("rankingSortBy", { metric: label })}
                  >
                    {label}
                    {active ? <span aria-hidden="true">{sort.direction === "desc" ? "↓" : "↑"}</span> : <HugeiconsIcon icon={ArrowUpDownIcon} size={12} aria-hidden="true" />}
                  </button>
                )
              })}
            </div>
            <div className="ranking-list ranking-list-upgraded">
              {rows.map((row, index) => {
                const model = modelIdentity(row.id)
                const agent = kind === "agents" ? AGENTS.find((item) => item.id === row.id) : undefined
                const name = kind === "models" ? model.name : agent?.name ?? humanizeAgentId(row.id)
                const secondary = kind === "models"
                  ? model.provider
                  : agent ? t(agent.roleKey) : t("rankingAgentRoleFallback")
                const unknown = row.id === "unknown"
                return (
                  <motion.div
                    initial={{ opacity: 0, x: -12 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: Math.min(index, 12) * 0.025 }}
                    key={row.id}
                  >
                    <span className="rank">{String(index + 1).padStart(2, "0")}</span>
                    <div className="ranking-identity">
                      <div className="ranking-name">
                        {kind === "models" && model.provider && <span className="provider-badge">{model.provider}</span>}
                        <strong>{unknown ? t("rankingUnknown") : name}</strong>
                      </div>
                      {secondary && <small>{secondary}</small>}
                      <div className="usage-bar" title={`${sortLabel}: ${formatRankingMetric(row)}`}>
                        <span style={{ width: `${maxMetric > 0 ? Math.max(3, (rankingMetric(row, sort.key) / maxMetric) * 100) : 3}%` }} />
                      </div>
                      <span className="ranking-bar-caption">{sortLabel} · {formatRankingMetric(row)}</span>
                    </div>
                    <span className="ranking-metric metric-calls"><small>{t("calls")}</small><b>{formatNumber(row.calls)}</b></span>
                    <span className="ranking-metric metric-tokens" title={formatTokensInOutCompact(row.tokens)}><small>{t("tokens")}</small><b>{formatNumber(totalTokens(row))}</b></span>
                    <span className="ranking-metric metric-cost"><small>{t("cost")}</small><b>{formatCost(row.cost)}</b></span>
                  </motion.div>
                )
              })}
            </div>
          </>
        ) : sourceRows.length ? (
          <div className="ranking-empty-search">
            <HugeiconsIcon icon={Search01Icon} size={22} />
            <span>{t("rankingNoMatches")}</span>
          </div>
        ) : (
          <EmptyState />
        )}
      </Card>
    </motion.div>
  )
}

/* ═══════════════════════════════════════════════════════
   SETTINGS PAGE
   ═══════════════════════════════════════════════════════ */

// Agent ids and display names are product identifiers and stay untranslated;
// roles and groups are prose and resolve through the locale catalogue.
const AGENTS: ReadonlyArray<{ id: string; name: string; roleKey: TranslationKey; groupKey: TranslationKey }> = [
  { id: "orch-lead", name: "Lead", roleKey: "roleLead", groupKey: "groupCore" },
  { id: "orch-judge", name: "Judge", roleKey: "roleJudge", groupKey: "groupCore" },
  { id: "orch-repo", name: "Repository", roleKey: "roleRepo", groupKey: "groupDevelopment" },
  { id: "orch-tests", name: "Tests", roleKey: "roleTests", groupKey: "groupDevelopment" },
  { id: "orch-critic", name: "Critic", roleKey: "roleCritic", groupKey: "groupDevelopment" },
  { id: "orch-docs", name: "Docs", roleKey: "roleDocs", groupKey: "groupResearch" },
  { id: "orch-research", name: "Research", roleKey: "roleResearch", groupKey: "groupResearch" },
  { id: "orch-security", name: "Security", roleKey: "roleSecurity", groupKey: "groupResearch" },
  { id: "orch-visual-reference", name: "Visual Reference", roleKey: "roleVisualReference", groupKey: "groupVisual" },
  { id: "orch-visual-generate", name: "Visual Generate", roleKey: "roleVisualGenerate", groupKey: "groupVisual" },
  { id: "orch-visual-review", name: "Visual Review", roleKey: "roleVisualReview", groupKey: "groupVisual" },
  { id: "orch-editor", name: "Editor", roleKey: "roleEditor", groupKey: "groupDevelopment" },
  { id: "orch-integrator", name: "Integrator", roleKey: "roleIntegrator", groupKey: "groupDevelopment" },
  { id: "orch-merge", name: "Merge", roleKey: "roleMerge", groupKey: "groupDevelopment" },
]

const BUDGET_LABEL_KEYS: Record<"eco" | "balanced" | "quality" | "ebobo", TranslationKey> = {
  eco: "budgetEco",
  balanced: "budgetBalanced",
  quality: "budgetQuality",
  ebobo: "budgetEbobo",
}

type OrchestrationNumberField = "parallelWorkers" | "parallelEditors" | "maxWorkers" | "maxDelegationDepth" | "maxPremiumCallsPerTask" | "confidenceThreshold"

const ORCHESTRATION_FIELDS: Array<{
  name: OrchestrationNumberField
  labelKey: TranslationKey
  hintKey: TranslationKey
  min: number
  max: number
  step: number
}> = [
  { name: "parallelWorkers", labelKey: "fieldParallelWorkers", hintKey: "fieldParallelWorkersHint", min: 1, max: 8, step: 1 },
  { name: "parallelEditors", labelKey: "fieldParallelEditors", hintKey: "fieldParallelEditorsHint", min: 0, max: 8, step: 1 },
  { name: "maxWorkers", labelKey: "fieldMaxWorkers", hintKey: "fieldMaxWorkersHint", min: 1, max: 8, step: 1 },
  { name: "maxDelegationDepth", labelKey: "fieldMaxDelegationDepth", hintKey: "fieldMaxDelegationDepthHint", min: 1, max: 4, step: 1 },
  { name: "maxPremiumCallsPerTask", labelKey: "fieldMaxPremiumCalls", hintKey: "fieldMaxPremiumCallsHint", min: 0, max: 24, step: 1 },
  { name: "confidenceThreshold", labelKey: "fieldConfidenceThreshold", hintKey: "fieldConfidenceThresholdHint", min: 0, max: 1, step: 0.01 },
]

const SETTINGS_NAV_ITEMS: Array<{ id: string; labelKey: TranslationKey }> = [
  { id: "settings-budget", labelKey: "budgetTitle" },
  { id: "settings-models", labelKey: "modelsAssignTitle" },
  { id: "settings-orchestration", labelKey: "orchestrationTitle" },
  { id: "settings-pricing", labelKey: "pricingTitle" },
  { id: "settings-telemetry", labelKey: "telemetryTitle" },
  { id: "settings-danger", labelKey: "dangerZoneTitle" },
]

const settingsSchema = z.object({
  budget: z.enum(["eco", "balanced", "quality", "ebobo"]),
  models: z.object({
    strategy: z.enum(["auto", "manual"]),
    agents: z.record(z.string(), z.string()),
    fallback: z.object({
      enabled: z.boolean(),
      maxRetries: z.number().int().min(0).max(5),
      agents: z.record(z.string(), z.array(z.string()).max(5)),
    }),
  }),
  telemetry: z.object({ enabled: z.boolean(), storeTexts: z.boolean(), anomalySigma: z.number().min(0.5).max(6) }),
  orchestration: z.object({ parallelWorkers: z.number().int().min(1).max(8), parallelEditors: z.number().int().min(0).max(8), maxWorkers: z.number().int().min(1).max(8), maxDelegationDepth: z.number().int().min(1).max(4), premiumEscalation: z.boolean(), maxPremiumCallsPerTask: z.number().int().min(0).max(24), confidenceThreshold: z.number().min(0).max(1), exposeWorkers: z.boolean(), worktreeRoot: z.string().optional() }),
  permissions: z.object({ autoAcceptAll: z.boolean() }),
  superpowers: z.object({ compatibility: z.boolean(), injectPrimaryHint: z.boolean() }),
  pricing: z.object({ endpoint: z.string().optional(), refreshIntervalHours: z.number().int().min(0).max(2160), estimate: z.boolean(), warnThresholdUSD: z.number().min(0), openrouter: z.object({ enabled: z.boolean(), ttlHours: z.number().int().min(1).max(720) }), aliases: z.array(z.object({ canonical: z.string(), aliases: z.array(z.string()) })) }),
})

/**
 * Flatten react-hook-form's nested error object into "path: message" lines so
 * a failed validation is visible instead of silently swallowing the submit.
 */
function flattenErrors(errors: Record<string, unknown>, prefix = ""): string[] {
  const lines: string[] = []
  for (const [key, value] of Object.entries(errors)) {
    if (!value || typeof value !== "object") continue
    const field = prefix ? `${prefix}.${key}` : key
    const message = (value as { message?: unknown }).message
    if (typeof message === "string") lines.push(`${field}: ${message}`)
    else lines.push(...flattenErrors(value as Record<string, unknown>, field))
  }
  return lines
}

function SettingsFieldHint({ id, text, error }: { id: string; text: string; error?: unknown }) {
  const message = typeof (error as { message?: unknown } | undefined)?.message === "string"
    ? (error as { message: string }).message
    : undefined
  return <small id={id} className={cn("settings-field-hint", message && "error")}>{message ?? text}</small>
}

function settingsFormDefaults(config: DashboardConfig): DashboardConfig {
  return {
    ...config,
    models: {
      ...config.models,
      agents: {
        ...Object.fromEntries(AGENTS.map((agent) => [agent.id, ""])),
        ...config.models.agents,
      },
      fallback: {
        ...config.models.fallback,
        agents: {
          ...Object.fromEntries(AGENTS.map((agent) => [agent.id, [] as string[]])),
          ...config.models.fallback.agents,
        },
      },
    },
  }
}

function SettingsPage() {
  const { t } = useTranslation()
  const query = useSnapshot()
  const selected = useUiStore((state) => state.selectedProject)
  const client = useQueryClient()
  const form = useForm<DashboardConfig>({ resolver: zodResolver(settingsSchema), defaultValues: query.data ? settingsFormDefaults(query.data.config) : undefined })
  const resetState = useRef<SnapshotResetState>({ initialized: false, appliedEpoch: 0 })
  const saveEpoch = useRef(0)
  useEffect(() => {
    if (!query.data) return
    const decision = snapshotResetDecision(resetState.current, saveEpoch.current)
    if (decision.reset) {
      resetState.current = decision.next
      form.reset(settingsFormDefaults(query.data.config))
    }
  }, [query.data, form])
  const save = useMutation({
    mutationFn: (config: DashboardConfig) => api.saveConfig(config, selected),
    onSuccess: async () => {
      saveEpoch.current += 1
      await client.invalidateQueries({ queryKey: ["snapshot"] })
    },
  })
  const modelStrategy = useWatch({ control: form.control, name: "models.strategy" })
  const modelAgents = useWatch({ control: form.control, name: "models.agents" })
  const fallbackEnabled = useWatch({ control: form.control, name: "models.fallback.enabled" })
  const fallbackAgents = useWatch({ control: form.control, name: "models.fallback.agents" })
  const premiumEscalation = useWatch({ control: form.control, name: "orchestration.premiumEscalation" })
  const openRouterEnabled = useWatch({ control: form.control, name: "pricing.openrouter.enabled" })
  const telemetryEnabled = useWatch({ control: form.control, name: "telemetry.enabled" })
  const isDirty = Object.keys(form.formState.dirtyFields).length > 0
  const fieldErrors = flattenErrors(form.formState.errors)
  if (selected === "global") return <ProjectRequired title={t("settingsTitle")} />
  if (!query.data) return query.isLoading ? <Loading /> : <ErrorState error={query.error} />
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
    >
      <PageIntro kicker={t("settingsKicker")} title={t("settingsTitle")} text={t("settingsText")} />
      <nav className="settings-nav" aria-label={t("settingsNavLabel")}>
        {SETTINGS_NAV_ITEMS.map((item) => <a href={`#${item.id}`} key={item.id}>{t(item.labelKey)}</a>)}
      </nav>
      <form onSubmit={form.handleSubmit((value) => save.mutate(value))} className="settings-stack">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
        >
          <Card className="settings-card settings-section" id="settings-budget">
            <div className="setting-title">
              <div>
                <h2>{t("budgetTitle")}</h2>
                <p>{t("budgetText")}</p>
              </div>
            </div>
            <Controller
              name="budget"
              control={form.control}
              render={({ field }) => (
                <div className="budget-grid" role="radiogroup" aria-label={t("budgetTitle")}>
                  {(["eco", "balanced", "quality", "ebobo"] as const).map((mode, index) => (
                    <motion.button
                      type="button"
                      role="radio"
                      aria-checked={field.value === mode}
                      key={mode}
                      className={cn("budget-option", field.value === mode && "selected")}
                      onClick={() => field.onChange(mode)}
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.1 + index * 0.05 }}
                    >
                      <strong>{mode}</strong>
                      <span>{t(BUDGET_LABEL_KEYS[mode])}</span>
                    </motion.button>
                  ))}
                </div>
              )}
            />
          </Card>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          <Card className="settings-card model-settings settings-section" id="settings-models">
            <div className="setting-title">
              <div>
                <h2>{t("modelsAssignTitle")}</h2>
                <p>{t("modelsAssignText")}</p>
              </div>
              <label className="strategy-select">
                <span>{t("strategyLabel")}</span>
                <select aria-label={t("strategyLabel")} {...form.register("models.strategy")}>
                  <option value="auto">{t("strategyAuto")}</option>
                  <option value="manual">{t("strategyManual")}</option>
                </select>
              </label>
            </div>
            {query.data.availableModels.length === 0 && (
              <div className="model-empty">
                {t("modelsEmpty")} <code>opencode models</code>.
              </div>
            )}
            {modelStrategy === "auto" && (
              <div className="settings-notice" role="status">
                <strong>{t("strategyAuto")}</strong>
                <span>{t("modelsAutoNotice")}</span>
              </div>
            )}
            <div className="fallback-policy">
              <label className="check-setting">
                <span><strong>{t("modelFallbackEnabled")}</strong><small>{t("modelFallbackEnabledHint")}</small></span>
                <Controller
                  name="models.fallback.enabled"
                  control={form.control}
                  render={({ field }) => <Switch aria-label={t("modelFallbackEnabled")} checked={field.value} onCheckedChange={field.onChange} />}
                />
              </label>
              <label className={cn(!fallbackEnabled && "disabled-setting")}>
                <span>{t("modelFallbackRetries")}</span>
                <input
                  type="number"
                  min="0"
                  max="5"
                  aria-describedby="model-fallback-retries-hint"
                  {...form.register("models.fallback.maxRetries", { valueAsNumber: true })}
                  disabled={!fallbackEnabled}
                />
                <SettingsFieldHint id="model-fallback-retries-hint" text={t("modelFallbackRetriesHint")} error={form.formState.errors.models?.fallback?.maxRetries} />
              </label>
            </div>
              <div className="agent-model-groups" hidden={modelStrategy === "auto"}>
                {(["groupCore", "groupDevelopment", "groupResearch", "groupVisual"] as TranslationKey[]).map((groupKey) => {
                  const agents = AGENTS.filter((agent) => agent.groupKey === groupKey)
                  return (
                    <details className="agent-model-group" key={groupKey}>
                      <summary>
                        <span>{t(groupKey)}</span>
                        <small>{t("modelsGroupCount", { count: agents.length })}</small>
                      </summary>
                      <div className="agent-model-list">
                        {agents.map((agent, index) => (
                          <motion.div
                            className="agent-model-row"
                            key={agent.id}
                            initial={{ opacity: 0, x: -10 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ delay: index * 0.03 }}
                          >
                            <div className="agent-identity">
                              <strong>{agent.name}</strong>
                              <span>{t(agent.roleKey)}</span>
                              <small>{agent.id}</small>
                            </div>
                            <div className="agent-model-controls">
                              <Controller
                                name={`models.agents.${agent.id}`}
                                control={form.control}
                                render={({ field }) => (
                                  <ModelCombobox
                                    value={field.value ?? ""}
                                    options={query.data.availableModels}
                                    onChange={field.onChange}
                                    ariaLabel={t("modelForAgent", { name: agent.name })}
                                    automaticLabel={t("modelAutomatic")}
                                    placeholder={t("modelSearchPlaceholder")}
                                    noResultsLabel={t("modelSearchEmpty")}
                                    unavailableLabel={t("modelUnavailable")}
                                    allowAutomatic
                                    excluded={fallbackAgents?.[agent.id] ?? []}
                                  />
                                )}
                              />
                              {fallbackEnabled && (() => {
                                const chain = fallbackAgents?.[agent.id] ?? []
                                const primary = modelAgents?.[agent.id] ?? ""
                                return (
                                  <div className="fallback-chain">
                                    <span className="fallback-chain-label">{t("modelFallbackChain")}</span>
                                    {chain.map((model, fallbackIndex) => (
                                      <div className="fallback-model-row" key={`${agent.id}-${fallbackIndex}`}>
                                        <span className="fallback-position">{fallbackIndex + 1}</span>
                                        <ModelCombobox
                                          value={model}
                                          options={query.data.availableModels}
                                          onChange={(next) => {
                                            const updated = [...chain]
                                            updated[fallbackIndex] = next
                                            form.setValue(`models.fallback.agents.${agent.id}`, updated, { shouldDirty: true, shouldValidate: true })
                                          }}
                                          ariaLabel={t("modelFallbackForAgent", { name: agent.name, position: fallbackIndex + 1 })}
                                          automaticLabel={t("modelFallbackAdd")}
                                          placeholder={t("modelSearchPlaceholder")}
                                          noResultsLabel={t("modelSearchEmpty")}
                                          unavailableLabel={t("modelUnavailable")}
                                          excluded={[primary, ...chain.filter((_, index) => index !== fallbackIndex)]}
                                        />
                                        <div className="fallback-actions">
                                          <button
                                            type="button"
                                            className="fallback-icon-button"
                                            aria-label={t("modelFallbackMoveUp")}
                                            disabled={fallbackIndex === 0}
                                            onClick={() => {
                                              const updated = [...chain]
                                              ;[updated[fallbackIndex - 1], updated[fallbackIndex]] = [updated[fallbackIndex], updated[fallbackIndex - 1]]
                                              form.setValue(`models.fallback.agents.${agent.id}`, updated, { shouldDirty: true, shouldValidate: true })
                                            }}
                                          >↑</button>
                                          <button
                                            type="button"
                                            className="fallback-icon-button"
                                            aria-label={t("modelFallbackMoveDown")}
                                            disabled={fallbackIndex === chain.length - 1}
                                            onClick={() => {
                                              const updated = [...chain]
                                              ;[updated[fallbackIndex], updated[fallbackIndex + 1]] = [updated[fallbackIndex + 1], updated[fallbackIndex]]
                                              form.setValue(`models.fallback.agents.${agent.id}`, updated, { shouldDirty: true, shouldValidate: true })
                                            }}
                                          >↓</button>
                                          <button
                                            type="button"
                                            className="fallback-icon-button"
                                            aria-label={t("modelFallbackRemove")}
                                            onClick={() => form.setValue(`models.fallback.agents.${agent.id}`, chain.filter((_, index) => index !== fallbackIndex), { shouldDirty: true, shouldValidate: true })}
                                          >×</button>
                                        </div>
                                      </div>
                                    ))}
                                    {chain.length < 5 && (
                                      <div className="fallback-model-row fallback-new">
                                        <span className="fallback-position">+</span>
                                        <ModelCombobox
                                          value=""
                                          options={query.data.availableModels}
                                          onChange={(model) => form.setValue(`models.fallback.agents.${agent.id}`, [...chain, model], { shouldDirty: true, shouldValidate: true })}
                                          ariaLabel={t("modelFallbackAddForAgent", { name: agent.name })}
                                          automaticLabel={t("modelFallbackAdd")}
                                          placeholder={t("modelSearchPlaceholder")}
                                          noResultsLabel={t("modelSearchEmpty")}
                                          unavailableLabel={t("modelUnavailable")}
                                          excluded={[primary, ...chain]}
                                        />
                                      </div>
                                    )}
                                  </div>
                                )
                              })()}
                            </div>
                          </motion.div>
                        ))}
                      </div>
                    </details>
                  )
                })}
              </div>
          </Card>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
        >
          <Card className="settings-card settings-section" id="settings-orchestration">
            <div className="setting-title">
              <div>
                <h2>{t("orchestrationTitle")}</h2>
                <p>{t("orchestrationText")}</p>
              </div>
            </div>
            <div className="settings-fields">
              {ORCHESTRATION_FIELDS.map(({ name, labelKey, hintKey, min, max, step }) => {
                const hintId = `orchestration-${name}-hint`
                const error = form.formState.errors.orchestration?.[name]
                const disabled = name === "maxPremiumCallsPerTask" && !premiumEscalation
                return (
                <label key={name} className={cn(disabled && "disabled-setting")}>
                  <span>{t(labelKey)}</span>
                  <input
                    type="number"
                    min={min}
                    max={max}
                    step={step}
                    {...form.register(`orchestration.${name}`, { valueAsNumber: true })}
                    disabled={disabled}
                    aria-invalid={Boolean(error)}
                    aria-describedby={hintId}
                  />
                  <SettingsFieldHint id={hintId} text={t(hintKey)} error={error} />
                </label>
                )
              })}
              <label>
                <span>{t("fieldWorktreeRoot")}</span>
                <input aria-describedby="worktree-root-hint" {...form.register("orchestration.worktreeRoot")} placeholder={t("placeholderUnset")} />
                <SettingsFieldHint id="worktree-root-hint" text={t("fieldWorktreeRootHint")} />
              </label>
              <label className="check-setting">
                <span><strong>{t("fieldPremiumEscalation")}</strong><small>{t("fieldPremiumEscalationHint")}</small></span>
                <Controller
                  name="orchestration.premiumEscalation"
                  control={form.control}
                  defaultValue={query.data.config.orchestration.premiumEscalation}
                  render={({ field }) => <Switch aria-label={t("fieldPremiumEscalation")} checked={field.value} onCheckedChange={field.onChange} />}
                />
              </label>
              <label className="check-setting">
                <span><strong>{t("fieldExposeWorkers")}</strong><small>{t("fieldExposeWorkersHint")}</small></span>
                <Controller
                  name="orchestration.exposeWorkers"
                  control={form.control}
                  defaultValue={query.data.config.orchestration.exposeWorkers}
                  render={({ field }) => <Switch aria-label={t("fieldExposeWorkers")} checked={field.value} onCheckedChange={field.onChange} />}
                />
              </label>
            </div>
          </Card>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
        >
          <Card className="settings-card settings-section" id="settings-pricing">
            <div className="setting-title">
              <div>
                <h2>{t("pricingTitle")}</h2>
                <p>{t("pricingText")}</p>
              </div>
            </div>
            <div className="settings-fields">
              <label>
                <span>{t("fieldEndpoint")}</span>
                <input aria-describedby="pricing-endpoint-hint" {...form.register("pricing.endpoint")} placeholder={t("placeholderUnset")} />
                <SettingsFieldHint id="pricing-endpoint-hint" text={t("fieldEndpointHint")} />
              </label>
              <label>
                <span>{t("fieldWarnAboveUsd")}</span>
                <input type="number" min="0" step="0.01" aria-describedby="pricing-warning-hint" {...form.register("pricing.warnThresholdUSD", { valueAsNumber: true })} />
                <SettingsFieldHint id="pricing-warning-hint" text={t("fieldWarnAboveUsdHint")} error={form.formState.errors.pricing?.warnThresholdUSD} />
              </label>
              <label>
                <span>{t("fieldPriceRefreshHours")}</span>
                <input type="number" min="0" max="2160" aria-describedby="pricing-refresh-hint" {...form.register("pricing.refreshIntervalHours", { valueAsNumber: true })} />
                <SettingsFieldHint id="pricing-refresh-hint" text={t("fieldPriceRefreshHoursHint")} error={form.formState.errors.pricing?.refreshIntervalHours} />
              </label>
              <label className="check-setting">
                <span><strong>{t("fieldEstimateCost")}</strong><small>{t("fieldEstimateCostHint")}</small></span>
                <Controller
                  name="pricing.estimate"
                  control={form.control}
                  defaultValue={query.data.config.pricing.estimate}
                  render={({ field }) => <Switch aria-label={t("fieldEstimateCost")} checked={field.value} onCheckedChange={field.onChange} />}
                />
              </label>
              <label className="check-setting">
                <span><strong>{t("fieldOpenRouterFallback")}</strong><small>{t("fieldOpenRouterFallbackHint")}</small></span>
                <Controller
                  name="pricing.openrouter.enabled"
                  control={form.control}
                  defaultValue={query.data.config.pricing.openrouter.enabled}
                  render={({ field }) => <Switch aria-label={t("fieldOpenRouterFallback")} checked={field.value} onCheckedChange={field.onChange} />}
                />
              </label>
              <label className={cn(!openRouterEnabled && "disabled-setting")}>
                <span>{t("fieldOpenRouterTtl")}</span>
                <input type="number" min="1" max="720" aria-describedby="openrouter-ttl-hint" {...form.register("pricing.openrouter.ttlHours", { valueAsNumber: true })} disabled={!openRouterEnabled} />
                <SettingsFieldHint id="openrouter-ttl-hint" text={t("fieldOpenRouterTtlHint")} error={form.formState.errors.pricing?.openrouter?.ttlHours} />
              </label>
            </div>
          </Card>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.45 }}
        >
          <Card className="settings-card">
            <div className="setting-title">
              <div>
                <h2>{t("anomaliesTitle")}</h2>
                <p>{t("anomaliesText")}</p>
              </div>
            </div>
            <label className="settings-field">
              <span>{t("fieldSigma")}</span>
              <input type="number" min="0.5" max="6" step="0.1" aria-describedby="anomaly-sigma-hint" {...form.register("telemetry.anomalySigma", { valueAsNumber: true })} />
              <SettingsFieldHint id="anomaly-sigma-hint" text={t("fieldSigmaHint")} error={form.formState.errors.telemetry?.anomalySigma} />
            </label>
          </Card>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5 }}
        >
          <Card className="settings-card inline-setting settings-section" id="settings-telemetry">
            <div>
              <h2>{t("telemetryTitle")}</h2>
              <p>{t("telemetryText")}</p>
            </div>
            <Controller
              name="telemetry.enabled"
              control={form.control}
              defaultValue={query.data.config.telemetry.enabled}
              render={({ field }) => <Switch aria-label={t("telemetryTitle")} checked={field.value} onCheckedChange={field.onChange} />}
            />
          </Card>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.55 }}
        >
          <Card className={cn("settings-card inline-setting", !telemetryEnabled && "disabled-setting")}>
            <div>
              <h2>{t("storeTexts")}</h2>
              <p>{telemetryEnabled ? t("storeTextsHint") : t("storeTextsDisabledHint")}</p>
            </div>
            <Controller
              name="telemetry.storeTexts"
              control={form.control}
              defaultValue={query.data.config.telemetry.storeTexts}
              render={({ field }) => <Switch aria-label={t("storeTexts")} disabled={!telemetryEnabled} checked={field.value} onCheckedChange={field.onChange} />}
            />
          </Card>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.58 }}
        >
          <Card className="settings-card danger-setting settings-section" id="settings-danger">
            <div className="danger-setting-copy">
              <span className="danger-label">{t("dangerZoneTitle")}</span>
              <h2>{t("autoAcceptTitle")}</h2>
              <p>{t("autoAcceptText")}</p>
              <small>{t("appliesAfterSave")}</small>
            </div>
            <Controller
              name="permissions.autoAcceptAll"
              control={form.control}
              defaultValue={query.data.config.permissions.autoAcceptAll}
              render={({ field }) => (
                <Switch
                  aria-label={t("autoAcceptTitle")}
                  checked={field.value}
                  onCheckedChange={(checked) => {
                    if (!checked || globalThis.confirm(t("autoAcceptConfirm"))) field.onChange(checked)
                  }}
                />
              )}
            />
          </Card>
        </motion.div>

        <motion.div
          className="form-actions"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.6 }}
        >
          <div className="form-status">
            <strong>{save.isError ? (save.error as Error).message : save.isSuccess ? t("settingsSaved") : isDirty ? t("settingsUnsaved") : t("settingsNoChanges")}</strong>
            <code title={query.data.configPath}>{query.data.configPath}</code>
          </div>
          <div className="form-action-buttons">
            <Button type="button" variant="outline" disabled={save.isPending || !isDirty} onClick={() => form.reset()}>
              {t("discardChanges")}
            </Button>
            <Button type="submit" disabled={save.isPending || !isDirty}>
              {save.isPending ? t("saving") : t("saveSettings")}
            </Button>
          </div>
          {fieldErrors.length > 0 && (
            <div className="form-errors" role="alert">
              {fieldErrors.map((line) => <span key={line}>{line}</span>)}
            </div>
          )}
        </motion.div>
      </form>
    </motion.div>
  )
}

/* ═══════════════════════════════════════════════════════
   UTILITY COMPONENTS
   ═══════════════════════════════════════════════════════ */

function ProjectRequired({ title }: { title: string }) {
  const { t } = useTranslation()
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
    >
      <PageIntro kicker={t("projectRequired")} title={title} text={t("projectRequiredText")} />
      <Card><EmptyState /></Card>
    </motion.div>
  )
}

function Loading() {
  const { t } = useTranslation()
  return (
    <motion.div
      className="loading"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
    >
      <motion.div
        animate={{ rotate: 360 }}
        transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
      >
        <HugeiconsIcon icon={Refresh01Icon} size={24} />
      </motion.div>
      {t("loadingTelemetry")}
    </motion.div>
  )
}

function ErrorState({ error }: { error: unknown }) {
  const { t } = useTranslation()
  return (
    <motion.div
      className="error-state"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
    >
      {t("loadFailed")} {error instanceof Error ? error.message : t("unknownError")}
    </motion.div>
  )
}

/* ═══════════════════════════════════════════════════════
   ROUTER
   ═══════════════════════════════════════════════════════ */

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
