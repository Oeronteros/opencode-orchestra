import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runVoiceEditor, voiceEditorCommand } from '../src/voice-editor.js'

test('launcher quotes the executable and CLI paths for OpenCode EDITOR', () => {
  assert.equal(
    voiceEditorCommand('C:\\Program Files\\nodejs\\node.exe', 'C:\\Program Files\\orchestra\\cli.js'),
    '"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\orchestra\\cli.js" voice-editor',
  )
})

test('voice editor appends transcript to the draft OpenCode handed it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'voice-editor-test-'))
  const file = path.join(dir, 'draft.txt')
  try {
    await writeFile(file, 'Существующий черновик')
    const calls: string[] = []
    await runVoiceEditor(file, {
      start: async () => { calls.push('start') },
      stop: async () => { calls.push('stop'); return 'новый текст' },
      cancel: async () => { calls.push('cancel') },
    }, async () => { calls.push('keypress') })
    assert.equal(await readFile(file, 'utf8'), 'Существующий черновик новый текст')
    assert.deepEqual(calls, ['start', 'keypress', 'stop'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('cancelled voice editor leaves the draft untouched', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'voice-editor-test-'))
  const file = path.join(dir, 'draft.txt')
  try {
    await writeFile(file, 'keep this')
    let cancelled = false
    await assert.rejects(runVoiceEditor(file, {
      start: async () => undefined,
      stop: async () => 'not inserted',
      cancel: async () => { cancelled = true },
    }, async () => { throw new Error('cancelled') }), /cancelled/)
    assert.equal(await readFile(file, 'utf8'), 'keep this')
    assert.equal(cancelled, true)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
