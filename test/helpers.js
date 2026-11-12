import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PresetStore } from '../lib/preset-store.js'
import { createPreset } from '../lib/preset-schema.js'

export async function makeTempDir(prefix = 'dsh-presets-test-') {
  return await mkdtemp(join(tmpdir(), prefix))
}

export async function createTempStore() {
  const dir = await makeTempDir()
  const store = new PresetStore({
    rootDir: dir,
    profileName: 'desktop',
    profileDir: join(dir, 'profile'),
    maxPresets: 100,
    maxBackups: 20,
    pluginVersion: '1.0.0-test',
    lockWaitMs: 5000,
  })
  await store.init()
  return {
    dir,
    store,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

export function sampleCaptured(overrides = {}) {
  return {
    bundles: ['@deepseek-ai/dsh-base', 'demo-plugin'],
    patch: [
      "# demo profile patch",
      '- insert:',
      '    - id: demo',
      "      name: 'demo-plugin'",
      '      config:',
      '        apiKey: "sk-live-abcdefghijklmnop"',
      '        mode: balanced',
      '',
    ].join('\n'),
    patchExists: true,
    entries: [
      {
        id: 'demo',
        name: 'demo-plugin',
        enabled: true,
        order: 0,
        config: { apiKey: 'sk-live-abcdefghijklmnop', nested: { token: 'token-value' }, mode: 'balanced' },
      },
      {
        id: 'base',
        name: '@deepseek-ai/dsh-base',
        enabled: true,
        order: 1,
        config: { theme: 'dark' },
      },
    ],
    ...overrides,
  }
}

export function samplePreset(name, options = {}) {
  return createPreset({
    name,
    description: options.description ?? '',
    captured: sampleCaptured(options.captured),
    origin: { dshVersion: '0.2.0', profileName: 'desktop' },
    metadata: options.metadata,
    id: options.id,
    now: options.now ?? '2026-01-01T00:00:00.000Z',
  })
}
