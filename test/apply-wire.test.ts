/**
 * Tests for the wire between the page and the apply route.
 *
 * Both functions exist because their failure modes are silent: a body the host
 * refuses with a 400 reads as nothing happening, and a reply read wrongly shows
 * an empty box where a diff should be.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyOutput, applyRequestBody, readApplyReply } from '../src/client/apply-wire.ts'

test('the body carries a patch id and a flag, and nothing that steers the host', () => {
  const body = JSON.parse(applyRequestBody('plan-build-switch', true)) as Record<string, unknown>
  assert.deepEqual(body, { patchId: 'plan-build-switch', dryRun: true })
  // An id is the only value that crosses the wire, and it is matched against
  // the host's own spec before a command is built, so a body that named a
  // command, a path or an argument could not change what runs.
  assert.deepEqual(Object.keys(body).sort(), ['dryRun', 'patchId'])
})

test('the body says which kind of run it wants, every time', () => {
  assert.equal(JSON.parse(applyRequestBody('a', false)).dryRun, false)
  assert.equal(JSON.parse(applyRequestBody('a', true)).dryRun, true)
})

test('a reply is read as the host sent it', () => {
  const reply = readApplyReply(
    JSON.stringify({
      ok: true,
      patchId: 'a',
      dryRun: false,
      code: 0,
      timedOut: false,
      truncated: false,
      stdout: 'patched\n',
      stderr: '',
    }),
    200,
  )
  assert.equal(reply.ok, true)
  assert.equal(reply.patchId, 'a')
  assert.equal(reply.dryRun, false)
  assert.equal(reply.code, 0)
  assert.equal(reply.timedOut, false)
  assert.equal(reply.truncated, false)
  assert.equal(reply.stdout, 'patched\n')
  assert.equal(reply.stderr, '')
})

test('a refusal is read as a refusal, not as a failed run', () => {
  const reply = readApplyReply(JSON.stringify({ ok: false, error: 'the row is not addressable' }), 409)
  assert.equal(reply.ok, false)
  assert.equal(reply.error, 'the row is not addressable')
  // Nothing ran, so nothing should look like output.
  assert.equal(reply.stdout, undefined)
})

test('a timeout keeps its own flag instead of reading as a clean failure', () => {
  const reply = readApplyReply(JSON.stringify({ ok: false, timedOut: true, code: -1, stderr: 'killed' }), 504)
  assert.equal(reply.timedOut, true)
  assert.equal(reply.code, -1)
})

test('a truncated reply says so, because a diff that stops mid-line is not a diff', () => {
  const reply = readApplyReply(JSON.stringify({ ok: true, truncated: true, stdout: '...' }), 200)
  assert.equal(reply.truncated, true)
})

test('a proxy error page is a message, not a crash', () => {
  const reply = readApplyReply('<html>502 Bad Gateway</html>', 502)
  assert.equal(reply.ok, false)
  assert.match(reply.error ?? '', /502/)
})

test('a body that is not JSON at all is a message too', () => {
  const reply = readApplyReply('', 0)
  assert.equal(reply.ok, false)
  assert.match(reply.error ?? '', /never reached the host/)
})

test('JSON that is not an object is still only a message', () => {
  for (const text of ['null', '42', '"done"', '[]']) {
    const reply = readApplyReply(text, 200)
    assert.equal(reply.ok, false, text)
    assert.match(reply.error ?? '', /cannot read/, text)
  }
})

test('a reply missing every optional field is still usable', () => {
  const reply = readApplyReply('{"ok":true}', 200)
  assert.equal(reply.ok, true)
  assert.equal(reply.dryRun, false)
  assert.equal(reply.timedOut, false)
  assert.equal(reply.truncated, false)
  assert.equal(reply.stdout, undefined)
})

test('a field of the wrong type is dropped rather than passed through as text', () => {
  // These come off a host this page does not control, in a build where the
  // types are erased. Reading "the page will render it" off an untrusted value
  // is how a number turns into [object Object] three components deep.
  const reply = readApplyReply(
    JSON.stringify({ ok: true, stdout: { nested: true }, code: 'zero', error: 7, patchId: ['a'] }),
    200,
  )
  assert.equal(reply.stdout, undefined)
  assert.equal(reply.code, undefined)
  assert.equal(reply.error, undefined)
  assert.equal(reply.patchId, undefined)
})

test('what is worth showing is the command’s own words', () => {
  assert.equal(
    applyOutput(readApplyReply(JSON.stringify({ ok: true, stdout: '- old\n+ new\n', stderr: '' }), 200)),
    '- old\n+ new',
  )
  // A command that says nothing on stdout and everything on stderr is common,
  // and showing only the empty half would look like a button that did nothing.
  assert.equal(
    applyOutput(readApplyReply(JSON.stringify({ ok: false, stdout: '', stderr: 'ERR_PNPM' }), 500)),
    'ERR_PNPM',
  )
})

test('a refusal is shown instead of output, because it is the reason there is none', () => {
  const reply = readApplyReply(JSON.stringify({ ok: false, error: 'already applying "a"' }), 409)
  assert.equal(applyOutput(reply), 'already applying "a"')
})

test('a silent success is called a silent success rather than an empty box', () => {
  assert.match(applyOutput(readApplyReply('{"ok":true}', 200)), /said nothing/)
})

test('no reply is no output', () => {
  assert.equal(applyOutput(undefined), '')
})
