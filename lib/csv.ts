export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', i = 0, quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 2; continue; }
        quoted = false; i += 1; continue;
      }
      cell += ch; i += 1; continue;
    }
    if (ch === '"') { quoted = true; i += 1; continue; }
    if (ch === ',') { row.push(cell.trim()); cell = ''; i += 1; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell.trim()); cell = '';
      if (row.some(v => v)) rows.push(row);
      row = []; i += 1; continue;
    }
    cell += ch; i += 1;
  }
  row.push(cell.trim());
  if (row.some(v => v)) rows.push(row);
  return rows;
}

const ALIASES: Record<string, string> = {
  company: 'company', company_name: 'company', name: 'company',
  domain: 'domain', website: 'domain',
  contact: 'contactName', contact_name: 'contactName', contactname: 'contactName', full_name: 'contactName',
  email: 'contactEmail', contact_email: 'contactEmail', contactemail: 'contactEmail',
  signal: 'signalSummary', signals: 'signalSummary', notes: 'signalSummary', why: 'signalSummary',
  score: 'score'
};

export function csvToLeadRows(text: string): Record<string, string>[] {
  const table = parseCsv(text);
  if (table.length < 2) return [];
  const headers = table[0].map(h => ALIASES[h.toLowerCase().replace(/\s+/g, '_')] ?? h.toLowerCase());
  return table.slice(1).map(cells => {
    const row: Record<string, string> = {};
    headers.forEach((key, i) => { if (key && cells[i]) row[key] = cells[i]; });
    return row;
  }).filter(r => r.company);
}
