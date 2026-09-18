// Display helpers. Money arrives as decimal strings and is only formatted, never
// computed with: arithmetic on prices belongs to the API.

const vnd = new Intl.NumberFormat('vi-VN');

/** "154001.00" → "154.001 ₫". Keeps the decimals only when they are not zero. */
export function formatMoney(amount: string): string {
  const [whole = '0', frac = '00'] = amount.split('.');
  const grouped = vnd.format(BigInt(whole));
  return `${grouped}${frac !== '00' ? `,${frac}` : ''} ₫`;
}

const dateTime = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' });

export function formatDateTime(iso: string | null | undefined): string {
  return iso ? dateTime.format(new Date(iso)) : '—';
}

/** "in 12 min", "3 min ago". */
export function relativeMinutes(iso: string, now = Date.now()): string {
  const minutes = Math.round((new Date(iso).getTime() - now) / 60_000);
  if (minutes === 0) return 'now';
  return minutes > 0 ? `in ${minutes} min` : `${-minutes} min ago`;
}
