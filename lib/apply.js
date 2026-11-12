import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import {
  bundlePatchPaths,
  composeEntries,
  loadOptionalPatches,
  loadOverlayPatches,
  readProfileManifest,
  resolveBundleDir,
} from '@deepseek-ai/dsh-app-boot'
import {
  DEFAULT_PROTECTED_BUNDLES,
  PACKAGE_NAME,
  PROTECTED_MODULES,
  ROW_ID,
} from './constants.js'
import { captureEntries, diffPreset, readProfileState } from './capture.js'
import { PresetError, asPresetError } from './errors.js'
import { removeFile, withFileLock, writeFileAtomic } from './io.js'
import { signatureOfParts, targetPatchState } from './preset-schema.js'
import {
  canonicalJson,
  normalizedPatchText,
  parseSemver,
  compareSemver,
  sha256,
} from './util.js'

function flattenRows(rows) {
  return rows.flatMap((row) => [row, ...(row.group === true && Array.isArray(row.config) ? flattenRows(row.config) : [])])
}

function hashState(manifestText, patchText, patchExists) {
  return {
    manifestHash: sha256(manifestText),
    patchHash: sha256(patchText ?? ''),
    patchExists: patchExists === true,
  }
}

function sameHashes(current, expected) {
  return current.manifestHash === expected.manifestHash && current.patchHash === expected.patchHash
}

function canonicalRows(rows) {
  const stripped = rows.map((row) => ({
    id: row.id,
    name: row.name,
    ...(row.disabled === undefined ? {} : { disabled: row.disabled }),
    ...(row.insert === undefined ? {} : { insert: row.insert }),
    ...(row.group === undefined ? {} : { group: row.group }),
    ...(row.config === undefined ? {} : { config: row.config }),
  }))
  try {
    return canonicalJson(stripped)
  } catch {
    return JSON.stringify(stripped)
  }
}

function manifestForBundles(manifest, bundles) {
  return {
    ...manifest,
    dsh: {
      ...(manifest.dsh ?? {}),
      profile: {
        ...(manifest.dsh?.profile ?? {}),
        bundles: [...bundles],
      },
    },
  }
}

/** Runtime profile application: preflight, backup, transactional write, rollback, and crash recovery. */
export class PresetApplier {
  constructor({ ctx, store, profile, logger, lockWaitMs = 15000 }) {
    this.ctx = ctx
    this.store = store
    this.profile = profile
    this.logger = logger
    this.lockWaitMs = lockWaitMs
  }

  get manifestPath() {
    return join(this.profile.dir, 'package.json')
  }

