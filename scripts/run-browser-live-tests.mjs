import { spawnSync } from "node:child_process"
const result = spawnSync(process.execPath, ["--test", "dist-test/test/browser-live.test.js"], {
  stdio: "inherit", env: { ...process.env, ORCHESTRA_LIVE_BROWSER: "1" },
})
process.exitCode = result.status ?? 1
