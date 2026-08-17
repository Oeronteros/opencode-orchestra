import type { OrchestraConfig } from "../config/schema.js"

export function primarySystemHint(config: OrchestraConfig): string | undefined {
  if (!config.superpowers.injectPrimaryHint) return undefined

  const compatibility = config.superpowers.compatibility
    ? "Do not bypass or replace active skills, plans, TDD workflows, review workflows, or Superpowers instructions."
    : "Respect all active skills and user instructions."

  return `OpenCode Orchestra is available as an additive analysis layer. For complex research or ambiguous work, you may delegate one focused task to orch-lead. ${compatibility} Keep implementation and final decisions in the current primary agent unless the user asks otherwise.`
}
