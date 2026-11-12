import { containsRedactedMarker, presetForExport, redactConfig } from './redact.js'
import { presetSummary } from './preset-schema.js'
import { humanBytes, truncate } from './util.js'

function json(value) {
  return `${JSON.stringify(value, undefined, 2)}\n`
}

function bullet(text, indent = '  ') {
  return `${indent}- ${text}`
}

function yesNo(value) {
  return value ? 'yes' : 'no'
}

function displayPreset(preset, includeSecrets) {
  return includeSecrets ? structuredClone(preset) : presetForExport(preset, { includeSecrets: false }).preset
}

function formatDiff(diff) {
  if (diff === undefined || diff === null) return []
  if (diff.same) return ['Live profile matches this preset (bundles and patch).']
  const lines = []
  if (diff.addedBundles.length > 0) lines.push(`Live-only bundles: ${diff.addedBundles.join(', ')}`)
  if (diff.removedBundles.length > 0) lines.push(`Preset-only bundles: ${diff.removedBundles.join(', ')}`)
  if (diff.reordered) lines.push('Bundle order differs.')
  if (diff.patchChanged) lines.push(`Patch differs (${humanBytes(diff.currentPatchBytes)} live vs ${humanBytes(diff.presetPatchBytes)} preset).`)
  if (diff.entriesChanged) lines.push(`Entry drift: ${diff.addedEntries} added, ${diff.removedEntries} removed, ${diff.changedEntries} changed (informational).`)
  return lines
}

export function formatHelp() {
  return `Plugin presets for DSH

Usage:
  /plugin-presets list [--json]
  /plugin-presets show <name|id> [--json] [--patch] [--secrets]
  /plugin-presets current [--json]
  /plugin-presets save <name> [--description <text>] [--activate]
  /plugin-presets capture <name> [--description <text>] [--activate]   (alias of save)
  /plugin-presets rename <name|id> <new-name>
  /plugin-presets duplicate <name|id> <new-name>
  /plugin-presets delete <name|id> [--yes]
  /plugin-presets edit <name|id>
      [--description <text>] [--set <entry-id> <json>] [--unset <entry-id>]
      [--enable <entry-id>] [--disable <entry-id>]
      [--add-bundle <package>] [--remove-bundle <package>]
      [--move-bundle <package> <index>]
  /plugin-presets apply <name|id> [--allow-missing-bundles] [--allow-overrides]
      [--allow-redacted] [--allow-protected] [--allow-self-disable] [--force]
  /plugin-presets validate <name|id> [--json] [--allow-...]
  /plugin-presets import <file> [--conflict rename|skip|overwrite|error] [--json]
  /plugin-presets export [name|id ...] [--out <file>] [--include-secrets] [--overwrite]
  /plugin-presets backups [--json]
  /plugin-presets rollback [backup-id] [--force]
  /plugin-presets doctor [--json]
  /plugin-presets help

Apply restores the preset's ordered bundle list and complete cordis.patch.yml. It always writes an exact
backup first and automatically restores it if applying fails. Presets live under $DSH_HOME/plugin-presets/.
Run /plugin-presets doctor after a crash or a suspicious result.`
}

export function formatList({ presets, invalid, active, profileName, liveDiff }) {
  const lines = [`Plugin presets — profile ${JSON.stringify(profileName)} — ${presets.length} preset(s)`]
  if (active === null || active === undefined) {
    lines.push('Active preset: (none recorded)')
  } else {
    lines.push(`Active preset: ${active.presetDeleted ? 'deleted: ' : ''}${active.presetName ?? active.presetId ?? '(unknown)'} — ${active.application ?? 'unknown'}${active.restartReason === undefined ? '' : ` (${active.restartReason})`}${active.appliedAt === undefined ? '' : `, applied ${active.appliedAt}`}`)
  }
  if (presets.length === 0) {
    lines.push('')
    lines.push('No presets yet. Save the current configuration with:')
    lines.push('  /plugin-presets save <name>')
  }
  for (const preset of presets) {
    const summary = presetSummary(preset)
    const marker = active?.presetId === preset.id ? ' [active]' : ''
    lines.push('')
    lines.push(`${preset.name}${marker}  (${preset.id})`)
    lines.push(`  ${summary.counts.bundles} bundles, ${summary.counts.entries} entries, ${summary.counts.edits} structured edit(s) · updated ${preset.updatedAt}`)
    if (preset.description.length > 0) lines.push(`  ${truncate(preset.description.replace(/\n/g, ' '), 160)}`)
    if (summary.redacted) lines.push('  Exported without secrets: contains redacted placeholders.')
    if (marker && liveDiff !== undefined) {
      for (const line of formatDiff(liveDiff)) lines.push(`  ${line}`)
    }
  }
  if (invalid.length > 0) {
    lines.push('')
    lines.push(`Unreadable preset files: ${invalid.length}`)
    for (const item of invalid.slice(0, 20)) lines.push(bullet(`${item.id}: ${item.message}`))
    lines.push('Run /plugin-presets doctor for details.')
  }
  return `${lines.join('\n')}\n`
}

