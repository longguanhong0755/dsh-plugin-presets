import assert from 'node:assert/strict'
import test from 'node:test'
import {
  containsRedactedMarker,
  isSensitiveKey,
  presetForExport,
  redactConfig,
  redactPatchText,
} from '../lib/redact.js'
import { samplePreset } from './helpers.js'

test('isSensitiveKey recognizes conventional secret names and suffixes', () => {
  for (const key of ['apiKey', 'API-KEY', 'client_secret', 'accessToken', 'password', 'Authorization', 'dbPassword', 'privateKey']) {
    assert.equal(isSensitiveKey(key), true, key)
  }
  for (const key of ['mode', 'model', 'timeout', 'url', 'name', 'tokenizer']) {
    assert.equal(isSensitiveKey(key), false, key)
  }
})

test('redactConfig replaces secret values but keeps structure', () => {
  const { value, paths } = redactConfig({
    mode: 'balanced',
    apiKey: 'sk-live-abcdefghijklmnop',
    headers: { Authorization: 'Bearer abcdefghijklmnop', accept: 'json' },
    list: [{ token: 'abc' }, { name: 'safe' }],
    empty: '',
  })
  assert.equal(value.mode, 'balanced')
  assert.equal(value.apiKey, '<redacted>')
  assert.equal(value.headers.Authorization, '<redacted>')
  assert.equal(value.headers.accept, 'json')
  assert.equal(value.list[0].token, '<redacted>')
  assert.equal(value.list[1].name, 'safe')
  assert.equal(value.empty, '')
  assert.ok(paths.includes('apiKey'))
  assert.ok(paths.includes('headers.Authorization'))
  assert.ok(paths.includes('list[0].token'))
})

test('redactConfig redacts URL userinfo', () => {
  const { value } = redactConfig({ endpoint: 'https://user:pass@example.com/v1' })
  assert.equal(value.endpoint, 'https://<redacted>@example.com/v1')
})

test('redactPatchText preserves comments and non-secret expressions', () => {
  const input = [
    '# keep this comment',
    '- id: demo',
    '  config:',
    '    apiKey: "sk-live-abcdefghijklmnop"',
    '    token: !!js process.env.DEMO_TOKEN',
    '    mode: balanced',
    '',
  ].join('\n')
  const result = redactPatchText(input)
  assert.match(result.text, /# keep this comment/)
  assert.match(result.text, /apiKey: "<redacted>"/)
  assert.match(result.text, /token: !!js process\.env\.DEMO_TOKEN/)
  assert.match(result.text, /mode: balanced/)
  assert.equal(result.expressionsPreserved, 1)
})

test('redactPatchText replaces block scalars owned by a sensitive key', () => {
  const input = ['secret: |', '  line one', '  line two', 'mode: strict', ''].join('\n')
  const result = redactPatchText(input)
  assert.match(result.text, /secret: \|/)
  assert.match(result.text, /  <redacted>/)
  assert.doesNotMatch(result.text, /line one/)
  assert.match(result.text, /mode: strict/)
})

test('redactPatchText redacts literal secrets inside !!js expressions only when literal', () => {
  const input = ['token: !!js "sk-live-abcdefghijklmnop"', ''].join('\n')
  const result = redactPatchText(input)
  assert.match(result.text, /token: "<redacted>"/)
})

test('presetForExport redacts by default, including structured edits', () => {
  const preset = samplePreset('Secrets')
  preset.captured.edits = [{ id: 'demo', config: { apiKey: 'sk-live-abcdefghijklmnop' } }]
  const { preset: exported, redaction } = presetForExport(preset)
  assert.equal(exported.metadata.redacted, true)
  assert.equal(exported.captured.entries[0].config.apiKey, '<redacted>')
  assert.equal(exported.captured.entries[0].config.mode, 'balanced')
  assert.equal(exported.captured.edits[0].config.apiKey, '<redacted>')
  assert.match(exported.captured.patch, /"<redacted>"/)
  assert.equal(exported.captured.patchHash, undefined)
  assert.equal(redaction.applied, true)
  assert.ok(redaction.fields > 0)
  assert.equal(containsRedactedMarker(exported), true)
})

test('presetForExport keeps secrets when explicitly requested', () => {
  const preset = samplePreset('Secrets')
  const { preset: exported, redaction } = presetForExport(preset, { includeSecrets: true })
  assert.equal(exported.metadata.secretsIncluded, true)
  assert.equal(exported.captured.entries[0].config.apiKey, 'sk-live-abcdefghijklmnop')
  assert.equal(exported.captured.patchHash, preset.captured.patchHash)
  assert.equal(redaction.applied, false)
  assert.equal(containsRedactedMarker(exported), false)
})
