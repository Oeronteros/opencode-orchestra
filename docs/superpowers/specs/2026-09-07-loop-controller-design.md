# Bounded Loop Design

One explicit `/loop` command activates the existing orch-lead. Inline goals and `--file workspace-relative.md` are supported, without path guessing or plugin file reads. The agent reads plans through normal permissioned tools and must report failures rather than invent contents.

The command hook starts an in-memory controller. The host executes the initial command turn. Finalized assistant replies are fetched using the installed SDK session.message API and correlated by parent user message ID independently of telemetry. Only final unquoted DONE/MORE lines outside code fences count. Idle and reply readiness jointly gate deferred promptAsync submissions, explicitly bound to orch-lead. Consumed parent IDs and single-flight guards prevent duplicate submission.

DONE is a completion claim, never independent verification. Nonempty verifyCommand fails closed at activation; no shell runner bypasses host permissions. MORE continues only within maxIterations (including initial turn), maxMinutes and repeated-reason limits. Unknown replies pause. Permission requests pause; errors, manual messages and stop cancel future continuation. Deadline timers also stop during waits. Already executing host tools are not forcibly killed.

`/loop status` and `/loop stop` use command-hook notices (thrown errors because the installed hook has no handled-response return). Stop prevents future submissions; host interrupt cancels current execution. No backlog, extra agent or plan command. Disposal clears timers and invalidates late replies.

Defaults: enabled false, maxIterations 10, maxMinutes 30, noProgressLimit 3, verifyCommand empty. Tests cover protocol, scoped plan instructions, limits, single-flight, late replies, cancellation and fail-closed activation. Real host event timing remains an integration risk requiring a live OpenCode smoke test.