export function formatListJson({ presets, invalid, active, profileName }) {
  return json({
    profile: profileName,
    active,
    presets: presets.map(presetSummary),
    invalid,
  })
}

export function formatShow(preset, options = {}) {
  const shown = displayPreset(preset, options.includeSecrets === true)
  const summary = presetSummary(preset)
  if (options.json === true) {
    const text = shown.captured.patch ?? ''
    const patchPreview = options.includePatch === true ? text : text.slice(0, 4000)
    const result = {
      ...shown,
      captured: {
        ...shown.captured,
        patch: patchPreview,
        ...(options.includePatch === true || text.length <= 4000 ? {} : { patchTruncated: true }),
      },
      active: options.active === true,
      drift: options.diff,
      redactedForDisplay: options.includeSecrets !== true,
      dataFile: options.dataFile,
    }
    return json(result)
  }
  const lines = []
  lines.push(`Preset: ${preset.name}`)
  lines.push(`Id: ${preset.id}`)
  lines.push(`Active: ${yesNo(options.active === true)}`)
  if (preset.description.length > 0) lines.push(`Description: ${preset.description}`)
  lines.push(`Created: ${preset.createdAt}`)
  lines.push(`Updated: ${preset.updatedAt}`)
  lines.push(`Captured: ${preset.captured.capturedAt}${preset.origin?.dshVersion === undefined ? '' : ` by DSH ${preset.origin.dshVersion}`}${preset.origin?.profileName === undefined ? '' : ` on profile ${JSON.stringify(preset.origin.profileName)}`}`)
  lines.push(`Counts: ${summary.counts.bundles} bundles, ${summary.counts.entries} entries (${summary.counts.enabledEntries} enabled), ${summary.counts.configuredEntries} configured, ${summary.counts.edits} structured edit(s)`)
  if (summary.redacted) lines.push('Secrets: exported without secrets; "<redacted>" placeholders are stored literally.')
  if (options.active === true) {
    for (const line of formatDiff(options.diff)) lines.push(`Drift: ${line}`)
  }
  lines.push('')
  lines.push(`Bundles, in order (${preset.captured.bundles.length}):`)
  if (preset.captured.bundles.length === 0) lines.push('  (none)')
  preset.captured.bundles.forEach((name, index) => lines.push(`  ${index + 1}. ${name}`))
  lines.push('')
  lines.push(`Entries (${shown.captured.entries.length}):`)
  if (shown.captured.entries.length === 0) lines.push('  (none captured)')
  for (const entry of shown.captured.entries) {
    const state = entry.enabled === false ? 'disabled' : entry.active === false ? 'inactive' : 'enabled'
    lines.push(`  ${entry.id} — ${entry.name} [${state}]`)
    const config = JSON.stringify(entry.config ?? {})
    if (config !== '{}') lines.push(`      config: ${truncate(config, 1200)}`)
  }
  if ((preset.captured.edits ?? []).length > 0) {
    lines.push('')
    lines.push(`Structured edits (${preset.captured.edits.length}):`)
    for (const edit of shown.captured.edits) {
      lines.push(`  ${edit.id}${edit.disabled === undefined ? '' : edit.disabled ? ' disabled' : ' enabled'}${edit.config === undefined ? '' : ` config: ${truncate(JSON.stringify(edit.config), 800)}`}`)
    }
  }
  lines.push('')
  const patchText = shown.captured.patch ?? ''
  lines.push(`Patch: ${humanBytes(Buffer.byteLength(preset.captured.patch ?? '', 'utf8'))}${preset.captured.patchExists ? '' : ' (file absent at capture)'} hash ${preset.captured.patchHash ?? '(none)'}`)
  if (patchText.trim().length === 0 || patchText.trim() === '[]') {
    lines.push('  (empty patch)')
  } else if (options.includePatch === true) {
    lines.push(patchText)
  } else {
    lines.push('  Preview (use --patch for the full text):')
    for (const line of patchText.split('\n').slice(0, 30)) lines.push(`  | ${line}`)
    if (patchText.split('\n').length > 30) lines.push('  | …')
  }
  if (containsRedactedMarker(shown.captured)) lines.push('Note: this display redacts secret-looking values; use --secrets to show them.')
  if (options.dataFile !== undefined) lines.push(`Data file: ${options.dataFile}`)
  return `${lines.join('\n')}\n`
}

