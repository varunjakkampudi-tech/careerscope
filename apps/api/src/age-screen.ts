/** Date-of-birth validation and the 18+ self-declaration check used by the sign-up routes in `app.ts`. */

/** Validate a date-only value without interpreting it in the server's local timezone. */
export function isIsoCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return false;

  const parsed = new Date(0);
  parsed.setUTCHours(0, 0, 0, 0);
  parsed.setUTCFullYear(year, month - 1, day);
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

/** Apply the product's self-reported 18+ screen using UTC calendar dates. */
export function passesAgeScreen(dateOfBirth: string, now = new Date()): boolean {
  if (!isIsoCalendarDate(dateOfBirth) || Number.isNaN(now.getTime())) return false;

  const [year, month, day] = dateOfBirth.split('-').map(Number);
  const currentYear = now.getUTCFullYear();
  let age = currentYear - year!;
  const birthdayHasOccurred =
    now.getUTCMonth() + 1 > month! ||
    (now.getUTCMonth() + 1 === month! && now.getUTCDate() >= day!);
  if (!birthdayHasOccurred) age -= 1;
  return age >= 18;
}
