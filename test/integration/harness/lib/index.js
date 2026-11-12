/**
 * Real-DSH integration harness for dsh-plugin-presets.
 *
 * This package is NOT part of the shipped plugin. It is installed into a
 * disposable DSH profile as a bundle, waits for the plugin's command and tool
 * to register, then drives them in-process. Every assertion runs against the
 * actual DSH loader, profile composition, HMR service, and profile files.
 *
 * Enable with DSH_PRESET_IT_PHASE=main|recovery|restore. Without that
 * environment variable the bundle is inert, so an accidental install does
 * nothing.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const name = 'dsh-plugin-presets-it-harness'

const PHASE = process.env.DSH_PRESET_IT_PHASE
const OUT = process.env.DSH_PRESET_IT_OUT
const FIXTURE_BUNDLE = 'dsh-plugin-presets-it-fixture'
const FIXTURE_ROW = 'dsh-plugin-presets-it-fixture'
const HARNESS_BUNDLE = 'dsh-plugin-presets-it-harness'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function sha256(text) {
  return createHash('sha256').update(text ?? '', 'utf8').digest('hex')
}

async function waitFor(predicate, timeoutMs = 30000, label = 'condition') {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      const value = await predicate()
      if (value) return value
    } catch (error) {
      last = error
    }
    await sleep(100)
  }
  throw new Error(`Timed out waiting for ${label}${last === undefined ? '' : `: ${last.message}`}`)
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function apply(ctx) {
  if (PHASE === undefined || PHASE.length === 0) return
  const profile = ctx.get('profileContext')
  if (profile === undefined) {
    console.error('[it] no profileContext; cannot run integration harness')
    process.exit(2)
  }

  const checks = []
  const logLines = []
  const log = (line) => {
    logLines.push(line)
    console.log(`[it] ${line}`)
  }
  const check = async (label, fn) => {
    try {
      const detail = await fn()
      checks.push({ label, ok: true, detail: detail === undefined ? null : detail })
      log(`PASS ${label}`)
      return { ok: true, detail }
    } catch (error) {
      checks.push({ label, ok: false, error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) })
      log(`FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`)
      return { ok: false, error }
    }
  }
  const expect = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  const expectEqual = (actual, expected, message) => {
    if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }

  let commandService
  let toolService
  let dataDir
  const command = async (line) => {
    const definition = commandService.find(undefined, 'plugin-presets')
    if (definition === undefined) throw new Error('the /plugin-presets command is not registered')
    return await definition.handler({ rawInput: line })
  }
  const commandOk = async (line) => {
    const result = await command(line)
    if (result?.kind !== 'success') throw new Error(`command failed: ${line}\n${result?.text ?? '(no text)'}`)
    return result.text
  }
  const commandJson = async (line) => {
    const text = await commandOk(line)
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`command did not return JSON: ${line}\n${text.slice(0, 500)}`)
    }
  }
  const commandError = async (line) => {
    const result = await command(line)
    if (result?.kind !== 'error') throw new Error(`expected an error from: ${line}`)
    return result.text
  }
  const presetFile = async (id) => {
    const text = await readFile(join(dataDir, 'presets', `${id}.json`), 'utf8')
    return JSON.parse(text)
  }
  const live = async () => {
    const manifestText = await readFile(join(profile.dir, 'package.json'), 'utf8')
    let patchText = null
    try {
      patchText = await readFile(profile.patchPath, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    const manifest = JSON.parse(manifestText)
    return {
      manifest,
      manifestText,
      manifestHash: sha256(manifestText),
      patchText,
      patchHash: sha256(patchText ?? ''),
      bundles: manifest.dsh?.profile?.bundles ?? [],
    }
  }
  const loaderNames = () => {
    try {
      return [...ctx.loader.entries()].map((entry) => entry?.options?.name).filter((value) => typeof value === 'string')
    } catch {
      return []
    }
  }
  const waitRow = async (rowName, present, timeoutMs = 20000) => {
    await waitFor(() => loaderNames().includes(rowName) === present, timeoutMs, `loader row ${rowName} ${present ? 'present' : 'absent'}`)
  }
  const readActive = async () => {
    try {
      return JSON.parse(await readFile(join(dataDir, 'active.json'), 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }
  const readPending = async () => {
    try {
      return JSON.parse(await readFile(join(dataDir, 'pending.json'), 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }
  const readRecovery = async () => {
    try {
      return JSON.parse(await readFile(join(dataDir, 'last-recovery.json'), 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }
  const backupMeta = async (id) => {
    return JSON.parse(await readFile(join(dataDir, 'backups', id, 'meta.json'), 'utf8'))
  }
  const backupText = async (id, filename) => {
    try {
      return await readFile(join(dataDir, 'backups', id, filename), 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }
  const listJson = async () => await commandJson('list --json')
  const findPreset = (listed, name) => listed.presets.find((preset) => preset.name === name)

  async function writeResult(status) {
    const payload = {
      phase: PHASE,
      status,
      profile: profile.name,
      profileDir: profile.dir,
      dataDir,
      loaderRows: loaderNames(),
      checks,
      log: logLines,
      finishedAt: new Date().toISOString(),
    }
    if (OUT !== undefined && OUT.length > 0) {
      await mkdir(dirname(OUT), { recursive: true })
      await writeFile(OUT, `${JSON.stringify(payload, undefined, 2)}\n`, 'utf8')
    }
    const failed = checks.filter((item) => !item.ok)
    console.log(`[it] ${PHASE}: ${checks.length - failed.length}/${checks.length} checks passed`)
  }

  async function waitForPlugin() {
    await waitFor(() => {
      commandService = ctx.get('commands')
      toolService = ctx.get('tools')
      return commandService !== undefined && toolService !== undefined
        && commandService.find(undefined, 'plugin-presets') !== undefined
        && toolService.get('plugin_presets') !== undefined
    }, 60000, 'plugin-presets command and tool registration')
  }

  async function runMain() {
    await waitForPlugin()
    let baseBundles
    await check('command help renders', async () => {
      const text = await commandOk('help')
      expect(text.includes('Plugin presets for DSH'), 'help text is unexpected')
    })

    await check('doctor exposes the profile-scoped data directory', async () => {
      const doctor = await commandJson('doctor --json')
      dataDir = doctor.dataDir
      expect(typeof dataDir === 'string' && dataDir.length > 0, 'doctor has no dataDir')
      expect(doctor.profileName === profile.name, 'doctor profile mismatch')
      expect(doctor.presets?.count === 0, `expected a clean preset store, found ${doctor.presets?.count}`)
      expect(doctor.pending?.present === false, `pending marker exists at the start: ${JSON.stringify(doctor.pending)}`)
    })
    if (dataDir === undefined) throw new Error('doctor failed; cannot continue')

    await check('list starts empty', async () => {
      const listed = await listJson()
      expectEqual(listed.presets.length, 0, 'initial preset count')
    })

    await check('save captures the live profile and loader entries', async () => {
      await commandOk('save it-base --description "integration base"')
      const listed = await listJson()
      const summary = findPreset(listed, 'it-base')
      expect(summary !== undefined, 'saved preset is not listed')
      expectEqual(summary.counts.bundles, 3, 'captured bundle count')
      expect(summary.counts.entries > 0, 'capture recorded no loader entries')
      const raw = await presetFile(summary.id)
      expect(Array.isArray(raw.captured.bundles), 'captured.bundles is not an array')
      expectEqual(raw.captured.patchExists, true, 'captured.patchExists')
      expect(typeof raw.captured.signature === 'string' && raw.captured.signature.length === 64, 'signature is missing')
      const state = await live()
      baseBundles = [...state.bundles]
      expectEqual(raw.captured.signature, sha256(`${state.bundles.join('\n')}\u0000${raw.captured.patch}`), 'signature does not match captured parts')
      return { id: summary.id, entries: summary.counts.entries }
    })

    await check('duplicate and edit produce an alternate bundle list', async () => {
      await commandOk('duplicate it-base it-fixture')
      let listed = await listJson()
      const copy = findPreset(listed, 'it-fixture')
      expect(copy !== undefined, 'duplicate is not listed')
      await commandOk(`edit it-fixture --add-bundle ${FIXTURE_BUNDLE} --set ${FIXTURE_ROW} '{"mode":"integration","apiKey":"sk-it-secret-value"}'`)
      listed = await listJson()
      const edited = findPreset(listed, 'it-fixture')
      expectEqual(edited.counts.bundles, 4, 'edited bundle count')
      expectEqual(edited.counts.edits, 1, 'edited structured edit count')
      const shown = await commandJson('show it-fixture --json --patch')
      expect(shown.captured.bundles.includes(FIXTURE_BUNDLE), 'fixture bundle missing from preset')
      expect(Array.isArray(shown.captured.edits) && shown.captured.edits.some((edit) => edit.id === FIXTURE_ROW), 'structured edit is missing from preset')
      return edited.id
    })

    await check('validate composes the target without writing files', async () => {
      const before = await live()
      const plan = await commandJson('validate it-fixture --json')
      expect(plan.valid === true, 'validate did not return valid')
      expect(plan.bundles.includes(FIXTURE_BUNDLE), 'plan misses the fixture bundle')
      expectEqual(plan.diff.bundlesChanged, true, 'plan diff should change bundles')
      const after = await live()
      expectEqual(after.manifestHash, before.manifestHash, 'validate changed package.json')
      expectEqual(after.patchHash, before.patchHash, 'validate changed cordis.patch.yml')
    })

    let appliedBackupId
    let fixtureLive
    await check('apply writes bundles and patch, then HMR loads the new bundle', async () => {
      const before = await live()
      fixtureLive = {
        bundles: [...before.bundles, FIXTURE_BUNDLE],
        patchText: before.patchText,
        patchHash: before.patchHash,
        manifestHash: before.manifestHash,
      }
      const result = await commandJson('apply it-fixture --json')
      expectEqual(result.changed, true, 'apply changed flag')
      expect(result.application === 'applied' || result.application === 'restart-required', `unexpected application ${result.application}`)
      expect(typeof result.backupId === 'string', 'apply did not return a backup id')
      appliedBackupId = result.backupId
      const after = await live()
      expectEqual(JSON.stringify(after.bundles), JSON.stringify(fixtureLive.bundles), 'live bundle list after apply')
      expect(after.patchText !== null && after.patchText.includes(FIXTURE_ROW), 'apply did not materialize the structured edit block')
      expect(after.patchText !== null && after.patchText.includes('structured edits'), 'generated edit header is missing')
      expect(after.patchText !== null && after.patchText.includes('#'), 'captured patch comments were lost')
      expect(after.patchHash !== before.patchHash, 'apply should change the patch when structured edits exist')
      const active = await readActive()
      expect(active?.presetName === 'it-fixture', `active marker is ${JSON.stringify(active?.presetName)}`)
      expect(active?.application === result.application, 'active marker application mismatch')
      const meta = await backupMeta(appliedBackupId)
      expectEqual(meta.status, 'applied', 'backup status')
      expectEqual(sha256(await backupText(appliedBackupId, 'package.json')), before.manifestHash, 'backup package.json differs from pre-apply')
      if (before.patchText !== null) {
        expectEqual(sha256(await backupText(appliedBackupId, 'cordis.patch.yml')), before.patchHash, 'backup patch differs from pre-apply')
      }
      if (result.application === 'applied') await waitRow(FIXTURE_ROW, true)
      return { application: result.application, backupId: appliedBackupId, entries: loaderNames().length }
    })

    await check('current reports the active preset with no drift', async () => {
      const current = await commandJson('current --json')
      expect(current.active?.presetName === 'it-fixture', 'current active preset mismatch')
      expect(current.diff?.same === true, `current diff is not same: ${JSON.stringify(current.diff)}`)
      expect(current.live?.bundles?.includes(FIXTURE_BUNDLE), 'current live bundles miss the fixture')
    })

    await check('rollback restores the exact pre-apply files and unloads the bundle', async () => {
      const beforeRollback = await live()
      const result = await commandJson('rollback --json')
      expect(typeof result.backupId === 'string', 'rollback has no backup id')
      expectEqual(result.backupId, appliedBackupId, 'rollback target')
      const after = await live()
      expectEqual(after.manifestHash, fixtureLive.manifestHash, 'rollback package.json differs from pre-apply')
      expectEqual(after.patchHash, fixtureLive.patchHash, 'rollback patch differs from pre-apply')
      expect(!after.bundles.includes(FIXTURE_BUNDLE), 'fixture bundle survived rollback')
      expectEqual(JSON.stringify(after.bundles), JSON.stringify(baseBundles), 'rollback bundle list')
      const active = await readActive()
      expect(active === null, `active marker should be cleared by rollback, got ${JSON.stringify(active)}`)
      await waitRow(FIXTURE_ROW, false)
      expectEqual(beforeRollback.bundles.includes(FIXTURE_BUNDLE), true, 'precondition: fixture was live before rollback')
      return { safetyBackupId: result.safetyBackupId, hmr: result.hmr }
    })

    await check('a failed apply restores the pre-apply files automatically', async () => {
      const before = await live()
      const hmr = ctx.get('hmr')
      expect(hmr !== undefined && typeof hmr.reconcileProfile === 'function', 'hmr service is unavailable')
      const original = hmr.reconcileProfile
      let calls = 0
      // Fail the live reconcile once, after the apply has written both files. The
      // rollback path needs the real method to reconcile the restored profile.
      hmr.reconcileProfile = async function reconcileFailure(...args) {
        calls += 1
        if (calls === 1) throw new Error('integration-induced reconcile failure')
        return await original.apply(this, args)
      }
      let failure
      try {
        failure = await commandError('apply it-fixture --json')
      } finally {
        hmr.reconcileProfile = original
      }
      expect(/Applying|apply-failed/i.test(failure), `unexpected failed-apply error: ${failure}`)
      expect(/restored/i.test(failure), `automatic rollback was not reported: ${failure}`)
      const after = await live()
      expectEqual(after.manifestHash, before.manifestHash, 'failed apply did not restore package.json')
      expectEqual(after.patchHash, before.patchHash, 'failed apply did not restore cordis.patch.yml')
      expect((await readActive()) === null, 'failed apply changed the active marker')
      expect((await readPending()) === null, 'failed apply left a pending marker')
      const listed = await commandJson('backups --json')
      const rolledBack = listed.backups.find((item) => item.status === 'rolled-back' && item.preset?.name === 'it-fixture')
      expect(rolledBack !== undefined, 'failed apply did not record a rolled-back backup')
      return { backupId: rolledBack.id }
    })

    await check('backups lists apply and pre-rollback entries with integrity metadata', async () => {
      const listed = await commandJson('backups --json')
      expect(Array.isArray(listed.backups) && listed.backups.length >= 2, 'expected at least two backups')
      const applied = listed.backups.find((item) => item.id === appliedBackupId)
      expect(applied !== undefined, 'apply backup is missing')
      expectEqual(applied.reason, 'apply', 'apply backup reason')
      const safety = listed.backups.find((item) => item.reason === 'pre-rollback')
      expect(safety !== undefined, 'pre-rollback safety backup is missing')
      expectEqual(safety.status, 'applied', 'safety backup status')
      return { count: listed.backups.length }
    })

    await check('export redacts secrets by default and includes them only on request', async () => {
      const redactedPath = join(profile.cwd ?? profile.dir, `preset-it-export-redacted-${process.pid}.json`)
      const fullPath = join(profile.cwd ?? profile.dir, `preset-it-export-full-${process.pid}.json`)
      const redactedText = await commandOk(`export it-fixture --out "${redactedPath}"`)
      const redacted = JSON.parse(await readFile(redactedPath, 'utf8'))
      expectEqual(redacted.includeSecrets, false, 'redacted export includeSecrets')
      expect(redacted.presets.length === 1, 'redacted export count')
      expect(!JSON.stringify(redacted).includes('sk-it-secret-value'), 'redacted export leaked the secret')
      expect(JSON.stringify(redacted).includes('<redacted>'), 'redacted export has no placeholder')
      await commandOk(`export it-fixture --out "${fullPath}" --include-secrets`)
      const full = JSON.parse(await readFile(fullPath, 'utf8'))
      expectEqual(full.includeSecrets, true, 'full export includeSecrets')
      expect(JSON.stringify(full).includes('sk-it-secret-value'), 'full export lost the secret')
      return { redactedPath, fullPath, note: redactedText.split('\n')[0] }
    })

    let importedId
    await check('import handles a duplicate name and a malformed file atomically', async () => {
      const redactedPath = join(profile.cwd ?? profile.dir, `preset-it-export-redacted-${process.pid}.json`)
      const imported = await commandJson(`import "${redactedPath}" --conflict rename --json`)
      expectEqual(imported.imported.length, 1, 'import count')
      expect(imported.imported[0].action === 'renamed', `expected rename, got ${imported.imported[0].action}`)
      const importedName = imported.imported[0].name
      const listed = await listJson()
      const preset = findPreset(listed, importedName)
      expect(preset !== undefined, 'imported preset is not listed')
      importedId = preset.id
      const raw = await presetFile(importedId)
      expectEqual(raw.metadata?.redacted, true, 'imported redacted flag')
      expectEqual(raw.metadata?.imported?.formatVersion, 1, 'imported format version metadata')

      const badPath = join(profile.cwd ?? profile.dir, `preset-it-bad-${process.pid}.json`)
      await writeFile(badPath, JSON.stringify({ format: 'dsh-plugin-presets', formatVersion: 999, presets: [] }), 'utf8')
      const countBefore = (await listJson()).presets.length
      const errorText = await commandError(`import "${badPath}" --json`)
      expect(/format version|Unsupported/i.test(errorText), `unexpected malformed-import error: ${errorText}`)
      const countAfter = (await listJson()).presets.length
      expectEqual(countAfter, countBefore, 'malformed import changed the preset count')
      return { importedId, importedName }
    })

    await check('tool read-only action works and tool apply is blocked without an agent', async () => {
      const tool = toolService.get('plugin_presets')
      expect(tool !== undefined, 'plugin_presets tool is not registered')
      const text = await tool.execute({ action: 'list' }, { signal: new AbortController().signal })
      const parsed = JSON.parse(text)
      expect(Array.isArray(parsed.presets), 'tool list result is not an array')
      const activeBefore = await readActive()
      let blocked
      try {
        await tool.execute({ action: 'apply', name: 'it-fixture' }, { signal: new AbortController().signal })
      } catch (error) {
        blocked = error
      }
      expect(blocked !== undefined, 'tool apply did not fail without approval routing')
      expect(/approval/i.test(blocked.message), `tool apply failed for the wrong reason: ${blocked.message}`)
      const activeAfter = await readActive()
      expectEqual(JSON.stringify(activeAfter), JSON.stringify(activeBefore), 'blocked tool apply changed the active marker')
      return { presets: parsed.presets.length }
    })

    await check('delete refuses without --yes and succeeds with it', async () => {
      await commandOk('duplicate it-base it-delete')
      const errorText = await commandError('delete it-delete')
      expect(/confirmation/i.test(errorText), `unexpected delete error: ${errorText}`)
      const listed = await listJson()
      expect(findPreset(listed, 'it-delete') !== undefined, 'preset disappeared before confirmation')
      const result = await commandOk('delete it-delete --yes')
      expect(result.includes('Deleted preset'), 'delete result is unexpected')
      const after = await listJson()
      expect(findPreset(after, 'it-delete') === undefined, 'deleted preset is still listed')
      const trash = await readdir(join(dataDir, 'trash'))
      expect(trash.length > 0, 'delete did not keep a trash copy')
      return { trash: trash.length }
    })

    let restoreBackupId
    let restoreMeta
    await check('apply again after rollback records a fresh backup', async () => {
      const result = await commandJson('apply it-fixture --json')
      expectEqual(result.changed, true, 'second apply changed flag')
      if (result.application === 'applied') await waitRow(FIXTURE_ROW, true)
      restoreBackupId = result.backupId
      restoreMeta = await backupMeta(restoreBackupId)
      const current = await live()
      expectEqual(current.manifestHash, restoreMeta.after.manifestHash, 'live manifest does not match backup.after')
      expectEqual(current.patchHash, restoreMeta.after.patchHash, 'live patch does not match backup.after')
      return { backupId: restoreBackupId, application: result.application }
    })

    await check('patchExists=false removes the file, then a normal preset restores it', async () => {
      const original = await live()
      expect(original.patchText !== null, 'profile has no patch file to test removal')
      const { rm } = await import('node:fs/promises')
      await rm(profile.patchPath)
      await sleep(300)
      await commandOk('save it-nopatch')
      const listed = await listJson()
      const nopatch = findPreset(listed, 'it-nopatch')
      expect(nopatch !== undefined, 'it-nopatch is not listed')
      const raw = await presetFile(nopatch.id)
      expectEqual(raw.captured.patchExists, false, 'it-nopatch captured.patchExists')
      await writeFile(profile.patchPath, original.patchText, 'utf8')
      await sleep(300)
      const result = await commandJson('apply it-nopatch --json')
      expectEqual(result.changed, true, 'it-nopatch apply changed flag')
      let exists = true
      try {
        await stat(profile.patchPath)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
        exists = false
      }
      expectEqual(exists, false, 'applying an absent-patch preset should remove cordis.patch.yml')
      await commandJson('apply it-fixture --json')
      const restored = await live()
      expectEqual(restored.patchText !== null, true, 'normal preset did not recreate the patch file')
      return { nopatchId: nopatch.id }
    })

    await check('simulate an interrupted apply that must be finalized on restart', async () => {
      const active = await readActive()
      expect(active !== null, 'active marker is missing')
      expectEqual(active.presetName, 'it-fixture', 'active preset before crash simulation')
      const current = await live()
      expectEqual(current.manifestHash, restoreMeta.after.manifestHash, 'live manifest does not match the finalize backup')
      expectEqual(current.patchHash, restoreMeta.after.patchHash, 'live patch does not match the finalize backup')
      await writeFile(join(dataDir, 'pending.json'), `${JSON.stringify({
        id: `it-finalize-${process.pid}`,
        backupId: restoreBackupId,
        presetId: active.presetId,
        presetName: 'it-fixture',
        presetSignature: active.presetSignature,
        appliedSignature: active.appliedSignature,
        before: restoreMeta.before,
        after: restoreMeta.after,
        activeBefore: restoreMeta.activeBefore,
        warnings: [],
        reason: 'apply',
      }, undefined, 2)}\n`, 'utf8')
      const pending = await readPending()
      expect(pending !== null, 'failed to write the pending marker')
      return { backupId: restoreBackupId }
    })
  }

  async function runRecovery() {
    await waitForPlugin()
    dataDir = (await commandJson('doctor --json')).dataDir
    await check('startup recovery finalized the interrupted apply', async () => {
      const pending = await readPending()
      expect(pending === null, 'pending.json still exists after startup recovery')
      const recovery = await readRecovery()
      expect(recovery?.action === 'finalized', `recovery action is ${JSON.stringify(recovery?.action)}`)
      const active = await readActive()
      expect(active?.presetName === 'it-fixture', 'active marker was not finalized')
      const state = await live()
      expect(state.bundles.includes(FIXTURE_BUNDLE), 'finalized live bundles miss the fixture')
      return { recovery: recovery.action }
    })

    await check('presets and the active marker survive the DSH restart', async () => {
      const listed = await listJson()
      expect(listed.presets.length >= 4, `expected persisted presets, found ${listed.presets.length}`)
      expect(findPreset(listed, 'it-fixture') !== undefined, 'it-fixture did not persist')
      expect(listed.active?.presetName === 'it-fixture', 'listed active preset did not persist')
      const current = await commandJson('current --json')
      expect(current.diff?.same === true, 'persisted active preset drifts from live files')
      return { presets: listed.presets.length }
    })

    let mixedBackupId
    let mixedBefore
    await check('set up a mixed crash state for the restore path', async () => {
      const applyResult = await commandJson('apply it-base --json')
      expectEqual(applyResult.changed, true, 'it-base apply changed flag')
      mixedBackupId = applyResult.backupId
      const meta = await backupMeta(mixedBackupId)
      mixedBefore = meta.before
      // Manifest is the after state (it-base); patch is forced back to before (it-fixture).
      const beforePatch = await backupText(mixedBackupId, 'cordis.patch.yml')
      expect(beforePatch !== null, 'backup has no patch text')
      await writeFile(profile.patchPath, beforePatch, 'utf8')
      const state = await live()
      expectEqual(state.manifestHash, meta.after.manifestHash, 'manifest is not in the after state')
      expectEqual(state.patchHash, meta.before.patchHash, 'patch is not in the before state')
      const activeBefore = meta.activeBefore
      await writeFile(join(dataDir, 'pending.json'), `${JSON.stringify({
        id: `it-restore-${process.pid}`,
        backupId: mixedBackupId,
        presetId: 'it-fixture',
        presetName: 'it-fixture',
        presetSignature: activeBefore?.presetSignature,
        appliedSignature: activeBefore?.appliedSignature,
        before: meta.before,
        after: meta.after,
        activeBefore,
        warnings: [],
        reason: 'apply',
      }, undefined, 2)}\n`, 'utf8')
      return { backupId: mixedBackupId }
    })
  }

  async function runRestore() {
    await waitForPlugin()
    dataDir = (await commandJson('doctor --json')).dataDir
    await check('startup recovery restored the pre-apply files from the backup', async () => {
      const pending = await readPending()
      expect(pending === null, 'pending.json still exists after startup recovery')
      const recovery = await readRecovery()
      expect(recovery?.action === 'restored', `recovery action is ${JSON.stringify(recovery?.action)}`)
      expectEqual(recovery?.restartRequired, true, 'recovery should require a restart')
      const state = await live()
      expect(state.bundles.includes(FIXTURE_BUNDLE), 'restored bundles miss the fixture')
      const active = await readActive()
      expect(active?.presetName === 'it-fixture', `active marker after restore is ${JSON.stringify(active?.presetName)}`)
      return { recovery: recovery.action }
    })

    await check('the profile is usable after recovery: validate, apply, rollback', async () => {
      const plan = await commandJson('validate it-base --json')
      expect(plan.valid === true, 'validate after recovery failed')
      const applied = await commandJson('apply it-base --json')
      expect(applied.changed === true || applied.changed === false, 'apply after recovery did not settle')
      const rolled = await commandJson('rollback --json')
      expect(typeof rolled.backupId === 'string', 'rollback after recovery failed')
      return { applied: applied.application, rolled: rolled.application }
    })
  }

  const run = async () => {
    try {
      if (PHASE === 'main') await runMain()
      else if (PHASE === 'recovery') await runRecovery()
      else if (PHASE === 'restore') await runRestore()
      else throw new Error(`unknown DSH_PRESET_IT_PHASE ${JSON.stringify(PHASE)}`)
      const failed = checks.filter((item) => !item.ok)
      await writeResult(failed.length === 0 ? 'passed' : 'failed')
      process.exit(failed.length === 0 ? 0 : 1)
    } catch (error) {
      checks.push({ label: 'harness', ok: false, error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) })
      log(`HARNESS ERROR: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      await writeResult('error').catch(() => {})
      process.exit(2)
    }
  }

  // Let the rest of the profile settle, then run. A short delay keeps the
  // harness from racing plugin registration; waitForPlugin still guards it.
  setTimeout(() => {
    run().catch((error) => {
      console.error('[it] harness rejected:', error)
      process.exit(3)
    })
  }, 250).unref?.()
}
