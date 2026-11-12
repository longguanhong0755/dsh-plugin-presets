import { randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { jsonText } from './util.js'

let nativeAtomic
try {
  nativeAtomic = await import('@deepseek-ai/dsh-atomic-write')
} catch {
  nativeAtomic = undefined
}

const RENAME_RETRIES = 8

async function fallbackWriteFileAtomic(filename, content, options = {}) {
  await mkdir(dirname(filename), { recursive: true, ...(options.dirMode === undefined ? {} : { mode: options.dirMode }) })
  const temp = `${filename}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, content, { mode: options.mode ?? 0o600, flag: 'wx' })
    let wait = 20
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temp, filename)
        return
      } catch (error) {
        if (process.platform !== 'win32' || attempt >= RENAME_RETRIES || !['EACCES', 'EBUSY', 'EPERM'].includes(error?.code)) throw error
      }
      await delay(wait)
      wait = Math.min(wait * 2, 200)
    }
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

const fallbackLockTails = new Map()

/** In-process serializer used only when the DSH atomic-write package is unavailable. */
function fallbackWithFileLock(filename, operation) {
  const key = resolve(filename)
  const prior = fallbackLockTails.get(key) ?? Promise.resolve()
  const run = prior.then(operation, operation)
  const tail = run.catch(() => {})
  fallbackLockTails.set(key, tail)
  return run.finally(() => {
    if (fallbackLockTails.get(key) === tail) fallbackLockTails.delete(key)
  })
}

export const writeFileAtomic = nativeAtomic?.writeFileAtomic ?? fallbackWriteFileAtomic
export const withFileLock = nativeAtomic?.withFileLock ?? fallbackWithFileLock
export const usingNativeAtomicWrite = nativeAtomic !== undefined

export async function readTextIfExists(filename) {
  try {
    return await readFile(filename, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

export async function readJsonIfExists(filename) {
  const text = await readTextIfExists(filename)
  if (text === null) return null
  return JSON.parse(text)
}

export async function writeJsonAtomic(filename, value, options = {}) {
  await writeFileAtomic(filename, jsonText(value), { mode: 0o600, ...options })
}

export async function fileExists(filename) {
  try {
    const info = await stat(filename)
    return info.isFile()
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

export async function statSafe(filename) {
  try {
    return await stat(filename)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

export async function ensureDir(dir, mode = 0o700) {
  await mkdir(dir, { recursive: true, mode })
}

export async function listDirectory(dir) {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

export async function removeFile(filename) {
  await rm(filename, { force: true })
}

export async function readFileLimited(filename, maxBytes) {
  const info = await stat(filename)
  if (!info.isFile()) throw new Error(`${filename} is not a regular file`)
  if (info.size > maxBytes) throw new Error(`${filename} is ${info.size} bytes; the limit is ${maxBytes} bytes`)
  return await readFile(filename, 'utf8')
}
