import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Page not found' };
export default function NotFound() {
  return <main id="main" className="wrap">
    <h1>Page not found</h1>
    <p>That address is not a LeadMelo page.</p>
    <p><a href="/">Back to home</a> · <a href="/auth/signin">Sign in</a></p>
  </main>;
}
