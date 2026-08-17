import { PACKAGE_NAME } from "../plugin-status.js"

// Completions for the opencode-orchestra CLI. The binary is typically invoked
// through bunx, so completions cover the bare command name and bunx alike.

const COMMANDS = ["install", "dashboard", "doctor", "update", "completion"] as const

interface CompletionOption {
  name: string
  takesValue?: string
}

function optionsFor(command: string): CompletionOption[] {
  switch (command) {
    case "install":
      return [
        { name: "--no-context7" },
        { name: "--no-codebase-memory" },
        { name: "--no-memorygraph" },
        { name: "--no-deps" },
        { name: "--force" },
        { name: "--dry-run" },
        { name: "--config-dir", takesValue: "DIR" },
      ]
    case "dashboard":
      return [
        { name: "--directory", takesValue: "DIR" },
        { name: "--config-dir", takesValue: "DIR" },
        { name: "--host", takesValue: "HOST" },
        { name: "--port", takesValue: "PORT" },
        { name: "--no-open" },
      ]
    case "doctor":
      return [{ name: "--config-dir", takesValue: "DIR" }, { name: "--json" }]
    case "update":
      return []
    case "completion":
      return []
    default:
      return []
  }
}

function globalOptions(): CompletionOption[] {
  return [{ name: "--help" }, { name: "-h" }]
}

export function bashCompletion(program = "opencode-orchestra"): string {
  const fn = "_" + program.replaceAll("-", "_") + "_completion"
  const words = [...COMMANDS, "--help", "-h"].join(" ")
  const lines: string[] = [
    "# bash completion for " + program,
    fn + "() {",
    "  local cur cmd word",
    "  COMPREPLY=()",
    '  cur="${COMP_WORDS[COMP_CWORD]}"',
    '  cmd=""',
    '  for word in "${COMP_WORDS[@]:1:COMP_CWORD-1}"; do',
    '    case "$word" in',
    "      " + COMMANDS.join("|") + ') cmd="$word" ;;',
    "    esac",
    "  done",
    '  if [ -z "$cmd" ]; then',
    '    COMPREPLY=( $(compgen -W "' + words + '" -- "$cur") )',
    "    return 0",
    "  fi",
    '  case "$cmd" in',
  ]
  for (const command of COMMANDS) {
    const opts = [...optionsFor(command), ...globalOptions()]
    const names = opts.map((o) => o.name).join(" ")
    lines.push("    " + command + ")")
    lines.push('      COMPREPLY=( $(compgen -W "' + names + '" -- "$cur") ) ;;')
  }
  lines.push("    *) COMPREPLY=() ;;")
  lines.push("  esac")
  lines.push("}")
  lines.push("complete -F " + fn + " " + program)
  return lines.join("\n") + "\n"
}

export function zshCompletion(program = "opencode-orchestra"): string {
  const fn = "_" + program.replaceAll("-", "_")
  const lines: string[] = [
    "#compdef " + program + " bunx opencode-orchestra",
    "# zsh completion for " + program,
    fn + "() {",
    "  local -a commands",
    "  commands=(",
  ]
  for (const command of COMMANDS) {
    lines.push("    '" + command + ":" + command + " command'")
  }
  lines.push("  )")
  lines.push("  if (( CURRENT == 2 )); then")
  lines.push("    _describe 'command' commands")
  lines.push("    return")
  lines.push("  fi")
  lines.push('  case "${words[2]}" in')
  for (const command of COMMANDS) {
    const opts = optionsFor(command)
    const descriptions = opts
      .map((o) => (o.takesValue ? "'" + o.name + "[" + o.takesValue + "]'" : "'" + o.name + "'"))
      .join(" ")
    lines.push("    " + command + ")")
    if (descriptions) {
      lines.push("      _arguments " + descriptions)
    }
    lines.push("      ;;")
  }
  lines.push("  esac")
  lines.push("}")
  lines.push(fn + ' "$@"')
  return lines.join("\n") + "\n"
}

export function pwshCompletion(program = "opencode-orchestra"): string {
  const commands = COMMANDS.map((c) => "'" + c + "'").join(", ")
  const lines: string[] = [
    "# pwsh completion for " + program,
    "# Register-ArgumentCompleter -Native -CommandName " + program + " -ScriptBlock",
    "Register-ArgumentCompleter -Native -CommandName " + program + " -ScriptBlock {",
    "  param($wordToComplete, $commandAst, $cursorPosition)",
    "  $commands = @(" + commands + ")",
    "  $options = @('--help', '-h')",
    "  switch ($commandAst.CommandElements[1].Value) {",
  ]
  for (const command of COMMANDS) {
    const opts = [...optionsFor(command), ...globalOptions()]
    const names = opts.map((o) => "'" + o.name + "'")
    lines.push("    '" + command + "' { $options = @(" + names.join(", ") + ") }")
  }
  lines.push("  }")
  lines.push('  $options | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {')
  lines.push("    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterName', $_)")
  lines.push("  }")
  lines.push('  $commands | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {')
  lines.push("    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)")
  lines.push("  }")
  lines.push("}")
  return lines.join("\n") + "\n"
}

export function completionFor(shell: string, program = "opencode-orchestra"): string {
  switch (shell) {
    case "bash":
      return bashCompletion(program)
    case "zsh":
      return zshCompletion(program)
    case "pwsh":
    case "powershell":
      return pwshCompletion(program)
    default:
      throw new Error("Unsupported shell: " + shell + ". Use one of: zsh, bash, pwsh.")
  }
}

export const SHELL_NAMES = ["zsh", "bash", "pwsh"] as const
