import test from 'node:test';
import assert from 'node:assert/strict';
import { base32Encode, base32Decode, hotp, verifyTotp, newTotpSecret, otpauthUri } from '../lib/totp.ts';

const rfcSecret = Buffer.from('12345678901234567890');
test('HOTP matches RFC 4226 and TOTP matches RFC 6238 vectors', () => {
  const rfc4226 = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  rfc4226.forEach((code, i) => assert.equal(hotp(rfcSecret, i), code));
  assert.equal(hotp(rfcSecret, Math.floor(59 / 30), 8), '94287082');
  assert.equal(hotp(rfcSecret, Math.floor(1111111109 / 30), 8), '07081804');
  assert.equal(hotp(rfcSecret, Math.floor(20000000000 / 30), 8), '65353130');
});
test('base32 round-trips and rejects junk', () => {
  const s = newTotpSecret();
  assert.equal(base32Encode(base32Decode(s)), s);
  assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
  assert.throws(() => base32Decode('not*base32'));
});
test('verifyTotp accepts +/-1 step drift, rejects others, and blocks replay', () => {
  const secret = base32Encode(rfcSecret), now = 1111111109000;
  const step = Math.floor(now / 30000);
  const at = s => hotp(rfcSecret, s);
  assert.equal(verifyTotp(secret, at(step), null, now), step);
  assert.equal(verifyTotp(secret, at(step - 1), null, now), step - 1);
  assert.equal(verifyTotp(secret, at(step + 1), null, now), step + 1);
  assert.equal(verifyTotp(secret, at(step + 2), null, now), null);
  assert.equal(verifyTotp(secret, at(step - 2), null, now), null);
  assert.equal(verifyTotp(secret, at(step), step, now), null, 'same step cannot be reused');
  assert.equal(verifyTotp(secret, at(step - 1), step, now), null, 'older step cannot be used after a newer one');
  assert.equal(verifyTotp(secret, 'abcdef', null, now), null);
  assert.equal(verifyTotp(secret, '12345', null, now), null);
});
test('otpauth URI carries issuer and secret', () => {
  const uri = otpauthUri('a@b.com', 'ABC234');
  assert.match(uri, /^otpauth:\/\/totp\/LeadMelo:a%40b\.com\?secret=ABC234&issuer=LeadMelo/);
});
