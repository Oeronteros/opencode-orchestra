import { spawn } from "node:child_process"
import path from "node:path"

export interface GitResult { stdout: string; stderr: string; exitCode: number }
export interface GitRunner { run(args: string[], cwd: string): Promise<GitResult> }

export const systemGit: GitRunner = { run(args, cwd) { return new Promise((resolve, reject) => { const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); let stdout = "", stderr = ""; child.stdout.on("data", (chunk) => stdout += chunk); child.stderr.on("data", (chunk) => stderr += chunk); child.once("error", reject); child.once("exit", (exitCode) => resolve({ stdout, stderr, exitCode: exitCode ?? 1 })) }) } }

export interface ChangedPath { status: string; path: string; oldPath?: string }
export function parseNameStatusZ(output: string): ChangedPath[] { const tokens = output.split("\0"); const result: ChangedPath[] = []; for (let i = 0; i < tokens.length - 1;) { const status = tokens[i++]!; if (!status) continue; const code = status[0]!; const first = tokens[i++]!; if ((code === "R" || code === "C") && i < tokens.length) result.push({ status, oldPath: first, path: tokens[i++]! }); else result.push({ status, path: first }) } return result }

export async function createEditorWorktree(git: GitRunner, repo: string, taskId: string, nodeId: string, baseSha: string, root = ".orchestra/worktrees"): Promise<{ path: string; branch: string }> { const safe = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, "-"); const branch = "orch/" + safe(taskId) + "/" + safe(nodeId); const worktreePath = path.join(root || ".orchestra/worktrees", safe(taskId) + "-" + safe(nodeId)); const result = await git.run(["worktree", "add", "-b", branch, worktreePath, baseSha], repo); if (result.exitCode !== 0) throw new Error(result.stderr || "git worktree add failed"); return { path: worktreePath, branch } }

export async function assertCommitDescendsFromBase(git: GitRunner, repo: string, baseSha: string, commitSha: string): Promise<void> { const result = await git.run(["merge-base", "--is-ancestor", baseSha, commitSha], repo); if (result.exitCode !== 0) throw new Error("commit is not descended from base: " + commitSha) }

export async function integrateValidatedCommits(git: GitRunner, repo: string, commits: string[]): Promise<void> { for (const commit of commits) { const result = await git.run(["cherry-pick", commit], repo); if (result.exitCode !== 0) { await git.run(["cherry-pick", "--abort"], repo); throw new Error("cherry-pick conflict for " + commit + ": " + result.stderr) } } }

export async function collectCommitChanges(git: GitRunner, repo: string, baseSha: string, commitSha: string): Promise<ChangedPath[]> { const result = await git.run(["diff", "--name-status", "-z", "--find-renames", baseSha + "..." + commitSha], repo); if (result.exitCode !== 0) throw new Error(result.stderr || "git diff failed"); return parseNameStatusZ(result.stdout) }
