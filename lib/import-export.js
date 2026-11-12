import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { stat } from 'node:fs/promises'
import {
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  MAX_IMPORT_BYTES,
  MAX_PRESETS_LIMIT,
  PACKAGE_NAME,
} from './constants.js'
import { PresetError } from './errors.js'
import { ensureDir, readFileLimited, statSafe, writeFileAtomic } from './io.js'
import { normalizePreset, presetSummary } from './preset-schema.js'
import { presetForExport } from './redact.js'
import {
  compareSemver,
  isoNow,
  nameKey,
  newPresetId,
  parseSemver,
  uniqueDisplayName,
} from './util.js'

async function currentDshVersion() {
  try {
    const { getDshRuntimeVersion } = await import('@deepseek-ai/dsh-app-boot')
    return getDshRuntimeVersion()
  } catch {
    return undefined
  }
}

async function missingBundlesFor(preset, profile) {
  let resolveBundleDir
  try {
    ;({ resolveBundleDir } = await import('@deepseek-ai/dsh-app-boot'))
  } catch {
    return []
  }
  const missing = []
  for (const name of preset.captured.bundles) {
    try {
      resolveBundleDir('dsh', name, profile.installAnchor, profile.dir)
    } catch {
      missing.push(name)
    }
  }
  return missing
}

export function resolveUserPath(profile, input) {
  const text = String(input ?? '').trim()
  if (text.length === 0) throw new PresetError('invalid-arguments', 'A file path is required.')
  if (text === '~') return homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2))
  return isAbsolute(text) ? text : resolve(profile.cwd, text)
}

function exportFilename(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
  return `plugin-presets-${stamp}.json`
}

async function isDirectory(filename) {
  try {
    return (await stat(filename)).isDirectory()
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

/**
 * Export selected presets (or all) as one versioned envelope.
 * @param {import('./preset-store.js').PresetStore} store
 * @param {{profile: object, names?: string[], includeSecrets?: boolean, outPath?: string, overwrite?: boolean, pluginVersion?: string}} options
 */
export async function exportPresets(store, options) {
  const { profile } = options
  const all = await store.listPresets()
  let selected
  if (Array.isArray(options.names) && options.names.length > 0) {
    selected = []
    const seen = new Set()
    for (const name of options.names) {
      const preset = await store.resolvePreset(name)
      if (!seen.has(preset.id)) {
        seen.add(preset.id)
        selected.push(preset)
      }
    }
  } else {
    selected = all.presets
  }
  if (selected.length === 0) {
    throw new PresetError('nothing-to-export', 'There are no presets to export.', {
      nextStep: 'Save the current configuration first with /plugin-presets save <name>.',
    })
  }

  const includeSecrets = options.includeSecrets === true
  const exportedAt = isoNow()
  const dshVersion = await currentDshVersion()
  const prepared = []
  const redactionPaths = []
  let expressionsPreserved = 0
  for (const preset of selected) {
    const { preset: exported, redaction } = presetForExport(preset, { includeSecrets })
    prepared.push(exported)
    redactionPaths.push(...(redaction.paths ?? []))
    expressionsPreserved += redaction.expressionsPreserved ?? 0
  }

  const envelope = {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt,
    generator: {
      name: PACKAGE_NAME,
      version: options.pluginVersion ?? 'unknown',
    },
    source: {
      profileName: profile.name,
      ...(dshVersion === undefined ? {} : { dshVersion }),
      platform: process.platform,
      arch: process.arch,
    },
    includeSecrets,
    count: prepared.length,
    presets: prepared,
  }

  let target = options.outPath === undefined || String(options.outPath).trim() === ''
    ? join(store.exportsDir, exportFilename())
    : resolveUserPath(profile, options.outPath)
  if (await isDirectory(target)) target = join(target, exportFilename())
  if (!target.toLowerCase().endsWith('.json')) target = `${target}.json`
  if (!options.overwrite && (await statSafe(target)) !== null) {
    throw new PresetError('file-exists', `The export file already exists: ${target}`, {
      nextStep: 'Choose another path or pass --overwrite.',
    })
  }
  await ensureDir(dirname(target), 0o700)
  const text = `${JSON.stringify(envelope, undefined, 2)}\n`
  await writeFileAtomic(target, text, { mode: 0o600 })
  return {
    file: target,
    count: prepared.length,
    includeSecrets,
    bytes: Buffer.byteLength(text, 'utf8'),
    redaction: includeSecrets
      ? { applied: false, fields: 0 }
      : { applied: true, fields: new Set(redactionPaths).size, expressionsPreserved },
    presets: prepared.map(presetSummary),
  }
}

function envelopeOf(parsed, sourceFile) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PresetError('invalid-import', 'The import file must contain a JSON object.', {
      nextStep: 'Choose a file exported by /plugin-presets export.',
    })
  }
  if (parsed.format === undefined && parsed.captured !== undefined) {
    return {
      envelope: {
        format: EXPORT_FORMAT,
        formatVersion: EXPORT_FORMAT_VERSION,
        exportedAt: undefined,
        count: 1,
        presets: [parsed],
      },
      single: true,
      warnings: ['The file contains one bare preset rather than an export envelope; it was imported as a single preset.'],
    }
  }
  if (parsed.format !== EXPORT_FORMAT) {
    throw new PresetError('invalid-format', `Unsupported import format ${JSON.stringify(parsed.format)}.`, {
      nextStep: `Expected "${EXPORT_FORMAT}" format version ${EXPORT_FORMAT_VERSION}.`,
    })
  }
  if (!Number.isInteger(parsed.formatVersion)) {
    throw new PresetError('invalid-format', 'The import file has no integer formatVersion.', {
      nextStep: 'Re-export it with this plugin version.',
    })
  }
  if (parsed.formatVersion > EXPORT_FORMAT_VERSION) {
    throw new PresetError('incompatible-format', `This file uses format version ${parsed.formatVersion}; this plugin supports up to ${EXPORT_FORMAT_VERSION}.`, {
      nextStep: 'Update dsh-plugin-presets before importing this file.',
      details: { found: parsed.formatVersion, supported: EXPORT_FORMAT_VERSION },
    })
  }
  if (parsed.formatVersion < 1) {
    throw new PresetError('invalid-format', `Invalid format version ${parsed.formatVersion}.`)
  }
  if (!Array.isArray(parsed.presets)) {
    throw new PresetError('invalid-import', 'The import file has no presets array.', {
      nextStep: 'Re-export it with this plugin version.',
    })
  }
  if (parsed.presets.length === 0) {
    throw new PresetError('invalid-import', 'The import file contains no presets.')
  }
  if (parsed.presets.length > MAX_PRESETS_LIMIT) {
    throw new PresetError('invalid-import', `The import file contains ${parsed.presets.length} presets; the limit is ${MAX_PRESETS_LIMIT}.`)
  }
  const warnings = []
  if (Number.isInteger(parsed.count) && parsed.count !== parsed.presets.length) {
    warnings.push(`The envelope says ${parsed.count} presets but contains ${parsed.presets.length}.`)
  }
  return { envelope: parsed, single: false, warnings, sourceFile }
}

