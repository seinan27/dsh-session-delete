// The sweep is the only part of this plugin that can be tested without a running host:
// it is pure file surgery. Everything else (registry removal, the live-agent stop, the
// web route) needs the storage domain and is verified by hand.
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert'

const HOME = join(process.cwd(), 'test', '.tmp-home')
const ID = 'session-11111111-2222-3333-4444-555555555555'
const OTHER = 'session-99999999-8888-7777-6666-555555555555'

let passed = 0
let failed = 0

function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log('ok    ' + name)
  } catch (e) {
    failed += 1
    console.log('FAIL  ' + name + '\n        ' + (e && e.message))
  }
}

function reset() {
  rmSync(HOME, { recursive: true, force: true })
  mkdirSync(join(HOME, 'storages'), { recursive: true })
  mkdirSync(join(HOME, 'qq-bridge'), { recursive: true })
}

process.env.DSH_HOME = HOME
const mod = await import('../lib/index.js')
const { sweepReferences, pruneRefs } = mod

/* ---------------------------------------------------------------- pruneRefs */

check('pruneRefs removes a key that is the id', () => {
  const o = { [ID]: 1, keep: 2 }
  assert.equal(pruneRefs(o, ID), 1)
  assert.deepEqual(o, { keep: 2 })
})

check('pruneRefs removes a key whose value contains the id', () => {
  const o = { a: 'x ' + ID + ' y', b: 'clean' }
  assert.equal(pruneRefs(o, ID), 1)
  assert.deepEqual(o, { b: 'clean' })
})

check('pruneRefs removes an array element equal to the id', () => {
  const o = { ids: [ID, OTHER] }
  assert.equal(pruneRefs(o, ID), 1)
  assert.deepEqual(o, { ids: [OTHER] })
})

check('pruneRefs descends into nested objects', () => {
  const o = { deep: { deeper: { [ID]: 'x' } } }
  assert.equal(pruneRefs(o, ID), 1)
  assert.deepEqual(o, { deep: { deeper: {} } })
})

check('pruneRefs leaves other ids alone', () => {
  const o = { [OTHER]: 1, ids: [OTHER] }
  assert.equal(pruneRefs(o, ID), 0)
  assert.deepEqual(o, { [OTHER]: 1, ids: [OTHER] })
})

/* ----------------------------------------------------------- sweepReferences */

check('sweep removes the id from a .json store and keeps the rest', () => {
  reset()
  writeFileSync(join(HOME, 'main-session.json'), JSON.stringify({
    mains: { [ID]: { note: 'gone' }, keep: { note: 'stays' } },
    lastActive: ID,
  }, null, 2))
  const w = []
  const r = sweepReferences(ID, w)
  const after = JSON.parse(readFileSync(join(HOME, 'main-session.json'), 'utf8'))
  assert.deepEqual(after, { mains: { keep: { note: 'stays' } } })
  assert.equal(r.keys, 2)
  assert.equal(w.length, 0)
})

check('sweep drops whole lines from a .jsonl transcript', () => {
  reset()
  writeFileSync(join(HOME, 'qq-bridge', 'transcript.jsonl'), [
    '{"text":"keep one"}',
    '{"text":"about ' + ID + ' and a whole reply"}',
    '{"text":"keep two"}',
  ].join('\n'))
  const w = []
  const r = sweepReferences(ID, w)
  const after = readFileSync(join(HOME, 'qq-bridge', 'transcript.jsonl'), 'utf8')
  assert.equal(after.split('\n').length, 2)
  assert.ok(!after.includes(ID))
  assert.ok(after.includes('keep one') && after.includes('keep two'))
  assert.equal(r.lines, 1)
})

check('sweep drops lines from a .log', () => {
  reset()
  writeFileSync(join(HOME, 'prompt-inherit.log'),
    ['2026-01-01 ' + ID + ' injected', '2026-01-02 other injected'].join('\n'))
  const w = []
  sweepReferences(ID, w)
  const after = readFileSync(join(HOME, 'prompt-inherit.log'), 'utf8')
  assert.ok(!after.includes(ID))
  assert.ok(after.includes('other injected'))
})

check('sweep removes the id from a workspace sessionIds array', () => {
  reset()
  writeFileSync(join(HOME, 'storages', 'workspace.json'), JSON.stringify({
    workspaces: [{ id: 'w1', sessionIds: [ID, OTHER] }],
  }, null, 2))
  const w = []
  sweepReferences(ID, w)
  const after = JSON.parse(readFileSync(join(HOME, 'storages', 'workspace.json'), 'utf8'))
  assert.deepEqual(after.workspaces[0].sessionIds, [OTHER])
})

check('sweep is a no-op when the id never appears', () => {
  reset()
  writeFileSync(join(HOME, 'main-session.json'), JSON.stringify({ lastActive: OTHER }, null, 2))
  const before = readFileSync(join(HOME, 'main-session.json'), 'utf8')
  const w = []
  const r = sweepReferences(ID, w)
  assert.deepEqual(r, { lines: 0, keys: 0 })
  assert.equal(readFileSync(join(HOME, 'main-session.json'), 'utf8'), before)
})

check('sweep records a warning instead of throwing on malformed json', () => {
  reset()
  // Must CONTAIN the id, or the sweep skips the file before it ever parses it.
  writeFileSync(join(HOME, 'main-session.json'), '{ "x": "' + ID + '"')
  const w = []
  sweepReferences(ID, w)
  assert.equal(w.length, 1)
  assert.ok(w[0].startsWith('sweep main-session.json'))
})

check('sweep skips files that do not exist', () => {
  reset()
  const w = []
  const r = sweepReferences(ID, w)
  assert.deepEqual(r, { lines: 0, keys: 0 })
  assert.equal(w.length, 0)
})

/* ------------------------------------------------------------ module surface */

check('the plugin exports a name and an apply', () => {
  assert.equal(typeof mod.apply, 'function')
  assert.equal(typeof mod.name, 'string')
})

check('the recycle-bin helper is not exported by accident', () => {
  // It shells out to PowerShell; the UI must never be able to call it directly.
  assert.equal(mod.sendToRecycleBin, undefined)
})

rmSync(HOME, { recursive: true, force: true })

console.log('')
console.log(passed + ' passed, ' + failed + ' failed')
if (failed) process.exitCode = 1
