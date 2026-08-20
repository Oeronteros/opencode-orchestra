import type { OrchestraConfig } from "../config/schema.js"

export function primarySystemHint(config: OrchestraConfig): string | undefined {
  if (!config.superpowers.injectPrimaryHint) return undefined

  const compatibility = config.superpowers.compatibility
    ? "Do not bypass or replace active skills, plans, TDD workflows, review workflows, or Superpowers instructions."
    : "Respect all active skills and user instructions."

  return `OpenCode Orchestra is available as an additive orchestration layer. orch-lead is the primary implementation agent: for complex research or ambiguous work, it may delegate focused evidence tasks to Orchestra workers, then implement and verify the result itself. ${compatibility}`
}
