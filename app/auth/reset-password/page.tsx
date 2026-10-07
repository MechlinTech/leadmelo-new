import type { Metadata } from 'next';
import Logo from '../../../components/Logo';
import AccountLink from '../../../components/AccountLink';
import ResendSetupEmail from '../../../components/ResendSetupEmail';
export const metadata: Metadata = { title: 'Reset your password' };
export const dynamic = 'force-dynamic';
// Same single-use reset token as /auth/reset, under the name the flow is described by.
// Both consume the same tokens: consumeReset only checks the token hash, never the path.
export default async function Page({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token = '' } = await searchParams;
  return <main id="main" className="wrap"><div className="form"><Logo/><h1>Set a new password</h1><AccountLink mode="reset" token={token}/><ResendSetupEmail/></div></main>;
}