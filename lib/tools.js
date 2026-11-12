import { defineTool } from '@deepseek-ai/dsh-tools'
import { TOOL_NAME } from './constants.js'
import { captureEntries, captureCurrent, diffPreset, readProfileState } from './capture.js'
import { PresetError, asPresetError } from './errors.js'
import { exportPresets, importPresets } from './import-export.js'
import { presetSummary } from './preset-schema.js'
import { presetForExport } from './redact.js'
import { isPlainObject } from './util.js'

function summaryOf(preset) {
  return presetSummary(preset)
}

function toolError(error) {
  const failure = asPresetError(error)
  const next = failure.nextStep === undefined ? '' : ` Next: ${failure.nextStep}`
  return new Error(`${failure.code}: ${failure.message}${next}`)
}

function requireName(args) {
  if (typeof args.name !== 'string' || args.name.trim().length === 0) throw new PresetError('invalid-arguments', 'name is required for this action.')
  return args.name
}

function configEditsOf(args) {
  const edits = args.configEdits ?? []
  if (!Array.isArray(edits)) throw new PresetError('invalid-arguments', 'configEdits must be an array.')
  const result = []
  for (const [index, edit] of edits.entries()) {
    if (!isPlainObject(edit)) throw new PresetError('invalid-arguments', `configEdits[${index}] must be an object.`)
    if (typeof edit.id !== 'string' || edit.id.length === 0) throw new PresetError('invalid-arguments', `configEdits[${index}].id must be a non-empty string.`)
    if (edit.config !== undefined && !isPlainObject(edit.config)) throw new PresetError('invalid-arguments', `configEdits[${index}].config must be an object.`)
    if (edit.disabled !== undefined && typeof edit.disabled !== 'boolean') throw new PresetError('invalid-arguments', `configEdits[${index}].disabled must be a boolean.`)
    if (edit.config === undefined && edit.disabled === undefined) throw new PresetError('invalid-arguments', `configEdits[${index}] changes nothing.`)
    result.push(edit)
  }
  return result
}

function assertBundles(value) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
    throw new PresetError('invalid-arguments', 'bundles must be an array of non-empty package names.')
  }
  return value.map((item) => item.trim())
}

