export const GIT_MCP_VERSION = "2026.8.18"
export const AST_GREP_CLI_VERSION = "0.45.1"
export const AST_GREP_MCP_REVISION = "149e20d47bb7125fb0c1451feea2f48a98742034"

export function gitMcpCommand(uvx = "uvx", restrictToWorkspace = true): string[] {
  return [
    uvx,
    `mcp-server-git==${GIT_MCP_VERSION}`,
    ...(restrictToWorkspace ? ["--repository", "."] : []),
  ]
}

export function astGrepMcpCommand(uvx = "uvx"): string[] {
  return [
    uvx,
    "--with",
    `ast-grep-cli==${AST_GREP_CLI_VERSION}`,
    "--from",
    `git+https://github.com/ast-grep/ast-grep-mcp@${AST_GREP_MCP_REVISION}`,
    "ast-grep-server",
  ]
}
