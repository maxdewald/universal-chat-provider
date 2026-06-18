import { isPlainObject } from 'moderndash'

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isPlainObject(value) ? value : undefined
}

/** Type guard for any non-array object (looser than {@link asRecord}). */
export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
