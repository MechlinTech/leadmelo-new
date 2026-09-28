// Posts a signed `sender.health` event to LeadMelo, for operators who have no automated health feed.
// LeadMelo blocks sending unless a HEALTHY event newer than 24 hours exists for the sender.
//
// The values MUST come from real measurement (your mail provider's reputation/postmaster data, bounce
// and complaint reports). This tool does not measure anything and must not be scheduled to report
// HEALTHY unconditionally; that would defeat the safety gate it feeds.
//
//   APP_URL=https://leadmelo.example.com TENANT_ID=... WEBHOOK_SECRET=... \
//   node scripts/post-sender-health.mjs --sender sam@example.com --status HEALTHY --daily-cap 25 --bounce-rate 0.01 --complaint-rate 0
import { createHmac, randomUUID } from 'node:crypto';

export function buildHealthEvent(args, now = new Date()) {
  const get = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const status = get('status'), sender = get('sender');
  if (!sender || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(sender)) throw new Error('--sender must be an email address');
  if (!['HEALTHY', 'WATCHLIST', 'THROTTLED', 'BLOCKED'].includes(status)) throw new Error('--status must be HEALTHY, WATCHLIST, THROTTLED or BLOCKED');
  const dailyCap = Number(get('daily-cap')), bounceRate = Number(get('bounce-rate')), complaintRate = Number(get('complaint-rate'));
  if (!Number.isInteger(dailyCap) || dailyCap < 0 || dailyCap > 250) throw new Error('--daily-cap must be an integer from 0 to 250');
  for (const [n, v] of [['bounce-rate', bounceRate], ['complaint-rate', complaintRate]]) if (!Number.isFinite(v) || v < 0 || v > 1) throw new Error(`--${n} must be a fraction from 0 to 1 (0.01 = 1%)`);
  return { id: `health-${randomUUID()}`, type: 'sender.health', occurredAt: now.toISOString(), senderEmail: sender.toLowerCase(), status, dailyCap, bounceRate, complaintRate };
}
// Same scheme as docs/PROVIDER_GATEWAY.md: HMAC-SHA256(secret, timestamp + "." + rawBody), lowercase hex.
export function signBody(secret, raw, now = new Date()) {
  const timestamp = String(Math.floor(now.getTime() / 1000));
  return { timestamp, signature: createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex') };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('\\').join('/').split('/').pop())) {
  const { APP_URL, TENANT_ID, WEBHOOK_SECRET } = process.env;
  try {
    if (!APP_URL?.startsWith('https://') || !TENANT_ID || !WEBHOOK_SECRET) throw new Error('Set APP_URL (https), TENANT_ID and WEBHOOK_SECRET');
    const raw = JSON.stringify(buildHealthEvent(process.argv.slice(2)));
    const { timestamp, signature } = signBody(WEBHOOK_SECRET, raw);
    const res = await fetch(`${APP_URL.replace(/\/$/, '')}/api/webhooks/provider/${encodeURIComponent(TENANT_ID)}`, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', 'X-LeadMelo-Timestamp': timestamp, 'X-LeadMelo-Signature': signature }, body: raw, signal: AbortSignal.timeout(15000) });
    console.log(res.ok ? 'sender health recorded' : `rejected: HTTP ${res.status}`);
    process.exitCode = res.ok ? 0 : 1;
  } catch (e) { console.error(e.message); process.exitCode = 2; }
}
