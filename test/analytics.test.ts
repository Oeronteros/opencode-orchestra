import assert from "node:assert/strict"
import test from "node:test"
import { detectAnomalies, projectMonth, type DailyPoint } from "../src/telemetry/analytics.js"

function point(date: string, cost: number): DailyPoint {
  return { date, cost, input: 0, output: 0, reasoning: 0 }
}

test("detectAnomalies flags a day above the trailing mean + 2 sigma", () => {
  // Steady baseline of 10 across four days, then a 100 spike.
  const daily = [
    point("2026-08-01", 10),
    point("2026-08-02", 10),
    point("2026-08-03", 10),
    point("2026-08-04", 10),
    point("2026-08-05", 100),
  ]
  const anomalies = detectAnomalies(daily)
  assert.equal(anomalies.length, 1)
  assert.equal(anomalies[0]?.date, "2026-08-05")
  assert.equal(anomalies[0]?.cost, 100)
})

test("detectAnomalies needs a baseline and does not flag the first days", () => {
  const daily = [
    point("2026-08-01", 5),
    point("2026-08-02", 500),
  ]
  // Only two days: never enough history for a trailing baseline.
  assert.deepEqual(detectAnomalies(daily), [])
})

test("detectAnomalies ignores a single outlier from poisoning the baseline", () => {
  // One big day early on, then a modest later day is NOT flagged because the
  // outlier is part of history but a fresh stable run follows.
  const daily = [
    point("2026-08-01", 1),
    point("2026-08-02", 1),
    point("2026-08-03", 1),
    point("2026-08-04", 50),
    point("2026-08-05", 2),
    point("2026-08-06", 2),
  ]
  const anomalies = detectAnomalies(daily)
  // Day 4 (50) is flagged; the later small days are not.
  assert.deepEqual(anomalies.map((a) => a.date), ["2026-08-04"])
})

test("projectMonth extrapolates month-to-date spend across the calendar month", () => {
  const now = new Date("2026-08-10T12:00:00.000Z")
  // 3 days of a 31-day month at $10/day = $30 month-to-date.
  const daily = [
    point("2026-08-01", 10),
    point("2026-08-02", 10),
    point("2026-08-03", 10),
  ]
  const projection = projectMonth(daily, now)
  assert.equal(projection.monthToDate, 30)
  assert.equal(projection.elapsedDays, 10)
  assert.equal(projection.daysInMonth, 31)
  // (30 / 10) * 31 = 93
  assert.equal(projection.projected, 93)
})

test("projectMonth reports ahead-of-pace when extrapolation beats prior-month average", () => {
  const now = new Date("2026-08-02T12:00:00.000Z")
  // Two quiet July days ($1 each) then two heavy August days ($30 each), so the
  // current month's run-rate (30/day) clearly outpaces the trailing average.
  const daily = [
    point("2026-07-01", 1),
    point("2026-07-02", 1),
    point("2026-08-01", 30),
    point("2026-08-02", 30),
  ]
  const projection = projectMonth(daily, now)
  // monthToDate = 60, elapsed = 2, daysInMonth = 31 -> 60/2*31 = 930.
  assert.equal(projection.projected, 930)
  assert.equal(projection.isAheadOfPace, true)
})
