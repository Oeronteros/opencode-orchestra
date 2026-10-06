// Minimal whisper CLI stand-in: writes the transcript next to `-of` and
// echoes the received `-t` thread count so tests can assert the flag.
import { writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const of = args[args.indexOf('-of') + 1]!
const threads = args[args.indexOf('-t') + 1] ?? 'missing'
const language = args[args.indexOf('-l') + 1] ?? 'missing'
writeFileSync(`${of}.txt`, `threads=${threads} language=${language}`)