/**
 * Validate the whole import file, resolve conflicts, and write the accepted presets.
 * Nothing is written unless every accepted preset validates.
 * @returns {{plans: object[], skipped: object[], warnings: string[], envelope: object, imported: object[]}}
 */
export async function planImport(store, options) {
  const { profile } = options
  const file = resolveUserPath(profile, options.file)
  let text
  try {
    text = await readFileLimited(file, MAX_IMPORT_BYTES)
  } catch (error) {
    throw new PresetError('invalid-import', `Cannot read the import file: ${error instanceof Error ? error.message : String(error)}`, {
      nextStep: 'Check the path and that the file is a JSON export smaller than 24 MB.',
      cause: error,
    })
  }
  text = text.replace(/^\uFEFF/, '')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new PresetError('invalid-import', `The import file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, {
      nextStep: 'Fix the file or export it again from DSH.',
      cause: error,
    })
  }
  const { envelope, single, warnings: envelopeWarnings } = envelopeOf(parsed, file)
  const warnings = [...envelopeWarnings]
  const policy = options.conflict ?? 'rename'
  if (!['rename', 'skip', 'overwrite', 'error'].includes(policy)) {
    throw new PresetError('invalid-arguments', `Unknown conflict policy ${JSON.stringify(policy)}.`)
  }

  const existing = await store.listPresets()
  const existingByName = new Map(existing.presets.map((preset) => [nameKey(preset.name), preset]))
  const usedNames = new Set(existing.presets.map((preset) => nameKey(preset.name)))
  const seenInFile = new Set()
  const dshVersion = await currentDshVersion()
  const importedAt = isoNow()
  const plans = []
  const skipped = []

  for (const [index, raw] of envelope.presets.entries()) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new PresetError('invalid-import', `Preset #${index + 1} is not a JSON object.`)
    }
    const originalId = typeof raw.id === 'string' ? raw.id : undefined
    const originalName = typeof raw.name === 'string' ? raw.name : `preset-${index + 1}`
    let normalized
    try {
      normalized = normalizePreset({
        ...raw,
        id: newPresetId(),
        metadata: {
          ...(raw.metadata ?? {}),
          source: 'imported',
          imported: {
            at: importedAt,
            file: basename(file),
            originalId,
            originalName,
            formatVersion: envelope.formatVersion,
            single,
          },
        },
      }, { now: importedAt })
    } catch (error) {
      const details = {
        index,
        name: originalName,
        ...(error?.details ?? {}),
      }
      throw new PresetError(
        error?.code === 'incompatible-schema' ? 'incompatible-schema' : 'invalid-import',
        `Preset #${index + 1} (${JSON.stringify(originalName)}) is invalid: ${error instanceof Error ? error.message : String(error)}`,
        {
          nextStep: error?.code === 'incompatible-schema'
            ? 'Update dsh-plugin-presets to a version that supports this preset schema.'
            : 'Repair or remove that preset from the export and import again. No presets were imported.',
          details,
          cause: error,
        },
      )
    }

    const key = nameKey(normalized.name)
    if (seenInFile.has(key)) {
      throw new PresetError('invalid-import', `The import file contains the name ${JSON.stringify(normalized.name)} more than once.`, {
        nextStep: 'Rename or remove the duplicate in the export, then import again. No presets were imported.',
        details: { index, name: normalized.name },
      })
    }
    seenInFile.add(key)

    const compatibility = []
    const missing = await missingBundlesFor(normalized, profile)
    if (missing.length > 0) {
      compatibility.push({
        code: 'missing-bundles',
        message: `Bundles not installed in this DSH profile: ${missing.join(', ')}`,
        details: { bundles: missing.slice(0, 50) },
      })
    }
    const originVersion = normalized.origin?.dshVersion
    if (dshVersion !== undefined && typeof originVersion === 'string') {
      const left = parseSemver(originVersion)
      const right = parseSemver(dshVersion)
      if (left !== null && right !== null && compareSemver(left, right) !== 0) {
        compatibility.push({
          code: 'dsh-version',
          message: `Captured with DSH ${originVersion}; this DSH is ${dshVersion}.`,
        })
      }
    }
    if (normalized.metadata?.redacted === true) {
      warnings.push(`Preset ${JSON.stringify(normalized.name)} was exported without secrets and contains "<redacted>" placeholders.`)
    }
    if (compatibility.length > 0) {
      normalized = normalizePreset({
        ...normalized,
        metadata: {
          ...normalized.metadata,
          compatibility: [...(normalized.metadata?.compatibility ?? []), ...compatibility],
        },
      }, { now: importedAt })
    }

    const match = existingByName.get(key)
    if (match !== undefined) {
      if (policy === 'skip') {
        skipped.push({ index, name: normalized.name, reason: 'name-already-exists', existingId: match.id })
        continue
      }
      if (policy === 'error') {
        throw new PresetError('already-exists', `A preset named ${JSON.stringify(match.name)} already exists.`, {
          nextStep: 'Import with --conflict rename, --conflict skip, or --conflict overwrite. No presets were imported.',
          details: { index, name: match.name, existingId: match.id },
        })
      }
      if (policy === 'overwrite') {
        usedNames.add(key)
        plans.push({
          index,
          action: 'replaced',
          preset: normalizePreset({ ...normalized, name: match.name }, { now: importedAt }),
          replaceId: match.id,
          originalName,
          name: match.name,
        })
        continue
      }
    }

    let finalName = normalized.name
    let action = 'imported'
    if (match !== undefined || usedNames.has(key)) {
      finalName = uniqueDisplayName(normalized.name, usedNames)
      action = 'renamed'
      normalized = normalizePreset({ ...normalized, name: finalName }, { now: importedAt })
    }
    usedNames.add(nameKey(finalName))
    plans.push({
      index,
      action,
      preset: normalized,
      ...(action === 'renamed' ? { originalName } : {}),
      name: finalName,
    })
  }

  if (plans.length === 0) {
    return { file, envelope, plans, skipped, warnings, imported: [], changed: false }
  }
  const saved = await store.savePresetBatch(plans.map((plan) => ({
    preset: plan.preset,
    ...(plan.replaceId === undefined ? {} : { replaceId: plan.replaceId }),
  })))
  const imported = saved.map((preset, index) => ({
    ...presetSummary(preset),
    action: plans[index].action,
    ...(plans[index].action === 'renamed' ? { renamedFrom: plans[index].originalName } : {}),
  }))
  return {
    file,
    envelope: {
      format: envelope.format,
      formatVersion: envelope.formatVersion,
      exportedAt: envelope.exportedAt,
      source: envelope.source,
      includeSecrets: envelope.includeSecrets,
    },
    plans,
    skipped,
    warnings,
    imported,
    changed: true,
  }
}

/** Import presets, validating every preset before writing any of them. */
export async function importPresets(store, options) {
  const result = await planImport(store, options)
  return {
    file: result.file,
    imported: result.imported,
    skipped: result.skipped,
    warnings: result.warnings,
    count: result.imported.length,
    formatVersion: result.envelope.formatVersion,
    source: result.envelope.source,
  }
}
