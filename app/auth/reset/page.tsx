import type { Metadata } from 'next';
import Logo from '../../../components/Logo';
import AccountLink from '../../../components/AccountLink';
export const metadata: Metadata = { title: 'Reset password' };
export const dynamic = 'force-dynamic';
export default async function Page({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token = '' } = await searchParams;
  return <main id="main" className="wrap"><div className="form"><Logo/><h1>Set a new password</h1><AccountLink mode="reset" token={token}/></div></main>;
}
