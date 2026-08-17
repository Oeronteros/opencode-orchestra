import type { OrchestraConfig } from "../config/schema.js"
import type { Classification } from "./classifier.js"

export interface EscalationInput {
  classification: Classification
  consensus?: number
  premiumCallsUsed?: number
}

export interface EscalationDecision {
  escalate: boolean
  reason: string
}

export function decideEscalation(
  config: OrchestraConfig,
  input: EscalationInput,
): EscalationDecision {
  if (!config.orchestration.premiumEscalation) {
    return { escalate: false, reason: "premium escalation disabled" }
  }

  if ((input.premiumCallsUsed ?? 0) >= config.orchestration.maxPremiumCallsPerTask) {
    return { escalate: false, reason: "premium call budget exhausted" }
  }

  const uncertain = input.classification.confidence < config.orchestration.confidenceThreshold
  const disagreement = input.consensus !== undefined && input.consensus < config.orchestration.confidenceThreshold

  if (config.budget === "ebobo") {
    return { escalate: true, reason: "ebobo mode always requests frontier arbitration" }
  }

  if (config.budget === "eco") {
    return input.classification.critical && disagreement
      ? { escalate: true, reason: "critical worker disagreement" }
      : { escalate: false, reason: "eco mode reserves judge for critical disagreement" }
  }

  if (input.classification.critical || uncertain || disagreement) {
    return {
      escalate: true,
      reason: input.classification.critical
        ? "critical task"
        : disagreement
          ? "worker disagreement"
          : "low classification confidence",
    }
  }

  return { escalate: false, reason: "lead can synthesize with sufficient confidence" }
}
