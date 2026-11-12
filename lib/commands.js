import { join } from 'node:path'
import { PACKAGE_NAME } from './constants.js'
import { captureEntries, captureCurrent, diffPreset, readProfileState } from './capture.js'
import { PresetError, asPresetError } from './errors.js'
import { importPresets, exportPresets } from './import-export.js'
import { parseOptions, requirePositionals, tokenize } from './parse-command.js'
import { isPlainObject } from './util.js'
import {
  errorText,
  formatApply,
  formatApplyJson,
  formatBackups,
  formatCurrent,
  formatCurrentJson,
  formatDelete,
  formatDoctor,
  formatDuplicate,
  formatEdit,
  formatExport,
  formatHelp,
  formatImport,
  formatJson,
  formatList,
  formatListJson,
  formatRename,
  formatRollback,
  formatSave,
  formatShow,
  formatValidate,
  success,
} from './format.js'

const ACTIONS = new Set([
  'list', 'ls', 'show', 'current', 'status', 'save', 'capture', 'create', 'rename', 'duplicate', 'delete', 'rm',
  'edit', 'apply', 'use', 'switch', 'validate', 'check', 'import', 'export', 'backups', 'history', 'rollback',
  'doctor', 'help',
])

const ALLOW_FLAGS = {
  'allow-missing-bundles': { kind: 'boolean' },
  'allow-overrides': { kind: 'boolean' },
  'allow-redacted': { kind: 'boolean' },
  'allow-protected': { kind: 'boolean' },
  'allow-self-disable': { kind: 'boolean' },
}

function allowOptions(flags) {
  return {
    allowMissingBundles: flags['allow-missing-bundles'] === true,
    allowOverrides: flags['allow-overrides'] === true,
    allowRedacted: flags['allow-redacted'] === true,
    allowProtected: flags['allow-protected'] === true,
    allowSelfDisable: flags['allow-self-disable'] === true,
  }
}

function currentDshVersion() {
  return import('@deepseek-ai/dsh-app-boot')
    .then((module) => module.getDshRuntimeVersion())
    .catch(() => undefined)
}

function parseJsonObject(text, label) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new PresetError('invalid-arguments', `${label} must be valid JSON: ${error.message}`, {
      nextStep: 'Pass a JSON object, for example --set plugin-id \'{"key":"value"}\'.',
    })
  }
  if (!isPlainObject(parsed)) throw new PresetError('invalid-arguments', `${label} must be a JSON object.`)
  return parsed
}

function integerIndex(text) {
  const value = Number(text)
  if (!Number.isInteger(value) || value < 1) throw new PresetError('invalid-arguments', `Bundle index ${JSON.stringify(text)} must be a positive integer (1-based).`)
  return value
}

/** Parse, execute, and render every /plugin-presets subcommand. */
export class PresetCommands {
  constructor({ ctx, store, applier, profile, logger, pluginVersion }) {
    this.ctx = ctx
    this.store = store
    this.applier = applier
    this.profile = profile
    this.logger = logger
    this.pluginVersion = pluginVersion
  }

