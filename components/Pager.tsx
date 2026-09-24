'use client';

export default function Pager({ page, pages, total, label, onPage }: { page: number; pages: number; total: number; label: string; onPage: (p: number) => void }) {
  if (total === 0) return null;
  return <div className="toolbar" role="navigation" aria-label={`${label} pages`}>
    <p className="muted">{total} {label} · page {page} of {pages}</p>
    <button type="button" className="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
    <button type="button" className="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</button>
  </div>;
}

export function pageSlice<T>(items: T[], page: number, size = 10) {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(Math.max(1, page), pages);
  return { page: current, pages, slice: items.slice((current - 1) * size, current * size), total: items.length };
}
