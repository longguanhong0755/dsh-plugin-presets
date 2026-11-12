import { basename, join } from 'node:path'
import { PACKAGE_NAME, PRESET_SCHEMA_VERSION } from './constants.js'
import { PresetError, errorPayload } from './errors.js'
import {
  ensureDir,
  listDirectory,
  readFileLimited,
  readJsonIfExists,
  readTextIfExists,
  removeFile,
  statSafe,
  withFileLock,
  writeJsonAtomic,
  writeFileAtomic,
} from './io.js'
import {
  createPreset,
  normalizePreset,
  presetSignature,
} from './preset-schema.js'
import {
  MAX_IMPORT_BYTES,
  BACKUP_SCHEMA_VERSION,
  INDEX_SCHEMA_VERSION,
} from './constants.js'
import {
  isoNow,
  nameKey,
  newBackupId,
  newPresetId,
  normalizePresetName,
  safeProfileKey,
  sha256,
} from './util.js'

// Stable across HMR module reloads: only a real process restart changes this boot id.
const BOOT_ID_KEY = Symbol.for('dsh-plugin-presets.bootId')
const CURRENT_BOOT_ID = globalThis[BOOT_ID_KEY] ??= `${process.pid}:${Math.round(Date.now() - process.uptime() * 1000)}`
const PRESET_ID_RE = /^ps_[A-Za-z0-9_-]{3,128}$/
const BACKUP_ID_RE = /^bk_[A-Za-z0-9_-]{3,160}$/

/** Durable, profile-scoped preset storage. Presets and the active marker share one directory. */
export class PresetStore {
  constructor(options) {
    this.rootDir = options.rootDir
    this.profileName = options.profileName
    this.profileKey = safeProfileKey(options.profileName)
    this.profileDir = options.profileDir
    this.maxPresets = options.maxPresets
    this.maxBackups = options.maxBackups
    this.pluginVersion = options.pluginVersion ?? PACKAGE_NAME
    this.lockWaitMs = options.lockWaitMs ?? 30000
    this.logger = options.logger
    this.now = options.now ?? isoNow
    this.dir = join(this.rootDir, this.profileKey)
    this.presetsDir = join(this.dir, 'presets')
    this.backupsDir = join(this.dir, 'backups')
    this.trashDir = join(this.dir, 'trash')
    this.tmpDir = join(this.dir, 'tmp')
    this.exportsDir = join(this.dir, 'exports')
    this.activePath = join(this.dir, 'active.json')
    this.pendingPath = join(this.dir, 'pending.json')
    this.lockPath = join(this.dir, '.store')
    this.ready = undefined
  }

  async init() {
    this.ready ??= (async () => {
      for (const directory of [this.dir, this.presetsDir, this.backupsDir, this.trashDir, this.tmpDir, this.exportsDir]) {
        await ensureDir(directory, 0o700)
      }
      const profilePath = join(this.dir, 'profile.json')
      if ((await statSafe(profilePath)) === null) {
        await writeJsonAtomic(profilePath, {
          schemaVersion: INDEX_SCHEMA_VERSION,
          profileName: this.profileName,
          profileKey: this.profileKey,
          profileDir: this.profileDir,
          pluginVersion: this.pluginVersion,
          createdAt: this.now(),
        })
      }
    })()
    return await this.ready
  }

  async withLock(operation) {
    await this.init()
    return await withFileLock(this.lockPath, operation, { waitMs: this.lockWaitMs })
  }

  presetPath(id) {
    if (!PRESET_ID_RE.test(id)) throw new PresetError('invalid-preset-id', `Invalid preset id ${JSON.stringify(id)}.`)
    return join(this.presetsDir, `${id}.json`)
  }

  backupPath(id) {
    if (!BACKUP_ID_RE.test(id)) throw new PresetError('invalid-backup-id', `Invalid backup id ${JSON.stringify(id)}.`)
    return join(this.backupsDir, id)
  }

  async readPresetFile(filename) {
    let text
    try {
      text = await readFileLimited(filename, MAX_IMPORT_BYTES)
    } catch (error) {
      throw new PresetError('invalid-preset', `Cannot read preset file ${basename(filename)}: ${error.message}`, { cause: error })
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new PresetError('invalid-preset', `Preset file ${basename(filename)} is not valid JSON: ${error.message}`, {
        nextStep: 'Restore the file from a backup/export or delete it and re-save the preset.',
        cause: error,
      })
    }
    return normalizePreset(parsed, { verifyIntegrity: true })
  }

