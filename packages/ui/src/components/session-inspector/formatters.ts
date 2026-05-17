export function formatTokens(n: number | null | undefined): string {
  if (n == null) return "--";
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1) + "k";
  if (n < 1000000) return Math.round(n / 1000) + "k";
  return (n / 1000000).toFixed(1) + "M";
}

export function formatCurrency(n: number | null | undefined): string {
  if (n == null) return "--";
  return "$" + n.toFixed(4);
}

export function formatPct(n: number | null | undefined): string {
  if (n == null) return "--";
  return (n * 100).toFixed(1) + "%";
}
