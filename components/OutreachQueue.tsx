'use client';

import { userError } from '../lib/userErrors';
import { buildOutreachPreview } from '../lib/outreachPreview';

type Row = Record<string, any>;

function formatWhen(value: unknown, label: string) {
  if (!value) return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  return <span>{label}: {date.toLocaleString()}</span>;
}

export default function OutreachQueue({ rows, canWrite, rowActioning, onApprove }: {
  rows: Row[];
  canWrite: boolean;
  rowActioning: Record<string, boolean>;
  onApprove: (row: Row) => void | Promise<void>;
}) {
  if (!rows.length) return <p className="muted">No messages are waiting in the outreach queue.</p>;

  return <ul className="recordList outreachQueue">
    {rows.map(row => {
      const preview = buildOutreachPreview(row);
      const actionKey = `${row.id}-approve`;
      const busy = Boolean(rowActioning[actionKey]);
      const recipient = row.contact?.email ?? 'recipient unavailable';
      const status = String(row.statusLabel ?? row.status ?? 'UNKNOWN').replaceAll('_', ' ');
      const scheduled = formatWhen(row.scheduledAt, 'Scheduled');
      const sent = formatWhen(row.sentAt, 'Sent');
      return <li key={row.id} className="outreachItem">
        <div className="outreachItemHead">
          <div className="outreachIdentity">
            <strong className="outreachRecipient">{row.contact?.email ?? 'Recipient unavailable'}</strong>
            <span className="outreachMeta">Step {row.stepOrder ?? 1} &middot; <span className="pill">{status}</span></span>
          </div>
          {(scheduled || sent) && <div className="outreachMeta outreachDates">{scheduled}{sent}</div>}
        </div>

        {row.error && <p role="alert" className="error outreachError">{userError(row.error)}</p>}
        {row.approvedAt && !row.error && <p className="muted outreachApproved">Approved for sending</p>}

        <div className="outreachPreviewPanel" aria-label={`Message preview for ${recipient}`}>
          {preview.state === 'error'
            ? <p role="alert" className="error">{`Preview unavailable: ${userError(preview.code)}`}</p>
            : preview.state === 'empty'
              ? <p className="muted">Message content is no longer available for this recipient.</p>
              : <>
                <div className="outreachPreviewField">
                  <span className="outreachPreviewLabel">Subject</span>
                  <p className="outreachPreviewSubject">{preview.subject || '(no subject)'}</p>
                </div>
                <div className="outreachPreviewField">
                  <span className="outreachPreviewLabel">{preview.contentType === 'HTML' ? 'Message (HTML)' : 'Message'}</span>
                  {preview.contentType === 'HTML'
                    ? <iframe
                        className="outreachPreviewFrame"
                        title={`HTML message preview for ${recipient}`}
                        sandbox=""
                        referrerPolicy="no-referrer"
                        loading="lazy"
                        srcDoc={preview.body}
                      />
                    : <pre className="outreachPreviewBody">{preview.body}</pre>}
                </div>
              </>}
        </div>

        {canWrite && row.status === 'QUEUED' && !row.approvedAt && row.reviewToken && <div className="toolbar outreachActions">
          <button type="button" disabled={busy} onClick={() => void onApprove(row)}>
            {busy && <span className="spinner" aria-hidden="true" />}{busy ? 'Approving…' : 'Approve send'}
          </button>
        </div>}
      </li>;
    })}
  </ul>;
}
