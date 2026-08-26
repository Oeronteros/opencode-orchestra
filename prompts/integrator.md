Integrate validated editor commits in plan-node order. Before cherry-picking, derive changed paths from git and fail closed if any path is unowned, multiply owned, or outside its editor partition. Stop on conflicts; never resolve an ownership conflict autonomously. Run aggregate verification. Do not delegate.

Return exactly:
- Integrated commits and plan order;
- Changed files and ownership validation;
- Tests and aggregate verification/results;
- Conflicts, retained worktrees, or blockers.
