import type { WorkspaceAdapter, WorkspaceInfo } from "@opencode-ai/plugin"
import { mkdir, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { spawn } from "node:child_process"

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80)
}

function runGit(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, { cwd, stdio: "ignore", windowsHide: true })
    child.once("error", reject)
    child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error("git " + args.join(" ") + " exited with " + code)))
  })
}

/** OpenCode experimental workspace adapter backed by isolated local git worktrees. */
export function createGitWorktreeAdapter(repository: string, root = ".orchestra/worktrees"): WorkspaceAdapter {
  const base = resolve(repository)
  const worktreeRoot = resolve(base, root)
  const directoryOf = (config: WorkspaceInfo) => join(worktreeRoot, safeId(config.id))
  return {
    name: "Orchestra Git Worktree",
    description: "Creates one isolated git worktree per parallel Orchestra editor.",
    configure(config) {
      return { ...config, directory: directoryOf(config), branch: config.branch ?? "orchestra/" + safeId(config.id) }
    },
    async create(config, _env, from) {
      const directory = directoryOf(config)
      const branch = config.branch ?? "orchestra/" + safeId(config.id)
      await mkdir(dirname(directory), { recursive: true })
      await runGit(base, ["worktree", "add", "-b", branch, directory, from?.branch ?? "HEAD"])
    },
    async remove(config) {
      const directory = directoryOf(config)
      const branch = config.branch ?? "orchestra/" + safeId(config.id)
      try { await runGit(base, ["worktree", "remove", "--force", directory]) }
      finally {
        await rm(directory, { recursive: true, force: true })
        await runGit(base, ["branch", "-D", branch]).catch(() => undefined)
      }
    },
    target(config) { return { type: "local", directory: directoryOf(config) } },
  }
}
