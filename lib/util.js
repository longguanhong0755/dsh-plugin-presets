import { createHash, randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { MAX_NAME_LENGTH } from './constants.js'

export { isDeepStrictEqual }

export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

export function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

export function normalizeEol(value) {
  return String(value).replace(/\r\n?/g, '\n')
}

export function isoNow() {
  return new Date().toISOString()
}

export function newPresetId() {
  return `ps_${Date.now().toString(36)}_${randomBytes(6).toString('hex')}`
}

export function newBackupId() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
  return `bk_${stamp}_${randomBytes(4).toString('hex')}`
}

export function newTransactionId() {
  return `tx_${Date.now().toString(36)}_${randomBytes(6).toString('hex')}`
}

/** Normalize a preset name for storage. Case is preserved; comparison uses {@link nameKey}. */
export function normalizePresetName(input) {
  if (typeof input !== 'string') throw new TypeError('Preset name must be a string')
  const name = input.normalize('NFKC').replace(/\s+/g, ' ').trim()
  if (name.length === 0) throw new TypeError('Preset name must not be empty')
  if (name.length > MAX_NAME_LENGTH) throw new TypeError(`Preset name must be at most ${MAX_NAME_LENGTH} characters`)
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new TypeError('Preset name must not contain control characters')
  if (name === '.' || name === '..') throw new TypeError('Preset name must not be "." or ".."')
  if (/^ps_/i.test(name)) throw new TypeError('Preset names must not start with "ps_" because that prefix is reserved for preset ids')
  return name
}

export function nameKey(name) {
  return normalizePresetName(name).toLowerCase()
}

export function safeProfileKey(name) {
  const slug = String(name ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug.length > 0 ? slug : 'profile'
}

/** Generate a non-colliding display name, preserving the caller's base when possible. */
export function uniqueDisplayName(base, takenKeys, suffix = 'imported') {
  const clean = normalizePresetName(base)
  const first = `${clean} (${suffix})`
  if (!takenKeys.has(nameKey(first))) return clipName(first)
  for (let index = 2; index < 1000; index += 1) {
    const candidate = clipName(`${clean} (${suffix} ${index})`)
    if (!takenKeys.has(nameKey(candidate))) return candidate
  }
  return clipName(`${clean} (${suffix} ${randomBytes(3).toString('hex')})`)
}

function clipName(name) {
  if (name.length <= MAX_NAME_LENGTH) return name
  return `${name.slice(0, MAX_NAME_LENGTH - 12)}…${randomBytes(2).toString('hex')}`
}

/** Recursively sort object keys so signatures do not depend on insertion order. */
export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value, new Set()))
}

function canonicalize(value, seen) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') return null
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalize(item, seen))
    if (isPlainObject(value)) {
      const result = {}
      for (const key of Object.keys(value).sort()) {
        result[key] = canonicalize(value[key], seen)
      }
      return result
    }
    if (value instanceof Date) return value.toISOString()
    try {
      return canonicalize(JSON.parse(JSON.stringify(value)), seen)
    } catch {
      return String(value)
    }
  } finally {
    seen.delete(value)
  }
}

export function parseSemver(value) {
  if (typeof value !== 'string') return null
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim())
  if (match === null) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? '',
    raw: value.trim(),
  }
}

/** Compare two parsed versions; a prerelease sorts before the same release. */
export function compareSemver(left, right) {
  for (const part of ['major', 'minor', 'patch']) {
    if (left[part] !== right[part]) return left[part] < right[part] ? -1 : 1
  }
  if (left.prerelease === right.prerelease) return 0
  if (left.prerelease === '') return 1
  if (right.prerelease === '') return -1
  return left.prerelease < right.prerelease ? -1 : 1
}

export function truncate(value, max) {
  const text = String(value)
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

export function humanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

export function clampInteger(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isInteger(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
    }, { once: true })
  })
}

export function jsonText(value) {
  return `${JSON.stringify(value, undefined, 2)}\n`
}

/** Convert CRLF text to the exact form DSH writes (LF, trailing newline). */
export function normalizedPatchText(raw) {
  const text = normalizeEol(raw ?? '')
  return text.length === 0 ? '[]\n' : text
}
