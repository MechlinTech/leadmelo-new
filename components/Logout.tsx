'use client';
export default function Logout() {
  return <button onClick={async () => {
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* still leave the page */ }
    window.location.assign('/auth/signin');
  }}>Sign out</button>;
}