/** Model-facing tool: list/view/switch presets and edit their ordered bundles/config overrides. */
export function createPresetTool({ ctx, store, applier, profile, logger, pluginVersion }) {
  const liveState = async () => {
    const state = await readProfileState(profile)
    state.entries = captureEntries(ctx.loader).entries
    return state
  }
  const dshVersion = async () => {
    try {
      const { getDshRuntimeVersion } = await import('@deepseek-ai/dsh-app-boot')
      return getDshRuntimeVersion()
    } catch {
      return undefined
    }
  }
  const assertNoPending = async () => {
    const pending = await store.readPending()
    if (pending !== null && typeof pending === 'object') {
      throw new PresetError('pending-apply', 'An interrupted apply transaction is recorded; restart DSH before applying or rolling back.', {
        details: { backupId: pending.backupId },
      })
    }
  }
  const approve = async (exec, subject, justification) => {
    const approval = ctx.get('approval')
    if (approval === undefined || typeof approval.request !== 'function') {
      throw new PresetError('approval-unavailable', `The DSH approval service is unavailable, so the model tool cannot ${subject}.`, {
        nextStep: 'Run the same operation with the /plugin-presets command instead.',
      })
    }
    if (exec.agent === undefined) {
      throw new PresetError('approval-unavailable', `This call has no agent to route approval for ${subject} through.`, {
        nextStep: 'Run the operation with the /plugin-presets command instead.',
      })
    }
    const outcome = await approval.request({
      agent: exec.agent,
      toolName: TOOL_NAME,
      callId: exec.callId,
      reason: `plugin-presets: ${subject}`,
      displayReason: justification,
      ...(exec.signal === undefined ? {} : { signal: exec.signal }),
    })
    if (outcome !== 'allowed-once') {
      const detail = outcome === 'rejected'
        ? 'the user rejected it'
        : outcome === 'cancelled' ? 'approval was cancelled' : 'no approval channel is available'
      throw new PresetError('approval-denied', `${subject[0].toUpperCase()}${subject.slice(1)} was not approved: ${detail}.`, {
        nextStep: 'Nothing was changed. Ask the user before trying again.',
      })
    }
  }

  return defineTool({
    name: TOOL_NAME,
    description: 'Manage named DSH plugin presets for the current profile. A preset snapshots the ordered dsh.profile.bundles list and the complete cordis.patch.yml. list/show/current/validate/doctor are read-only. apply and rollback rewrite this profile for every session, require approval, always create an exact backup, and automatically restore it on failure. save captures the live configuration. Import/export use the versioned dsh-plugin-presets JSON format; exported secrets are redacted unless includeSecrets is explicitly true. After apply, check application: when it is restart-required, tell the user to restart DSH.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'show', 'current', 'save', 'rename', 'duplicate', 'delete', 'edit', 'apply', 'validate', 'import', 'export', 'backups', 'rollback', 'doctor'], description: 'Operation to perform.' },
      name: { type: 'string', description: 'Preset name or ps_ id. Required for show, save, rename, duplicate, delete, edit, apply, and validate.' },
      newName: { type: 'string', description: 'New name for rename and duplicate.' },
      description: { type: 'string', description: 'Description for save or edit.' },
      activate: { type: 'boolean', description: 'For save: record the saved preset as active without changing files.' },
      bundles: { type: 'array', items: { type: 'string' }, description: 'For edit: replacement ordered bundle list. The dsh-plugin-presets bundle should stay present.' },
      configEdits: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: 'Loader row id to target.' },
            config: { type: 'json', description: 'Complete replacement config object for that row.' },
            disabled: { type: 'boolean', description: 'Enable or disable that row in the structured edit block.' },
          },
        },
        description: 'For edit: structured edits appended to the preset patch, one per row id.',
      },
      file: { type: 'string', description: 'Import/export file path. Relative paths resolve against the DSH working directory.' },
      outFile: { type: 'string', description: 'For export: destination file. Defaults to the plugin data exports directory.' },
      includeSecrets: { type: 'boolean', description: 'For export: include secret-looking values. Requires approval and produces a sensitive file.' },
      overwrite: { type: 'boolean', description: 'For export: replace an existing destination file.' },
      conflict: { type: 'string', enum: ['rename', 'skip', 'overwrite', 'error'], description: 'For import: how to handle a preset name that already exists. Defaults to rename.' },
      backupId: { type: 'string', description: 'For rollback: backup id; defaults to the newest applied backup.' },
      force: { type: 'boolean', description: 'For apply: apply even when the live profile already matches. For rollback: restore even when live files changed since the backup.' },
      yes: { type: 'boolean', description: 'Must be true for delete. Confirms deleting the preset file (a trash copy is kept).' },
      allowMissingBundles: { type: 'boolean', description: 'For apply/validate: permit bundles this profile cannot resolve (DSH will skip them).' },
      allowOverrides: { type: 'boolean', description: 'For apply/validate: permit a home patch or command-line overlay that changes the effective rows.' },
      allowRedacted: { type: 'boolean', description: 'For apply/validate: permit writing "<redacted>" placeholders from a secret-free export.' },
      allowProtected: { type: 'boolean', description: 'For apply/validate: permit disabling core plugin-management modules. Dangerous.' },
      allowSelfDisable: { type: 'boolean', description: 'For apply/validate: permit removing dsh-plugin-presets itself. The command disappears until restored manually.' },
      includePatch: { type: 'boolean', description: 'For show: include the full patch text (redacted) instead of a preview.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: (args) => ['list', 'show', 'current', 'validate', 'backups', 'doctor'].includes(args.action),
    async execute(args, exec) {
      try {
        const action = args.action
        if (action === 'apply' || action === 'rollback' || (action === 'export' && args.includeSecrets === true)) {
          const subject = action === 'apply'
            ? 'applying a plugin preset'
            : action === 'rollback' ? 'rolling back a plugin preset' : 'exporting plugin presets with secrets'
          const justification = action === 'export'
            ? 'The export file will contain API keys or other credentials in readable form.'
            : 'This rewrites the current profile package.json and cordis.patch.yml for every DSH session. An exact backup is created and restored automatically on failure.'
          await approve(exec, subject, justification)
        }
        exec.signal.throwIfAborted?.()

        switch (action) {
          case 'list': {
            const { presets, invalid } = await store.listPresets()
            const { active, error } = await store.readActiveSafe()
            let diff
            if (active?.presetId !== undefined) {
              const preset = presets.find((item) => item.id === active.presetId)
              if (preset !== undefined) {
                try {
                  diff = diffPreset(preset, await liveState())
                } catch {
                  diff = undefined
                }
              }
            }
            return JSON.stringify({ profile: profile.name, active, activeError: error, presets: presets.map(summaryOf), invalid, activeDiff: diff })
          }
          case 'show': {
            const preset = await store.resolvePreset(requireName(args))
            const active = await store.readActive().catch(() => null)
            let diff
            try {
              diff = diffPreset(preset, await liveState())
            } catch {
              diff = undefined
            }
            const shown = presetForExport(preset, { includeSecrets: false }).preset
            return JSON.stringify({
              preset: shown,
              active: active?.presetId === preset.id,
              drift: diff,
              redactedForDisplay: true,
              patchPreview: args.includePatch === true ? shown.captured.patch : shown.captured.patch.slice(0, 4000),
              patchTruncated: args.includePatch !== true && shown.captured.patch.length > 4000,
            })
          }
          case 'current': {
            const { active, error } = await store.readActiveSafe()
            const state = await liveState()
            let preset = null
            if (active?.presetId !== undefined) preset = await store.readPresetById(active.presetId).catch(() => null)
            const diff = preset === null ? undefined : diffPreset(preset, state)
            const recovery = await store.readRecoveryReport()
            return JSON.stringify({
              profile: profile.name,
              active,
              activeError: error,
              preset: preset === null ? null : summaryOf(preset),
              liveBundles: state.bundles,
              patchBytes: Buffer.byteLength(state.patchText ?? '', 'utf8'),
              patchHash: state.patchHash,
              drift: diff,
              recovery,
            })
          }
          case 'save': {
            const captured = await captureCurrent({ profile, loader: ctx.loader })
            const preset = await store.saveCaptured(captured.captured, {
              name: requireName(args),
              description: args.description ?? '',
              origin: {
                dshVersion: await dshVersion(),
                profileName: profile.name,
                platform: process.platform,
                arch: process.arch,
                pluginVersion,
                createdWith: `plugin-presets@${pluginVersion}`,
              },
              metadata: { source: 'saved' },
              activate: args.activate === true,
              currentSignature: captured.state.signature,
            })
            return JSON.stringify({ preset: summaryOf(preset), activated: args.activate === true, warnings: captured.warnings })
          }
          case 'rename': {
            const target = await store.resolvePreset(requireName(args))
            if (typeof args.newName !== 'string' || args.newName.trim().length === 0) throw new PresetError('invalid-arguments', 'newName is required for rename.')
            const preset = await store.renamePreset(target.id, args.newName)
            return JSON.stringify({ renamedFrom: target.name, preset: summaryOf(preset) })
          }
          case 'duplicate': {
            const target = await store.resolvePreset(requireName(args))
            if (typeof args.newName !== 'string' || args.newName.trim().length === 0) throw new PresetError('invalid-arguments', 'newName is required for duplicate.')
            const copy = await store.duplicatePreset(target.id, args.newName)
            return JSON.stringify({ source: summaryOf(target), preset: summaryOf(copy) })
          }
          case 'delete': {
            if (args.yes !== true) {
              const target = await store.resolvePreset(requireName(args))
              return JSON.stringify({
                confirmationRequired: true,
                preset: summaryOf(target),
                nextStep: 'Ask the user to confirm, then call again with yes:true. The preset file is deleted but a trash copy is kept; the live profile is unchanged.',
              })
            }
            const preset = await store.deletePreset(requireName(args))
            return JSON.stringify({ deleted: summaryOf(preset), liveProfileChanged: false })
          }
          case 'edit': {
            const target = await store.resolvePreset(requireName(args))
            const bundles = assertBundles(args.bundles)
            const edits = configEditsOf(args)
            if (args.description === undefined && bundles === undefined && edits.length === 0) {
              throw new PresetError('invalid-arguments', 'Nothing to change: pass description, bundles, or configEdits.')
            }
            const changes = {}
            const preset = await store.updatePreset(target.id, (draft) => {
              if (args.description !== undefined) {
                draft.description = args.description
                changes.description = true
              }
              if (bundles !== undefined) {
                draft.captured.bundles = bundles
                changes.bundles = bundles
              }
              if (edits.length > 0) {
                const current = Array.isArray(draft.captured.edits) ? draft.captured.edits : []
                for (const edit of edits) {
                  let row = current.find((item) => item.id === edit.id)
                  if (row === undefined) {
                    row = { id: edit.id }
                    current.push(row)
                  }
                  if (edit.config !== undefined) row.config = edit.config
                  if (edit.disabled !== undefined) row.disabled = edit.disabled
                }
                draft.captured.edits = current
                changes.configEdits = edits.map((edit) => edit.id)
              }
              draft.metadata = {
                ...draft.metadata,
                editedAt: new Date().toISOString(),
                editCount: (draft.metadata?.editCount ?? 0) + 1,
              }
              return draft
            })
            return JSON.stringify({ preset: summaryOf(preset), changes })
          }
          case 'apply': {
            await assertNoPending()
            const preset = await store.resolvePreset(requireName(args))
            const result = await applier.apply(preset, {
              allowMissingBundles: args.allowMissingBundles === true,
              allowOverrides: args.allowOverrides === true,
              allowRedacted: args.allowRedacted === true,
              allowProtected: args.allowProtected === true,
              allowSelfDisable: args.allowSelfDisable === true,
              force: args.force === true,
            })
            return JSON.stringify({
              changed: result.changed,
              application: result.application,
              restartReason: result.restartReason,
              nextStep: result.application === 'applied'
                ? undefined
                : 'Tell the user to restart DSH to load the applied configuration.',
              backupId: result.backupId,
              preset: result.plan.preset,
              bundles: result.plan.targetBundles,
              warnings: result.warnings,
              overrides: result.plan.overrides,
              diff: result.diff,
            })
          }
          case 'validate': {
            const preset = await store.resolvePreset(requireName(args))
            const plan = await applier.plan(preset, {
              allowMissingBundles: args.allowMissingBundles === true,
              allowOverrides: args.allowOverrides === true,
              allowRedacted: args.allowRedacted === true,
              allowProtected: args.allowProtected === true,
              allowSelfDisable: args.allowSelfDisable === true,
            })
            return JSON.stringify({
              valid: true,
              preset: plan.preset,
              bundles: plan.targetBundles,
              patchBytes: Buffer.byteLength(plan.patchText, 'utf8'),
              diff: plan.diff,
              missingBundles: plan.missingBundles,
              overrides: plan.overrides,
              warnings: plan.warnings,
            })
          }
          case 'import': {
            if (typeof args.file !== 'string' || args.file.length === 0) throw new PresetError('invalid-arguments', 'file is required for import.')
            const result = await importPresets(store, { profile, file: args.file, conflict: args.conflict ?? 'rename' })
            return JSON.stringify(result)
          }
          case 'export': {
            const result = await exportPresets(store, {
              profile,
              names: Array.isArray(args.name) ? args.name : args.name === undefined ? [] : [args.name],
              includeSecrets: args.includeSecrets === true,
              outPath: typeof args.outFile === 'string' ? args.outFile : undefined,
              overwrite: args.overwrite === true,
              pluginVersion,
            })
            return JSON.stringify(result)
          }
          case 'backups': {
            const backups = await store.listBackups()
            return JSON.stringify({ backups })
          }
          case 'rollback': {
            await assertNoPending()
            const result = await applier.rollback({ backupId: args.backupId, force: args.force === true })
            return JSON.stringify({
              ...result,
              nextStep: result.application === 'applied' ? undefined : 'Tell the user to restart DSH to load the restored configuration.',
            })
          }
          case 'doctor': {
            const { presets, invalid } = await store.listPresets()
            const { active, error } = await store.readActiveSafe()
            const pending = await store.readPending().catch((failure) => ({ unreadable: true, message: failure.message }))
            const recovery = await store.readRecoveryReport()
            return JSON.stringify({
              profile: profile.name,
              dataDir: store.dir,
              dshVersion: await dshVersion(),
              presets: { count: presets.length, invalid },
              active,
              activeError: error,
              pending: pending === null ? null : pending,
              recovery,
              backupCount: (await store.listBackups()).length,
            })
          }
          default: throw new PresetError('invalid-arguments', `Unknown action ${JSON.stringify(action)}.`)
        }
      } catch (error) {
        logger?.warn?.('plugin-presets tool %s failed: %s', args.action, error instanceof Error ? error.message : String(error))
        throw toolError(error)
      }
    },
  })
}