  async #loadBundlePatches(bundles) {
    const patches = []
    const missing = []
    for (const name of bundles) {
      try {
        const dir = resolveBundleDir('dsh', name, this.profile.installAnchor, this.profile.dir)
        const manifest = readProfileManifest('dsh', dir)
        if (manifest.dsh?.bundle === undefined) {
          throw new Error(`${name} declares no dsh.bundle in its package.json`)
        }
        for (const file of bundlePatchPaths(dir, manifest.dsh.bundle)) {
          patches.push(...loadOverlayPatches('dsh', file))
        }
      } catch (error) {
        missing.push({ name, message: error instanceof Error ? error.message : String(error) })
      }
    }
    return { patches, missing }
  }

  async #parseTargetPatch(text) {
    if (typeof text !== 'string' || text.trim().length === 0) return []
    const file = join(this.store.tmpDir, `preset-patch-${randomBytes(8).toString('hex')}.yml`)
    await writeFileAtomic(file, text, { mode: 0o600 })
    try {
      return loadOverlayPatches('dsh', file)
    } catch (error) {
      throw new PresetError('invalid-patch', `The preset's patch file is not a valid DSH patch: ${error instanceof Error ? error.message : String(error)}`, {
        nextStep: 'Fix the preset patch with /plugin-presets edit or re-import a valid preset.',
        cause: error,
      })
    } finally {
      await removeFile(file).catch(() => {})
    }
  }

  #compose(targetPatchRows, bundlePatches, includeHigherLayers) {
    const warnings = []
    const home = includeHigherLayers && typeof this.profile.home === 'string'
      ? loadOptionalPatches('dsh', join(this.profile.home, 'cordis.patch.yml')) ?? []
      : []
    const overlays = includeHigherLayers && Array.isArray(this.profile.overlays) ? this.profile.overlays : []
    const layers = [...bundlePatches, ...targetPatchRows, ...home, ...overlays]
    const rows = composeEntries(layers, (message) => warnings.push(message))
    return { rows, warnings, homeRows: home.length, overlayRows: overlays.length }
  }

  #currentModuleNames() {
    try {
      const names = new Set()
      for (const entry of this.ctx.loader.entries()) {
        if (typeof entry.options?.name === 'string') names.add(entry.options.name)
      }
      return names
    } catch {
      return new Set()
    }
  }

  #selfRow(rows) {
    const flat = flattenRows(rows)
    return flat.find((row) => row.id === ROW_ID && row.name === PACKAGE_NAME)
      ?? flat.find((row) => row.name === PACKAGE_NAME)
      ?? flat.find((row) => row.id === ROW_ID)
  }

  #checkProtection(rows, targetBundles, currentBundles, options) {
    const targetFlat = flattenRows(rows)
    const targetNames = new Map(targetFlat.filter((row) => typeof row.name === 'string').map((row) => [row.name, row]))
    const self = this.#selfRow(rows)
    if (self === undefined || self.disabled === true) {
      if (options.allowSelfDisable !== true) {
        throw new PresetError('self-disabled', 'Applying this preset would remove or disable the plugin-presets plugin itself.', {
          nextStep: 'Add the dsh-plugin-presets bundle to the preset, or pass --allow-self-disable if you really want to remove this plugin.',
        })
      }
    }
    for (const name of DEFAULT_PROTECTED_BUNDLES) {
      if (currentBundles.includes(name) && !targetBundles.includes(name) && options.allowProtected !== true) {
        throw new PresetError('protected-bundle', `Applying this preset would remove the protected bundle ${JSON.stringify(name)}.`, {
          nextStep: 'Keep the bundle in the preset, or pass --allow-protected to override this protection.',
          details: { bundle: name },
        })
      }
    }
    const liveModules = this.#currentModuleNames()
    for (const name of PROTECTED_MODULES) {
      if (!liveModules.has(name) && name !== PACKAGE_NAME) continue
      const row = targetNames.get(name)
      if (row === undefined || row.disabled === true) {
        if (options.allowProtected === true) continue
        throw new PresetError('protected-module', `Applying this preset would disable or remove the protected module ${JSON.stringify(name)}.`, {
          nextStep: 'Keep that module enabled in the preset, or pass --allow-protected to override this protection.',
          details: { module: name },
        })
      }
    }
    return self
  }

  async #dshVersionWarning(preset) {
    const presetVersion = preset.origin?.dshVersion
    if (typeof presetVersion !== 'string') return undefined
    try {
      const { getDshRuntimeVersion } = await import('@deepseek-ai/dsh-app-boot')
      const current = getDshRuntimeVersion()
      if (typeof current !== 'string' || current.length === 0) return undefined
      const left = parseSemver(presetVersion)
      const right = parseSemver(current)
      if (left === null || right === null) return undefined
      if (compareSemver(left, right) === 0) return undefined
      return `This preset was captured with DSH ${presetVersion}; the running DSH is ${current}.`
    } catch {
      return undefined
    }
  }

  /**
   * Compute the complete effect of applying a preset without touching the profile.
   * @param {object} preset
   * @param {{allowMissingBundles?: boolean, allowOverrides?: boolean, allowRedacted?: boolean, allowSelfDisable?: boolean, allowProtected?: boolean, includeEntries?: boolean}} [options]
   */
  async plan(preset, options = {}) {
    const current = await readProfileState(this.profile)
    if (options.includeEntries !== false) {
      const captured = captureEntries(this.ctx.loader)
      current.entries = captured.entries
    }
    const targetBundles = [...preset.captured.bundles]
    // A preset captured from a profile without cordis.patch.yml stores patchExists: false.
    // Applying it removes the file instead of creating an empty one, unless edits added content.
    const targetPatch = targetPatchState(preset)
    const targetPatchRows = await this.#parseTargetPatch(targetPatch.patchText)
    const { patches: bundlePatches, missing } = await this.#loadBundlePatches(targetBundles)
    if (missing.length > 0 && options.allowMissingBundles !== true) {
      throw new PresetError('bundle-missing', `This preset needs ${missing.length} bundle(s) that cannot be resolved: ${missing.map((item) => item.name).join(', ')}.`, {
        nextStep: 'Install those bundles in this profile, or pass --allow-missing-bundles to apply anyway (DSH will skip the missing bundles).',
        details: { missing: missing.slice(0, 20) },
      })
    }

    let base
    let full
    try {
      base = this.#compose(targetPatchRows, bundlePatches, false)
      full = this.#compose(targetPatchRows, bundlePatches, true)
    } catch (error) {
      throw new PresetError('invalid-overlay', `A higher-priority patch layer could not be read: ${error instanceof Error ? error.message : String(error)}`, {
        nextStep: 'Repair the home cordis.patch.yml or the command-line overlay before applying a preset.',
        cause: error,
      })
    }

    const higherLayersPresent = full.homeRows > 0 || full.overlayRows > 0
    const overridesChanged = higherLayersPresent && canonicalRows(base.rows) !== canonicalRows(full.rows)
    if (overridesChanged && options.allowOverrides !== true) {
      throw new PresetError('higher-priority-overrides', 'A home patch or command-line overlay changes the effective configuration, so this preset cannot be applied exactly.', {
        nextStep: 'Remove/empty those layers, or pass --allow-overrides to apply the preset while they stay in effect.',
        details: { homeRows: full.homeRows, overlayRows: full.overlayRows },
      })
    }

    const self = this.#checkProtection(full.rows, targetBundles, current.bundles, options)
    const warnings = [...new Set([...full.warnings, ...base.warnings])]
    if (missing.length > 0) warnings.push(`Missing bundles will be skipped by DSH: ${missing.map((item) => item.name).join(', ')}.`)
    if (overridesChanged) warnings.push('Higher-priority layers override part of this preset; the live configuration is not identical to the preset.')
    if (higherLayersPresent && !overridesChanged) warnings.push('Higher-priority layers are present but do not change the composed rows.')
    if (preset.metadata?.redacted === true) {
      if (options.allowRedacted !== true) {
        throw new PresetError('redacted-preset', 'This preset was exported without secrets: applying it would write "<redacted>" placeholders into plugin configuration.', {
          nextStep: 'Edit the preset to enter the real values, export with secrets, or pass --allow-redacted if placeholders are acceptable.',
        })
      }
      warnings.push('The preset contains redacted placeholders; plugin configuration will literally contain "<redacted>".')
    }
    const versionWarning = await this.#dshVersionWarning(preset)
    if (versionWarning !== undefined) warnings.push(versionWarning)

    const manifest = manifestForBundles(current.manifest, targetBundles)
    const manifestText = `${JSON.stringify(manifest, undefined, 2)}\n`
    const diff = diffPreset(preset, current)
    return {
      preset: { id: preset.id, name: preset.name, signature: preset.captured.signature },
      current,
      targetBundles,
      patchText: targetPatch.patchText,
      patchExists: targetPatch.patchExists,
      manifest,
      manifestText,
      diff,
      selfEntryId: self?.id ?? ROW_ID,
      missingBundles: missing,
      warnings,
      overrides: { present: higherLayersPresent, changed: overridesChanged, homeRows: full.homeRows, overlayRows: full.overlayRows },
      after: hashState(manifestText, targetPatch.patchText, targetPatch.patchExists),
      // The full target content, so the backup can record exactly what an apply wrote.
      afterState: { manifestText, patchText: targetPatch.patchText ?? '', patchExists: targetPatch.patchExists },
      targetSignature: signatureOfParts(targetBundles, targetPatch.effectiveText),
    }
  }

  async #transaction(operation) {
    const hmr = this.ctx.get('hmr')
    const run = () => withFileLock(this.manifestPath, operation, { waitMs: this.lockWaitMs })
    if (hmr !== undefined && typeof hmr.runExclusive === 'function') {
      return { result: await hmr.runExclusive(run), hmr: true, hmrService: hmr }
    }
    return { result: await run(), hmr: false, hmrService: undefined }
  }

  async #writeFiles(manifestText, patchText, patchExists) {
    await writeFileAtomic(this.manifestPath, manifestText, { mode: 0o600 })
    if (patchExists === true) await writeFileAtomic(this.profile.patchPath, patchText ?? '[]\n', { mode: 0o600 })
    else await removeFile(this.profile.patchPath)
  }

  async #restoreFiles(backup) {
    if (backup === null || backup === undefined || typeof backup.manifestText !== 'string') {
      throw new Error(`Backup ${backup?.id ?? '(unknown)'} has no package.json`)
    }
    await this.#writeFiles(backup.manifestText, backup.patchText, backup.patchText !== null)
    return hashState(backup.manifestText, backup.patchText, backup.patchText !== null)
  }

  async #writeRecoveryReport(report) {
    await this.store.writeRecoveryReport(report)
  }

  /**
   * Apply a preset. The profile lock and HMR transaction cover preflight, backup, writes, and reconcile;
   * any failure after the backup was created restores the exact pre-apply files.
   */
  async apply(preset, options = {}) {
    let backup
    let plan
    let activeBefore
    let backupStarted = false
    try {
      const transaction = await this.#transaction(async () => {
        plan = await this.plan(preset, options)
        activeBefore = await this.store.readActive().catch(() => null)

        if (plan.diff.same && options.force !== true) {
          const marker = await this.store.setActive(preset, {
            application: 'applied',
            appliedSignature: plan.current.signature,
            presetSignature: plan.preset.signature,
            backupId: null,
            warnings: plan.warnings,
            overridesPresent: plan.overrides.present,
          })
          return { changed: false, application: 'applied', backupId: null, warnings: plan.warnings, diff: plan.diff, plan, marker }
        }

        backup = await this.store.createBackup({
          reason: options.reason ?? 'apply',
          preset,
          before: {
            manifestText: plan.current.manifestText,
            patchText: plan.current.patchText,
            patchExists: plan.current.patchExists,
          },
          after: plan.afterState,
          activeBefore,
          warnings: plan.warnings,
        })
        backupStarted = true
        await this.store.writePending({
          id: `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`,
          backupId: backup.id,
          presetId: preset.id,
          presetName: preset.name,
          presetSignature: plan.preset.signature,
          appliedSignature: plan.targetSignature,
          before: hashState(plan.current.manifestText, plan.current.patchText, plan.current.patchExists),
          after: plan.after,
          activeBefore,
          warnings: plan.warnings,
          reason: options.reason ?? 'apply',
        })

        await this.#writeFiles(plan.manifestText, plan.patchText, plan.patchExists)

        let application = 'restart-required'
        let restartReason = 'no-hmr'
        let reconcileWarnings = []
        const hmr = this.ctx.get('hmr')
        if (hmr !== undefined && typeof hmr.reconcileProfile === 'function') {
          const result = await hmr.reconcileProfile([plan.selfEntryId])
          reconcileWarnings = [...(result.warnings ?? [])]
          if (result.restartReason === undefined) {
            application = 'applied'
            restartReason = undefined
          } else {
            restartReason = result.restartReason
          }
        }
        const warnings = [...plan.warnings, ...reconcileWarnings]
        await this.store.finalizeBackup(backup.id, { status: 'applied', application, restartReason })
        const marker = await this.store.setActive(preset, {
          application,
          appliedSignature: plan.targetSignature,
          presetSignature: plan.preset.signature,
          backupId: backup.id,
          warnings,
          overridesPresent: plan.overrides.present,
          ...(restartReason === undefined ? {} : { restartReason }),
        })
        await this.store.clearPending()
        await this.store.pruneBackups({ keepIds: [backup.id] })
        return {
          changed: true,
          application,
          restartReason,
          backupId: backup.id,
          warnings,
          diff: plan.diff,
          plan,
          marker,
        }
      })
      return { ...transaction.result, hmr: transaction.hmr }
    } catch (error) {
      const failure = asPresetError(error)
      if (!backupStarted || backup === undefined) throw failure

      let rollback
      try {
        // createBackup() returns metadata and a directory; the file contents have to be
        // loaded back (or taken from the pre-apply snapshot already in memory).
        const backupFiles = await this.store.loadBackup(backup.id).catch(() => null)
        const restoreSource = backupFiles ?? {
          id: backup.id,
          manifestText: plan.current.manifestText,
          patchText: plan.current.patchText,
        }
        const restored = await this.#transaction(async () => {
          await this.#restoreFiles(restoreSource)
          const hmr = this.ctx.get('hmr')
          if (hmr !== undefined && typeof hmr.reconcileProfile === 'function') {
            await hmr.reconcileProfile([ROW_ID])
          }
          await this.store.restoreActive(activeBefore)
          await this.store.finalizeBackup(backup.id, { status: 'rolled-back', error: failure.message, reason: failure.code })
          await this.store.clearPending()
        })
        rollback = { ok: true, hmr: restored.hmr }
        this.logger?.warn?.('plugin-presets: apply failed; restored the previous profile files from backup %s', backup.id)
      } catch (rollbackError) {
        rollback = { ok: false, error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError) }
        await this.store.finalizeBackup(backup.id, {
          status: 'failed',
          error: failure.message,
          rollbackError: rollback.error,
        }).catch(() => {})
        this.logger?.error?.('plugin-presets: apply failed AND rollback failed; backup %s retains the previous files', backup.id)
      }
      const details = {
        ...(failure.details ?? {}),
        backupId: backup.id,
        backupDir: backup.dir,
        rollback: rollback.ok ? 'restored' : 'failed',
        ...(rollback.ok ? {} : { rollbackError: rollback.error }),
      }
      const nextStep = rollback.ok
        ? 'The previous configuration was restored. Run /plugin-presets doctor to verify.'
        : `Automatic rollback failed. Restore package.json and cordis.patch.yml from ${backup.dir} manually, then restart DSH.`
      throw new PresetError('apply-failed', `Applying ${JSON.stringify(preset.name)} failed: ${failure.message}`, {
        nextStep,
        details,
        cause: failure,
      })
    }
  }

  /**
   * Restore a backup created by apply. Refuses when the live files no longer match the backup's
   * post-apply state unless `force` is set; always creates a safety backup first.
   */
  async rollback(options = {}) {
    let backup
    if (options.backupId !== undefined) {
      backup = await this.store.loadBackup(options.backupId)
      if (backup === null) throw new PresetError('not-found', `No backup with id ${JSON.stringify(options.backupId)} exists.`, {
        nextStep: 'Run /plugin-presets backups to list available backups.',
      })
    } else {
      const backups = await this.store.listBackups()
      // Only backups from an apply are implicit rollback targets. Safety copies taken before a
      // rollback must never become the next bare rollback's target, or it would redo the apply.
      const candidates = backups.filter((item) => item.reason !== 'pre-rollback'
        && (item.status === 'applied' || item.status === 'restart-required' || item.reason === 'legacy'))
      const candidate = candidates.find((item) => item.reason === 'apply' && item.preset != null) ?? candidates[0]
      if (candidate === undefined) throw new PresetError('not-found', 'No restorable backup exists yet.', {
        nextStep: 'Apply a preset first; each apply records a backup.',
      })
      backup = await this.store.loadBackup(candidate.id)
      if (backup === null) throw new PresetError('backup-invalid', `Backup ${candidate.id} has no readable meta.json.`)
    }
    if (backup.manifestText === null && backup.meta.reason !== 'legacy') {
      throw new PresetError('backup-invalid', `Backup ${backup.id} does not contain package.json and cannot be restored.`, {
        nextStep: 'Choose another backup from /plugin-presets backups.',
      })
    }

    try {
      const transaction = await this.#transaction(async () => {
        const current = await readProfileState(this.profile)
        const expected = backup.meta.after ?? backup.meta.before
        if (options.force !== true && expected !== undefined && !sameHashes(current, expected)) {
          throw new PresetError('rollback-conflict', 'The live profile has changed since this backup was created, so restoring it would discard newer edits.', {
            nextStep: 'Pass --force to restore anyway (a safety backup of the current files is created first).',
            details: { backupId: backup.id },
          })
        }

        const activeBeforeRollback = await this.store.readActive().catch(() => null)
        const safety = await this.store.createBackup({
          reason: 'pre-rollback',
          preset: null,
          before: {
            manifestText: current.manifestText,
            patchText: current.patchText,
            patchExists: current.patchExists,
          },
          after: null,
          activeBefore: activeBeforeRollback,
        })
        let safetyUsed = false
        const beforeRestore = hashState(current.manifestText, current.patchText, current.patchExists)
        const targetRestored = hashState(backup.manifestText, backup.patchText, backup.patchText !== null)
        try {
          safetyUsed = true
          await this.store.writePending({
            id: `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`,
            backupId: safety.id,
            presetId: null,
            presetName: null,
            presetSignature: null,
            appliedSignature: signatureOfParts(
              (JSON.parse(backup.manifestText)).dsh?.profile?.bundles ?? [],
              normalizedPatchText(backup.patchText ?? ''),
            ),
            before: beforeRestore,
            after: targetRestored,
            activeBefore: activeBeforeRollback,
            resultActive: backup.meta.activeBefore ?? null,
            targetBackupId: backup.id,
            reason: 'rollback',
          })
          await this.#restoreFiles(backup)
          const hmr = this.ctx.get('hmr')
          let application = 'restart-required'
          let restartReason = 'no-hmr'
          if (hmr !== undefined && typeof hmr.reconcileProfile === 'function') {
            const result = await hmr.reconcileProfile([ROW_ID])
            if (result.restartReason === undefined) {
              application = 'applied'
              restartReason = undefined
            } else {
              restartReason = result.restartReason
            }
          }
          await this.store.restoreActive(backup.meta.activeBefore ?? null)
          await this.store.finalizeBackup(safety.id, { status: 'applied', application, restartReason, note: `safety copy before restoring ${backup.id}` })
          await this.store.finalizeBackup(backup.id, { status: 'restored', restoredAt: new Date().toISOString() })
          await this.store.clearPending()
          return { backupId: backup.id, safetyBackupId: safety.id, application, restartReason }
        } catch (error) {
          try {
            await this.#writeFiles(current.manifestText, current.patchText, current.patchExists)
            const hmr = this.ctx.get('hmr')
            if (hmr !== undefined && typeof hmr.reconcileProfile === 'function') await hmr.reconcileProfile([ROW_ID])
            await this.store.restoreActive(activeBeforeRollback)
            await this.store.clearPending()
            await this.store.finalizeBackup(safety.id, {
              status: 'cancelled',
              reason: 'rollback-failed',
              error: asPresetError(error).message,
            }).catch(() => {})
          } catch (restoreError) {
            await this.store.finalizeBackup(safety.id, { status: 'failed', error: asPresetError(error).message, rollbackError: restoreError instanceof Error ? restoreError.message : String(restoreError) }).catch(() => {})
            throw asPresetError(restoreError)
          }
          throw asPresetError(error)
        } finally {
          if (!safetyUsed) await this.store.finalizeBackup(safety.id, { status: 'cancelled' }).catch(() => {})
        }
      })
      return { ...transaction.result, hmr: transaction.hmr }
    } catch (error) {
      throw asPresetError(error)
    }
  }

  /**
   * Resolve a pending apply transaction left by a crash. Runs once at plugin startup, before commands are served.
   * Both post-apply files => finalize; both pre-apply files => cancel; mixed => restore the backup.
   * Unrelated newer edits => leave everything untouched and report.
   *
   * The profile lock is held for the whole decision so a concurrent DSH writer cannot change the
   * files between the hash comparison and the restore.
   */
  async recoverOnStartup() {
    try {
      return await withFileLock(this.manifestPath, () => this.#recoverOnStartupLocked(), { waitMs: this.lockWaitMs })
    } catch (error) {
      const report = {
        at: new Date().toISOString(),
        action: 'needs-attention',
        message: `Startup recovery could not run: ${error instanceof Error ? error.message : String(error)}`,
      }
      await this.#writeRecoveryReport(report).catch(() => {})
      return report
    }
  }

  async #recoverOnStartupLocked() {
    let pending
    try {
      pending = await this.store.readPending()
    } catch (error) {
      const report = {
        at: new Date().toISOString(),
        action: 'needs-attention',
        message: `The pending-apply marker is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      }
      await this.#writeRecoveryReport(report).catch(() => {})
      return report
    }
    if (pending === null || typeof pending !== 'object') return null

    let current
    try {
      current = await readProfileState(this.profile)
    } catch (error) {
      const report = {
        at: new Date().toISOString(),
        action: 'needs-attention',
        pendingId: pending.id,
        backupId: pending.backupId,
        message: `Could not read the profile to recover an interrupted apply: ${error instanceof Error ? error.message : String(error)}`,
      }
      await this.#writeRecoveryReport(report).catch(() => {})
      return report
    }

    const matchesAfter = pending.after !== undefined && sameHashes(current, pending.after)
    const matchesBefore = pending.before !== undefined && sameHashes(current, pending.before)
    const backup = pending.backupId === undefined ? null : await this.store.loadBackup(pending.backupId).catch(() => null)

    if (matchesAfter && pending.reason === 'rollback') {
      await this.store.finalizeBackup(pending.backupId, { status: 'applied', application: 'applied', recovered: true, recoveredAt: new Date().toISOString(), note: 'safety copy before an interrupted rollback' })
      if (typeof pending.targetBackupId === 'string') {
        await this.store.finalizeBackup(pending.targetBackupId, { status: 'restored', restoredAt: new Date().toISOString() }).catch(() => null)
      }
      await this.store.restoreActive(pending.resultActive ?? null)
      await this.store.clearPending()
      const report = {
        at: new Date().toISOString(),
        action: 'finalized',
        pendingId: pending.id,
        backupId: pending.backupId,
        targetBackupId: pending.targetBackupId,
        message: 'Recovered an interrupted rollback: the backup files had both been written, so the rollback was finalized.',
      }
      await this.#writeRecoveryReport(report)
      this.logger?.info?.('plugin-presets: %s', report.message)
      return report
    }

    if (matchesAfter) {
      await this.store.finalizeBackup(pending.backupId, { status: 'applied', application: 'applied', recovered: true, recoveredAt: new Date().toISOString() })
      const marker = await this.store.setActive({
        id: pending.presetId,
        name: pending.presetName,
      }, {
        application: 'applied',
        appliedSignature: pending.appliedSignature,
        presetSignature: pending.presetSignature,
        backupId: pending.backupId,
        warnings: pending.warnings ?? [],
      }).catch(() => null)
      await this.store.clearPending()
      const report = {
        at: new Date().toISOString(),
        action: 'finalized',
        pendingId: pending.id,
        backupId: pending.backupId,
        presetId: pending.presetId,
        presetName: pending.presetName,
        message: 'Recovered an interrupted preset apply: the profile files had both been written, so the apply was finalized.',
        activeRecovered: marker !== null,
      }
      await this.#writeRecoveryReport(report)
      this.logger?.info?.('plugin-presets: %s', report.message)
      return report
    }

    if (matchesBefore) {
      await this.store.finalizeBackup(pending.backupId, { status: 'cancelled', reason: 'interrupted-before-write' })
      await this.store.restoreActive(pending.activeBefore ?? null)
      await this.store.clearPending()
      const report = {
        at: new Date().toISOString(),
        action: 'cancelled',
        pendingId: pending.id,
        backupId: pending.backupId,
        message: 'Recovered an interrupted preset apply: the profile files were unchanged, so the apply was cancelled.',
      }
      await this.#writeRecoveryReport(report)
      this.logger?.info?.('plugin-presets: %s', report.message)
      return report
    }

    // One file was written and the other was not: package.json is in the after state
    // while cordis.patch.yml is still in the before state, or the reverse.
    const mixed = !matchesAfter && !matchesBefore && (
      (pending.after?.manifestHash === current.manifestHash && pending.before?.patchHash === current.patchHash)
      || (pending.before?.manifestHash === current.manifestHash && pending.after?.patchHash === current.patchHash)
    )

    if (!matchesAfter && !matchesBefore && !mixed) {
      const report = {
        at: new Date().toISOString(),
        action: 'needs-attention',
        pendingId: pending.id,
        backupId: pending.backupId,
        backupDir: backup?.dir,
        message: 'An interrupted preset apply was found, but the profile files match neither its before nor after state. Nothing was changed; inspect the backup and the profile manually.',
      }
      await this.#writeRecoveryReport(report)
      this.logger?.warn?.('plugin-presets: %s', report.message)
      return report
    }

    if (backup === null) {
      const report = {
        at: new Date().toISOString(),
        action: 'needs-attention',
        pendingId: pending.id,
        backupId: pending.backupId,
        message: 'An interrupted preset apply left mixed profile files, but its backup is missing; restore manually.',
      }
      await this.#writeRecoveryReport(report)
      this.logger?.warn?.('plugin-presets: %s', report.message)
      return report
    }

    let report
    try {
      await this.#restoreFiles(backup)
      await this.store.restoreActive(pending.activeBefore ?? null)
      await this.store.finalizeBackup(pending.backupId, {
        status: 'rolled-back',
        reason: 'interrupted-mixed-files',
        recoveredAt: new Date().toISOString(),
      })
      await this.store.clearPending()
      report = {
        at: new Date().toISOString(),
        action: 'restored',
        pendingId: pending.id,
        backupId: pending.backupId,
        restartRequired: true,
        message: 'An interrupted preset apply had written only part of the profile. The pre-apply files were restored; restart DSH to load them.',
      }
      this.logger?.warn?.('plugin-presets: %s', report.message)
    } catch (error) {
      report = {
        at: new Date().toISOString(),
        action: 'needs-attention',
        pendingId: pending.id,
        backupId: pending.backupId,
        backupDir: backup.dir,
        message: `An interrupted preset apply left mixed profile files, and restoring the backup failed: ${error instanceof Error ? error.message : String(error)}`,
      }
      this.logger?.error?.('plugin-presets: %s', report.message)
    }
    await this.#writeRecoveryReport(report)
    return report
  }
}
