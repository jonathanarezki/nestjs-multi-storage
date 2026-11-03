/** Drops `undefined` values, so that fs applies its own defaults instead of receiving an explicit `undefined`. */
export function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
