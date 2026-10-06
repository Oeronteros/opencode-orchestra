import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  fallbackPhysicalCores,
  parseCoreCountOutput,
  parseProcCpuinfo,
  physicalCoreCount,
  threadOverride,
  voiceThreadCount,
} from '../src/voice-threads.js'

describe('voice thread policy', () => {
  it('accepts a bounded explicit override and ignores junk', () => {
    assert.equal(threadOverride({ ORCHESTRA_VOICE_THREADS: '8' }), 8)
    assert.equal(threadOverride({ ORCHESTRA_VOICE_THREADS: ' 6 ' }), 6)
    assert.equal(threadOverride({}), null)
    assert.equal(threadOverride({ ORCHESTRA_VOICE_THREADS: '0' }), null)
    assert.equal(threadOverride({ ORCHESTRA_VOICE_THREADS: '-2' }), null)
    assert.equal(threadOverride({ ORCHESTRA_VOICE_THREADS: '9999' }), null)
    assert.equal(threadOverride({ ORCHESTRA_VOICE_THREADS: 'half' }), null)
  })

  it('counts unique physical/core pairs from /proc/cpuinfo', () => {
    const sample = [
      'processor\t: 0',
      'physical id\t: 0',
      'core id\t\t: 0',
      '',
      'processor\t: 1',
      'physical id\t: 0',
      'core id\t\t: 0',
      '',
      'processor\t: 2',
      'physical id\t: 0',
      'core id\t\t: 1',
      '',
      'processor\t: 3',
      'physical id\t: 1',
      'core id\t\t: 0',
      '',
    ].join('\n')
    assert.equal(parseProcCpuinfo(sample), 3)
    assert.equal(parseProcCpuinfo('processor\t: 0\nBogoMIPS\t: 100\n'), null)
  })

  it('sums NumberOfCores across sockets and survives header output', () => {
    assert.equal(parseCoreCountOutput('NumberOfCores=8\r\n\r\n'), 8)
    assert.equal(parseCoreCountOutput('NumberOfCores=4\r\nNumberOfCores=4\r\n'), 8)
    assert.equal(parseCoreCountOutput('6\r\n'), 6)
    assert.equal(parseCoreCountOutput('NumberOfCores\r\n\r\n'), null)
  })

  it('detects Linux physical cores through /proc/cpuinfo and falls back safely', async () => {
    const proc = 'physical id : 0\ncore id : 0\n\nphysical id : 0\ncore id : 1\n\n'
    assert.equal(await physicalCoreCount({
      platform: 'linux', logical: 8,
      readFile: async (file) => { assert.equal(file, '/proc/cpuinfo'); return proc },
    }), 2)
    assert.equal(await physicalCoreCount({
      platform: 'linux', logical: 8,
      readFile: async () => { throw new Error('ENOENT') },
    }), fallbackPhysicalCores(8))
  })

  it('detects Windows cores with wmic first and PowerShell as a fallback', async () => {
    const calls: string[] = []
    assert.equal(await physicalCoreCount({
      platform: 'win32', logical: 16,
      run: async (file) => { calls.push(file); return 'NumberOfCores=8\r\n' },
    }), 8)
    assert.deepEqual(calls, ['wmic'])
    assert.equal(await physicalCoreCount({
      platform: 'win32', logical: 12,
      run: async (file, args) => {
        if (file === 'wmic') throw new Error('ENOENT')
        assert.equal(file, 'powershell.exe')
        assert.ok(args.includes('-NoProfile'))
        return '6\r\n'
      },
    }), 6)
  })

  it('honors the environment override before any detection', async () => {
    let probed = false
    const value = await voiceThreadCount({ ORCHESTRA_VOICE_THREADS: '7' }, {
      platform: 'linux', logical: 32,
      readFile: async () => { probed = true; return '' },
    })
    assert.equal(value, 7)
    assert.equal(probed, false)
  })

  it('never returns fewer than one thread', async () => {
    assert.equal(await physicalCoreCount({ platform: 'darwin', logical: 0 }), 1)
    assert.equal(fallbackPhysicalCores(1), 1)
    assert.equal(fallbackPhysicalCores(2), 2)
    assert.equal(fallbackPhysicalCores(5), 5)
  })
})
