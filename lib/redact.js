import { isPlainObject } from './util.js'

const EXACT_SECRET_KEYS = new Set([
  'authorization',
  'cookie',
  'setcookie',
  'password',
  'passwd',
  'pwd',
  'secret',
  'clientsecret',
  'apikey',
  'accesskey',
  'secretaccesskey',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authtoken',
  'bearertoken',
  'token',
  'privatekey',
  'secretkey',
  'signingkey',
  'encryptionkey',
  'sessionkey',
  'credential',
  'credentials',
  'auth',
  'authentication',
])

const SECRET_SUFFIXES = [
  'apikey',
  'accesskey',
  'secretaccesskey',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authtoken',
  'bearertoken',
  'clientsecret',
  'privatekey',
  'secretkey',
  'signingkey',
  'encryptionkey',
  'sessionkey',
  'password',
  'passwd',
]

/** Whether a configuration key conventionally holds a secret value. */
export function isSensitiveKey(key) {
  const normalized = String(key)
    .trim()
    .replace(/^["']|["']$/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
  if (normalized.length === 0) return false
  if (EXACT_SECRET_KEYS.has(normalized)) return true
  return SECRET_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
}

/** Replace credentials embedded in a URL's userinfo. */
function redactUrlUserinfo(value) {
  return value.replace(/\b(https?:\/\/)([^/@\s]+)@/gi, '$1<redacted>@')
}

/**
 * Redact secret-looking values in a config value.
 * @returns {{value: unknown, paths: string[]}}
 */
export function redactConfig(value, path = '') {
  const paths = []
  const walk = (current, currentPath) => {
    if (Array.isArray(current)) {
      return current.map((item, index) => walk(item, `${currentPath}[${index}]`))
    }
    if (isPlainObject(current)) {
      const result = {}
      for (const [key, child] of Object.entries(current)) {
        const childPath = currentPath.length === 0 ? key : `${currentPath}.${key}`
        if (isSensitiveKey(key) && child !== undefined && child !== null && child !== '') {
          result[key] = '<redacted>'
          paths.push(childPath)
          continue
        }
        result[key] = walk(child, childPath)
      }
      return result
    }
    if (typeof current === 'string') {
      const redacted = redactUrlUserinfo(current)
      if (redacted !== current) paths.push(`${currentPath || '<value>'}:url-userinfo`)
      return redacted
    }
    return current
  }
  return { value: walk(value, path), paths }
}

function splitTopLevelKeyValue(text) {
  let quote = ''
  let escaped = false
  let depth = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== '') {
      if (escaped) {
        escaped = false
      } else if (char === '\\' && quote === '"') {
        escaped = true
      } else if (char === quote) {
        quote = ''
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '[' || char === '{') {
      depth += 1
      continue
    }
    if (char === ']' || char === '}') {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (char === '#' && depth === 0 && (index === 0 || /\s/.test(text[index - 1]))) return null
    if (char === ':' && depth === 0) return { key: text.slice(0, index).trim(), value: text.slice(index + 1) }
  }
  return null
}

function unquoteKey(key) {
  const trimmed = key.trim()
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function looksLikeLiteralSecret(expression) {
  return /(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._~+/=-]{12,}|[A-Za-z0-9+/=_-]{40,})/.test(expression)
}

function isBlockScalarHeader(value) {
  return /^[|>][-+0-9]*\s*(?:#.*)?$/.test(value.trim())
}

function indentOf(line) {
  const match = /^(\s*)/.exec(line)
  return match === null ? 0 : match[1].length
}

/**
 * Redact secret-looking values in a raw DSH patch without changing its YAML shape.
 * Line-oriented so comments, `!!js` expressions, and ordering stay intact.
 * @returns {{text: string, paths: string[], expressionsPreserved: number}}
 */
export function redactPatchText(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n')
  const output = []
  const paths = []
  let expressionsPreserved = 0

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const indent = indentOf(line)
    const contentStart = line.slice(indent)
    const itemMatch = /^-\s+/.exec(contentStart)
    const itemOffset = itemMatch === null ? 0 : itemMatch[0].length
    const body = contentStart.slice(itemOffset)
    const pair = splitTopLevelKeyValue(body)

    if (pair === null) {
      output.push(line)
      continue
    }

    const key = unquoteKey(pair.key)
    const rawValue = pair.value
    const trimmedValue = rawValue.trim()
    const prefix = `${line.slice(0, indent)}${itemOffset > 0 ? '- ' : ''}${pair.key}:`

    if (!isSensitiveKey(key)) {
      output.push(redactInlineJsonPairs(line, paths))
      continue
    }

    if (isBlockScalarHeader(trimmedValue)) {
      output.push(`${prefix} ${trimmedValue}`)
      let blockIndent = indent + 2
      let next = index + 1
      while (next < lines.length) {
        const candidate = lines[next]
        if (candidate.trim().length === 0) {
          next += 1
          continue
        }
        if (indentOf(candidate) <= indent) break
        blockIndent = Math.min(blockIndent, indentOf(candidate))
        next += 1
      }
      if (next > index + 1) {
        output.push(`${' '.repeat(blockIndent)}<redacted>`)
        paths.push(key)
        index = next - 1
      }
      continue
    }

    if (trimmedValue.startsWith('!!js ') || trimmedValue.startsWith('!js ')) {
      if (looksLikeLiteralSecret(trimmedValue)) {
        output.push(`${prefix} "<redacted>"`)
        paths.push(key)
      } else {
        output.push(line)
        expressionsPreserved += 1
      }
      continue
    }

    if (trimmedValue.length > 0) {
      output.push(`${prefix} "<redacted>"`)
      paths.push(key)
      continue
    }

    // A sensitive key with no inline value may still own an indented block.
    let next = index + 1
    while (next < lines.length && lines[next].trim().length === 0) next += 1
    if (next < lines.length && indentOf(lines[next]) > indent) {
      output.push(`${prefix} "<redacted>"`)
      let end = next
      while (end < lines.length) {
        if (lines[end].trim().length === 0) {
          end += 1
          continue
        }
        if (indentOf(lines[end]) <= indent) break
        end += 1
      }
      paths.push(key)
      index = end - 1
      continue
    }
    output.push(`${prefix} "<redacted>"`)
    paths.push(key)
  }

  return { text: output.join('\n'), paths, expressionsPreserved }
}

function redactInlineJsonPairs(line, paths) {
  return line.replace(
    /(["']?)([A-Za-z_$][A-Za-z0-9_.$-]*)\1(\s*:\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,}\]\s]+)/g,
    (match, quote, key, separator, value) => {
      if (!isSensitiveKey(key)) return match
      if (value === '"<redacted>"' || value === "'<redacted>'" || value === '<redacted>') return match
      paths.push(key)
      return `${quote}${key}${quote}${separator}"<redacted>"`
    },
  )
}

/**
 * Prepare a preset document for export.
 * @param {object} preset
 * @param {{includeSecrets?: boolean}} options
 */
export function presetForExport(preset, options = {}) {
  const clone = structuredClone(preset)
  if (options.includeSecrets === true) {
    clone.metadata = {
      ...(clone.metadata ?? {}),
      redacted: false,
      secretsIncluded: true,
    }
    return { preset: clone, redaction: { applied: false, fields: 0, expressionsPreserved: 0 } }
  }

  const paths = []
  if (Array.isArray(clone.captured?.entries)) {
    clone.captured.entries = clone.captured.entries.map((entry) => {
      const redacted = redactConfig(entry.config ?? {})
      paths.push(...redacted.paths.map((path) => `entries.${entry.id ?? entry.name ?? '?'}.${path}`))
      return { ...entry, config: redacted.value }
    })
  }
  if (Array.isArray(clone.captured?.edits)) {
    clone.captured.edits = clone.captured.edits.map((edit) => {
      if (edit.config === undefined) return edit
      const redacted = redactConfig(edit.config)
      paths.push(...redacted.paths.map((path) => `edits.${edit.id ?? '?'}.${path}`))
      return { ...edit, config: redacted.value }
    })
  }
  const patchRedaction = redactPatchText(clone.captured?.patch ?? '')
  clone.captured = {
    ...clone.captured,
    patch: patchRedaction.text,
    patchHash: undefined,
  }
  delete clone.captured.patchHash
  paths.push(...patchRedaction.paths.map((path) => `patch.${path}`))
  clone.metadata = {
    ...(clone.metadata ?? {}),
    redacted: true,
    secretsIncluded: false,
  }
  clone.redaction = {
    applied: true,
    fields: paths.length,
    expressionsPreserved: patchRedaction.expressionsPreserved,
    note: 'Secret-looking values were replaced with "<redacted>". Re-enter them after importing, or export with includeSecrets.',
  }
  return {
    preset: clone,
    redaction: {
      applied: true,
      fields: paths.length,
      expressionsPreserved: patchRedaction.expressionsPreserved,
      paths: [...new Set(paths)].slice(0, 200),
    },
  }
}

export function containsRedactedMarker(value) {
  if (typeof value === 'string') return value.includes('<redacted>')
  if (Array.isArray(value)) return value.some(containsRedactedMarker)
  if (isPlainObject(value)) return Object.values(value).some(containsRedactedMarker)
  return false
}
