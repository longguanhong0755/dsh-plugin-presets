import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, normalize, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'

import { PresetApplier } from './apply.js'
import { PresetCommands } from './commands.js'
import {
  COMMAND_NAME,
  DATA_DIR_NAME,
  DEFAULT_MAX_BACKUPS,
  DEFAULT_MAX_PRESETS,
  MAX_BACKUPS_LIMIT,
  MAX_PRESETS_LIMIT,
  PACKAGE_NAME,
} from './constants.js'
import { PresetStore } from './preset-store.js'
import { createPresetTool } from './tools.js'
import { clampInteger } from './util.js'

const name = PACKAGE_NAME
const inject = ['loader', 'profileContext']

const Config = z.object({
  dataDir: z
    .string()
    .default('')
    .description('Directory holding preset data. Empty uses $DSH_HOME/plugin-presets; relative paths resolve against the profile directory.'),
  maxPresets: z
    .number()
    .default(DEFAULT_MAX_PRESETS)
    .description(`Maximum number of presets kept per profile (1-${MAX_PRESETS_LIMIT}).`),
  maxBackups: z
    .number()
    .default(DEFAULT_MAX_BACKUPS)
    .description(`Maximum number of configuration backups kept per profile (1-${MAX_BACKUPS_LIMIT}).`),
  lockWaitMs: z
    .number()
    .default(15000)
    .description('How long to wait for another DSH writer before failing an operation (1000-120000 ms).'),
})

function readPluginVersion() {
  try {
    const document = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return typeof document.version === 'string' ? document.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function expandHome(value, home) {
  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(home, value.slice(2))
  return value
}

function resolveDataRoot(dataDir, profile) {
  const home = typeof profile.home === 'string' && profile.home.length > 0 ? profile.home : homedir()
  const raw = typeof dataDir === 'string' ? dataDir.trim() : ''
  if (raw.length === 0) return join(home, DATA_DIR_NAME)
  const expanded = expandHome(raw, home)
  return isAbsolute(expanded) ? normalize(expanded) : resolve(profile.dir, expanded)
}

function describeRecovery(recovery) {
  if (recovery === null || recovery === undefined) return undefined
  if (typeof recovery.message !== 'string') return `action=${String(recovery.action)}`
  return `action=${String(recovery.action)}: ${recovery.message}`
}

/**
 * Register preset storage, commands, and the model tool for the current profile.
 *
 * The profile files are only touched by an explicit apply/rollback. Startup
 * recovery resolves a transaction interrupted by a crash before the command
 * and tool registrations become usable.
 */
async function apply(ctx, config) {
  const profile = ctx.profileContext
  if (profile === undefined || typeof profile.dir !== 'string') {
    throw new Error('plugin-presets requires profileContext; install it in a DSH profile bundle or profile patch.')
  }
  const logger = ctx.logger
  const pluginVersion = readPluginVersion()
  const lockWaitMs = clampInteger(config.lockWaitMs, 15000, 1000, 120000)
  const store = new PresetStore({
    rootDir: resolveDataRoot(config.dataDir, profile),
    profileName: profile.name,
    profileDir: profile.dir,
    maxPresets: clampInteger(config.maxPresets, DEFAULT_MAX_PRESETS, 1, MAX_PRESETS_LIMIT),
    maxBackups: clampInteger(config.maxBackups, DEFAULT_MAX_BACKUPS, 1, MAX_BACKUPS_LIMIT),
    pluginVersion,
    lockWaitMs,
    logger,
  })
  const applier = new PresetApplier({ ctx, store, profile, logger, lockWaitMs })

  await store.init()
  try {
    const recovery = await applier.recoverOnStartup()
    if (recovery !== null && recovery !== undefined) {
      const message = describeRecovery(recovery)
      if (recovery.action === 'needs-attention') logger?.warn?.('plugin-presets startup recovery: %s', message)
      else logger?.info?.('plugin-presets startup recovery: %s', message)
    }
    await store.markLiveIfRestarted()
  } catch (error) {
    // A recovery problem must not hide the commands that let the user inspect it.
    logger?.error?.('plugin-presets startup recovery failed: %s', error instanceof Error ? error.message : String(error))
  }

  const commands = new PresetCommands({ ctx, store, applier, profile, logger, pluginVersion })
  ctx.inject(['commands'], (scope) => {
    scope.commands.register({
      name: COMMAND_NAME,
      description: 'Save, switch, import, and export named DSH plugin presets (ordered bundles and patch), with backups and rollback.',
      input: {
        hint: 'list | show <name> | current | save <name> | apply <name> | import <file> | export | doctor',
      },
      handler: (invocation) => commands.handle(typeof invocation.rawInput === 'string' ? invocation.rawInput : ''),
    })
  })

  ctx.inject(['tools'], (scope) => {
    scope.tools.register(
      createPresetTool({
        ctx: scope,
        store,
        applier,
        profile,
        logger,
        pluginVersion,
      }),
    )
  })

  logger?.info?.('plugin-presets %s ready for profile %s (data: %s)', pluginVersion, profile.name, store.dir)
}

export { Config, apply, inject, name }
export default { name, inject, Config, apply }
