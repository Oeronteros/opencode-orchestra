import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { splitTokens } from "../dashboard/src/lib/tokens.js"

describe("splitTokens", () => {
  it("splits incoming, outgoing and cache separately", () => {
    const result = splitTokens({
      input: 100,
      output: 50,
      reasoning: 10,
      cache: { read: 20, write: 5 },
    })
    assert.equal(result.input, 100)
    assert.equal(result.output, 60)
    assert.equal(result.cacheRead, 20)
    assert.equal(result.cacheWrite, 5)
    assert.equal(result.total, 160)
  })

  it("treats missing reasoning and cache as zero", () => {
    const result = splitTokens({ input: 7, output: 3 } as never)
    assert.equal(result.input, 7)
    assert.equal(result.output, 3)
    assert.equal(result.cacheRead, 0)
    assert.equal(result.cacheWrite, 0)
  })
})
