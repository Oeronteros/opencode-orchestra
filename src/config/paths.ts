import os from "node:os"
import path from "node:path"

export function openCodeConfigDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENCODE_CONFIG_DIR) return path.resolve(env.OPENCODE_CONFIG_DIR)
  if (env.XDG_CONFIG_HOME) return path.join(path.resolve(env.XDG_CONFIG_HOME), "opencode")
  return path.join(os.homedir(), ".config", "opencode")
}

export function globalOrchestraConfig(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(openCodeConfigDirectory(env), "orchestra.jsonc")
}
