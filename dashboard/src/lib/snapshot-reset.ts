// Decision logic for re-populating the settings form from a freshly loaded
// snapshot. The dashboard snapshot query polls every 2.5s, so resetting the
// form on every `data` change would silently discard unsaved edits (a toggle
// flipped by the user would snap back within one poll interval). The form may
// only be reset on the first successful load and once after each explicit
// save, identified by a monotonically increasing save epoch.

export interface SnapshotResetState {
  /** True once the form has been populated from a snapshot at least once. */
  initialized: boolean
  /** Epoch of the last explicit save already applied to the form. */
  appliedEpoch: number
}

export interface SnapshotResetDecision {
  /** True when the form should be reset from the latest snapshot config. */
  reset: boolean
  /** The state to carry forward after applying (or skipping) the reset. */
  next: SnapshotResetState
}

export function snapshotResetDecision(
  state: SnapshotResetState,
  saveEpoch: number,
): SnapshotResetDecision {
  if (!state.initialized) {
    return { reset: true, next: { initialized: true, appliedEpoch: saveEpoch } }
  }
  if (saveEpoch > state.appliedEpoch) {
    return { reset: true, next: { initialized: true, appliedEpoch: saveEpoch } }
  }
  return { reset: false, next: state }
}