export function formatCurrent({ profileName, active, preset, current, diff, recovery, error }) {
  const lines = [`Live profile: ${profileName} (${current.bundles.length} bundles, ${current.entries?.length ?? 0} entries)`]
  if (error !== undefined) lines.push(`Active marker error: ${error.message}`)
  if (active === null || active === undefined) {
    lines.push('Active preset: (none recorded)')
    lines.push('The live profile configuration is shown below; save it with /plugin-presets save <name>.')
  } else {
    lines.push(`Active preset: ${active.presetDeleted ? '(deleted) ' : ''}${active.presetName ?? active.presetId ?? '(unknown)'}`)
    lines.push(`Preset id: ${active.presetId ?? '(unknown)'}`)
    lines.push(`Application: ${active.application ?? 'unknown'}${active.restartReason === undefined ? '' : ` — ${active.restartReason}`}`)
    if (active.appliedAt !== undefined) lines.push(`Applied at: ${active.appliedAt}`)
    if (active.backupId !== null && active.backupId !== undefined) lines.push(`Backup: ${active.backupId}`)
    if (active.presetDeleted === true) lines.push('The preset file was deleted; the live configuration is unchanged.')
    if (preset !== null && preset !== undefined && preset.captured.signature !== active.presetSignature) {
      lines.push('The active preset has been edited since it was applied.')
    }
  }
  if (diff !== undefined) {
    lines.push('')
    lines.push(`Live vs active preset: ${diff.same ? 'identical configuration' : 'different'}`)
    for (const line of formatDiff(diff)) lines.push(`  ${line}`)
  }
  if (active?.overridesPresent === true) lines.push('Higher-priority layers were present when the preset was applied.')
  if (active?.warnings?.length > 0) {
    lines.push('')
    lines.push('Last apply warnings:')
    for (const warning of active.warnings.slice(0, 20)) lines.push(bullet(warning))
  }
  if (recovery !== null && recovery !== undefined) {
    lines.push('')
    lines.push(`Last recovery: ${recovery.action} — ${recovery.message}`)
  }
  lines.push('')
  lines.push('Live bundles, in order:')
  current.bundles.forEach((name, index) => lines.push(`  ${index + 1}. ${name}`))
  return `${lines.join('\n')}\n`
}

export function formatCurrentJson({ profileName, active, preset, current, diff, recovery, error }) {
  return json({
    profile: profileName,
    active,
    preset: preset === null || preset === undefined ? null : presetSummary(preset),
    live: {
      bundles: current.bundles,
      patchBytes: Buffer.byteLength(current.patchText ?? '', 'utf8'),
      patchHash: current.patchHash,
      patchExists: current.patchExists,
      entries: (current.entries ?? []).map((entry) => ({
        ...entry,
        config: redactConfig(entry.config ?? {}).value,
      })),
      redactedForDisplay: true,
    },
    diff,
    recovery,
    error,
  })
}

