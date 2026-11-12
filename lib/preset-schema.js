import {
  MAX_BUNDLES,
  MAX_CONFIG_DEPTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_ENTRIES,
  MAX_PATCH_BYTES,
  PRESET_SCHEMA_VERSION,
} from './constants.js'
import { PresetError } from './errors.js'
import {
  isPlainObject,
  nameKey,
  newPresetId,
  normalizeEol,
  normalizePresetName,
  sha256,
} from './util.js'

function invalid(message, details) {
  return new PresetError('invalid-preset', message, {
    nextStep: 'Fix the preset file or re-import a valid export. Run /plugin-presets doctor for a full check.',
    details,
  })
}

/** Convert arbitrary loader configuration into durable JSON without leaking functions or cycles. */
export function sanitizeConfigValue(value, path = '', depth = 0) {
  const omitted = []
  const walk = (current, currentPath, currentDepth) => {
    if (currentDepth > MAX_CONFIG_DEPTH) {
      omitted.push(currentPath)
      return '[depth-limit]'
    }
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current
    if (typeof current === 'number') return Number.isFinite(current) ? current : null
    if (typeof current === 'bigint') {
      omitted.push(currentPath)
      return current.toString()
    }
    if (typeof current === 'undefined' || typeof current === 'function' || typeof current === 'symbol') {
      omitted.push(currentPath)
      return undefined
    }
    if (current instanceof Date) return current.toISOString()
    if (Array.isArray(current)) {
      return current.map((item, index) => {
        const next = walk(item, `${currentPath}[${index}]`, currentDepth + 1)
        return next === undefined ? null : next
      })
    }
    if (isPlainObject(current)) {
      const result = {}
      for (const [key, child] of Object.entries(current)) {
        const next = walk(child, currentPath.length === 0 ? key : `${currentPath}.${key}`, currentDepth + 1)
        if (next !== undefined) result[key] = next
        else omitted.push(currentPath.length === 0 ? key : `${currentPath}.${key}`)
      }
      return result
    }
    try {
      return walk(JSON.parse(JSON.stringify(current)), currentPath, currentDepth + 1)
    } catch {
      omitted.push(currentPath)
      return '[unserializable]'
    }
  }
  return { value: walk(value, path, depth), omitted }
}

export function validateBundleList(input) {
  if (!Array.isArray(input)) throw invalid('captured.bundles must be an array of package names', { field: 'captured.bundles' })
  if (input.length > MAX_BUNDLES) throw invalid(`A preset may list at most ${MAX_BUNDLES} bundles`, { field: 'captured.bundles' })
  const bundles = []
  const seen = new Set()
  for (const [index, item] of input.entries()) {
    if (typeof item !== 'string') throw invalid(`captured.bundles[${index}] must be a string`)
    const name = item.trim()
    if (name.length === 0) throw invalid(`captured.bundles[${index}] must not be empty`)
    if (seen.has(name)) throw invalid(`captured.bundles lists ${JSON.stringify(name)} more than once`)
    seen.add(name)
    bundles.push(name)
  }
  return bundles
}

function normalizeTimestamp(value, fallback, field) {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw invalid(`${field} must be an ISO timestamp`)
  return new Date(value).toISOString()
}

function normalizeDescription(value) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw invalid('description must be a string')
  if (/[\u0000\r]/.test(value)) throw invalid('description must not contain NUL or carriage returns')
  const text = value.replace(/\r\n?/g, '\n').trim()
  if (text.length > MAX_DESCRIPTION_LENGTH) throw invalid(`description must be at most ${MAX_DESCRIPTION_LENGTH} characters`)
  return text
}

function normalizeEdits(input) {
  if (input === undefined) return []
  if (!Array.isArray(input)) throw invalid('captured.edits must be an array')
  const edits = []
  for (const [index, edit] of input.entries()) {
    if (!isPlainObject(edit)) throw invalid(`captured.edits[${index}] must be an object`)
    if (typeof edit.id !== 'string' || edit.id.trim().length === 0) throw invalid(`captured.edits[${index}].id must be a non-empty string`)
    if (edit.config !== undefined && !isPlainObject(edit.config)) throw invalid(`captured.edits[${index}].config must be an object`)
    if (edit.disabled !== undefined && typeof edit.disabled !== 'boolean') throw invalid(`captured.edits[${index}].disabled must be a boolean`)
    if (edit.config === undefined && edit.disabled === undefined) throw invalid(`captured.edits[${index}] changes nothing`)
    edits.push({
      id: edit.id.trim(),
      ...(edit.config === undefined ? {} : { config: sanitizeConfigValue(edit.config).value }),
      ...(edit.disabled === undefined ? {} : { disabled: edit.disabled }),
    })
  }
  return edits
}

