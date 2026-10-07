import type { Metadata } from 'next';
import Logo from '../../../components/Logo';
import ForgotPassword from '../../../components/ForgotPassword';
export const metadata: Metadata = { title: 'Reset your password' };
export default function Page() {
  return <main id="main" className="wrap"><div className="form"><Logo/><h1>Reset your password</h1>
    <p className="muted">Enter the email address you sign in with. If the account exists we will email a secure link that sets a new password.</p>
    <ForgotPassword/>
  </div></main>;
}