/**
 * Pure spend analytics derived from the per-day cost series the dashboard
 * already aggregates. No I/O; deterministic given the same inputs so the
 * results are straightforward to unit test.
 */

export interface DailyPoint {
  date: string
  cost: number
  input: number
  output: number
  reasoning: number
}

export interface DailyAnomaly {
  date: string
  cost: number
  baselineMean: number
  threshold: number
  /** Signatures of the spike over the baseline (cost / stdev). */
  z: number
}

export interface MonthProjection {
  /** Full calendar-month projection from month-to-date spend. */
  projected: number
  monthToDate: number
  elapsedDays: number
  daysInMonth: number
  isAheadOfPace: boolean
}

const SIGMA = 2

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0
  const center = mean(values)
  const variance = values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

/**
 * Flag days whose spend exceeds the trailing baseline (mean + SIGMA×stdev of
 * the *prior* ordered days). A spike is only detected once enough history
 * exists to form a stable baseline; the first days are therefore never
 * flagged, and a single outlier does not poison the baseline.
 */
export function detectAnomalies(daily: DailyPoint[], sigma = SIGMA): DailyAnomaly[] {
  const ordered = [...daily].sort((a, b) => a.date.localeCompare(b.date))
  const anomalies: DailyAnomaly[] = []
  const history: number[] = []

  for (const point of ordered) {
    if (history.length >= 3) {
      const baselineMean = mean(history)
      const deviation = stdev(history)
      const threshold = baselineMean + sigma * Math.max(deviation, 0.0001)
      if (point.cost > threshold) {
        anomalies.push({
          date: point.date,
          cost: point.cost,
          baselineMean,
          threshold,
          z: deviation > 0 ? (point.cost - baselineMean) / deviation : 0,
        })
      }
    }
    history.push(point.cost)
  }

  return anomalies
}

/**
 * Linear extrapolation of month-to-date spend to the full calendar month.
 * `now` defaults to the real clock and exists only for deterministic tests.
 */
export function projectMonth(daily: DailyPoint[], now = new Date()): MonthProjection {
  const year = now.getFullYear()
  const month = now.getMonth()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const elapsedDays = now.getDate()
  const prefix = now.toISOString().slice(0, 7)

  const monthToDate = daily
    .filter((point) => point.date.startsWith(prefix))
    .reduce((sum, point) => sum + point.cost, 0)

  const elapsed = Math.max(1, elapsedDays)
  const projected = (monthToDate / elapsed) * daysInMonth

  // Compare the current projection with the average of prior calendar months.
  // Current-month points are deliberately excluded so the baseline and the
  // projection do not measure the same period.
  const prior = daily.filter((point) => !point.date.startsWith(prefix) && point.date < `${prefix}-01`)
  const priorDailyAverage = prior.length > 0 ? prior.reduce((sum, point) => sum + point.cost, 0) / prior.length : 0
  const isAheadOfPace = prior.length > 0 && projected > priorDailyAverage * daysInMonth

  return { projected, monthToDate, elapsedDays, daysInMonth, isAheadOfPace }
}

/** Convenience: run both analyses and expose a combined result. */
export function analyzeDaily(daily: DailyPoint[], now = new Date()) {
  return {
    anomalies: detectAnomalies(daily),
    projection: projectMonth(daily, now),
  }
}