  async #liveState() {
    const state = await readProfileState(this.profile)
    const captured = captureEntries(this.ctx.loader)
    state.entries = captured.entries
    state.entryWarnings = captured.warnings
    return state
  }

  async #origin() {
    return {
      dshVersion: await currentDshVersion(),
      profileName: this.profile.name,
      platform: process.platform,
      arch: process.arch,
      pluginVersion: this.pluginVersion,
      createdWith: `${PACKAGE_NAME}@${this.pluginVersion}`,
    }
  }

  async #assertNoPending() {
    const pending = await this.store.readPending()
    if (pending !== null && typeof pending === 'object') {
      throw new PresetError('pending-apply', 'An interrupted apply transaction is still recorded for this profile.', {
        nextStep: 'Restart DSH so startup recovery can resolve it, then run /plugin-presets doctor. Do not apply or roll back until it is resolved.',
        details: { backupId: pending.backupId, pendingId: pending.id },
      })
    }
  }

  async handle(rawInput) {
    try {
      const tokens = tokenize(rawInput)
      if (tokens.length === 0) return success(formatHelp())
      const action = tokens[0].toLowerCase()
      if (!ACTIONS.has(action)) {
        throw new PresetError('invalid-arguments', `Unknown action ${JSON.stringify(tokens[0])}.`, { nextStep: formatHelp() })
      }
      const rest = tokens.slice(1)
      switch (action) {
        case 'help': return success(formatHelp())
        case 'list':
        case 'ls': return await this.#list(rest)
        case 'show': return await this.#show(rest)
        case 'current':
        case 'status': return await this.#current(rest)
        case 'save':
        case 'capture':
        case 'create': return await this.#save(rest)
        case 'rename': return await this.#rename(rest)
        case 'duplicate': return await this.#duplicate(rest)
        case 'delete':
        case 'rm': return await this.#delete(rest)
        case 'edit': return await this.#edit(rest)
        case 'apply':
        case 'use':
        case 'switch': return await this.#apply(rest)
        case 'validate':
        case 'check': return await this.#validate(rest)
        case 'import': return await this.#import(rest)
        case 'export': return await this.#export(rest)
        case 'backups':
        case 'history': return await this.#backups(rest)
        case 'rollback': return await this.#rollback(rest)
        case 'doctor': return await this.#doctor(rest)
        default: throw new PresetError('invalid-arguments', `Unknown action ${JSON.stringify(action)}.`)
      }
    } catch (error) {
      const failure = asPresetError(error)
      if (failure.code === 'internal') this.logger?.warn?.('plugin-presets command failed: %s', failure.message)
      return { kind: 'error', text: errorText(failure) }
    }
  }

  async #list(tokens) {
    const { flags } = parseOptions(tokens, { json: { kind: 'boolean' } })
    const { presets, invalid } = await this.store.listPresets()
    const { active, error } = await this.store.readActiveSafe()
    let liveDiff
    if (active?.presetId !== undefined) {
      const preset = presets.find((item) => item.id === active.presetId)
      if (preset !== undefined) {
        try {
          liveDiff = diffPreset(preset, await this.#liveState())
        } catch {
          liveDiff = undefined
        }
      }
    }
    if (flags.json === true) {
      return success(formatListJson({ presets, invalid, active, profileName: this.profile.name }))
    }
    const text = formatList({ presets, invalid, active, profileName: this.profile.name, liveDiff })
    return success(error === undefined ? text : `${text}\nActive marker error: ${error.message}\n`)
  }

  async #show(tokens) {
    const { positionals, flags } = parseOptions(tokens, {
      json: { kind: 'boolean' },
      patch: { kind: 'boolean' },
      secrets: { kind: 'boolean' },
    })
    requirePositionals(positionals, 1, 'Usage: /plugin-presets show <name|id>', ['name-or-id'])
    const preset = await this.store.resolvePreset(positionals[0])
    const active = await this.store.readActive().catch(() => null)
    let diff
    try {
      diff = diffPreset(preset, await this.#liveState())
    } catch {
      diff = undefined
    }
    return success(formatShow(preset, {
      json: flags.json === true,
      includePatch: flags.patch === true,
      includeSecrets: flags.secrets === true,
      active: active?.presetId === preset.id,
      diff,
      dataFile: this.store.presetPath(preset.id),
    }))
  }

  async #current(tokens) {
    const { flags } = parseOptions(tokens, { json: { kind: 'boolean' } })
    const { active, error } = await this.store.readActiveSafe()
    const state = await this.#liveState()
    let preset = null
    if (active?.presetId !== undefined) preset = await this.store.readPresetById(active.presetId).catch(() => null)
    const diff = preset === null ? undefined : diffPreset(preset, state)
    const recovery = await this.store.readRecoveryReport()
    const context = {
      profileName: this.profile.name,
      active,
      preset,
      current: state,
      diff,
      recovery,
      error,
    }
    return success(flags.json === true ? formatCurrentJson(context) : formatCurrent(context))
  }

  async #save(tokens) {
    const { positionals, flags } = parseOptions(tokens, {
      description: { kind: 'value' },
      activate: { kind: 'boolean' },
    })
    requirePositionals(positionals, 1, 'Usage: /plugin-presets save <name> [--description <text>] [--activate]', ['name'])
    const captured = await captureCurrent({ profile: this.profile, loader: this.ctx.loader })
    const preset = await this.store.saveCaptured(captured.captured, {
      name: positionals[0],
      description: flags.description ?? '',
      origin: await this.#origin(),
      metadata: { source: 'saved' },
      activate: flags.activate === true,
      currentSignature: captured.state.signature,
    })
    let text = formatSave(preset, { activated: flags.activate === true })
    if (captured.warnings.length > 0) {
      text += `Warnings:\n${captured.warnings.map((warning) => `  - ${warning}`).join('\n')}\n`
    }
    return success(text)
  }

  async #rename(tokens) {
    const { positionals } = parseOptions(tokens, {})
    requirePositionals(positionals, 2, 'Usage: /plugin-presets rename <name|id> <new-name>', ['name-or-id', 'new-name'])
    const previous = await this.store.resolvePreset(positionals[0])
    const preset = await this.store.renamePreset(previous.id, positionals[1])
    return success(formatRename(preset, previous.name))
  }

  async #duplicate(tokens) {
    const { positionals } = parseOptions(tokens, {})
    requirePositionals(positionals, 2, 'Usage: /plugin-presets duplicate <name|id> <new-name>', ['name-or-id', 'new-name'])
    const source = await this.store.resolvePreset(positionals[0])
    const copy = await this.store.duplicatePreset(source.id, positionals[1])
    return success(formatDuplicate(source, copy))
  }

  async #delete(tokens) {
    const { positionals, flags } = parseOptions(tokens, { yes: { kind: 'boolean' } })
    requirePositionals(positionals, 1, 'Usage: /plugin-presets delete <name|id> --yes', ['name-or-id'])
    if (flags.yes !== true) {
      const preset = await this.store.resolvePreset(positionals[0])
      throw new PresetError('confirmation-required', `Deleting preset ${JSON.stringify(preset.name)} requires confirmation.`, {
        nextStep: `Run /plugin-presets delete ${JSON.stringify(preset.name)} --yes to delete it (a copy is kept in the trash).`,
      })
    }
    const preset = await this.store.deletePreset(positionals[0])
    return success(formatDelete(preset))
  }

  async #edit(tokens) {
    const { positionals, flags } = parseOptions(tokens, {
      description: { kind: 'value' },
      set: { kind: 'pair', multiple: true },
      unset: { kind: 'value', multiple: true },
      enable: { kind: 'value', multiple: true },
      disable: { kind: 'value', multiple: true },
      'add-bundle': { kind: 'value', multiple: true },
      'remove-bundle': { kind: 'value', multiple: true },
      'move-bundle': { kind: 'pair', multiple: true },
    })
    requirePositionals(positionals, 1, 'Usage: /plugin-presets edit <name|id> [options]', ['name-or-id'])
    const target = await this.store.resolvePreset(positionals[0])
    const sets = flags.set ?? []
    const unsets = flags.unset ?? []
    const enables = flags.enable ?? []
    const disables = flags.disable ?? []
    const adds = flags['add-bundle'] ?? []
    const removes = flags['remove-bundle'] ?? []
    const moves = flags['move-bundle'] ?? []
    const changed = flags.description !== undefined || sets.length + unsets.length + enables.length + disables.length + adds.length + removes.length + moves.length > 0
    if (!changed) {
      throw new PresetError('invalid-arguments', 'Nothing to change.', {
        nextStep: 'Pass --description, --set, --unset, --enable, --disable, --add-bundle, --remove-bundle, or --move-bundle.',
      })
    }

    const changes = {}
    const preset = await this.store.updatePreset(target.id, (draft) => {
      if (flags.description !== undefined) {
        draft.description = flags.description
        changes.description = JSON.stringify(flags.description)
      }
      const edits = Array.isArray(draft.captured.edits) ? draft.captured.edits : []
      const findEdit = (id) => edits.find((edit) => edit.id === id)
      const upsert = (id) => {
        let edit = findEdit(id)
        if (edit === undefined) {
          edit = { id }
          edits.push(edit)
        }
        return edit
      }
      const removeEdit = (id) => {
        const index = edits.findIndex((edit) => edit.id === id)
        if (index >= 0) edits.splice(index, 1)
      }
      for (const [id, json] of sets) {
        upsert(id).config = parseJsonObject(json, `--set ${id}`)
        changes.set = `${changes.set === undefined ? '' : `${changes.set}; `}${id}`
      }
      for (const id of unsets) {
        removeEdit(id)
        changes.unset = `${changes.unset === undefined ? '' : `${changes.unset}; `}${id}`
      }
      for (const id of enables) {
        upsert(id).disabled = false
        changes.enable = `${changes.enable === undefined ? '' : `${changes.enable}; `}${id}`
      }
      for (const id of disables) {
        upsert(id).disabled = true
        changes.disable = `${changes.disable === undefined ? '' : `${changes.disable}; `}${id}`
      }
      const bundles = [...draft.captured.bundles]
      for (const name of adds) {
        if (bundles.includes(name)) throw new PresetError('already-exists', `Bundle ${JSON.stringify(name)} is already in the preset.`)
        bundles.push(name)
        changes.addBundle = `${changes.addBundle === undefined ? '' : `${changes.addBundle}; `}${name}`
      }
      for (const name of removes) {
        const index = bundles.indexOf(name)
        if (index < 0) throw new PresetError('not-found', `Bundle ${JSON.stringify(name)} is not in the preset.`)
        bundles.splice(index, 1)
        changes.removeBundle = `${changes.removeBundle === undefined ? '' : `${changes.removeBundle}; `}${name}`
      }
      for (const [name, rawIndex] of moves) {
        const index = bundles.indexOf(name)
        if (index < 0) throw new PresetError('not-found', `Bundle ${JSON.stringify(name)} is not in the preset.`)
        bundles.splice(index, 1)
        const destination = Math.min(integerIndex(rawIndex), bundles.length + 1) - 1
        bundles.splice(destination, 0, name)
        changes.moveBundle = `${changes.moveBundle === undefined ? '' : `${changes.moveBundle}; `}${name} -> ${destination + 1}`
      }
      draft.captured.bundles = bundles
      draft.captured.edits = edits
      draft.metadata = {
        ...draft.metadata,
        editedAt: new Date().toISOString(),
        editCount: (draft.metadata?.editCount ?? 0) + 1,
      }
      return draft
    })
    return success(formatEdit(preset, changes))
  }

  async #apply(tokens) {
    const { positionals, flags } = parseOptions(tokens, {
      ...ALLOW_FLAGS,
      force: { kind: 'boolean' },
      json: { kind: 'boolean' },
    })
    requirePositionals(positionals, 1, 'Usage: /plugin-presets apply <name|id> [options]', ['name-or-id'])
    await this.#assertNoPending()
    const preset = await this.store.resolvePreset(positionals[0])
    const result = await this.applier.apply(preset, {
      ...allowOptions(flags),
      force: flags.force === true,
    })
    if (flags.json === true) return success(formatApplyJson(result))
    return success(formatApply(result, this.profile.name))
  }

  async #validate(tokens) {
    const { positionals, flags } = parseOptions(tokens, {
      ...ALLOW_FLAGS,
      json: { kind: 'boolean' },
    })
    requirePositionals(positionals, 1, 'Usage: /plugin-presets validate <name|id> [options]', ['name-or-id'])
    const preset = await this.store.resolvePreset(positionals[0])
    const plan = await this.applier.plan(preset, allowOptions(flags))
    if (flags.json === true) {
      return success(formatJson({
        valid: true,
        preset: plan.preset,
        bundles: plan.targetBundles,
        patchBytes: Buffer.byteLength(plan.patchText, 'utf8'),
        diff: plan.diff,
        overrides: plan.overrides,
        missingBundles: plan.missingBundles,
        warnings: plan.warnings,
      }))
    }
    return success(formatValidate(plan, this.profile.name))
  }

  async #import(tokens) {
    const { positionals, flags } = parseOptions(tokens, {
      conflict: { kind: 'value' },
      json: { kind: 'boolean' },
    })
    requirePositionals(positionals, 1, 'Usage: /plugin-presets import <file> [--conflict rename|skip|overwrite|error]', ['file'])
    const result = await importPresets(this.store, {
      profile: this.profile,
      file: positionals[0],
      conflict: flags.conflict ?? 'rename',
    })
    if (flags.json === true) return success(formatJson(result))
    return success(formatImport(result))
  }

  async #export(tokens) {
    const { positionals, flags } = parseOptions(tokens, {
      out: { kind: 'value' },
      'include-secrets': { kind: 'boolean' },
      overwrite: { kind: 'boolean' },
      json: { kind: 'boolean' },
    })
    const result = await exportPresets(this.store, {
      profile: this.profile,
      names: positionals,
      includeSecrets: flags['include-secrets'] === true,
      outPath: flags.out,
      overwrite: flags.overwrite === true,
      pluginVersion: this.pluginVersion,
    })
    if (flags.json === true) return success(formatJson(result))
    return success(formatExport(result))
  }

  async #backups(tokens) {
    const { flags } = parseOptions(tokens, { json: { kind: 'boolean' } })
    const backups = await this.store.listBackups()
    if (flags.json === true) return success(formatJson({ backups }))
    return success(formatBackups(backups))
  }

  async #rollback(tokens) {
    const { positionals, flags } = parseOptions(tokens, { force: { kind: 'boolean' }, json: { kind: 'boolean' } })
    if (positionals.length > 1) throw new PresetError('invalid-arguments', 'Usage: /plugin-presets rollback [backup-id] [--force]')
    await this.#assertNoPending()
    const result = await this.applier.rollback({ backupId: positionals[0], force: flags.force === true })
    if (flags.json === true) return success(formatJson(result))
    return success(formatRollback(result))
  }

  async #doctor(tokens) {
    const { flags } = parseOptions(tokens, { json: { kind: 'boolean' } })
    const issues = []
    const { presets, invalid } = await this.store.listPresets()
    const { active, error: activeError } = await this.store.readActiveSafe()
    let pending
    try {
      pending = await this.store.readPending()
    } catch (error) {
      pending = { unreadable: true, message: error instanceof Error ? error.message : String(error) }
      issues.push({ level: 'error', message: `pending.json is unreadable: ${pending.message}` })
    }
    const recovery = await this.store.readRecoveryReport()
    const backups = await this.store.listBackups()
    const dshVersion = await currentDshVersion()
    let current
    let profileError
    try {
      current = await this.#liveState()
    } catch (error) {
      profileError = error instanceof Error ? error.message : String(error)
      current = { bundles: [], entries: [], patchText: '', patchExists: false, patchHash: '', signature: undefined }
      issues.push({ level: 'error', message: `Cannot read the live profile: ${profileError}` })
    }

    let activePreset = null
    if (active?.presetId !== undefined) {
      try {
        activePreset = await this.store.readPresetById(active.presetId)
      } catch (error) {
        issues.push({ level: 'warn', message: `The active preset file cannot be read: ${error instanceof Error ? error.message : String(error)}` })
      }
    }
    const activePresetExists = active === null || active?.presetId === undefined ? undefined : activePreset !== null
    let matchesLive
    if (active?.appliedSignature !== undefined && profileError === undefined) {
      matchesLive = active.appliedSignature === current.signature
      if (!matchesLive) issues.push({ level: 'warn', message: 'The live profile no longer matches the active preset signature. The profile may have been edited outside the plugin.' })
    }
    if (active?.presetId !== undefined && activePreset === null) {
      issues.push({ level: 'warn', message: `The active preset ${active.presetId} no longer exists.` })
    }
    if (active !== null && active?.presetDeleted === true) {
      issues.push({ level: 'warn', message: 'The active preset was deleted; the live configuration remains in effect.' })
    }
    if (activeError !== undefined) issues.push({ level: 'warn', message: `Active marker: ${activeError.message}` })
    if (invalid.length > 0) issues.push({ level: 'warn', message: `${invalid.length} preset file(s) are unreadable; see \`list\`.` })
    if (pending !== null && pending !== undefined) {
      issues.push({ level: 'warn', message: `An interrupted apply transaction is recorded (backup ${pending.backupId ?? 'unknown'}); restart DSH to let recovery resolve it.` })
    }
    if (recovery?.action === 'needs-attention') issues.push({ level: 'warn', message: `Last recovery needs attention: ${recovery.message}` })
    if (recovery?.restartRequired === true) issues.push({ level: 'warn', message: 'The last recovery restored files; restart DSH to load them.' })

    let homeRows = 0
    let overlayRows = 0
    try {
      const { loadOptionalPatches } = await import('@deepseek-ai/dsh-app-boot')
      homeRows = (loadOptionalPatches('dsh', join(this.profile.home, 'cordis.patch.yml')) ?? []).length
      overlayRows = Array.isArray(this.profile.overlays) ? this.profile.overlays.length : 0
    } catch (error) {
      issues.push({ level: 'error', message: `Cannot read higher-priority layers: ${error instanceof Error ? error.message : String(error)}` })
    }

    const report = {
      profileName: this.profile.name,
      profileDir: this.profile.dir,
      dataDir: this.store.dir,
      pluginVersion: this.pluginVersion,
      dshVersion,
      presets: { count: presets.length, invalid },
      backups: { count: backups.length, latest: backups[0]?.id ?? null },
      active: {
        present: active !== null,
        ...(active ?? {}),
        presetExists: activePresetExists,
        matchesLive,
        error: activeError,
      },
      pending: {
        present: pending !== null && pending !== undefined,
        ...(pending ?? {}),
      },
      recovery,
      higherPriority: { present: homeRows > 0 || overlayRows > 0, homeRows, overlayRows, changed: undefined },
      profile: { ok: profileError === undefined, error: profileError, bundles: current.bundles, entries: current.entries?.length ?? 0 },
      issues,
    }
    if (flags.json === true) return success(formatJson(report))
    return success(formatDoctor(report))
  }
}

export { ACTIONS, ALLOW_FLAGS }
