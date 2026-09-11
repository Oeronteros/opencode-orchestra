import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

// A matrix rerun may follow a successful publish on just one platform.
// Skip only an exact published version; authentication/network errors must fail.
const directory = path.resolve(process.argv[2])
const { name, version } = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'))
const npmCli = process.env.npm_execpath
const command = npmCli ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm')
const run = (args, options = {}) => spawnSync(command, [...(npmCli ? [npmCli] : []), ...args], {
  encoding: 'utf8', shell: !npmCli && process.platform === 'win32', ...options,
})
const result = run(['view', `${name}@${version}`, 'version', '--json', '--registry=https://registry.npmjs.org'])
if (result.error) throw result.error
if (result.status === 0) {
  if (JSON.parse(result.stdout) !== version) throw new Error('Unexpected registry version response')
  console.log(`${name}@${version} already published; skipping`)
} else {
  let code
  try { code = JSON.parse(result.stdout).error?.code } catch {}
  if (code !== 'E404') throw new Error(result.stderr || result.stdout || 'Registry lookup failed')
  const published = run(['publish', '--access', 'public', '--registry=https://registry.npmjs.org'], { cwd: directory, stdio: 'inherit' })
  if (published.error) throw published.error
  if (published.status !== 0) process.exit(published.status ?? 1)
}
