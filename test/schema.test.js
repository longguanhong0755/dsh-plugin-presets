import assert from 'node:assert/strict'
import test from 'node:test'
import {
  computeCounts,
  effectivePatchText,
  normalizePreset,
  presetSignature,
  presetSummary,
  sanitizeConfigValue,
  targetPatchState,
  validateBundleList,
} from '../lib/preset-schema.js'
import { sampleCaptured, samplePreset } from './helpers.js'

test('createPreset computes integrity fields and a stable signature', () => {
  const preset = samplePreset('Work')
  assert.equal(preset.schemaVersion, 1)
  assert.match(preset.id, /^ps_[A-Za-z0-9_-]{3,128}$/)
  assert.equal(preset.name, 'Work')
  assert.equal(preset.captured.patchHash.length, 64)
  assert.equal(preset.captured.signature, presetSignature(preset))
  assert.equal(preset.captured.counts.bundles, 2)
  assert.equal(preset.captured.counts.entries, 2)
})

test('normalizePreset with integrity verification rejects tampered patch or signature', () => {
  const preset = samplePreset('Tamper')
  const badPatch = { ...preset, captured: { ...preset.captured, patch: `${preset.captured.patch}# changed\n` } }
  assert.throws(() => normalizePreset(badPatch, { verifyIntegrity: true }), /patch hash/)
  const badSignature = { ...preset, captured: { ...preset.captured, signature: 'f'.repeat(64) } }
  assert.throws(() => normalizePreset(badSignature, { verifyIntegrity: true }), /signature/)
})

test('normalizePreset rejects future schema versions and reserved ids', () => {
  const preset = samplePreset('Future')
  assert.throws(() => normalizePreset({ ...preset, schemaVersion: 99 }), /schema version/)
  assert.throws(() => normalizePreset({ ...preset, id: 'not-a-preset-id' }), /preset id/)
  assert.throws(() => normalizePreset({ ...preset, name: 'ps_reserved' }), /reserved/)
})

test('normalizePreset normalizes line endings and blank patches', () => {
  const preset = normalizePreset({
    id: 'ps_blank_patch',
    name: 'Blank',
    captured: { bundles: ['a'], patch: '', patchExists: false, entries: [] },
  })
  assert.equal(preset.captured.patch, '')
  assert.equal(effectivePatchText(preset), '[]\n')
  assert.equal(preset.captured.patchExists, false)
})

test('validateBundleList trims, preserves order, and rejects duplicates', () => {
  assert.deepEqual(validateBundleList([' a ', 'b', 'c']), ['a', 'b', 'c'])
  assert.throws(() => validateBundleList(['a', 'a']), /more than once/)
  assert.throws(() => validateBundleList(['a', '']), /must not be empty/)
  assert.throws(() => validateBundleList('a'), /array/)
})

test('structured edits append a generated block after the base patch', () => {
  const preset = normalizePreset({
    id: 'ps_with_edits',
    name: 'Edits',
    captured: {
      bundles: ['a'],
      patch: '- insert:\n    - id: a\n      name: a\n',
      entries: [],
      edits: [
        { id: 'a', config: { mode: 'strict', nested: { count: 2 } } },
        { id: 'b', disabled: true },
      ],
    },
  })
  const text = effectivePatchText(preset)
  assert.match(text, /# dsh-plugin-presets: structured edits \(generated; this block is appended last\)/)
  assert.match(text, /- id: "a"\n  config: \{"mode":"strict","nested":\{"count":2\}\}/)
  assert.match(text, /- id: "b"\n  disabled: true/)
  assert.equal(preset.captured.counts.edits, 2)
  assert.equal(preset.captured.counts.configuredEntries, 1)
})

test('structured edits drop an empty flow list but keep surrounding comments', () => {
  const preset = normalizePreset({
    id: 'ps_commented_empty_edits',
    name: 'Commented empty',
    captured: {
      bundles: ['a'],
      patch: '# default profile patch\n# keep these notes\n[]\n',
      entries: [],
      edits: [{ id: 'a', disabled: true }],
    },
  })
  const text = effectivePatchText(preset)
  assert.equal(text.startsWith('# default profile patch\n# keep these notes\n'), true)
  assert.equal(text.includes('\n[]'), false)
  assert.match(text, /- id: "a"\n  disabled: true\n$/)
  const state = targetPatchState(preset)
  assert.equal(state.patchExists, true)
})

test('structured edits refuse a non-empty flow-style patch', () => {
  assert.throws(() => normalizePreset({
    id: 'ps_flow_edits',
    name: 'Flow',
    captured: { bundles: ['a'], patch: '[{ insert: [] }]\n', entries: [], edits: [{ id: 'a', disabled: true }] },
  }), /flow-style/)
})

test('sanitizeConfigValue records omitted values without losing the rest', () => {
  const result = sanitizeConfigValue({ keep: 1, callback: () => {}, missing: undefined })
  assert.equal(result.value.keep, 1)
  assert.ok(result.omitted.includes('callback'))
  assert.ok(result.omitted.includes('missing'))
  assert.equal('callback' in result.value, false)
})

test('presetSummary exposes counts and hides raw patch text', () => {
  const preset = samplePreset('Summary')
  const summary = presetSummary(preset)
  assert.equal(summary.name, 'Summary')
  assert.equal(summary.patch, undefined)
  assert.equal(summary.captured, undefined)
  assert.equal(summary.counts.entries, 2)
  assert.equal(summary.signature, preset.captured.signature)
  assert.equal(computeCounts(preset).bundles, 2)
})

test('sampleCaptured fixture is independent between calls', () => {
  const first = sampleCaptured()
  first.entries[0].config.mode = 'changed'
  const second = sampleCaptured()
  assert.equal(second.entries[0].config.mode, 'balanced')
})

test('targetPatchState removes the patch file only when the preset captured none', () => {
  const absent = normalizePreset({
    id: 'ps_absent_patch',
    name: 'Absent',
    captured: { bundles: ['a'], patch: '', patchExists: false, entries: [] },
  })
  const absentState = targetPatchState(absent)
  assert.equal(absentState.patchExists, false)
  assert.equal(absentState.patchText, '')
  assert.equal(absentState.effectiveText, '[]\n')

  const present = normalizePreset({
    id: 'ps_present_patch',
    name: 'Present',
    captured: { bundles: ['a'], patch: '[]', patchExists: true, entries: [] },
  })
  const presentState = targetPatchState(present)
  assert.equal(presentState.patchExists, true)
  assert.equal(presentState.patchText, '[]')
})

test('targetPatchState keeps the patch file when edits add content to an absent patch', () => {
  const preset = normalizePreset({
    id: 'ps_absent_with_edits',
    name: 'Absent edits',
    captured: {
      bundles: ['a'],
      patch: '',
      patchExists: false,
      entries: [],
      edits: [{ id: 'a', disabled: true }],
    },
  })
  const state = targetPatchState(preset)
  assert.equal(state.patchExists, true)
  assert.match(state.patchText, /disabled: true/)
})

test('targetPatchState preserves a captured patch verbatim', () => {
  const text = '# keep me\n- insert:\n    - id: a\n      name: a\n'
  const preset = normalizePreset({
    id: 'ps_verbatim_patch',
    name: 'Verbatim',
    captured: { bundles: ['a'], patch: text, patchExists: true, entries: [] },
  })
  const state = targetPatchState(preset)
  assert.equal(state.patchExists, true)
  assert.equal(state.patchText, text)
  assert.equal(state.effectiveText, text)
})
