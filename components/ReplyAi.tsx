'use client';
import { useEffect, useState } from 'react';
import { api } from './api';

export default function ReplyAi({ replyId }: { replyId: string }) {
  const [available, setAvailable] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [insight, setInsight] = useState<any>(null);
  useEffect(() => { api('ai/status').then(s => setAvailable(!!s.enabled && s.canUse && s.features.includes('reply_assist'))).catch(() => setAvailable(false)); }, []);
  if (!available) return null;
  async function run() { setBusy(true); setError(''); try { setInsight((await api('ai/reply', 'POST', { replyId })).insight); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  return <div className="aiReply">
    <button type="button" disabled={busy} onClick={() => void run()}>{busy ? 'Analysing…' : 'Analyse with AI'}</button>
    {error && <p role="alert" className="error">{error}</p>}
    {insight && <div role="status"><p><strong>AI summary:</strong> {insight.summary}</p><p className="muted">{insight.note}</p>{insight.referralName && <p>Possible referral: {insight.referralName}</p>}{insight.followUpNote && <p>Follow-up: {insight.followUpNote}</p>}{insight.suggestedReply && <><p><strong>Suggested reply (edit before use; placeholders are filled by you):</strong></p><pre>{insight.suggestedReply}</pre></>}</div>}
  </div>;
}
