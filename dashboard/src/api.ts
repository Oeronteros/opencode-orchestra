import type { DashboardConfig, Snapshot } from "./types"

const query = new URLSearchParams(window.location.search)
const fromUrl = query.get("token")
if (fromUrl) {
  sessionStorage.setItem("orchestra-token", fromUrl)
  query.delete("token")
  const clean = `${window.location.pathname}${query.size ? `?${query}` : ""}${window.location.hash}`
  window.history.replaceState({}, "", clean)
}

const token = sessionStorage.getItem("orchestra-token") ?? ""

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Orchestra-Token": token,
      ...init?.headers,
    },
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string }
    throw new Error(body.error ?? `HTTP ${response.status}`)
  }
  return response.json() as Promise<T>
}

export type ExportScope = "activity" | "models" | "agents" | "daily" | "summary"
export type ExportFormat = "csv" | "json"

export const api = {
  snapshot: () => request<Snapshot>("/api/snapshot"),
  saveConfig: (config: DashboardConfig) => request<{ ok: true }>("/api/config", {
    method: "PUT",
    body: JSON.stringify(config),
  }),
  exportUrl: (scope: ExportScope, format: ExportFormat) => `/api/export?scope=${scope}&format=${format}`,
}
