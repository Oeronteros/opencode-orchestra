// A recorder child that flushes a fixture WAV and exits when Stop sends q.
import { copyFileSync } from 'node:fs'
copyFileSync(process.argv[2]!, process.argv[3]!)
process.stdin.on('data', (chunk: Buffer) => {
  if (chunk.toString().includes('q')) process.exit(0)
})
