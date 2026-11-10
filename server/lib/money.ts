// All money is integer cents in code. PayPal gets two-decimal strings. USD only.

export function toPayPal(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new Error(`bad cents: ${cents}`);
  return (cents / 100).toFixed(2);
}

export function fromPayPal(value: string): number {
  return Math.round(Number.parseFloat(value) * 100);
}

export function fmt(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function median(values: number[]): number {
  if (values.length === 0) throw new Error('median of empty list');
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
