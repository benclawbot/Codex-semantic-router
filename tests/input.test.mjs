import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInput, clipText, getPath, InputParseError } from '../skills/bulk-semantic-filter/scripts/lib/input.mjs';

test('line input preserves order, blanks, unicode, and inferred paths', () => {
  const records = parseInput('src/a.rs:1: fn x() {}\n\n日本語\n');
  assert.equal(records.length, 3);
  assert.equal(records[0].path, 'src/a.rs');
  assert.equal(records[1].blank, true);
  assert.equal(records[2].text, '日本語');
});


test('line input preserves Windows drive paths before line numbers', () => {
  const [record] = parseInput('C:\\repo\\.env:12:SECRET=value');
  assert.equal(record.path, 'C:\\repo\\.env');
});

test('JSONL supports dotted fields and ephemeral ids', () => {
  const input = [
    JSON.stringify({ meta: { id: 'a' }, payload: { text: 'one' }, path: 'src/a.js' }),
    JSON.stringify({ payload: { text: 'two' } })
  ].join('\n');
  const records = parseInput(input, { format: 'jsonl', textField: 'payload.text', idField: 'meta.id' });
  assert.equal(records[0].id, 'a');
  assert.equal(records[1].id, '1');
  assert.equal(records[0].path, 'src/a.js');
  assert.equal(getPath(records[0].object, 'payload.text'), 'one');
});

test('malformed JSONL throws a typed parse error', () => {
  assert.throws(() => parseInput('{oops}', { format: 'jsonl' }), InputParseError);
});

test('JSONL requires selected text field to be a string', () => {
  assert.throws(() => parseInput('{"text":12}', { format: 'jsonl' }), /must be a string/);
});

test('clipText preserves head and tail with explicit marker', () => {
  const original = 'a'.repeat(9000) + 'TAIL';
  const clipped = clipText(original, 8000);
  assert.equal(clipped.clipped, true);
  assert.ok(clipped.text.length <= 8000);
  assert.match(clipped.text, /locally clipped/);
  assert.ok(clipped.text.endsWith('TAIL'));
});

test('clipText leaves short text unchanged', () => {
  assert.deepEqual(clipText('short', 8000), { text: 'short', clipped: false });
});
