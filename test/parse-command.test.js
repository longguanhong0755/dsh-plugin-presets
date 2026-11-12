import assert from 'node:assert/strict'
import test from 'node:test'
import { parseOptions, requirePositionals, tokenize } from '../lib/parse-command.js'

test('tokenize splits words and honors quotes', () => {
  assert.deepEqual(tokenize("save 'My Work' --description \"a b\""), ['save', 'My Work', '--description', 'a b'])
  assert.deepEqual(tokenize('  list   --json  '), ['list', '--json'])
  assert.deepEqual(tokenize(''), [])
})

test('tokenize preserves Windows paths and escaped quotes', () => {
  assert.deepEqual(tokenize('import C:\\Users\\me\\presets.json'), ['import', 'C:\\Users\\me\\presets.json'])
  assert.deepEqual(tokenize('save "say \\"hi\\""'), ['save', 'say "hi"'])
})

test('tokenize rejects an unterminated quote', () => {
  assert.throws(() => tokenize('show "broken'), /Unterminated/)
})

test('parseOptions handles booleans, values, pairs, and repeats', () => {
  const { positionals, flags } = parseOptions(
    ['first', '--json', '--set', 'demo', '{"a":1}', '--move-bundle', 'pkg', '2', '--include', 'a', '--include', 'b', '--'],
    {
      json: { kind: 'boolean' },
      set: { kind: 'pair' },
      'move-bundle': { kind: 'pair' },
      include: { kind: 'value', multiple: true },
    },
  )
  assert.deepEqual(positionals, ['first'])
  assert.deepEqual(flags, {
    json: true,
    set: ['demo', '{"a":1}'],
    'move-bundle': ['pkg', '2'],
    include: ['a', 'b'],
  })
})

test('parseOptions treats tokens after -- as positional', () => {
  const { positionals, flags } = parseOptions(['--', '--json'], { json: { kind: 'boolean' } })
  assert.deepEqual(positionals, ['--json'])
  assert.deepEqual(flags, {})
})

test('parseOptions supports inline values and rejects misuse', () => {
  const { flags } = parseOptions(['--conflict=skip'], { conflict: { kind: 'value' } })
  assert.equal(flags.conflict, 'skip')
  assert.throws(() => parseOptions(['--json=yes'], { json: { kind: 'boolean' } }), /does not take a value/)
  assert.throws(() => parseOptions(['--json', '--json'], { json: { kind: 'boolean' } }), /more than once/)
  assert.throws(() => parseOptions(['--unknown'], {}), /Unknown option/)
  assert.throws(() => parseOptions(['--set', 'one'], { set: { kind: 'pair' } }), /needs two values/)
})

test('requirePositionals reports missing and extra arguments', () => {
  assert.throws(() => requirePositionals([], 1, 'usage', ['name']), /Missing name/)
  assert.throws(() => requirePositionals(['a', 'b'], 1, 'usage'), /Unexpected argument/)
  assert.doesNotThrow(() => requirePositionals(['a'], 1, 'usage'))
})
