import { useState, type SyntheticEvent } from "react";
import { ArrowRight, Eye, EyeOff, LockKeyhole, Mail, ShieldCheck } from "lucide-react";
import type { Role } from "@servicecare/contracts";
import { demoMode, embeddedAuthConfigured, signInOnPage, confirmSignInOnPage, requestPasswordReset, finishPasswordReset, verifyExistingAccount, resendAccountCode, type EmbeddedAuthResult } from "../lib/auth";
import { authError, passwordIssue, type LoginPhase } from "../lib/auth-flow";
import { supportImages } from "../lib/support";
import { Brand } from "./Brand";

function PasswordFields({ newPassword, phase, showPassword, password, confirmation, busy, onPassword, onConfirmation, onToggle }: Readonly<{
  newPassword: boolean; phase: LoginPhase; showPassword: boolean; password: string; confirmation: string; busy: boolean;
  onPassword: (value: string) => void; onConfirmation: (value: string) => void; onToggle: () => void;
}>) {
  let label = 'Password';
  if (newPassword) label = 'New password';
  else if (phase === 'ACTIVATE') label = 'Temporary password';
  return <>
    <label htmlFor="login-password">{label}</label>
    <div className="login-email-field">
      <LockKeyhole size={18} />
      <input id="login-password" type={showPassword ? 'text' : 'password'} autoComplete={newPassword ? 'new-password' : 'current-password'} value={password} onChange={event => onPassword(event.target.value)} required disabled={busy} />
      <button type="button" className="icon-button login-password-toggle" title={showPassword ? 'Hide password' : 'Show password'} aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword} disabled={busy} onClick={onToggle}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button>
    </div>
    {newPassword && <>
      <label htmlFor="login-confirm-password">Confirm new password</label>
      <div className="login-email-field"><LockKeyhole size={18} /><input id="login-confirm-password" type={showPassword ? 'text' : 'password'} autoComplete="new-password" value={confirmation} onChange={event => onConfirmation(event.target.value)} required disabled={busy} /></div>
      <p className="login-password-policy">8+ characters, uppercase, lowercase, a number and a symbol.</p>
    </>}
  </>;
}

