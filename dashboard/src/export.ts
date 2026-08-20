import type { ExportFormat, ExportScope } from "./api"

function token(): string {
  return sessionStorage.getItem("orchestra-token") ?? ""
}

function filenameFromDisposition(disposition: string | null): string | null {
  if (!disposition) return null
  const match = /filename="([^"]+)"/i.exec(disposition)
  return match?.[1] ?? null
}

export async function downloadExport(scope: ExportScope, format: ExportFormat, projectId: string): Promise<void> {
  const query = new URLSearchParams({ scope, format })
  query.set("project", projectId)
  const response = await fetch(`/api/export?${query.toString()}`, {
    headers: { "X-Orchestra-Token": token() },
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string }
    throw new Error(body.error ?? `HTTP ${response.status}`)
  }
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filenameFromDisposition(response.headers.get("Content-Disposition")) ?? `orchestra-${scope}.${format}`
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}
