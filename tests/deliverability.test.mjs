import test from 'node:test';
import assert from 'node:assert/strict';
import { decideHealth, rampCap, checkDomainAuth, RAMP } from '../lib/senderHealth.ts';
import { isBounceNotice, bounceRecipients } from '../lib/m365/sync.ts';
import { isHoliday, localDate, withinSendWindow, addBusinessDays } from '../lib/policy.ts';
import { campaignInput } from '../lib/validation.ts';

const err = code => Object.assign(new Error(code), { code });
const resolverFor = records => ({
  txt: async name => { if (name in records) { if (records[name] instanceof Error) throw records[name]; return records[name]; } throw err('ENOTFOUND'); },
  cname: async name => { const v = records['CNAME:' + name]; if (v) return v; throw err('ENODATA'); }
});
const okAuth = { spf: 'pass', dmarc: 'pass' };

test('send ramp starts small and only grows with the sender\'s age', () => {
  assert.equal(rampCap(0), 10); assert.equal(rampCap(2), 10); assert.equal(rampCap(3), 20); assert.equal(rampCap(7), 30); assert.equal(rampCap(14), 50);
  assert.equal(rampCap(28), 100); assert.equal(rampCap(60), 250); assert.equal(rampCap(365), 250);
  assert.ok(RAMP.every(([, cap], i) => i === 0 || cap > RAMP[i - 1][1]), 'strictly increasing');
});
test('health decisions: bounces, complaints, authentication and small samples', () => {
  const d = o => decideHealth({ sent: 100, bounces: 0, complaints: 0, ageDays: 30, auth: okAuth, ...o });
  assert.deepEqual([d({}).status, d({}).dailyCap], ['HEALTHY', 100]);
  assert.equal(d({ bounces: 5 }).status, 'BLOCKED', '5% bounce rate blocks');
  assert.equal(d({ bounces: 4 }).status, 'HEALTHY'); assert.equal(d({ bounces: 4 }).dailyCap, 50, '2-5% bounce rate halves the cap');
  assert.equal(d({ complaints: 1 }).status, 'BLOCKED', 'a single complaint blocks a small sender');
  assert.equal(d({ sent: 5000, complaints: 3 }).status, 'HEALTHY', '0.06% complaints on a large sender is under the 0.1% line');
  assert.equal(d({ sent: 5000, complaints: 6 }).status, 'BLOCKED');
  assert.equal(d({ sent: 10, bounces: 3 }).status, 'BLOCKED', 'bounces on a tiny sample are not ignored');
  assert.equal(d({ sent: 10, bounces: 1 }).status, 'HEALTHY');
  const spf = d({ auth: { spf: 'fail', dmarc: 'pass' } }); assert.deepEqual([spf.status, spf.dailyCap, spf.reasons], ['WATCHLIST', 0, ['spf_missing']]);
  assert.deepEqual(d({ auth: { spf: 'pass', dmarc: 'fail' } }).reasons, ['dmarc_missing']);
  assert.equal(d({ auth: { spf: 'unknown', dmarc: 'unknown' } }).status, 'HEALTHY', 'a DNS timeout does not block a sender');
  assert.equal(d({ sent: 0, ageDays: 0 }).dailyCap, 10, 'a brand-new sender starts at the lowest ramp step');
  assert.equal(d({ ageDays: 1000 }).dailyCap, 250, 'never above the 250 hard cap');
});
test('SPF, DMARC and DKIM checks read DNS conservatively', async () => {
  const good = resolverFor({ 'ok.example': [['v=spf1 include:spf.protection.outlook.com -all']], '_dmarc.ok.example': [['v=DMARC1; p=quarantine; rua=mailto:d@ok.example']], 'CNAME:selector1._domainkey.ok.example': ['selector1-ok-example._domainkey.t.onmicrosoft.com'] });
  const r = await checkDomainAuth('ok.example', good);
  assert.deepEqual([r.spf, r.dmarc, r.dkim], ['pass', 'pass', 'pass']); assert.equal(r.detail.dmarcPolicy, 'quarantine'); assert.equal(r.detail.dkimSelector, 'selector1');
  const split = await checkDomainAuth('ok.example', resolverFor({ 'ok.example': [['v=spf1 include:a.example ', '-all']], '_dmarc.ok.example': [['v=DMARC1;', ' p=none']] }));
  assert.deepEqual([split.spf, split.dmarc], ['pass', 'pass'], 'TXT records split into chunks are rejoined');
  const none = await checkDomainAuth('bad.example', resolverFor({}));
  assert.deepEqual([none.spf, none.dmarc, none.dkim], ['fail', 'fail', 'unknown'], 'missing records fail; DKIM absence can never be proven');
  const wrong = await checkDomainAuth('x.example', resolverFor({ 'x.example': [['google-site-verification=abc']], '_dmarc.x.example': [['something else']] }));
  assert.deepEqual([wrong.spf, wrong.dmarc], ['fail', 'fail']);
  const flaky = await checkDomainAuth('t.example', resolverFor({ 't.example': err('ETIMEOUT'), '_dmarc.t.example': err('ESERVFAIL') }));
  assert.deepEqual([flaky.spf, flaky.dmarc], ['unknown', 'unknown'], 'a timeout is "unknown", never a false failure');
});

