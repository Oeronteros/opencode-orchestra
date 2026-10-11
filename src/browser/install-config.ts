import { applyEdits, modify, parse } from "jsonc-parser"
import { browserConfigSchema, type BrowserConfig } from "../config/schema.js"

export function migrateBrowserConfig(text: string, choice: { browserMode?: BrowserConfig["mode"]; playwright?: boolean }): { text: string; changed: boolean; browser: BrowserConfig } {
  if (choice.playwright === false && (choice.browserMode === "auto" || choice.browserMode === "playwright")) throw new Error("--no-playwright conflicts with browser mode")
  const parsed = parse(text) as Record<string, unknown> | undefined
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("orchestra_config_invalid")
  const browser = parsed.browser && typeof parsed.browser === "object" && !Array.isArray(parsed.browser) ? parsed.browser as Record<string, unknown> : {}
  const requested = choice.browserMode ?? (choice.playwright === false ? "off" : browser.mode ?? "auto")
  const next = { ...browser, mode: requested, ...(browser.download === undefined ? { download: true } : {}) }
  const validated = browserConfigSchema.parse(next)
  const edits = applyEdits(text, modify(text, ["browser"], next, { formattingOptions: { insertSpaces: true, tabSize: 2 } }))
  return { text: edits, changed: edits !== text, browser: validated }
}
