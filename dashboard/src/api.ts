import type { DashboardConfig, GlobalSnapshot, LiveSnapshot, ProjectInfo, Snapshot } from "./types"

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

/**
 * Subscribe to the live orchestration stream over SSE. The server pushes a
 * full LiveSnapshot whenever new events are produced. Returns a handle that
 * closes the connection (best-effort on cleanup).
 */
export function subscribeLive(projectId: string, onSnapshot: (snapshot: LiveSnapshot) => void, onError?: () => void): { close: () => void } {
  const query = new URLSearchParams({ token })
  query.set("project", projectId)
  const source = new EventSource("/api/live?" + query.toString())
  source.addEventListener("snapshot", (event) => {
    try {
      onSnapshot(JSON.parse((event as MessageEvent<string>).data) as LiveSnapshot)
    } catch {
      // Ignore malformed frames; the next push will reconcile.
    }
  })
  source.onerror = () => {
    // EventSource auto-reconnects; surface an error to let the panel degrade.
    onError?.()
  }
  return {
    close: () => source.close(),
  }
}

export const api = {
  snapshot: (projectId?: string) => request<Snapshot>(`/api/snapshot${projectId ? `?project=${encodeURIComponent(projectId)}` : ""}`),
  projects: () => request<ProjectInfo[]>("/api/projects"),
  global: () => request<GlobalSnapshot>("/api/global"),
  saveConfig: (config: DashboardConfig) => request<{ ok: true }>("/api/config", {
    method: "PUT",
    body: JSON.stringify(config),
  }),
  exportUrl: (scope: ExportScope, format: ExportFormat) => `/api/export?scope=${scope}&format=${format}`,
}