function normalizeEntries(input) {
  if (!Array.isArray(input)) throw invalid('captured.entries must be an array')
  if (input.length > MAX_ENTRIES) throw invalid(`A preset may capture at most ${MAX_ENTRIES} plugin entries`)
  const entries = []
  for (const [index, entry] of input.entries()) {
    if (!isPlainObject(entry)) throw invalid(`captured.entries[${index}] must be an object`)
    if (typeof entry.id !== 'string' || entry.id.trim().length === 0) throw invalid(`captured.entries[${index}].id must be a non-empty string`)
    if (typeof entry.name !== 'string' || entry.name.trim().length === 0) throw invalid(`captured.entries[${index}].name must be a non-empty string`)
    const sanitized = sanitizeConfigValue(entry.config ?? {})
    entries.push({
      id: entry.id.trim(),
      name: entry.name.trim(),
      enabled: entry.enabled !== false,
      ...(entry.active === undefined ? {} : { active: entry.active === true }),
      ...(Number.isInteger(entry.order) ? { order: entry.order } : { order: index }),
      ...(entry.parentId === undefined || entry.parentId === null ? {} : { parentId: String(entry.parentId) }),
      config: sanitized.value,
      ...(sanitized.omitted.length === 0 ? {} : { omittedConfig: sanitized.omitted.slice(0, 50) }),
    })
  }
  return entries
}

/**
 * If the patch text is a block of comments followed by an empty flow list (`[]`),
 * return just the comments (with a trailing newline). Appending list rows after the
 * `[]` token would produce invalid YAML, so the token has to be dropped first.
 * Returns null when the text is not such a document.
 */
function commentsAroundEmptyList(text) {
  const comments = []
  let sawEmptyList = false
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    if (trimmed.startsWith('#')) {
      comments.push(line.trimEnd())
      continue
    }
    if (!sawEmptyList && trimmed === '[]') {
      sawEmptyList = true
      continue
    }
    return null
  }
  if (!sawEmptyList) return null
  return comments.length === 0 ? '' : `${comments.join('\n')}\n`
}

/** The exact patch text a preset writes, including its structured edits. */
export function effectivePatchText(preset) {
  const captured = preset.captured ?? {}
  const base = normalizeEol(captured.patch ?? '')
  const edits = Array.isArray(captured.edits) ? captured.edits : []
  if (edits.length === 0) return base.length === 0 ? '[]\n' : base
  const trimmed = base.trim()
  if (trimmed.startsWith('[') && trimmed !== '[]') {
    throw new PresetError('unsupported-patch-style', 'Structured edits need a block-style patch or an empty list; this preset uses a non-empty flow-style array.', {
      nextStep: 'Edit the preset patch manually as JSON/YAML, or remove the structured edits.',
    })
  }
  const commentsOnly = commentsAroundEmptyList(base)
  const stem = commentsOnly !== null
    ? commentsOnly
    : base.endsWith('\n') ? base : `${base}\n`
  const rows = []
  rows.push('# dsh-plugin-presets: structured edits (generated; this block is appended last)')
  for (const edit of edits) {
    rows.push(`- id: ${JSON.stringify(edit.id)}`)
    if (edit.disabled !== undefined) rows.push(`  disabled: ${edit.disabled ? 'true' : 'false'}`)
    if (edit.config !== undefined) rows.push(`  config: ${JSON.stringify(edit.config)}`)
  }
  return `${stem}${rows.join('\n')}\n`
}

/**
 * The patch file an apply should write. A preset captured while cordis.patch.yml was absent
 * removes the file again instead of creating an empty list, unless structured edits add content.
 */
export function targetPatchState(preset) {
  const effectiveText = effectivePatchText(preset)
  const emptyPatch = effectiveText.trim() === '' || effectiveText.trim() === '[]'
  const patchExists = preset.captured?.patchExists !== false || !emptyPatch
  return { patchText: patchExists ? effectiveText : '', patchExists, effectiveText }
}

export function signatureOfParts(bundles, patchText) {
  return sha256(`${bundles.join('\n')}\u0000${patchText}`)
}

