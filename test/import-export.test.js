import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { exportPresets, importPresets, planImport, resolveUserPath } from '../lib/import-export.js'
import { EXPORT_FORMAT, EXPORT_FORMAT_VERSION } from '../lib/constants.js'
import { samplePreset } from './helpers.js'
import { createTempStore } from './helpers.js'

function profileFor(dir) {
  return {
    name: 'desktop',
    dir: join(dir, 'profile'),
    cwd: dir,
    installAnchor: dir,
  }
}

test('export writes a versioned envelope with secrets redacted by default', async () => {
  const { dir, store, cleanup } = await createTempStore()
  try {
    await store.savePreset(samplePreset('Work'))
    const target = join(dir, 'export.json')
    const result = await exportPresets(store, {
      profile: profileFor(dir),
      outPath: target,
      pluginVersion: '1.0.0-test',
    })
    assert.equal(result.count, 1)
    assert.equal(result.includeSecrets, false)
    assert.equal(result.redaction.applied, true)
    const parsed = JSON.parse(await readFile(target, 'utf8'))
    assert.equal(parsed.format, EXPORT_FORMAT)
    assert.equal(parsed.formatVersion, EXPORT_FORMAT_VERSION)
    assert.equal(parsed.count, 1)
    assert.equal(parsed.includeSecrets, false)
    assert.match(parsed.presets[0].captured.patch, /"<redacted>"/)
    assert.equal(parsed.presets[0].captured.entries[0].config.apiKey, '<redacted>')
  } finally {
    await cleanup()
  }
})

test('export can include secrets and refuses to overwrite without permission', async () => {
  const { dir, store, cleanup } = await createTempStore()
  try {
    await store.savePreset(samplePreset('Work'))
    const target = join(dir, 'secrets.json')
    const result = await exportPresets(store, {
      profile: profileFor(dir),
      outPath: target,
      includeSecrets: true,
    })
    assert.equal(result.redaction.applied, false)
    const parsed = JSON.parse(await readFile(target, 'utf8'))
    assert.equal(parsed.presets[0].captured.entries[0].config.apiKey, 'sk-live-abcdefghijklmnop')
    await assert.rejects(
      exportPresets(store, { profile: profileFor(dir), outPath: target }),
      /already exists/,
    )
    await assert.doesNotReject(
      exportPresets(store, { profile: profileFor(dir), outPath: target, overwrite: true }),
    )
  } finally {
    await cleanup()
  }
})

test('import renames conflicts by default and preserves provenance metadata', async () => {
  const { dir, store, cleanup } = await createTempStore()
  try {
    await store.savePreset(samplePreset('Work'))
    const target = join(dir, 'export.json')
    await exportPresets(store, { profile: profileFor(dir), outPath: target })
    const result = await importPresets(store, { profile: profileFor(dir), file: target })
    assert.equal(result.count, 1)
    assert.equal(result.imported[0].name, 'Work (imported)')
    assert.equal(result.imported[0].action, 'renamed')
    assert.equal((await store.listPresets()).presets.length, 2)
    const imported = await store.resolvePreset('Work (imported)')
    assert.equal(imported.metadata.source, 'imported')
    assert.equal(imported.metadata.imported.originalName, 'Work')
    assert.equal(imported.id.startsWith('ps_'), true)
  } finally {
    await cleanup()
  }
})

test('import conflict policies skip, overwrite, and error', async () => {
  const { dir, store, cleanup } = await createTempStore()
  try {
    await store.savePreset(samplePreset('Work'))
    const target = join(dir, 'export.json')
    await exportPresets(store, { profile: profileFor(dir), outPath: target })

    const skip = await importPresets(store, { profile: profileFor(dir), file: target, conflict: 'skip' })
    assert.equal(skip.count, 0)
    assert.equal(skip.skipped.length, 1)
    assert.equal(skip.skipped[0].reason, 'name-already-exists')

    const overwrite = await importPresets(store, { profile: profileFor(dir), file: target, conflict: 'overwrite' })
    assert.equal(overwrite.count, 1)
    assert.equal(overwrite.imported[0].action, 'replaced')
    assert.equal((await store.listPresets()).presets.length, 1)

    await assert.rejects(
      importPresets(store, { profile: profileFor(dir), file: target, conflict: 'error' }),
      /already exists/,
    )
  } finally {
    await cleanup()
  }
})

