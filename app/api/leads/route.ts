import { z } from 'zod';
import { db } from '../../../lib/db';
import { authenticate } from '../../../lib/auth';
import { endpoint, HttpError, jsonBody } from '../../../lib/http';
import { csvToLeadRows } from '../../../lib/csv';

const leadInput = z.object({
  company: z.string().trim().min(1).max(200),
  domain: z.string().trim().max(200).optional(),
  contactName: z.string().trim().max(200).optional(),
  contactEmail: z.string().email().optional(),
  signalSummary: z.string().trim().max(500).optional(),
  score: z.number().int().min(0).max(100).optional()
}).strict();

function domainFor(row: { domain?: string; contactEmail?: string }) {
  return (row.domain?.toLowerCase() || (row.contactEmail ? row.contactEmail.split('@')[1]?.toLowerCase() : undefined) || `manual-${crypto.randomUUID()}`);
}

async function createLead(tenantId: string, body: z.infer<typeof leadInput>, source: string) {
  return db.lead.create({
    data: {
      tenantId,
      company: body.company,
      domain: domainFor(body),
      contactName: body.contactName,
      contactEmail: body.contactEmail?.toLowerCase(),
      signalSummary: body.signalSummary ?? (source === 'csv' ? 'Imported from CSV' : 'Manually added'),
      source,
      score: body.score ?? 0,
      qualification: 'NEEDS_REVIEW'
    }
  });
}

export const GET = endpoint(async req => {
  const user = await authenticate(req);
  return Response.json(await db.lead.findMany({ where: { tenantId: user.tenantId }, orderBy: { createdAt: 'desc' }, take: 500 }));
});

export const POST = endpoint(async req => {
  const user = await authenticate(req, true);
  const raw = await jsonBody(req, 262144) as Record<string, unknown>;
  if (typeof raw.csv === 'string' || Array.isArray(raw.rows)) {
    const rows = typeof raw.csv === 'string' ? csvToLeadRows(raw.csv) : raw.rows as Record<string, unknown>[];
    if (rows.length > 200) throw new HttpError(400, 'import_too_large');
    const created: string[] = [], skipped: string[] = [], errors: string[] = [];
    for (const [i, row] of rows.entries()) {
      const parsed = leadInput.safeParse({
        company: String(row.company ?? '').trim(),
        domain: row.domain ? String(row.domain) : undefined,
        contactName: row.contactName ? String(row.contactName) : undefined,
        contactEmail: row.contactEmail ? String(row.contactEmail) : undefined,
        signalSummary: row.signalSummary ? String(row.signalSummary) : undefined,
        score: row.score === undefined || row.score === '' ? undefined : Number(row.score)
      });
      if (!parsed.success) { errors.push(`Row ${i + 2}: invalid fields`); continue; }
      try {
        const lead = await createLead(user.tenantId, parsed.data, 'csv');
        created.push(lead.id);
      } catch {
        skipped.push(parsed.data.company);
      }
    }
    return Response.json({ created: created.length, skipped: skipped.length, errors }, { status: 201 });
  }
  const body = leadInput.parse(raw);
  try {
    return Response.json(await createLead(user.tenantId, body, 'manual'), { status: 201 });
  } catch {
    throw new HttpError(409, 'already_exists');
  }
});
