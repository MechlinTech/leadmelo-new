import type { Metadata } from 'next';
import Logo from '../../../components/Logo';
import Login from '../../../components/Login';
export const metadata: Metadata = { title: 'Sign in' };
export default async function Page({ searchParams }: { searchParams: Promise<{ reason?: string }> }) {
  const { reason } = await searchParams;
  return <main id="main" className="wrap"><div className="form"><Logo/><h1>Sign in</h1><Login notice={reason === 'session' ? 'Your session ended. Please sign in again. Signing in here ends any other open session for this account.' : undefined}/></div></main>;
}
