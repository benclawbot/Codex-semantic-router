import test from 'node:test';
import assert from 'node:assert/strict';
import { detectSecret, isSensitivePath, inspectRecord } from '../skills/bulk-semantic-filter/scripts/lib/redact.mjs';

const paths = ['.env', '.env.*', '**/.ssh/**', '**/*id_rsa*', '**/*id_ed25519*', '**/*.pem', '**/*.key', '**/credentials*', '**/secrets*', '**/.aws/**', '**/.config/gcloud/**'];

for (const [name, text] of [
  ['PEM', '-----BEGIN PRIVATE KEY-----\nabc'],
  ['bearer', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz'],
  ['assignment', 'password=correct-horse-battery-staple'],
  ['GitHub token', 'ghp_abcdefghijklmnopqrstuvwxyz123456'],
  ['AWS key', 'AKIAABCDEFGHIJKLMNOP'],
  ['JWT', 'eyJabcdefghijk.abcdefghijk.abcdefghijk'],
  ['credential URL', 'https://user:secret@example.com/api'],
  ['dotenv secret', 'DATABASE_PASSWORD=something-secret']
]) {
  test(`detects ${name}`, () => assert.equal(detectSecret(text).sensitive, true));
}

test('does not flag ordinary high-entropy-looking hashes', () => {
  assert.equal(detectSecret('sha256=8f1d1fc08c4e0478b1a73634f9a64482a82e223e').sensitive, false);
});

test('sensitive path rules match protected material', () => {
  assert.equal(isSensitivePath('.env.local', paths), true);
  assert.equal(isSensitivePath('home/.ssh/id_ed25519', paths), true);
  assert.equal(isSensitivePath('certs/server.pem', paths), true);
  assert.equal(isSensitivePath('src/secrets/config.json', paths), true);
  assert.equal(isSensitivePath('src/index.js', paths), false);
});

test('path sensitivity blocks remote classification even without secret text', () => {
  const result = inspectRecord({ path: '.env', text: 'PUBLIC_VALUE=hello' }, { sensitive_paths: paths, block_probable_secrets: true, extra_secret_patterns: [] });
  assert.equal(result.sensitive, true);
  assert.equal(result.reason, 'sensitive-path');
});
