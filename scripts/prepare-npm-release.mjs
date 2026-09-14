import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const compare = (a, b) => {
  const left = a.split('.').map(Number), right = b.split('.').map(Number)
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2]
}

export function nextVersion(manifestVersion, usedVersions) {
  if (!stable.test(manifestVersion)) throw new Error('Expected a stable package version')
  const latest = usedVersions.filter(v => stable.test(v)).sort(compare).at(-1)
  if (!latest || compare(manifestVersion, latest) > 0) return manifestVersion
  const parts = latest.split('.').map(Number)
  parts[2]++
  return parts.join('.')
}

export async function prepareRelease() {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
  const requested = process.env.RELEASE_TAG
  let tag = requested
  if (tag) {
    if (!tag.startsWith('v') || !stable.test(tag.slice(1))) throw new Error('Expected release tag vX.Y.Z')
    git('rev-parse', '--verify', `refs/tags/${tag}^{commit}`)
  } else {
    const sha = process.env.GITHUB_SHA
    if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('Missing commit SHA')
    // A rerun must reuse its reserved version, including after a partial publish.
    tag = git('tag', '--points-at', sha).split('\n')
      .filter(t => t.startsWith('v') && stable.test(t.slice(1)))
      .sort((a, b) => compare(a.slice(1), b.slice(1))).at(-1)
    if (!tag) {
      const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
      const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(manifest.name)}`, {
        signal: AbortSignal.timeout(30000),
      })
      if (!response.ok && response.status !== 404) throw new Error(`npm registry: HTTP ${response.status}`)
      const published = response.status === 404 ? [] : Object.keys((await response.json()).versions)
      const tags = git('tag', '--list', 'v*').split('\n').map(t => t.slice(1))
      tag = `v${nextVersion(manifest.version, [...tags, ...published])}`
      git('tag', tag, sha)
      git('push', 'origin', `refs/tags/${tag}`)
    }
  }
  appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\n`)
  console.log(`Release: ${tag}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await prepareRelease()
