/**
 * Intl.DateTimeFormat is slow to build and cheap to reuse. The API builds the
 * same few formatters on every order and booking, so they are kept here, one
 * per locale, time zone and option set. A load profile found formatter
 * construction among the top costs of placing an order.
 */
const cache = new Map<string, Intl.DateTimeFormat>();

export function dateFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, options);
    cache.set(key, f);
  }
  return f;
}
