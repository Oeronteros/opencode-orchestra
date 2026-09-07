import { spawnSync } from "node:child_process"

const result = spawnSync(process.execPath, ["--test", "dist-test/test/mcp-live.test.js"], {
  stdio: "inherit",
  env: { ...process.env, ORCHESTRA_LIVE_MCP: "1" },
})
process.exitCode = result.status ?? 1
