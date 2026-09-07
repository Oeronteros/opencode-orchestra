import readline from "node:readline"

const lines = readline.createInterface({ input: process.stdin })
lines.on("line", (line) => {
  const message = JSON.parse(line)
  if (message.method === "initialize") {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fixture", version: "1" } } })}\n`)
  } else if (message.method === "tools/list") {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: ["ping", "git_status", "dump_syntax_tree"].map((name) => ({ name, description: "fixture", inputSchema: { type: "object" } })) } })}\n`)
  } else if (message.method === "tools/call") {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "pong" }] } })}\n`)
  }
})