export function Login({
  onDemoSignIn,
  onSignIn,
}: Readonly<{ onDemoSignIn: (role: Role) => void; onSignIn: (role: Role) => void }>) {
  const [role, setRole] = useState<Role>("customer");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [code, setCode] = useState("");
  const [phase, setPhase] = useState<LoginPhase>("SIGN_IN");
  const [showPassword, setShowPassword] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [recoveryNotice, setRecoveryNotice] = useState(false);
  const initial = phase === 'SIGN_IN' || phase === 'ACTIVATE';
  const newPassword = phase === 'NEW_PASSWORD' || phase === 'RESET_PASSWORD';
  const needsCode = ['MFA_CODE', 'CONFIRM_ACCOUNT', 'RESET_PASSWORD'].includes(phase);
  const labels: Record<LoginPhase, string> = { SIGN_IN: 'Sign in', ACTIVATE: 'Activate account', NEW_PASSWORD: 'Set password', MFA_CODE: 'Verify and sign in', CONFIRM_ACCOUNT: 'Verify account', RECOVERY: 'Send reset code', RESET_PASSWORD: 'Reset password' };
  const prompts: Partial<Record<LoginPhase, string>> = { ACTIVATE: 'Sign in with your invitation email and temporary password.', NEW_PASSWORD: 'Choose your new password.', MFA_CODE: 'Enter your verification code.', CONFIRM_ACCOUNT: 'Verify your account.', RECOVERY: 'Enter your account email to reset your password.', RESET_PASSWORD: 'Enter the reset code and your new password.' };
  let submitLabel = labels[phase];
  if (demoMode) submitLabel = "Enter demo";
  if (busy) submitLabel = "Please wait...";
  function move(next: LoginPhase) {
    setPhase(next); setPassword(''); setConfirmation(''); setCode(''); setShowPassword(false); setError(''); setNotice('');
  }
  function accepted(result: EmbeddedAuthResult) {
    setPassword(''); setConfirmation(''); setCode(''); setShowPassword(false);
    if (result.phase === 'SIGNED_IN' && result.role) onSignIn(result.role);
    else if (result.phase !== 'SIGNED_IN') setPhase(result.phase);
  }
  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (demoMode) {
      onDemoSignIn(role);
      return;
    }
    if (!embeddedAuthConfigured) {
      setError(
        "Secure sign-in is not configured. Please contact the service administrator.",
      );
      return;
    }
    setBusy(true);
    try {
      if (newPassword) {
        const issue = passwordIssue(password, confirmation);
        if (issue) { setError(issue); return; }
      }
      if (initial) accepted(await signInOnPage(email, password));
      else if (phase === 'NEW_PASSWORD') accepted(await confirmSignInOnPage(password, email.trim()));
      else if (phase === 'MFA_CODE') accepted(await confirmSignInOnPage(code.trim()));
      else if (phase === 'CONFIRM_ACCOUNT') {
        await verifyExistingAccount(email, code); move('SIGN_IN'); setNotice('Account verified. Sign in with your password.');
      } else if (phase === 'RECOVERY') {
        await requestPasswordReset(email); move('RESET_PASSWORD'); setNotice('Check your email for the reset code.');
      } else if (phase === 'RESET_PASSWORD') {
        await finishPasswordReset(email, code, password); move('SIGN_IN'); setNotice('Password changed. Sign in with your new password.');
      }
    } catch (error_) {
      setError(authError(error_));
    } finally { setBusy(false); }
  }
  async function resendCode() {
    setBusy(true); setError(''); setNotice('');
    try {
      if (phase === 'RESET_PASSWORD') await requestPasswordReset(email);
      else await resendAccountCode(email);
      setNotice('A new verification code has been sent.');
    } catch (error_) { setError(authError(error_)); }
    finally { setBusy(false); }
  }
  return (
    <main className="portal-login" data-auth-phase={phase}>
      <section className="login-photograph" aria-label="BMW Overdrive">
        <img src={supportImages.vehicle} alt="BMW vehicle" />
        <div className="login-photo-caption">
          <span>OVERDRIVE</span>
          <h2>
            Every journey.
            <br />A little more peace of mind.
          </h2>
          <p>BMW service & customer support</p>
        </div>
      </section>
      <section className="login-form-area">
        <Brand subtitle="SERVICE & SUPPORT" className="login-wordmark" />
        <div className="login-form-content">
          <span className="section-kicker">WELCOME TO OVERDRIVE</span>
          <h1 lang="de">Freude am Fahren.</h1>
          <p>
            {prompts[phase] ?? `Sign in to your ${role === "advisor" ? "service advisor" : "customer"} account.`}
          </p>
          {initial && <fieldset className="login-role-options" disabled={busy}>
            <legend className="sr-only">Account type</legend>
            <button
              type="button"
              aria-pressed={role === "customer"}
              onClick={() => setRole("customer")}
            >
              Customer
            </button>
            <button
              type="button"
              aria-pressed={role === "advisor"}
              onClick={() => setRole("advisor")}
            >
              Service advisor
            </button>
          </fieldset>}
          <form onSubmit={submit}>
            <label htmlFor="login-email">
              Email address{demoMode && <span>Optional in demo</span>}
            </label>
            <div className="login-email-field">
              <Mail size={18} />
              <input
                id="login-email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required={!demoMode}
                disabled={busy || (!initial && phase !== 'RECOVERY')}
              />
            </div>
            {!demoMode && (initial || newPassword) && <PasswordFields newPassword={newPassword} phase={phase} showPassword={showPassword} password={password} confirmation={confirmation} busy={busy} onPassword={setPassword} onConfirmation={setConfirmation} onToggle={() => setShowPassword(current => !current)} />}
            {needsCode && <>
              <label htmlFor="login-code">Verification code</label>
              <div className="login-email-field"><ShieldCheck size={18} /><input id="login-code" type="text" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={event => setCode(event.target.value)} required disabled={busy} /></div>
            </>}
            {notice && <output className="login-auth-notice">{notice}</output>}
            {error && (
              <p className="alert error" role="alert">
                {error}
              </p>
            )}
            <button
              type="submit"
              className="button primary login-submit"
              disabled={busy || (!demoMode && !embeddedAuthConfigured)}
            >
              {submitLabel}
              <ArrowRight size={18} />
            </button>
          </form>
          {!demoMode && ['CONFIRM_ACCOUNT', 'RESET_PASSWORD'].includes(phase) && <button type="button" className="recovery-link" disabled={busy} onClick={() => void resendCode()}>Resend code</button>}
          {demoMode ? (
            <p className="login-demo-notice">
              <ShieldCheck size={16} />
              <span>
                Demo access only. Synthetic accounts and sample data; no
                password is requested.
              </span>
            </p>
          ) : (
            <p className="login-security">
              <LockKeyhole size={15} />
              Secure sign-in with your identity provider
            </p>
          )}
        </div>
        <div className="login-recovery">
          {!demoMode ? <>
            {phase === 'SIGN_IN' ? <>
              <button type="button" className="recovery-link" disabled={busy} onClick={() => move('RECOVERY')}>Forgot password?</button>
              <button type="button" className="recovery-link" disabled={busy} onClick={() => move('ACTIVATE')}>Activate invited account</button>
            </> : <button type="button" className="recovery-link" disabled={busy} onClick={() => move('SIGN_IN')}>Back to sign in</button>}
          </> : (
            <button
              type="button"
              className="recovery-link"
              aria-expanded={recoveryNotice}
              onClick={() => setRecoveryNotice((current) => !current)}
            >
              Forgot password?
            </button>
          )}
          {recoveryNotice && (
            <output>
              {demoMode
                ? "Demo access has no password. For a real account, use your configured identity provider to reset your password."
                : "Password recovery is not configured. Please contact your account administrator."}
            </output>
          )}
        </div>
      </section>
    </main>
  );
}