test('import accepts a bare preset and warns about it', async () => {
  const { dir, store, cleanup } = await createTempStore()
  try {
    const bare = samplePreset('Bare')
    const file = join(dir, 'bare.json')
    await writeFile(file, JSON.stringify(bare, undefined, 2), 'utf8')
    const result = await importPresets(store, { profile: profileFor(dir), file })
    assert.equal(result.count, 1)
    assert.match(result.warnings.join('\n'), /bare preset/)
  } finally {
    await cleanup()
  }
})

test('import reports malformed JSON and incompatible formats without writing', async () => {
  const { dir, store, cleanup } = await createTempStore()
  try {
    const malformed = join(dir, 'malformed.json')
    await writeFile(malformed, '{ nope', 'utf8')
    await assert.rejects(importPresets(store, { profile: profileFor(dir), file: malformed }), /not valid JSON/)

    const future = join(dir, 'future.json')
    await writeFile(future, JSON.stringify({
      format: EXPORT_FORMAT,
      formatVersion: EXPORT_FORMAT_VERSION + 1,
      presets: [],
    }), 'utf8')
    await assert.rejects(importPresets(store, { profile: profileFor(dir), file: future }), /format version/)

    const wrongFormat = join(dir, 'wrong.json')
    await writeFile(wrongFormat, JSON.stringify({ format: 'other', formatVersion: 1, presets: [] }), 'utf8')
    await assert.rejects(importPresets(store, { profile: profileFor(dir), file: wrongFormat }), /Unsupported import format/)

    assert.equal((await store.listPresets()).presets.length, 0)
  } finally {
    await cleanup()
  }
})

test('import rejects duplicate names inside the file and invalid presets atomically', async () => {
  const { dir, store, cleanup } = await createTempStore()
  try {
    const first = samplePreset('Duplicate')
    const second = samplePreset('duplicate')
    const duplicateFile = join(dir, 'duplicates.json')
    await writeFile(duplicateFile, JSON.stringify({
      format: EXPORT_FORMAT,
      formatVersion: EXPORT_FORMAT_VERSION,
      presets: [first, second],
    }), 'utf8')
    await assert.rejects(importPresets(store, { profile: profileFor(dir), file: duplicateFile }), /more than once/)

    const invalidFile = join(dir, 'invalid.json')
    await writeFile(invalidFile, JSON.stringify({
      format: EXPORT_FORMAT,
      formatVersion: EXPORT_FORMAT_VERSION,
      presets: [samplePreset('Fine'), { ...samplePreset('Broken'), captured: { bundles: [], patch: 1 } }],
    }), 'utf8')
    await assert.rejects(importPresets(store, { profile: profileFor(dir), file: invalidFile }), /is invalid/)
    assert.equal((await store.listPresets()).presets.length, 0)
  } finally {
    await cleanup()
  }
})

test('planImport writes the accepted presets and returns their plans', async () => {
  const { dir, store, cleanup } = await createTempStore()
  try {
    await store.savePreset(samplePreset('Work'))
    const target = join(dir, 'export.json')
    await exportPresets(store, { profile: profileFor(dir), outPath: target })
    const before = (await store.listPresets()).presets.length
    await planImport(store, { profile: profileFor(dir), file: target })
    assert.ok((await store.listPresets()).presets.length > before)
  } finally {
    await cleanup()
  }
})

test('resolveUserPath expands home and resolves relative paths against cwd', () => {
  const profile = { cwd: 'D:\\work', dir: 'D:\\profile' }
  assert.equal(resolveUserPath(profile, 'file.json'), join('D:\\work', 'file.json'))
  assert.match(resolveUserPath(profile, '~/file.json'), /file\.json$/)
  assert.equal(resolveUserPath(profile, 'C:\\tmp\\file.json'), 'C:\\tmp\\file.json')
  assert.throws(() => resolveUserPath(profile, '   '), /path is required/)
})
