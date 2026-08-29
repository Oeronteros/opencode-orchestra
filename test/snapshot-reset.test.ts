import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { snapshotResetDecision, type SnapshotResetState } from "../dashboard/src/lib/snapshot-reset.js"

describe("snapshotResetDecision", () => {
  const fresh: SnapshotResetState = { initialized: false, appliedEpoch: 0 }

  it("resets the form on the first successful snapshot load", () => {
    const decision = snapshotResetDecision(fresh, 0)
    assert.equal(decision.reset, true)
    assert.deepEqual(decision.next, { initialized: true, appliedEpoch: 0 })
  })

  it("never resets the form on background polls (same save epoch)", () => {
    const state: SnapshotResetState = { initialized: true, appliedEpoch: 0 }
    const decision = snapshotResetDecision(state, 0)
    assert.equal(decision.reset, false)
    assert.equal(decision.next, state)
  })

  it("resets exactly once after an explicit save bumps the epoch", () => {
    const state: SnapshotResetState = { initialized: true, appliedEpoch: 0 }
    const afterSave = snapshotResetDecision(state, 1)
    assert.equal(afterSave.reset, true)
    assert.deepEqual(afterSave.next, { initialized: true, appliedEpoch: 1 })

    // The refetch that follows the save lands once; further polls must not reset.
    const afterRefetch = snapshotResetDecision(afterSave.next, 1)
    assert.equal(afterRefetch.reset, false)
  })

  it("does not clobber edits when a later poll carries the same epoch", () => {
    const state: SnapshotResetState = { initialized: true, appliedEpoch: 2 }
    const decision = snapshotResetDecision(state, 2)
    assert.equal(decision.reset, false)
  })

  it("resets again for every subsequent save", () => {
    const state: SnapshotResetState = { initialized: true, appliedEpoch: 1 }
    const decision = snapshotResetDecision(state, 3)
    assert.equal(decision.reset, true)
    assert.deepEqual(decision.next, { initialized: true, appliedEpoch: 3 })
  })
})
