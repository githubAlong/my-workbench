/*
 * Teacher Workbench account identifier helpers.
 * The visible login ID is exactly 11 numeric digits. Supabase Phone Auth is used
 * only as the existing password-auth identity field; this mapping does not
 * verify ownership, send SMS, or request an OTP.
 */
const ACCOUNT_NUMBER_RE = /^\d{11}$/;

export function isAccountNumber(value) {
  return ACCOUNT_NUMBER_RE.test(String(value ?? '').trim());
}

/* Map the 11-digit account ID to the E.164-shaped identifier expected by the
 * existing Supabase Auth phone/password records. Preserve legacy stored forms.
 */
export function normalizeAccountIdentifier(value) {
  const raw = String(value ?? '').trim().replace(/[\s()-]/g, '');
  if (ACCOUNT_NUMBER_RE.test(raw)) return '+86' + raw;

  const digits = raw.replace(/^\+/, '');
  const national = digits.startsWith('0086') && digits.length === 15
    ? digits.slice(4)
    : digits.startsWith('86') && digits.length === 13
      ? digits.slice(2)
      : digits;

  if (ACCOUNT_NUMBER_RE.test(national)) return '+86' + national;
  if (/^\+[1-9]\d{7,14}$/.test(raw)) return raw;
  throw new Error('账号必须为11位数字');
}

/* Convert a legacy Supabase phone identity back to the visible 11-digit ID. */
export function accountIdentifierFromPhone(value) {
  const raw = String(value ?? '').trim();
  const digits = raw.replace(/\D/g, '');
  if (/^0086\d{11}$/.test(digits)) return digits.slice(4);
  if (/^86\d{11}$/.test(digits)) return digits.slice(2);
  if (ACCOUNT_NUMBER_RE.test(digits)) return digits;
  return raw;
}