export function presetSignature(preset) {
  return signatureOfParts(preset.captured?.bundles ?? [], effectivePatchText(preset))
}

export function computeCounts(preset) {
  const entries = Array.isArray(preset.captured?.entries) ? preset.captured.entries : []
  const edits = Array.isArray(preset.captured?.edits) ? preset.captured.edits : []
  const configured = entries.filter((entry) => isPlainObject(entry.config) && Object.keys(entry.config).length > 0).length
  const edited = edits.filter((edit) => isPlainObject(edit.config) && Object.keys(edit.config).length > 0).length
  return {
    bundles: Array.isArray(preset.captured?.bundles) ? preset.captured.bundles.length : 0,
    entries: entries.length,
    enabledEntries: entries.filter((entry) => entry.enabled !== false).length,
    configuredEntries: configured + edited,
    edits: edits.length,
  }
}

function normalizeOrigin(input) {
  const source = isPlainObject(input) ? input : {}
  const text = (value) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined)
  return {
    app: 'dsh',
    ...(text(source.dshVersion) === undefined ? {} : { dshVersion: text(source.dshVersion) }),
    ...(text(source.profileName) === undefined ? {} : { profileName: text(source.profileName) }),
    ...(text(source.platform) === undefined ? {} : { platform: text(source.platform) }),
    ...(text(source.arch) === undefined ? {} : { arch: text(source.arch) }),
    ...(text(source.pluginVersion) === undefined ? {} : { pluginVersion: text(source.pluginVersion) }),
    ...(text(source.createdWith) === undefined ? {} : { createdWith: text(source.createdWith) }),
  }
}

function normalizeMetadata(input) {
  const source = isPlainObject(input) ? input : {}
  const compatibility = Array.isArray(source.compatibility)
    ? source.compatibility
        .filter((item) => isPlainObject(item) && typeof item.code === 'string')
        .map((item) => ({
          code: item.code,
          message: typeof item.message === 'string' ? item.message : item.code,
          ...(isPlainObject(item.details) ? { details: item.details } : {}),
        }))
    : []
  return {
    source: typeof source.source === 'string' ? source.source : 'saved',
    redacted: source.redacted === true,
    ...(source.secretsIncluded === true ? { secretsIncluded: true } : {}),
    ...(isPlainObject(source.imported) ? { imported: source.imported } : {}),
    ...(source.editedAt === undefined ? {} : { editedAt: String(source.editedAt) }),
    ...(Number.isInteger(source.editCount) ? { editCount: source.editCount } : {}),
    ...(compatibility.length === 0 ? {} : { compatibility }),
    ...(Array.isArray(source.notes) ? { notes: source.notes.filter((note) => typeof note === 'string').slice(0, 50) } : {}),
  }
}

/**
 * Validate and normalize a preset document.
 * @param {unknown} input
 * @param {{generateId?: boolean, verifyIntegrity?: boolean, now?: string}} [options]
 */
