import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

// The recovery flow ships user-facing copy. Pin the exact sentences so a refactor cannot
// quietly start confirming whether an account exists.
test('password recovery copy is fixed and never reveals account existence', async () => {
  const { RESET_REQUEST_ANSWER, resetRequestEmail } = await import('../lib/passwordRecovery.ts');
  assert.equal(RESET_REQUEST_ANSWER, 'If an account exists for this email address, you’ll receive a password-reset link shortly.');
  assert.ok(!/no account|unknown|not found|does not exist|invalid email address/i.test(RESET_REQUEST_ANSWER), 'the answer must not branch on the account');
  for (const bad of ['', 'x', 'no@', '@example.com', 'a b@example.com', `${'a'.repeat(250)}@example.com`, null, undefined, 42, {}])
    assert.equal(resetRequestEmail.safeParse(bad).success, false, `must reject ${JSON.stringify(bad)}`);
  for (const good of ['user@example.com', ' User@Example.COM ', 'first.last+tag@sub.example.co.uk'])
    assert.equal(resetRequestEmail.safeParse(good).success, true, `must accept ${good}`);
  assert.equal(resetRequestEmail.parse(' User@Example.COM '), 'user@example.com', 'normalised before lookup');
});

test('the recovery email body carries the link and never a password', async () => {
  const { RESET_REQUEST_ANSWER } = await import('../lib/passwordRecovery.ts');
  void RESET_REQUEST_ANSWER;
  const source = read('../lib/passwordRecovery.ts');
  const body = source.match(/function passwordResetEmail[\s\S]*?\n}/)?.[0] ?? '';
  assert.ok(body.length > 0, 'the template exists');
  assert.ok(body.includes('resetUrl'), 'the reset link is included');
  assert.ok(!/password[^\n]*=\s*`/i.test(body), 'the template never interpolates a password');
  for (const leak of ['passwordHash', 'verifyPassword', 'console.log'])
    assert.ok(!body.includes(leak), `the template never touches ${leak}`);
});

test('sign-in offers the forgot-password route, and the endpoint guards before it looks anyone up', () => {
  const login = read('../components/Login.tsx');
  assert.match(login, /<a href="\/auth\/forgot-password">Forgot password\?<\/a>/);
  const forgot = read('../app/api/auth/forgot-password/route.ts');
  const order = ['assertOrigin(req)', 'requireResetEmail(', 'rateLimit(', 'requestPasswordReset('].map(step => forgot.indexOf(step));
  assert.ok(order.every(index => index >= 0), 'every guard is present');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'guards run in order: origin, shape, budget, lookup');
  assert.ok(!forgot.includes('db.user'), 'the endpoint never queries the database itself');
  assert.ok(forgot.includes('RESET_REQUEST_ANSWER'), 'the answer is the shared constant');
  for (const page of ['../app/auth/forgot-password/page.tsx', '../app/auth/reset-password/page.tsx', '../app/auth/reset/page.tsx'])
    assert.ok(read(page).includes('Logo'), `${page} uses the shared auth layout`);
  const reset = read('../app/auth/reset/page.tsx');
  assert.ok(reset.includes('AccountLink mode="reset"'), 'the reset-password page sets the password');
});

test('the reset-password form confirms success, offers show/hide, and keeps the password policy', () => {
  const link = read('../components/AccountLink.tsx');
  assert.ok(link.includes('Your password has been reset successfully. Please sign in with your new password.'), 'exact success sentence');
  assert.ok(link.includes('aria-pressed={revealed}'), 'the show/hide toggle reports its state');
  assert.ok(link.includes("type={revealed ? 'text' : 'password'}"), 'the toggle switches the input type');
  assert.ok(link.includes('minLength={12}'), 'the 12-character policy is still enforced');
  assert.ok(link.includes('do not match'), 'the confirmation is checked');
  assert.ok(link.includes('autoComplete="new-password"'));
  // The request page never receives or echoes a token.
  const request = read('../components/ForgotPassword.tsx');
  assert.ok(!request.includes('token'), 'the request form has no token field');
  assert.ok(request.includes('type="email"'), 'the address is validated as an email');
});

test('the Meetings view has its own empty state and no stray "No records yet"', () => {
  const workspace = read('../components/Workspace.tsx');
  assert.ok(workspace.includes('<strong>No meetings found</strong>'), 'the unfiltered empty state');
  assert.ok(workspace.includes('Scheduled or manually recorded meetings will appear here.'), 'its supporting text');
  assert.ok(workspace.includes('<strong>No meetings match the selected filter.</strong>'), 'the filtered empty state');
  assert.ok(workspace.includes('const meetingsEmpty = !loading && !error'), 'the empty state waits for a successful load');
  const stray = workspace.match(/\{section !== 'settings'[^\n]*No records yet\.[^\n]*\}/)?.[0] ?? '';
  assert.ok(stray.includes("section !== 'overview'"), 'the generic fallback no longer applies to Meetings');
  assert.ok(workspace.includes('<tr className="emptyRow"><td colSpan={6}>'), 'the empty state spans every column below the headers');
});

test('meeting booking, Calendly attribution and the meeting-link field are untouched', () => {
  const route = read('../app/api/appointments/route.ts');
  assert.ok(route.includes('bookingUrl'), 'the per-appointment meeting link is still produced');
  assert.ok(route.includes('schedulingUrl'), 'and still carries signed attribution');
  assert.ok(route.includes("status: 'BOOKED'"), 'manual booking still works');
  const workspace = read('../components/Workspace.tsx');
  assert.ok(workspace.includes('name="calendlyUrl"'), 'the campaign booking link field is kept');
  assert.ok(workspace.includes('Record a meeting'), 'the manual booking form is kept');
  const calendly = read('../lib/calendly.ts');
  assert.ok(calendly.includes('export function schedulingUrl'), 'Calendly scheduling links are kept');
});