import { spawnWithCmdFallback } from "../spawn.js"

export const PACKAGE_NAME = "@oeronteros-1/opencode-orchestra"
const REGISTRY_URL = "https://registry.npmjs.org/@oeronteros-1%2Fopencode-orchestra/latest"

/** Compare two dotted versions. Returns negative, zero, or positive. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0)
  const length = Math.max(pa.length, pb.length)
  for (let i = 0; i < length; i += 1) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x - y
  }
  return 0
}

/**
 * Resolve the latest published version from the npm registry without
 * bundling a network client. Prefers `npm view`, then `bun pm view`, then
 * a direct `fetch` of the registry /latest document.
 */
export async function latestPublishedVersion(): Promise<string | undefined> {
  const steps: [string, string[]][] = [
    ["npm", ["view", PACKAGE_NAME, "version"]],
    ["bun", ["pm", "view", PACKAGE_NAME, "version"]],
  ]
  for (const [command, args] of steps) {
    try {
      const result = spawnWithCmdFallback(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      const first = String(result.stdout ?? "").trim().split(/\r?\n/)[0]
      if (result.status === 0 && first && isStableSemver(first)) return first
    } catch {
      // Try the next fallback.
    }
  }
  try {
    const response = await fetch(REGISTRY_URL, {
      redirect: "follow",
      headers: { accept: "application/json" },
    })
    if (response.ok) {
      const body = (await response.json()) as { version?: string }
      if (body.version && isStableSemver(body.version)) return body.version
    }
  } catch {
    // No network available.
  }
  return undefined
}

export interface UpdateCheckResult {
  current: string
  latest?: string
}

/** True for a bare x.y.z version (pre-release suffixes like -beta are excluded). */
export function isStableSemver(value: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(value)
}

export function formatUpdateResult(result: UpdateCheckResult): string {
  const lines = ["OpenCode Orchestra: " + result.current]
  const currentVersion = result.current
  if (!result.latest) {
    lines.push("Could not reach the npm registry to check for updates.")
    lines.push("Verify network access and retry with opencode-orchestra update.")
    return lines.join("\n")
  }
  // A non-semver current version (unknown, git build, or pre-release like
  // 0.5.3-beta) cannot be compared; just report the published latest.
  if (!isStableSemver(currentVersion)) {
    lines.push("Latest published version: " + result.latest)
    lines.push("Upgrade with: bunx " + PACKAGE_NAME + "@latest install --force")
    return lines.join("\n")
  }
  const level = compareVersions(currentVersion, result.latest)
  if (level < 0) {
    lines.push("A newer version is available: " + result.latest)
    lines.push("Upgrade with: bunx " + PACKAGE_NAME + "@latest install --force")
  } else if (level === 0) {
    lines.push("You are on the latest version.")
  } else {
    lines.push("Latest published version is older (" + result.latest + "); you may be on a pre-release build.")
  }
  return lines.join("\n")
}

export async function checkForUpdates(current: string): Promise<UpdateCheckResult> {
  const latest = await latestPublishedVersion()
  return latest ? { current, latest } : { current }
}