export function formatSave(preset, { activated = false } = {}) {
  return `Saved preset ${JSON.stringify(preset.name)} (${preset.id}) from the live profile.\n`
    + `  ${preset.captured.counts.bundles} bundles, ${preset.captured.counts.entries} entries, ${humanBytes(Buffer.byteLength(preset.captured.patch, 'utf8'))} patch\n`
    + (activated ? 'Marked this preset as the active preset (the live profile was not changed).\n' : '')
}

export function formatRename(preset, oldName) {
  return `Renamed preset ${JSON.stringify(oldName)} to ${JSON.stringify(preset.name)} (${preset.id}).\n`
}

export function formatDuplicate(source, copy) {
  return `Duplicated preset ${JSON.stringify(source.name)} as ${JSON.stringify(copy.name)} (${copy.id}).\n`
}

export function formatDelete(preset) {
  return `Deleted preset ${JSON.stringify(preset.name)} (${preset.id}).\n`
    + 'A copy was kept in the plugin data trash directory; the live profile was not changed.\n'
}

export function formatEdit(preset, changes) {
  const parts = Object.entries(changes).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${value}`)
  return `Updated preset ${JSON.stringify(preset.name)} (${preset.id})${parts.length === 0 ? '.' : ` — ${parts.join(', ')}.`}\n`
}

export function formatApply(result, profileName) {
  if (result.changed === false) {
    return `Preset ${JSON.stringify(result.plan.preset.name)} already matches the live profile; recorded it as active without changing files.\n`
  }
  const lines = [`Applied preset ${JSON.stringify(result.plan.preset.name)} to profile ${JSON.stringify(profileName)}.`]
  lines.push(`  Bundles: ${result.plan.targetBundles.length}`)
  if (result.application === 'applied') {
    lines.push('  Application: applied live (HMR reconciled the running profile).')
  } else {
    lines.push(`  Application: restart required${result.restartReason === undefined ? '' : ` (${result.restartReason})`}. Restart DSH to load the applied configuration.`)
  }
  lines.push(`  Backup of the previous configuration: ${result.backupId}`)
  if (result.plan.overrides.present) lines.push(`  Higher-priority layers were present${result.plan.overrides.changed ? ' and changed the effective rows' : ''}.`)
  if (result.warnings.length > 0) {
    lines.push('  Warnings:')
    for (const warning of result.warnings.slice(0, 30)) lines.push(bullet(warning, '    '))
  }
  lines.push('Rollback with: /plugin-presets rollback ' + result.backupId)
  return `${lines.join('\n')}\n`
}

export function formatApplyJson(result) {
  return json({
    changed: result.changed,
    application: result.application,
    restartReason: result.restartReason,
    backupId: result.backupId,
    preset: result.plan?.preset,
    bundles: result.plan?.targetBundles,
    warnings: result.warnings ?? [],
    overrides: result.plan?.overrides,
    diff: result.diff,
  })
}

export function formatValidate(plan, profileName) {
  const lines = [`Preset ${JSON.stringify(plan.preset.name)} is valid for profile ${JSON.stringify(profileName)}.`]
  lines.push(`Would write ${plan.targetBundles.length} bundles and ${humanBytes(Buffer.byteLength(plan.patchText, 'utf8'))} of patch text.`)
  lines.push(`Live profile: ${plan.diff.same ? 'already identical' : 'would change'}.`)
  if (plan.warnings.length > 0) {
    lines.push('Warnings:')
    for (const warning of plan.warnings.slice(0, 30)) lines.push(bullet(warning))
  }
  return `${lines.join('\n')}\n`
}

export function formatImport(result) {
  const lines = [`Imported ${result.imported.length} preset(s) from ${result.file} (format v${result.formatVersion ?? '?'}).`]
  for (const item of result.imported) {
    const detail = item.action === 'renamed'
      ? `renamed from ${JSON.stringify(item.renamedFrom)}`
      : item.action === 'replaced' ? 'replaced the existing preset' : 'new'
    lines.push(`  + ${item.name} — ${detail}`)
  }
  if (result.skipped.length > 0) {
    lines.push(`Skipped ${result.skipped.length}:`)
    for (const item of result.skipped) lines.push(bullet(`${item.name} — ${item.reason}`))
  }
  if (result.warnings.length > 0) {
    lines.push('Warnings:')
    for (const warning of result.warnings.slice(0, 30)) lines.push(bullet(warning))
  }
  lines.push('Imported presets are not applied automatically. Use /plugin-presets apply <name>.')
  return `${lines.join('\n')}\n`
}

export function formatExport(result) {
  const lines = [`Exported ${result.count} preset(s) to ${result.file} (${humanBytes(result.bytes)}).`]
  if (result.includeSecrets) lines.push('Secrets: included. Protect this file like a credential store.')
  else lines.push(`Secrets: redacted (${result.redaction.fields} field(s) replaced). Re-enter them after importing.`)
  return `${lines.join('\n')}\n`
}

export function formatBackups(backups) {
  const lines = [`Backups (${backups.length}):`]
  if (backups.length === 0) lines.push('  (none)')
  for (const backup of backups) {
    const preset = backup.preset?.name ?? backup.presetName ?? '—'
    lines.push(`  ${backup.id}  ${backup.createdAt}  ${backup.status ?? 'unknown'}  ${preset}${backup.reason === undefined ? '' : ` (${backup.reason})`}`)
  }
  return `${lines.join('\n')}\n`
}

export function formatRollback(result) {
  return `Restored backup ${result.backupId}.\n`
    + `  Application: ${result.application === 'applied' ? 'applied live' : `restart required${result.restartReason === undefined ? '' : ` (${result.restartReason})`}`}\n`
    + `  Safety backup of the pre-rollback files: ${result.safetyBackupId}\n`
}

export function formatDoctor(report) {
  const lines = [`Plugin presets doctor — ${report.profileName}`]
  lines.push(`  Data directory: ${report.dataDir}`)
  lines.push(`  Plugin version: ${report.pluginVersion}`)
  lines.push(`  DSH version: ${report.dshVersion ?? 'unknown'}`)
  lines.push(`  Presets: ${report.presets.count} valid, ${report.presets.invalid.length} unreadable`)
  lines.push(`  Backups: ${report.backups.count}`)
  lines.push(`  Active marker: ${report.active.present ? `${report.active.presetName ?? report.active.presetId} (${report.active.application ?? 'unknown'})` : 'not set'}`)
  if (report.active.error !== undefined) lines.push(`  Active marker problem: ${report.active.error}`)
  if (report.active.presetExists === false) lines.push('  Warning: the active preset file no longer exists.')
  if (report.active.matchesLive === false) lines.push('  Warning: the live profile no longer matches the active preset.')
  lines.push(`  Pending apply transaction: ${report.pending.present ? `yes (${report.pending.backupId ?? 'no backup id'})` : 'no'}`)
  if (report.recovery !== null && report.recovery !== undefined) {
    lines.push(`  Last recovery: ${report.recovery.action} — ${report.recovery.message}`)
  }
  if (report.higherPriority.present) {
    lines.push(`  Higher-priority layers: home=${report.higherPriority.homeRows}, overlays=${report.higherPriority.overlayRows}${report.higherPriority.changed ? ' (they change effective rows)' : '' }`)
  }
  if (report.profile.error !== undefined) lines.push(`  Profile check failed: ${report.profile.error}`)
  if (report.issues.length === 0) lines.push('  Result: OK')
  else {
    lines.push(`  Result: ${report.issues.length} issue(s)`)
    for (const issue of report.issues) lines.push(bullet(`${issue.level.toUpperCase()}: ${issue.message}`))
  }
  return `${lines.join('\n')}\n`
}

export function success(text) {
  return { kind: 'success', text }
}

export function errorText(error) {
  const lines = [`Error${error?.code === undefined ? '' : ` [${error.code}]`}: ${error?.message ?? String(error)}`]
  if (error?.nextStep !== undefined) lines.push(`Next: ${error.nextStep}`)
  if (error?.details !== undefined) {
    const details = JSON.stringify(error.details)
    if (details !== undefined && details !== '{}') lines.push(`Details: ${truncate(details, 4000)}`)
  }
  return `${lines.join('\n')}\n`
}

export { json as formatJson, formatDiff, displayPreset }
