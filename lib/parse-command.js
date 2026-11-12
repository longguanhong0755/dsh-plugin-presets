import { PresetError } from './errors.js'

/** Split a command line into tokens, honoring single/double quotes and backslash escapes.
 * Backslashes inside Windows paths are preserved unless they escape a quote, whitespace, or another backslash.
 */
export function tokenize(input) {
  const text = String(input ?? '')
  const tokens = []
  let current = ''
  let quote = ''
  let escaped = false
  let started = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (escaped) {
      current += char
      escaped = false
      started = true
      continue
    }
    if (char === '\\') {
      const next = text[index + 1]
      const escapes = quote !== ''
        ? next === quote || next === '\\'
        : next === undefined || /\s/.test(next) || next === '"' || next === "'" || next === '\\'
      if (escapes) {
        escaped = true
      } else {
        current += char
        started = true
      }
      continue
    }
    if (quote !== '') {
      if (char === quote) {
        quote = ''
      } else {
        current += char
      }
      started = true
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
    started = true
  }

  if (escaped) current += '\\'
  if (quote !== '') throw new PresetError('invalid-arguments', `Unterminated ${quote === '"' ? 'double' : 'single'} quote in the command arguments.`)
  if (started) tokens.push(current)
  return tokens
}

/**
 * Parse flags and positionals after the action word.
 * @param {string[]} tokens
 * @param {Record<string, {kind: 'boolean'|'value'|'pair', multiple?: boolean}>} spec
 * @returns {{positionals: string[], flags: Record<string, boolean|string|string[]>}}
 */
export function parseOptions(tokens, spec) {
  const positionals = []
  const flags = {}
  let literal = false

  const assign = (name, value) => {
    if (spec[name].multiple === true) {
      const previous = flags[name]
      flags[name] = previous === undefined ? [value] : [...previous, value]
    } else {
      if (flags[name] !== undefined) throw new PresetError('invalid-arguments', `--${name} was given more than once.`)
      flags[name] = value
    }
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (literal || !token.startsWith('--') || token === '-') {
      positionals.push(token)
      continue
    }
    if (token === '--') {
      literal = true
      continue
    }
    const equals = token.indexOf('=')
    const name = token.slice(2, equals < 0 ? undefined : equals)
    const inline = equals < 0 ? undefined : token.slice(equals + 1)
    const option = spec[name]
    if (option === undefined) throw new PresetError('invalid-arguments', `Unknown option --${name}.`)
    if (option.kind === 'boolean') {
      if (inline !== undefined) throw new PresetError('invalid-arguments', `--${name} does not take a value.`)
      assign(name, true)
      continue
    }
    const arity = option.kind === 'pair' ? 2 : 1
    const values = []
    if (inline !== undefined) values.push(inline)
    while (values.length < arity) {
      index += 1
      if (index >= tokens.length) throw new PresetError('invalid-arguments', `--${name} needs ${arity === 2 ? 'two values' : 'a value'}.`)
      values.push(tokens[index])
    }
    assign(name, arity === 2 ? values : values[0])
  }
  return { positionals, flags }
}

export function requirePositionals(positionals, count, usage, names = []) {
  if (positionals.length < count) {
    const missing = names.slice(positionals.length, count)
    throw new PresetError('invalid-arguments', `Missing ${missing.length > 0 ? missing.join(', ') : 'argument'}.`, { nextStep: usage })
  }
  if (positionals.length > count) {
    throw new PresetError('invalid-arguments', `Unexpected argument ${JSON.stringify(positionals[count])}.`, { nextStep: usage })
  }
}
