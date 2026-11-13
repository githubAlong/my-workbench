import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accountIdentifierFromPhone,
  isAccountNumber,
  normalizeAccountIdentifier,
} from '../js/auth-identifier.mjs';

test('accepts an exact 11-digit numeric account', () => {
  assert.equal(isAccountNumber('13912345678'), true);
  assert.equal(normalizeAccountIdentifier('13912345678'), '+8613912345678');
});

test('does not require a mobile-number prefix or verify ownership', () => {
  assert.equal(isAccountNumber('01234567890'), true);
  assert.equal(normalizeAccountIdentifier('01234567890'), '+8601234567890');
});

test('preserves legacy +86, 86 and 0086 Supabase identities', () => {
  assert.equal(normalizeAccountIdentifier('+8613912345678'), '+8613912345678');
  assert.equal(normalizeAccountIdentifier('8613912345678'), '+8613912345678');
  assert.equal(normalizeAccountIdentifier('008613912345678'), '+8613912345678');
});

test('maps a canonical Supabase identity back to the 11-digit account', () => {
  assert.equal(accountIdentifierFromPhone('+8613912345678'), '13912345678');
  assert.equal(accountIdentifierFromPhone('008613912345678'), '13912345678');
});

test('rejects identifiers that are not exactly 11 digits', () => {
  assert.equal(isAccountNumber('1391234567'), false);
  assert.equal(isAccountNumber('139123456789'), false);
  assert.throws(() => normalizeAccountIdentifier('1391234567'), /11位数字/);
  assert.throws(() => normalizeAccountIdentifier('abc12345678'), /11位数字/);
});
