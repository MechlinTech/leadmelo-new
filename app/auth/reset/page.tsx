import type { Metadata } from 'next';
import Logo from '../../../components/Logo';
import AccountLink from '../../../components/AccountLink';
import ResendSetupEmail from '../../../components/ResendSetupEmail';
export const metadata: Metadata = { title: 'Reset password' };
export const dynamic = 'force-dynamic';
export default async function Page({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token = '' } = await searchParams;
  return <main id="main" className="wrap"><div className="form"><Logo/>
    {token ? (
      <>
        <h1>Set a new password</h1>
        <AccountLink mode="reset" token={token}/>
        <ResendSetupEmail/>
      </>
    ) : (
      <>
        <h1>Reset password</h1>
        <ResendSetupEmail isStandalone/>
      </>
    )}
  </div></main>;
}