  async readPresetById(id) {
    const filename = this.presetPath(id)
    if ((await statSafe(filename)) === null) return null
    return await this.readPresetFile(filename)
  }

  /** List valid presets and malformed files without failing the whole listing. */
  async listPresets() {
    await this.init()
    const entries = await listDirectory(this.presetsDir)
    const presets = []
    const invalid = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const filename = join(this.presetsDir, entry.name)
      try {
        presets.push(await this.readPresetFile(filename))
      } catch (error) {
        invalid.push({
          file: filename,
          id: entry.name.slice(0, -'.json'.length),
          ...errorPayload(error),
        })
      }
    }
    presets.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }) || left.id.localeCompare(right.id))
    return { presets, invalid }
  }

  async resolvePreset(idOrName) {
    const needle = String(idOrName ?? '').trim()
    if (needle.length === 0) throw new PresetError('not-found', 'A preset name or id is required.')
    if (PRESET_ID_RE.test(needle)) {
      const byId = await this.readPresetById(needle)
      if (byId !== null) return byId
    }
    const { presets } = await this.listPresets()
    let key
    try {
      key = nameKey(needle)
    } catch {
      key = needle.toLowerCase()
    }
    const matches = presets.filter((preset) => nameKey(preset.name) === key)
    if (matches.length === 1) return matches[0]
    if (matches.length > 1) {
      throw new PresetError('ambiguous-preset', `More than one preset is named ${JSON.stringify(needle)}.`, {
        nextStep: 'Use the preset id from /plugin-presets list --json.',
        details: { ids: matches.map((preset) => preset.id) },
      })
    }
    throw new PresetError('not-found', `No preset named ${JSON.stringify(needle)} exists.`, {
      nextStep: 'Run /plugin-presets list to see available preset names.',
      details: { available: presets.slice(0, 30).map((preset) => preset.name) },
    })
  }

  async nameExists(name, exceptId) {
    const key = nameKey(name)
    const { presets } = await this.listPresets()
    return presets.some((preset) => preset.id !== exceptId && nameKey(preset.name) === key)
  }

  async savePreset(preset, options = {}) {
    const timestamp = this.now()
    return await this.withLock(async () => {
      const { presets, invalid } = await this.listPresets()
      let next = normalizePreset({ ...preset, updatedAt: timestamp }, { generateId: preset.id === undefined, now: timestamp })
      const overwriteId = options.overwriteId
      if (overwriteId !== undefined) {
        const existing = presets.find((item) => item.id === overwriteId)
        if (existing === undefined) throw new PresetError('not-found', `Preset ${JSON.stringify(overwriteId)} no longer exists.`)
        next = normalizePreset({
          ...next,
          id: existing.id,
          createdAt: existing.createdAt,
          updatedAt: timestamp,
        }, { now: timestamp })
      } else {
        const count = presets.length + invalid.length
        if (count >= this.maxPresets) {
          throw new PresetError('preset-limit', `This profile already has ${count} presets; the limit is ${this.maxPresets}.`, {
            nextStep: 'Delete a preset or raise the maxPresets setting.',
          })
        }
      }
      if (await this.nameExists(next.name, next.id)) {
        throw new PresetError('already-exists', `A preset named ${JSON.stringify(next.name)} already exists.`, {
          nextStep: 'Choose another name, or use /plugin-presets update to replace its contents.',
        })
      }
      await writeJsonAtomic(this.presetPath(next.id), next, { mode: 0o600 })
      return next
    })
  }

  async saveCaptured(captured, { name, description = '', origin = {}, metadata = {}, activate = false, currentSignature } = {}) {
    const preset = createPreset({
      name,
      description,
      captured,
      origin,
      metadata: { ...metadata, source: metadata.source ?? 'saved' },
      now: this.now(),
    })
    const saved = await this.savePreset(preset)
    if (activate === true) {
      await this.setActive(saved, {
        application: 'applied',
        appliedSignature: currentSignature ?? saved.captured.signature,
        presetSignature: presetSignature(saved),
        backupId: null,
      })
    }
    return saved
  }

  /**
   * Validate and write a batch of presets under one lock.
   * @param {{preset: object, replaceId?: string}[]} entries
   */
  async savePresetBatch(entries) {
    const timestamp = this.now()
    return await this.withLock(async () => {
      const { presets, invalid } = await this.listPresets()
      const byId = new Map(presets.map((preset) => [preset.id, preset]))
      const replaceIds = new Set(entries.map((entry) => entry.replaceId).filter(Boolean))
      const usedNames = new Set(presets.filter((preset) => !replaceIds.has(preset.id)).map((preset) => nameKey(preset.name)))
      const existingCount = presets.length + invalid.length
      let inserts = 0
      const planned = []
      for (const [index, entry] of entries.entries()) {
        let next = normalizePreset(entry.preset, { generateId: entry.preset?.id === undefined, now: timestamp })
        if (entry.replaceId !== undefined) {
          const existing = byId.get(entry.replaceId)
          if (existing === undefined) {
            throw new PresetError('not-found', `Cannot replace preset ${JSON.stringify(entry.replaceId)}: it no longer exists.`, {
              nextStep: 'Import again with the rename or skip conflict policy.',
            })
          }
          next = normalizePreset({
            ...next,
            id: existing.id,
            createdAt: existing.createdAt,
            updatedAt: timestamp,
          }, { now: timestamp })
        } else {
          inserts += 1
        }
        const key = nameKey(next.name)
        if (usedNames.has(key)) {
          throw new PresetError('already-exists', `Imported preset #${index + 1}, ${JSON.stringify(next.name)}, conflicts with another preset name.`, {
            nextStep: 'Import again with --conflict rename or --conflict skip.',
          })
        }
        usedNames.add(key)
        planned.push(next)
      }
      if (existingCount + inserts > this.maxPresets) {
        throw new PresetError('preset-limit', `Importing would create ${existingCount + inserts} presets; the limit is ${this.maxPresets}.`, {
          nextStep: 'Delete presets first or raise maxPresets.',
        })
      }
      for (const next of planned) await writeJsonAtomic(this.presetPath(next.id), next, { mode: 0o600 })
      return planned
    })
  }

  async updatePreset(idOrName, mutate, options = {}) {
    const existing = await this.resolvePreset(idOrName)
    return await this.withLock(async () => {
      const current = await this.readPresetById(existing.id)
      if (current === null) throw new PresetError('not-found', `Preset ${JSON.stringify(existing.name)} no longer exists.`)
      const draft = await mutate(structuredClone(current))
      const timestamp = this.now()
      const next = normalizePreset({
        ...draft,
        id: current.id,
        createdAt: current.createdAt,
        updatedAt: timestamp,
      }, { now: timestamp })
      if (await this.nameExists(next.name, next.id)) {
        throw new PresetError('already-exists', `A preset named ${JSON.stringify(next.name)} already exists.`, {
          nextStep: 'Choose another name.',
        })
      }
      await writeJsonAtomic(this.presetPath(next.id), next, { mode: 0o600 })
      if (options.updateActiveName === true) await this.#updateActiveName(next)
      return next
    })
  }

  async renamePreset(idOrName, newName) {
    const name = normalizePresetName(newName)
    return await this.updatePreset(idOrName, (preset) => ({ ...preset, name }), { updateActiveName: true })
  }

  async duplicatePreset(idOrName, newName) {
    const source = await this.resolvePreset(idOrName)
    const copy = structuredClone(source)
    const timestamp = this.now()
    const preset = normalizePreset({
      ...copy,
      id: newPresetId(),
      name: newName,
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: {
        ...copy.metadata,
        source: 'duplicate',
        duplicatedFrom: { id: source.id, name: source.name, at: timestamp },
      },
    }, { generateId: false, now: timestamp })
    return await this.savePreset(preset)
  }

  async deletePreset(idOrName) {
    const preset = await this.resolvePreset(idOrName)
    return await this.withLock(async () => {
      const current = await this.readPresetById(preset.id)
      if (current === null) throw new PresetError('not-found', `Preset ${JSON.stringify(preset.name)} no longer exists.`)
      const deletedAt = this.now()
      const trashName = `${preset.id}-${deletedAt.replace(/[:.]/g, '-')}.json`
      await writeJsonAtomic(join(this.trashDir, trashName), {
        schemaVersion: PRESET_SCHEMA_VERSION,
        deletedAt,
        preset: current,
      }, { mode: 0o600 })
      await removeFile(this.presetPath(preset.id))
      await this.#markActiveDeleted(current.id)
      await this.pruneTrash()
      return current
    })
  }

  async listTrash() {
    await this.init()
    const entries = await listDirectory(this.trashDir)
    const items = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const filename = join(this.trashDir, entry.name)
      try {
        const parsed = await readJsonIfExists(filename)
        if (parsed !== null) {
          items.push({
            file: filename,
            deletedAt: parsed.deletedAt,
            id: parsed.preset?.id,
            name: parsed.preset?.name,
          })
        }
      } catch {
        items.push({ file: filename, invalid: true })
      }
    }
    items.sort((left, right) => String(right.deletedAt).localeCompare(String(left.deletedAt)))
    return items
  }

  async pruneTrash() {
    const items = await this.listTrash()
    for (const item of items.slice(50)) await removeFile(item.file).catch(() => {})
  }

  async readActive() {
    await this.init()
    let parsed
    try {
      parsed = await readJsonIfExists(this.activePath)
    } catch (error) {
      throw new PresetError('active-marker-invalid', `The active-preset marker is not valid JSON: ${error.message}`, {
        nextStep: 'Delete active.json or re-apply a preset.',
        cause: error,
      })
    }
    if (parsed === null) return null
    if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new PresetError('active-marker-invalid', 'The active-preset marker must be a JSON object.')
    return parsed
  }

  async readActiveSafe() {
    try {
      return { active: await this.readActive(), error: undefined }
    } catch (error) {
      return { active: null, error: errorPayload(error) }
    }
  }

  async setActive(preset, options) {
    const timestamp = this.now()
    const marker = {
      schemaVersion: INDEX_SCHEMA_VERSION,
      profileKey: this.profileKey,
      profileName: this.profileName,
      profileDir: this.profileDir,
      presetId: preset.id,
      presetName: preset.name,
      presetSignature: options.presetSignature ?? presetSignature(preset),
      appliedSignature: options.appliedSignature,
      appliedAt: options.appliedAt ?? timestamp,
      updatedAt: timestamp,
      backupId: options.backupId ?? null,
      application: options.application ?? 'applied',
      ...(options.restartReason === undefined ? {} : { restartReason: options.restartReason }),
      ...(options.warnings === undefined ? {} : { warnings: options.warnings.slice(0, 50) }),
      ...(options.overridesPresent === true ? { overridesPresent: true } : {}),
      bootId: CURRENT_BOOT_ID,
      live: (options.application ?? 'applied') === 'applied',
      presetDeleted: false,
    }
    await this.withLock(async () => {
      await writeJsonAtomic(this.activePath, marker, { mode: 0o600 })
    })
    return marker
  }

  /** Put back a marker read before a transaction (or clear it). Used by rollback and crash recovery. */
  async restoreActive(marker) {
    await this.withLock(async () => {
      if (marker === null || marker === undefined) await removeFile(this.activePath)
      else await writeJsonAtomic(this.activePath, marker, { mode: 0o600 })
    })
  }

  async writeRecoveryReport(report) {
    await this.init()
    await writeJsonAtomic(join(this.dir, 'last-recovery.json'), report, { mode: 0o600 })
  }

  async readRecoveryReport() {
    await this.init()
    try {
      return await readJsonIfExists(join(this.dir, 'last-recovery.json'))
    } catch (error) {
      return { at: null, action: 'needs-attention', message: `last-recovery.json is unreadable: ${error.message}` }
    }
  }

  async #updateActiveName(preset) {
    const active = await this.readActive().catch(() => null)
    if (active === null || active.presetId !== preset.id) return
    await writeJsonAtomic(this.activePath, {
      ...active,
      presetName: preset.name,
      updatedAt: this.now(),
    }, { mode: 0o600 })
  }

  async #markActiveDeleted(id) {
    const active = await this.readActive().catch(() => null)
    if (active === null || active.presetId !== id) return
    await writeJsonAtomic(this.activePath, {
      ...active,
      presetDeleted: true,
      updatedAt: this.now(),
    }, { mode: 0o600 })
  }

  /** After a restart, record that a restart-required apply is now live. */
  async markLiveIfRestarted() {
    const active = await this.readActive().catch(() => null)
    if (active === null) return null
    if (active.bootId === CURRENT_BOOT_ID && active.live === true) return active
    const timestamp = this.now()
    const next = {
      ...active,
      bootId: CURRENT_BOOT_ID,
      live: true,
      application: active.application === 'restart-required' ? 'applied-after-restart' : active.application,
      liveSince: timestamp,
      updatedAt: timestamp,
    }
    await this.withLock(async () => {
      await writeJsonAtomic(this.activePath, next, { mode: 0o600 })
    })
    return next
  }

  async createBackup({ reason, preset, before, after, activeBefore = null, warnings = [] }) {
    await this.init()
    const id = newBackupId()
    const dir = this.backupPath(id)
    await ensureDir(dir, 0o700)
    const meta = {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      id,
      createdAt: this.now(),
      reason,
      profile: {
        key: this.profileKey,
        name: this.profileName,
        dir: this.profileDir,
      },
      preset: preset === undefined || preset === null ? null : { id: preset.id, name: preset.name },
      before: {
        manifestHash: sha256(before.manifestText),
        patchHash: sha256(before.patchText ?? ''),
        patchExists: before.patchExists === true,
        manifestBytes: Buffer.byteLength(before.manifestText, 'utf8'),
        patchBytes: Buffer.byteLength(before.patchText ?? '', 'utf8'),
      },
      after: after === undefined || after === null ? null : {
        manifestHash: sha256(after.manifestText),
        patchHash: sha256(after.patchText ?? ''),
        patchExists: after.patchExists === true,
      },
      activeBefore,
      status: 'pending',
      warnings: warnings.slice(0, 50),
    }
    await writeFileAtomic(join(dir, 'package.json'), before.manifestText, { mode: 0o600 })
    if (before.patchExists === true) {
      await writeFileAtomic(join(dir, 'cordis.patch.yml'), before.patchText ?? '[]\n', { mode: 0o600 })
    }
    await writeJsonAtomic(join(dir, 'meta.json'), meta, { mode: 0o600 })
    return { id, dir, meta }
  }

  async finalizeBackup(id, update) {
    const dir = this.backupPath(id)
    const metaPath = join(dir, 'meta.json')
    const meta = await readJsonIfExists(metaPath)
    if (meta === null) return null
    const next = {
      ...meta,
      ...update,
      settledAt: update.settledAt ?? this.now(),
    }
    await writeJsonAtomic(metaPath, next, { mode: 0o600 })
    return next
  }

  async loadBackup(id) {
    const dir = this.backupPath(id)
    const meta = await readJsonIfExists(join(dir, 'meta.json'))
    if (meta === null) return null
    return {
      id,
      dir,
      meta,
      manifestText: await readTextIfExists(join(dir, 'package.json')),
      patchText: await readTextIfExists(join(dir, 'cordis.patch.yml')),
    }
  }

  async listBackups() {
    await this.init()
    const entries = await listDirectory(this.backupsDir)
    const backups = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        const meta = await readJsonIfExists(join(this.backupsDir, entry.name, 'meta.json'))
        if (meta !== null) backups.push({ id: entry.name, ...meta })
      } catch {
        backups.push({ id: entry.name, error: 'unreadable meta.json' })
      }
    }
    backups.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
    return backups
  }

  async pruneBackups({ keepIds = [] } = {}) {
    const backups = await this.listBackups()
    const protectedIds = new Set([...keepIds, this.maxBackups > 0 ? backups[0]?.id : undefined].filter(Boolean))
    const keep = []
    for (const backup of backups) {
      if (protectedIds.has(backup.id)) {
        keep.push(backup.id)
        continue
      }
      if (keep.length < this.maxBackups) {
        keep.push(backup.id)
      } else {
        await removeFile(join(this.backupsDir, backup.id)).catch(() => {})
      }
    }
    return keep
  }

  async writePending(transaction) {
    await this.withLock(async () => {
      await writeJsonAtomic(this.pendingPath, {
        schemaVersion: INDEX_SCHEMA_VERSION,
        ...transaction,
        createdAt: transaction.createdAt ?? this.now(),
      }, { mode: 0o600 })
    })
  }

  async readPending() {
    await this.init()
    try {
      return await readJsonIfExists(this.pendingPath)
    } catch (error) {
      throw new PresetError('pending-invalid', `The pending-apply marker is not valid JSON: ${error.message}`, { cause: error })
    }
  }

  async clearPending() {
    await this.withLock(async () => {
      await removeFile(this.pendingPath)
    })
  }
}