test('bounce notices are recognised only from system senders and parsed conservatively', () => {
  assert.equal(isBounceNotice('postmaster@contoso.onmicrosoft.com', 'Undeliverable: Quick question'), true);
  assert.equal(isBounceNotice('MAILER-DAEMON@mail.example.com', 'Delivery Status Notification (Failure)'), true);
  assert.equal(isBounceNotice('microsoftexchange329e71ec88ae4615bbc36ab6ce41109e@contoso.com', 'Undeliverable: hi'), true);
  assert.equal(isBounceNotice('buyer@company.example', 'Undeliverable: hi'), false, 'a person writing "Undeliverable" is not a bounce');
  assert.equal(isBounceNotice('postmaster@x.example', 'Hello there'), false, 'a system sender with a normal subject is not a bounce');
  assert.deepEqual(bounceRecipients('Your message to <b>Pat@Buyer.example</b> could not be delivered. Sender: sam@ours.example postmaster@buyer.example', 'sam@ours.example'), ['pat@buyer.example']);
  assert.deepEqual(bounceRecipients('no addresses here', 'sam@ours.example'), []);
});

test('holidays: date in the campaign time zone, send window, and business-day arithmetic', () => {
  const noonUtc = new Date('2026-12-25T12:00:00Z');
  assert.equal(localDate(noonUtc, 'America/Los_Angeles'), '2026-12-25');
  assert.equal(localDate(new Date('2026-12-26T03:00:00Z'), 'America/Los_Angeles'), '2026-12-25', 'a UTC evening is still the 25th in Los Angeles');
  assert.equal(isHoliday(noonUtc, 'America/Los_Angeles', ['2026-12-25']), true); assert.equal(isHoliday(noonUtc, 'America/Los_Angeles', []), false);
  const campaign = { timezone: 'America/Los_Angeles', businessDaysOnly: false, sendStartHour: 0, sendEndHour: 24 };
  assert.equal(withinSendWindow({ ...campaign, holidays: [] }, noonUtc), true);
  assert.equal(withinSendWindow({ ...campaign, holidays: ['2026-12-25'] }, noonUtc), false, 'a holiday blocks sending even on a 24/7 campaign');
  // Mon 2026-12-21 + 3 business days = Thu 24th; with the 24th a holiday it becomes Fri 25th; with both, Mon 28th.
  const start = new Date('2026-12-21T17:00:00Z');
  const day = d => localDate(d, 'America/Los_Angeles');
  assert.equal(day(addBusinessDays(start, 3, 'America/Los_Angeles')), '2026-12-24');
  assert.equal(day(addBusinessDays(start, 3, 'America/Los_Angeles', ['2026-12-24'])), '2026-12-25');
  assert.equal(day(addBusinessDays(start, 3, 'America/Los_Angeles', ['2026-12-24', '2026-12-25'])), '2026-12-28', 'skips the holiday and the weekend');
  assert.equal(day(addBusinessDays(start, 0, 'America/Los_Angeles', ['2026-12-21'])), '2026-12-21');
});
test('campaign input validates holiday dates', () => {
  const base = { name: 'n', icpId: 'i', senderName: 's', senderEmail: 'a@b.co', calendlyUrl: 'https://calendly.com/x', sequenceSteps: [{ stepOrder: 1, waitBusinessDays: 0, subject: 's', body: 'b' }] };
  assert.deepEqual(campaignInput.parse({ ...base, holidays: ['2026-12-25'] }).holidays, ['2026-12-25']);
  assert.deepEqual(campaignInput.parse(base).holidays, []);
  assert.throws(() => campaignInput.parse({ ...base, holidays: ['25/12/2026'] })); assert.throws(() => campaignInput.parse({ ...base, holidays: ['2026-13-45'] }));
  assert.throws(() => campaignInput.parse({ ...base, holidays: Array.from({ length: 61 }, (_, i) => `2026-01-${String((i % 28) + 1).padStart(2, '0')}`) }));
});