export function normalizePreset(input, options = {}) {
  if (!isPlainObject(input)) throw invalid('A preset must be a JSON object')
  const now = options.now ?? new Date().toISOString()
  const schemaVersion = input.schemaVersion ?? PRESET_SCHEMA_VERSION
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) throw invalid('schemaVersion must be a positive integer')
  if (schemaVersion > PRESET_SCHEMA_VERSION) {
    throw new PresetError('incompatible-schema', `This preset uses schema version ${schemaVersion}; this plugin supports up to ${PRESET_SCHEMA_VERSION}.`, {
      nextStep: 'Update dsh-plugin-presets, or export/import an older-compatible preset.',
      details: { found: schemaVersion, supported: PRESET_SCHEMA_VERSION },
    })
  }

  let id = input.id
  if (id === undefined && options.generateId === true) id = newPresetId()
  if (typeof id !== 'string' || !/^ps_[A-Za-z0-9_-]{3,128}$/.test(id)) throw invalid('id must be a preset id such as "ps_..."')
  if (typeof input.name !== 'string') throw invalid('name must be a string')
  let name
  try {
    name = normalizePresetName(input.name)
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : String(error), { field: 'name' })
  }

  const capturedInput = input.captured
  if (!isPlainObject(capturedInput)) throw invalid('captured must be an object')
  const bundles = validateBundleList(capturedInput.bundles)
  if (typeof capturedInput.patch !== 'string') throw invalid('captured.patch must be a string')
  const patch = normalizeEol(capturedInput.patch)
  if (Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES) throw invalid(`captured.patch exceeds ${MAX_PATCH_BYTES} bytes`)
  if (patch.includes('\u0000')) throw invalid('captured.patch must not contain NUL bytes')
  const patchExists = capturedInput.patchExists === undefined ? true : capturedInput.patchExists === true
  const entries = normalizeEntries(capturedInput.entries ?? [])
  const edits = normalizeEdits(capturedInput.edits)
  const captured = {
    bundles,
    patch,
    patchExists,
    ...(capturedInput.patchHash === undefined ? {} : { patchHash: String(capturedInput.patchHash) }),
    entries,
    ...(edits.length === 0 ? {} : { edits }),
    capturedAt: normalizeTimestamp(capturedInput.capturedAt, now, 'captured.capturedAt'),
    ...(capturedInput.effectiveHash === undefined ? {} : { effectiveHash: String(capturedInput.effectiveHash) }),
    ...(capturedInput.notes === undefined ? {} : { notes: String(capturedInput.notes).slice(0, 2000) }),
  }

  const preset = {
    schemaVersion: PRESET_SCHEMA_VERSION,
    id,
    name,
    description: normalizeDescription(input.description),
    createdAt: normalizeTimestamp(input.createdAt, now, 'createdAt'),
    updatedAt: normalizeTimestamp(input.updatedAt, now, 'updatedAt'),
    origin: normalizeOrigin(input.origin),
    captured,
    metadata: normalizeMetadata(input.metadata),
    ...(input.version === undefined ? {} : { version: String(input.version) }),
  }

  preset.captured.counts = computeCounts(preset)
  const signature = presetSignature(preset)
  const expectedPatchHash = sha256(preset.captured.patch)
  const storedPatchHash = capturedInput.patchHash
  const storedSignature = capturedInput.signature
  preset.captured.signature = signature

  if (options.verifyIntegrity === true) {
    if (storedPatchHash !== undefined && storedPatchHash !== expectedPatchHash) {
      throw new PresetError('integrity-error', `Preset ${JSON.stringify(name)} has a patch hash that does not match its contents.`, {
        nextStep: 'The file was edited outside the plugin. Re-import it or save the current configuration as a new preset.',
        details: { presetId: id, expected: expectedPatchHash, found: storedPatchHash },
      })
    }
    if (storedSignature !== undefined && storedSignature !== signature) {
      throw new PresetError('integrity-error', `Preset ${JSON.stringify(name)} has a signature that does not match its contents.`, {
        nextStep: 'The file was edited outside the plugin. Re-import it or save the current configuration as a new preset.',
        details: { presetId: id },
      })
    }
    preset.captured.patchHash = expectedPatchHash
  } else {
    preset.captured.patchHash = expectedPatchHash
  }

  return preset
}

export function createPreset({ name, description = '', captured, origin = {}, metadata = {}, id, now }) {
  const timestamp = now ?? new Date().toISOString()
  return normalizePreset({
    schemaVersion: PRESET_SCHEMA_VERSION,
    ...(id === undefined ? {} : { id }),
    name,
    description,
    createdAt: timestamp,
    updatedAt: timestamp,
    origin: { ...origin, pluginVersion: origin.pluginVersion ?? undefined },
    captured: { ...captured, capturedAt: captured.capturedAt ?? timestamp },
    metadata,
  }, { generateId: id === undefined, now: timestamp })
}

export function presetSummary(preset) {
  return {
    id: preset.id,
    name: preset.name,
    description: preset.description,
    createdAt: preset.createdAt,
    updatedAt: preset.updatedAt,
    counts: preset.captured.counts ?? computeCounts(preset),
    signature: preset.captured.signature,
    patchHash: preset.captured.patchHash,
    patchExists: preset.captured.patchExists,
    dshVersion: preset.origin?.dshVersion,
    redacted: preset.metadata?.redacted === true,
    source: preset.metadata?.source,
    compatibility: preset.metadata?.compatibility ?? [],
    nameKey: nameKey(preset.name),
  }
}

/** Find captured entries by id or module name; callers decide whether duplicates are ambiguous. */
export function findCapturedEntries(preset, idOrName) {
  const needle = String(idOrName)
  const byId = preset.captured.entries.filter((entry) => entry.id === needle)
  if (byId.length > 0) return byId
  return preset.captured.entries.filter((entry) => entry.name === needle)
}

export function clonePreset(preset) {
  return structuredClone(preset)
}
