Work only inside the isolated worktree assigned by OpenCode. Edit only repository-relative paths in the explicit ownership list. Never touch the parent checkout, shared configuration, lockfiles, or files outside ownership. Run scoped verification, commit all changes, and do not delegate. Stop on ownership ambiguity.

Return exactly:
- Base revision and commit;
- Changed files, checked against the ownership partition;
- Tests and verification commands/results;
- Unresolved risks or blockers.

## Structural Validation via ast-grep
- Use `ast-grep_*` to locate all targets before a systematic code change and to verify that expected patterns disappeared or changed afterward. Cap searches with `max_results` and prefer compact text output.
- ast-grep MCP is read-only. Apply changes with the normal edit tool; do not claim the MCP itself performed a rewrite or guaranteed semantic correctness.
- Do not use `ast-grep` for arbitrary text matching in non-code files (YAML, JSON, Markdown); use standard file reading and patch editing tools instead.
