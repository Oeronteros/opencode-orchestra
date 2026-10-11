import { z } from "zod"

/**
 * Convert a tool input schema to a plain JSON Schema object.
 *
 * The native OpenCode host may bundle a different Zod copy than this plugin.
 * Passing foreign Zod instances through registration can fail inside the host
 * (`[toJSONSchema]: Non-representable type encountered`), so every native
 * `input` is pre-converted here. The plugin still validates raw input with the
 * original schema at execution time.
 */
export function toolInputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  try {
    const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>
    delete json.$schema
    delete json.$id
    return json
  } catch {
    // Registration must never leak a Zod instance; runtime validation still applies.
    return { type: "object", additionalProperties: true }
  }
}
