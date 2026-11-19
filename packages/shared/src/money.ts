/** All money is integer minor units (pence, cents). Never floats. */
export function formatMoney(minor: number, currency: string, locale = "en-GB"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(minor / 100);
}

export function lineTotal(unitPriceMinor: number, modifierDeltas: number[], quantity: number): number {
  const unit = unitPriceMinor + modifierDeltas.reduce((sum, d) => sum + d, 0);
  return unit * quantity;
}
