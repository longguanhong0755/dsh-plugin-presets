import { join } from 'node:path'
import { PresetError } from './errors.js'
import { readTextIfExists } from './io.js'
import {
  effectivePatchText,
  sanitizeConfigValue,
  signatureOfParts,
  validateBundleList,
} from './preset-schema.js'
import {
  canonicalJson,
  normalizedPatchText,
  sha256,
} from './util.js'

/** Read the profile files this plugin snapshots and restores without interpreting them. */
export async function readProfileState(profile) {
  const manifestPath = join(profile.dir, 'package.json')
  const manifestText = await readTextIfExists(manifestPath)
  if (manifestText === null) {
    throw new PresetError('invalid-profile', `The profile manifest ${manifestPath} does not exist.`, {
      nextStep: 'Start DSH once with this profile so it creates package.json, then retry.',
    })
  }
  let manifest
  try {
    manifest = JSON.parse(manifestText)
  } catch (error) {
    throw new PresetError('invalid-profile', `The profile manifest is not valid JSON: ${error.message}`, {
      nextStep: 'Repair package.json before saving or applying presets.',
      cause: error,
    })
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new PresetError('invalid-profile', 'The profile manifest must hold a JSON object.')
  }
  const declared = manifest.dsh?.profile?.bundles ?? []
  let bundles
  try {
    bundles = validateBundleList(declared)
  } catch (error) {
    throw new PresetError('invalid-profile', `dsh.profile.bundles is invalid: ${error.message}`, {
      nextStep: 'Repair dsh.profile.bundles in package.json before saving or applying presets.',
      cause: error,
    })
  }
  const patchText = await readTextIfExists(profile.patchPath)
  return {
    manifestPath,
    patchPath: profile.patchPath,
    manifestText,
    manifest,
    bundles,
    patchText,
    patchExists: patchText !== null,
    patchHash: sha256(patchText ?? ''),
    manifestHash: sha256(manifestText),
    signature: signatureOfParts(bundles, normalizedPatchText(patchText ?? '')),
  }
}

function entryEnabled(entry) {
  return entry?.options?.disabled !== true
}

function entryActive(entry) {
  return entry?.fiber !== undefined && (entry.fiber.state === undefined || entry.fiber.state === 2)
}

/** Capture top-level profile entries as durable, informational preset details. */
export function captureEntries(loader) {
  if (loader === undefined || typeof loader.entries !== 'function') return { entries: [], warnings: ['Loader entries are unavailable; the preset still captures bundles and the patch file.'] }
  const warnings = []
  const entries = []
  try {
    const all = [...loader.entries()].filter((entry) => entry.parent?.tree?.ctx?.fiber?.entry?.id === 'include')
    for (const [index, entry] of all.entries()) {
      const id = entry?.options?.id
      const name = entry?.options?.name
      if (typeof id !== 'string' || id.length === 0 || typeof name !== 'string' || name.length === 0) {
        warnings.push(`Skipped a loader entry without a string id/name at position ${index}.`)
        continue
      }
      if (name.startsWith('file:')) warnings.push(`Entry ${id} is an absolute file URL; preset details record it as-is.`)
      const sanitized = sanitizeConfigValue(entry.options.config ?? {})
      entries.push({
        id,
        name,
        enabled: entryEnabled(entry),
        active: entryActive(entry),
        order: index,
        config: sanitized.value,
        ...(entry.options.group === true ? { group: true } : {}),
        ...(sanitized.omitted.length === 0 ? {} : { omittedConfig: sanitized.omitted.slice(0, 50) }),
      })
    }
  } catch (error) {
    warnings.push(`Could not enumerate loader entries: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { entries, warnings }
}

/**
 * Capture the current profile as preset fields.
 * @param {{profile: object, loader?: object, now?: string}} options
 */
export async function captureCurrent(options) {
  const { profile, loader } = options
  const now = options.now ?? new Date().toISOString()
  const state = await readProfileState(profile)
  const { entries, warnings } = captureEntries(loader)
  const captured = {
    bundles: state.bundles,
    patch: state.patchText ?? '',
    patchExists: state.patchExists,
    patchHash: state.patchHash,
    entries,
    capturedAt: now,
    effectiveHash: sha256(effectivePatchText({ captured: { bundles: state.bundles, patch: state.patchText ?? '', edits: [] } })),
    signature: state.signature,
  }
  return {
    captured,
    state,
    warnings,
  }
}

/** Signature of the live profile files, matching a preset's signature when both represent the same configuration. */
function currentSignature(bundles, patchText) {
  return signatureOfParts(bundles, normalizedPatchText(patchText ?? ''))
}

function entryKey(entry) {
  return `${entry.id}\u0000${entry.name}`
}

/**
 * Compare a preset against the live profile. Bundle order and the complete patch text are significant;
 * captured entries are informational and compared for display only.
 */
export function diffPreset(preset, current) {
  const presetBundles = preset.captured.bundles
  const currentBundles = current.bundles
  const presetEffective = effectivePatchText(preset)
  const currentPatch = normalizedPatchText(current.patchText ?? '')
  const presetSet = new Set(presetBundles)
  const currentSet = new Set(currentBundles)
  const addedBundles = currentBundles.filter((name) => !presetSet.has(name))
  const removedBundles = presetBundles.filter((name) => !currentSet.has(name))
  const common = presetBundles.filter((name) => currentSet.has(name))
  const reordered = common.length > 1 && common.join('\n') !== currentBundles.filter((name) => presetSet.has(name)).join('\n')
  const bundlesChanged = addedBundles.length > 0 || removedBundles.length > 0 || reordered
  const patchChanged = presetEffective !== currentPatch

  const presetEntries = new Map((preset.captured.entries ?? []).map((entry) => [entryKey(entry), entry]))
  const liveEntries = new Map((current.entries ?? []).map((entry) => [entryKey(entry), entry]))
  const addedEntries = [...liveEntries.keys()].filter((key) => !presetEntries.has(key)).length
  const removedEntries = [...presetEntries.keys()].filter((key) => !liveEntries.has(key)).length
  let changedEntries = 0
  for (const [key, entry] of presetEntries) {
    const live = liveEntries.get(key)
    if (live === undefined) continue
    if (entry.enabled !== live.enabled
      || entry.active !== live.active
      || canonicalJson(entry.config ?? {}) !== canonicalJson(live.config ?? {})) changedEntries += 1
  }
  const entriesChanged = addedEntries + removedEntries + changedEntries > 0

  return {
    same: !bundlesChanged && !patchChanged,
    signature: preset.captured.signature,
    currentSignature: currentSignature(currentBundles, current.patchText ?? ''),
    bundlesChanged,
    patchChanged,
    entriesChanged,
    addedBundles,
    removedBundles,
    reordered,
    addedEntries,
    removedEntries,
    changedEntries,
    presetPatchBytes: Buffer.byteLength(presetEffective, 'utf8'),
    currentPatchBytes: Buffer.byteLength(current.patchText ?? '', 'utf8'),
  }
}
