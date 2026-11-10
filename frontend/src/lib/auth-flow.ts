import type { Role } from '@servicecare/contracts';

export type LoginPhase = 'SIGN_IN' | 'ACTIVATE' | 'NEW_PASSWORD' | 'MFA_CODE' | 'CONFIRM_ACCOUNT' | 'RECOVERY' | 'RESET_PASSWORD';
export function demoModeEnabled(explicit: string | undefined, development: boolean, cognitoConfigured: boolean): boolean {
  if (!development) return false;
  if (explicit === 'true') return true;
  if (explicit === 'false') return false;
  return !cognitoConfigured;
}

export function signInPhase(result: { isSignedIn: boolean; nextStep: { signInStep: string; missingAttributes?: readonly string[] } }): LoginPhase | 'SIGNED_IN' {
  const step = result.nextStep.signInStep;
  if (step === 'DONE' && result.isSignedIn) return 'SIGNED_IN';
  if (step === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
    if (result.nextStep.missingAttributes?.some(attribute => attribute !== 'email')) throw new Error('Your invitation needs additional account details. Please contact your administrator.');
    return 'NEW_PASSWORD';
  }
  if (['CONFIRM_SIGN_IN_WITH_SMS_CODE', 'CONFIRM_SIGN_IN_WITH_TOTP_CODE', 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE'].includes(step)) return 'MFA_CODE';
  if (step === 'CONFIRM_SIGN_UP') return 'CONFIRM_ACCOUNT';
  if (step === 'RESET_PASSWORD') return 'RECOVERY';
  throw new Error('This account requires an authentication method that is not configured on this page. Please contact your administrator.');
}
export function passwordIssue(password: string, confirmation: string): string | undefined {
  if (password.length < 8 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9\s]/.test(password)) return 'Use at least 8 characters with uppercase, lowercase, a number and a symbol.';
  if (password !== confirmation) return 'The passwords do not match.';
  return undefined;
}
export function cognitoRole(claims: Record<string, unknown>): Role {
  const groups = claims['cognito:groups'];
  if (!Array.isArray(groups)) throw new Error('Your account has not been assigned a service role. Please contact your administrator.');
  const names = groups.map(group => String(group).toLowerCase());
  if (names.some(group => ['admin', 'admins', 'advisors', 'serviceadvisors'].includes(group))) return 'advisor';
  if (names.some(group => ['customer', 'customers'].includes(group))) return 'customer';
  throw new Error('Your account has not been assigned a service role. Please contact your administrator.');
}
export function authError(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (['NotAuthorizedException', 'UserNotFoundException'].includes(name)) return 'The email or password is incorrect.';
  if (name === 'CodeMismatchException') return 'The verification code is incorrect.';
  if (name === 'ExpiredCodeException') return 'The verification code has expired. Request a new code.';
  if (['TooManyRequestsException', 'LimitExceededException'].includes(name)) return 'Too many attempts. Please try again later.';
  if (name === 'InvalidPasswordException') return 'Use at least 8 characters with uppercase, lowercase, a number and a symbol.';
  return error instanceof Error ? error.message : 'Authentication could not be completed. Please try again.';
}