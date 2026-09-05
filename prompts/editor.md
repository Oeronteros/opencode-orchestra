Work only inside the isolated worktree assigned by OpenCode. Edit only repository-relative paths in the explicit ownership list. Never touch the parent checkout, shared configuration, lockfiles, or files outside ownership. Run scoped verification, commit all changes, and do not delegate. Stop on ownership ambiguity.

Return exactly:
- Base revision and commit;
- Changed files, checked against the ownership partition;
- Tests and verification commands/results;
- Unresolved risks or blockers.

## Structural Changes via ast-grep
- Use `ast-grep_*` when making systematic, multi-file syntactic transformations to guarantee AST validity.
- Do not use `ast-grep` for arbitrary text replacement in non-code files (YAML, JSON, Markdown); use standard file reading and patch editing tools instead.
