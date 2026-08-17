/**
 * Stream observer ("Obestor"). Watches the token stream and flags rising
 * uncertainty mid-generation rather than judging only a finalized answer.
 */

export interface StreamObservation {
  confidence: number
  lowConfidence: boolean
  flags: string[]
  length: number
}

export interface StreamObserverOptions {
  threshold?: number
  minLength?: number
}

const HEDGES = [
  "i think", "perhaps", "maybe", "might be", "possibly", "not sure",
  "uncertain", "unclear", "ambiguous", "it seems", "i believe", "likely",
  "assum", "probably", "похоже", "возможно", "вероятно", "не уверен",
  "кажется", "неясно", "предполож", "скорее всего",
]

const DISAGREEMENT = [
  "disagree", "conflict", "contradict", "inconsistent", "diverg",
  "however", "on the other hand", "but note",
  "противореч", "не соглас", "однако", "с другой стороны", "расхожд",
]

const CORRECTIONS = [
  "actually", "wait", "correction", "let me reconsider", "i mean", "rather",
  "точнее", "на самом деле", "погоди", "точнее говоря",
]

export function createStreamObserver(options: StreamObserverOptions = {}) {
  const threshold = options.threshold ?? 0.6
  const minLength = options.minLength ?? 40
  let text = ""

  function count(list: string[]): number {
    const lower = text.toLowerCase()
    return list.reduce((acc, phrase) => acc + (lower.includes(phrase) ? 1 : 0), 0)
  }

  function observe(): StreamObservation {
    const flags: string[] = []
    const hedgeHits = count(HEDGES)
    const disagreeHits = count(DISAGREEMENT)
    const correctionHits = count(CORRECTIONS)

    let penalties = 0.04 * Math.min(4, hedgeHits)
    penalties += 0.12 * Math.min(3, disagreeHits)
    penalties += 0.08 * Math.min(3, correctionHits)

    if (disagreeHits > 0) flags.push("disagreement markers detected")
    if (correctionHits > 0) flags.push("self-correction or retraction detected")
    if (hedgeHits >= 2) flags.push("persistent hedging language")

    const settled = text.length >= minLength
    const confidence = Math.max(0.15, Math.min(0.98, 0.92 - penalties))
    const lowConfidence = settled && confidence < threshold

    return { confidence, lowConfidence, flags, length: text.length }
  }

  return {
    push(delta: string): StreamObservation {
      text += delta
      return observe()
    },
    observe,
    text: () => text,
    reset() {
      text = ""
    },
  }
}

export type StreamObserver = ReturnType<typeof createStreamObserver>

export function scoreFinalText(text: string, options: StreamObserverOptions = {}): StreamObservation {
  const observer = createStreamObserver(options)
  observer.push(text)
  return observer.observe()
}
