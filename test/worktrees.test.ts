import assert from "node:assert/strict"
import test from "node:test"
import { assertCommitDescendsFromBase, collectCommitChanges, createEditorWorktree, integrateValidatedCommits, parseNameStatusZ, type GitRunner } from "../src/orchestration/worktrees.js"

class FakeGit implements GitRunner { calls: string[][]=[]; constructor(private responses: Array<{stdout?:string;stderr?:string;exitCode:number}>) {} async run(args:string[]): Promise<{stdout:string;stderr:string;exitCode:number}> { this.calls.push(args); const r=this.responses.shift() ?? {exitCode:0}; return {stdout:r.stdout??"",stderr:r.stderr??"",exitCode:r.exitCode} } }
test("parses NUL-safe rename diff",()=>assert.deepEqual(parseNameStatusZ("M\0src/a.ts\0R100\0old.ts\0new.ts\0"),[{status:"M",path:"src/a.ts"},{status:"R100",oldPath:"old.ts",path:"new.ts"}]))
test("creates isolated deterministic worktree",async()=>{const git=new FakeGit([{exitCode:0}]); const result=await createEditorWorktree(git,"repo","task 1","api","base","root"); assert.equal(result.branch,"orch/task-1/api"); assert.deepEqual(git.calls[0],["worktree","add","-b","orch/task-1/api","root/task-1-api","base"])})
test("collects actual commit changes",async()=>{const git=new FakeGit([{exitCode:0,stdout:"A\0src/x.ts\0"}]); assert.deepEqual(await collectCommitChanges(git,"repo","base","commit"),[{status:"A",path:"src/x.ts"}])})
test("rejects unrelated commit",async()=>{const git=new FakeGit([{exitCode:1}]); await assert.rejects(()=>assertCommitDescendsFromBase(git,"repo","base","commit"))})
test("aborts cherry-pick on conflict",async()=>{const git=new FakeGit([{exitCode:0},{exitCode:1,stderr:"conflict"},{exitCode:0}]); await assert.rejects(()=>integrateValidatedCommits(git,"repo",["a","b"])); assert.deepEqual(git.calls.at(-1),["cherry-pick","--abort"])})
