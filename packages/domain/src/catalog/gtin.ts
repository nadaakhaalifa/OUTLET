/** GTIN-8, 12, 13 or 14 with a valid GS1 check digit. */
export function isValidGtin(value: string): boolean {
  if (!/^[0-9]+$/.test(value)) return false;
  if (![8, 12, 13, 14].includes(value.length)) return false;
  const digits = [...value].map((c) => c.charCodeAt(0) - 48);
  const check = digits[digits.length - 1];
  if (check === undefined) return false;
  let sum = 0;
  // From the digit left of the check digit, weights alternate 3, 1, 3, ...
  for (let i = digits.length - 2, w = 3; i >= 0; i -= 1, w = w === 3 ? 1 : 3) {
    sum += (digits[i] ?? 0) * w;
  }
  return (10 - (sum % 10)) % 10 === check;
}
