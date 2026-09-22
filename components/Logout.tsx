'use client';
export default function Logout() { return <button onClick={async () => { const r = await fetch('/api/auth/logout', { method: 'POST' }); if (r.ok) window.location.assign('/auth/signin'); }}>Sign out</button>; }
