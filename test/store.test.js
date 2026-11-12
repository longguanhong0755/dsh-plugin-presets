import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { PresetStore } from '../lib/preset-store.js'
import { samplePreset } from './helpers.js'
import { createTempStore } from './helpers.js'

test('store persists presets and the active marker across instances', async () => {
  const { dir, store, cleanup } = await createTempStore()
  try {
    const saved = await store.savePreset(samplePreset('Work'))
    assert.equal(saved.name, 'Work')
    assert.equal((await store.listPresets()).presets.length, 1)

    await store.setActive(saved, { application: 'applied', appliedSignature: saved.captured.signature })

    const reopened = new PresetStore({
      rootDir: dir,
      profileName: 'desktop',
      profileDir: join(dir, 'profile'),
      maxPresets: 100,
      maxBackups: 20,
      lockWaitMs: 5000,
    })
    const presets = await reopened.listPresets()
    assert.equal(presets.presets.length, 1)
    assert.equal(presets.presets[0].id, saved.id)
    const active = await reopened.readActive()
    assert.equal(active.presetId, saved.id)
    assert.equal(active.presetName, 'Work')
    assert.equal(active.application, 'applied')
  } finally {
    await cleanup()
  }
})

test('resolvePreset is case-insensitive by name and accepts ids', async () => {
  const { store, cleanup } = await createTempStore()
  try {
    const saved = await store.savePreset(samplePreset('My Work'))
    assert.equal((await store.resolvePreset('my work')).id, saved.id)
    assert.equal((await store.resolvePreset(saved.id)).id, saved.id)
    await assert.rejects(store.resolvePreset('missing'), /No preset named/)
  } finally {
    await cleanup()
  }
})

test('savePreset refuses duplicate names case-insensitively', async () => {
  const { store, cleanup } = await createTempStore()
  try {
    await store.savePreset(samplePreset('Work'))
    await assert.rejects(store.savePreset(samplePreset('work')), /already exists/)
    assert.equal((await store.listPresets()).presets.length, 1)
  } finally {
    await cleanup()
  }
})

test('rename, duplicate, and delete keep files and the active marker consistent', async () => {
  const { store, cleanup } = await createTempStore()
  try {
    const saved = await store.savePreset(samplePreset('Work'))
    await store.setActive(saved, { appliedSignature: saved.captured.signature })

    const renamed = await store.renamePreset(saved.id, 'Office')
    assert.equal(renamed.name, 'Office')
    assert.equal((await store.readActive()).presetName, 'Office')

    const copy = await store.duplicatePreset(saved.id, 'Office Copy')
    assert.notEqual(copy.id, saved.id)
    assert.equal(copy.captured.signature, saved.captured.signature)
    assert.equal((await store.listPresets()).presets.length, 2)

    const deleted = await store.deletePreset(copy.id)
    assert.equal(deleted.name, 'Office Copy')
    assert.equal((await store.listPresets()).presets.length, 1)
    const trash = await store.listTrash()
    assert.equal(trash.length, 1)
    assert.equal(trash[0].name, 'Office Copy')
  } finally {
    await cleanup()
  }
})

test('deleting the active preset marks the marker instead of clearing it', async () => {
  const { store, cleanup } = await createTempStore()
  try {
    const saved = await store.savePreset(samplePreset('Work'))
    await store.setActive(saved, { appliedSignature: saved.captured.signature })
    await store.deletePreset(saved.id)
    const active = await store.readActive()
    assert.equal(active.presetId, saved.id)
    assert.equal(active.presetDeleted, true)
  } finally {
    await cleanup()
  }
})

test('listPresets reports malformed files without failing the whole list', async () => {
  const { store, cleanup } = await createTempStore()
  try {
    await store.savePreset(samplePreset('Good'))
    await writeFile(join(store.presetsDir, 'ps_broken_file.json'), '{ not json', 'utf8')
    const list = await store.listPresets()
    assert.equal(list.presets.length, 1)
    assert.equal(list.invalid.length, 1)
    assert.match(list.invalid[0].file, /ps_broken_file\.json$/)
    assert.equal(list.invalid[0].code, 'invalid-preset')
  } finally {
    await cleanup()
  }
})

test('savePresetBatch validates every entry before writing any', async () => {
  const { store, cleanup } = await createTempStore()
  try {
    const first = samplePreset('First')
    const second = { ...samplePreset('Second'), captured: { bundles: [], patch: 5 } }
    await assert.rejects(store.savePresetBatch([{ preset: first }, { preset: second }]), /patch/)
    assert.equal((await store.listPresets()).presets.length, 0)
  } finally {
    await cleanup()
  }
})

test('savePresetBatch replaces an existing preset by replaceId', async () => {
  const { store, cleanup } = await createTempStore()
  try {
    const saved = await store.savePreset(samplePreset('Work'))
    const replacement = samplePreset('Work Replaced', { captured: { bundles: ['@deepseek-ai/dsh-base'], patch: '[]\n' } })
    const written = await store.savePresetBatch([{ preset: replacement, replaceId: saved.id }])
    assert.equal(written.length, 1)
    assert.equal(written[0].id, saved.id)
    assert.equal(written[0].name, 'Work Replaced')
    const list = await store.listPresets()
    assert.equal(list.presets.length, 1)
    assert.equal(list.presets[0].captured.bundles.length, 1)
  } finally {
    await cleanup()
  }
})

test('createBackup accepts a safety copy with no after state', async () => {
  const { store, cleanup } = await createTempStore()
  try {
    const before = {
      manifestText: '{"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base"]}}}\n',
      patchText: '[]\n',
      patchExists: true,
    }
    const backup = await store.createBackup({ reason: 'pre-rollback', preset: null, before, after: null })
    assert.equal(backup.meta.after, null)
    assert.equal(backup.meta.reason, 'pre-rollback')
    assert.equal(backup.meta.before.patchExists, true)
    const loaded = await store.loadBackup(backup.id)
    assert.equal(loaded.manifestText, before.manifestText)
    assert.equal(loaded.patchText, before.patchText)
  } finally {
    await cleanup()
  }
})

test('createBackup records the after state of an apply', async () => {
  const { store, cleanup } = await createTempStore()
  try {
    const before = { manifestText: '{"a":1}\n', patchText: '', patchExists: false }
    const after = { manifestText: '{"a":2}\n', patchText: '- id: x\n', patchExists: true }
    const backup = await store.createBackup({ reason: 'apply', preset: null, before, after })
    assert.equal(typeof backup.meta.after.manifestHash, 'string')
    assert.equal(backup.meta.after.patchExists, true)
    assert.equal(backup.meta.after.patchHash.length, 64)
  } finally {
    await cleanup()
  }
})

test('maxPresets is enforced on save', async () => {
  const { dir, cleanup } = await createTempStore()
  try {
    const store = new PresetStore({
      rootDir: dir,
      profileName: 'small',
      profileDir: join(dir, 'profile'),
      maxPresets: 1,
      maxBackups: 1,
      lockWaitMs: 5000,
    })
    await store.savePreset(samplePreset('One'))
    await assert.rejects(store.savePreset(samplePreset('Two')), /limit|at most|maximum/i)
  } finally {
    await cleanup()
  }
})
