import { stripTrailingSlashes } from "./internal.ts"
import { FETCH_TIMEOUT_MS, type Fetch } from "./oauth.ts"

export interface AbsoluteUsage {
  readonly used: number
  readonly limit: number
  readonly remaining?: number
}

export interface UsageWindow {
  readonly usedRatio?: number
  readonly resetTime?: string
  readonly absolute?: AbsoluteUsage
}

export interface ExtraUsage {
  readonly balanceCents?: number
  readonly totalCents?: number
  readonly monthlyUsedCents?: number
  readonly monthlyChargeLimitCents?: number
  readonly currency?: string
}

export interface KimiUsageReport {
  readonly fiveHour?: UsageWindow
  readonly weekly?: UsageWindow
  readonly monthlyTotal?: UsageWindow
  readonly monthlyCode?: UsageWindow
  readonly extraUsage?: ExtraUsage
}

type RecordValue = Record<string, unknown>
type MutableWindow = {
  usedRatio?: number
  resetTime?: string
  absolute?: AbsoluteUsage
}

const isRecord = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function field(record: RecordValue, ...keys: readonly string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key]
  }
  return undefined
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value !== "string" || value.trim() === "") return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function nonNegativeNumber(value: unknown): number | undefined {
  const parsed = finiteNumber(value)
  return parsed !== undefined && parsed >= 0 ? parsed : undefined
}

function nonNegativeSafeInteger(value: unknown): number | undefined {
  const parsed = nonNegativeNumber(value)
  return parsed !== undefined && Number.isSafeInteger(parsed) ? parsed : undefined
}

function resetTime(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "" || !Number.isFinite(Date.parse(value))) return undefined
  return value
}

function currency(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[A-Za-z]{3}$/.test(value)) return undefined
  return value.toUpperCase()
}

function parseRatioWindow(value: unknown): UsageWindow | undefined {
  if (!isRecord(value)) return undefined
  const usedRatio = nonNegativeNumber(field(value, "used_ratio", "usedRatio"))
  const reset = resetTime(field(value, "reset_time", "resetTime", "resetAt"))
  if (usedRatio === undefined && reset === undefined) return undefined
  return {
    ...(usedRatio === undefined ? {} : { usedRatio }),
    ...(reset === undefined ? {} : { resetTime: reset }),
  }
}

function parseAbsolute(value: unknown): { absolute?: AbsoluteUsage; resetTime?: string } | undefined {
  if (!isRecord(value)) return undefined
  const detail = isRecord(value.detail) ? value.detail : value
  const used = nonNegativeNumber(field(detail, "used"))
  const limit = nonNegativeNumber(field(detail, "limit"))
  const remaining = nonNegativeNumber(field(detail, "remaining"))
  const reset = resetTime(field(detail, "reset_time", "resetTime", "resetAt"))
  if (used === undefined || limit === undefined) return reset === undefined ? undefined : { resetTime: reset }
  return {
    absolute: {
      used,
      limit,
      ...(remaining === undefined ? {} : { remaining }),
    },
    ...(reset === undefined ? {} : { resetTime: reset }),
  }
}

function isFiveHourWindow(value: unknown): boolean {
  if (!isRecord(value)) return false
  const duration = finiteNumber(field(value, "duration"))
  const unit = field(value, "timeUnit", "time_unit")
  if (duration === undefined || typeof unit !== "string") return false
  if (unit === "TIME_UNIT_MINUTE" && duration === 300) return true
  if (unit === "TIME_UNIT_HOUR" && duration === 5) return true
  return unit === "TIME_UNIT_SECOND" && duration === 18_000
}

function payloadRecords(payload: unknown): RecordValue[] {
  const records: RecordValue[] = []
  const seen = new Set<unknown>()
  let current: unknown[] = [payload]
  for (let depth = 0; depth < 4 && current.length > 0; depth++) {
    const next: unknown[] = []
    for (const value of current) {
      if (!isRecord(value) || seen.has(value)) continue
      seen.add(value)
      records.push(value)
      for (const key of ["data", "quota"] as const) {
        if (isRecord(value[key])) next.push(value[key])
      }
    }
    current = next
  }
  return records
}

function mergeWindow(target: MutableWindow, source: UsageWindow | undefined) {
  if (!source) return
  if (target.usedRatio === undefined && source.usedRatio !== undefined) target.usedRatio = source.usedRatio
  if (target.resetTime === undefined && source.resetTime !== undefined) target.resetTime = source.resetTime
  if (target.absolute === undefined && source.absolute !== undefined) target.absolute = source.absolute
}

function optionalWindow(value: MutableWindow): UsageWindow | undefined {
  if (value.usedRatio === undefined && value.resetTime === undefined && value.absolute === undefined) return undefined
  return value
}

function fixedPointToCents(value: unknown): number | undefined {
  const raw = nonNegativeSafeInteger(value)
  if (raw === undefined) return undefined
  const cents = raw > 0 && raw < 1_000_000 ? 1 : Math.round(raw / 1_000_000)
  return Number.isSafeInteger(cents) ? cents : undefined
}

function parseMoney(value: unknown): { cents: number; currency?: string } | undefined {
  if (!isRecord(value)) return undefined
  const cents = nonNegativeSafeInteger(field(value, "priceInCents", "price_in_cents"))
  if (cents === undefined) return undefined
  const code = currency(value.currency)
  return { cents, ...(code === undefined ? {} : { currency: code }) }
}

function parseNormalizedExtra(value: unknown): ExtraUsage | undefined {
  if (!isRecord(value)) return undefined
  const balanceCents = nonNegativeSafeInteger(field(value, "balanceCents", "balance_cents"))
  const totalCents = nonNegativeSafeInteger(field(value, "totalCents", "total_cents"))
  const monthlyUsedCents = nonNegativeSafeInteger(field(value, "monthlyUsedCents", "monthly_used_cents"))
  const monthlyChargeLimitCents =
    field(value, "monthlyChargeLimitEnabled", "monthly_charge_limit_enabled") === true
      ? nonNegativeSafeInteger(field(value, "monthlyChargeLimitCents", "monthly_charge_limit_cents"))
      : undefined
  const code = currency(value.currency)
  if (balanceCents === undefined && totalCents === undefined && monthlyUsedCents === undefined) return undefined
  return {
    ...(balanceCents === undefined ? {} : { balanceCents }),
    ...(totalCents === undefined ? {} : { totalCents }),
    ...(monthlyUsedCents === undefined ? {} : { monthlyUsedCents }),
    ...(monthlyChargeLimitCents === undefined ? {} : { monthlyChargeLimitCents }),
    ...(code === undefined ? {} : { currency: code }),
  }
}

function parseBoosterWallet(value: unknown): ExtraUsage | undefined {
  if (!isRecord(value) || !isRecord(value.balance) || value.balance.type !== "BOOSTER") return undefined
  const totalCents = fixedPointToCents(field(value.balance, "amount"))
  const balanceCents = fixedPointToCents(field(value.balance, "amountLeft", "amount_left"))
  if (totalCents === undefined || balanceCents === undefined) return undefined
  const monthlyLimit = parseMoney(field(value, "monthlyChargeLimit", "monthly_charge_limit"))
  const monthlyUsed = parseMoney(field(value, "monthlyUsed", "monthly_used"))
  const enabled = field(value, "monthlyChargeLimitEnabled", "monthly_charge_limit_enabled") === true
  const code = monthlyLimit?.currency ?? monthlyUsed?.currency
  return {
    balanceCents,
    totalCents,
    ...(monthlyUsed === undefined ? {} : { monthlyUsedCents: monthlyUsed.cents }),
    ...(enabled && monthlyLimit !== undefined ? { monthlyChargeLimitCents: monthlyLimit.cents } : {}),
    ...(code === undefined ? {} : { currency: code }),
  }
}

function mergeExtra(target: ExtraUsage | undefined, source: ExtraUsage | undefined): ExtraUsage | undefined {
  if (!source) return target
  if (!target) return source
  const balanceCents = target.balanceCents ?? source.balanceCents
  const totalCents = target.totalCents ?? source.totalCents
  const monthlyUsedCents = target.monthlyUsedCents ?? source.monthlyUsedCents
  const monthlyChargeLimitCents = target.monthlyChargeLimitCents ?? source.monthlyChargeLimitCents
  const code = target.currency ?? source.currency
  return {
    ...(balanceCents === undefined ? {} : { balanceCents }),
    ...(totalCents === undefined ? {} : { totalCents }),
    ...(monthlyUsedCents === undefined ? {} : { monthlyUsedCents }),
    ...(monthlyChargeLimitCents === undefined ? {} : { monthlyChargeLimitCents }),
    ...(code === undefined ? {} : { currency: code }),
  }
}

export function parseKimiUsage(payload: unknown): KimiUsageReport {
  const fiveHour: MutableWindow = {}
  const weekly: MutableWindow = {}
  const monthlyTotal: MutableWindow = {}
  const monthlyCode: MutableWindow = {}
  let extraUsage: ExtraUsage | undefined

  for (const record of payloadRecords(payload)) {
    const usages = field(record, "usages")
    if (isRecord(usages)) {
      mergeWindow(fiveHour, parseRatioWindow(field(usages, "limit_5h", "limit5h")))
      mergeWindow(weekly, parseRatioWindow(field(usages, "limit_7d", "limit7d")))
      mergeWindow(monthlyTotal, parseRatioWindow(field(usages, "limit_month_total", "monthTotal", "month_total")))
      mergeWindow(monthlyCode, parseRatioWindow(field(usages, "limit_month_code", "monthCode", "month_code")))
    }

    const limits = field(record, "limits")
    if (Array.isArray(limits)) {
      for (const entry of limits) {
        if (!isRecord(entry) || !isFiveHourWindow(entry.window)) continue
        mergeWindow(fiveHour, parseAbsolute(entry))
      }
    }

    mergeWindow(weekly, parseAbsolute(field(record, "usage")))
    extraUsage = mergeExtra(extraUsage, parseNormalizedExtra(field(record, "extraUsage", "extra_usage")))
    extraUsage = mergeExtra(extraUsage, parseBoosterWallet(field(record, "boosterWallet", "booster_wallet")))
  }

  const fiveHourWindow = optionalWindow(fiveHour)
  const weeklyWindow = optionalWindow(weekly)
  const monthlyTotalWindow = optionalWindow(monthlyTotal)
  const monthlyCodeWindow = optionalWindow(monthlyCode)
  return {
    ...(fiveHourWindow ? { fiveHour: fiveHourWindow } : {}),
    ...(weeklyWindow ? { weekly: weeklyWindow } : {}),
    ...(monthlyTotalWindow ? { monthlyTotal: monthlyTotalWindow } : {}),
    ...(monthlyCodeWindow ? { monthlyCode: monthlyCodeWindow } : {}),
    ...(extraUsage ? { extraUsage } : {}),
  }
}

function decimal(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)))
}

function percent(ratio: number): string {
  return `${decimal(Number((ratio * 100).toFixed(2)))}%`
}

function reset(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().replace(".000Z", "Z") : undefined
}

function windowRatio(window: UsageWindow): number | undefined {
  const absolute = window.absolute
  if (absolute && absolute.limit > 0) return absolute.used / absolute.limit
  return window.usedRatio
}

function formatWindow(lines: string[], label: string, window: UsageWindow | undefined, required = false) {
  if (!window) {
    if (required) lines.push(`${label}\n  Not returned by Kimi.`)
    return
  }
  const ratio = windowRatio(window)
  const absolute = window.absolute
  const remainingRatio = ratio === undefined ? undefined : Math.max(0, 1 - ratio)
  const remainingAbsolute = absolute
    ? (absolute.remaining ?? Math.max(0, absolute.limit - absolute.used))
    : undefined
  const resetAt = reset(window.resetTime)
  lines.push(
    [
      label,
      `  Used: ${ratio === undefined ? "not returned" : percent(ratio)}${absolute ? ` (${decimal(absolute.used)} / ${decimal(absolute.limit)})` : ""}`,
      `  Remaining: ${remainingRatio === undefined ? "not returned" : percent(remainingRatio)}${remainingAbsolute === undefined ? "" : ` (${decimal(remainingAbsolute)})`}`,
      ...(resetAt ? [`  Resets: ${resetAt}`] : []),
    ].join("\n"),
  )
}

function money(cents: number, code: string | undefined): string {
  const units = Math.floor(cents / 100)
  const fraction = String(cents % 100).padStart(2, "0")
  return `${code ? `${code} ` : ""}${units}.${fraction}${code ? "" : " (currency not returned)"}`
}

function formatExtra(lines: string[], extra: ExtraUsage | undefined) {
  if (!extra) return
  const rows: string[] = []
  if (extra.balanceCents !== undefined) {
    rows.push(
      `  Balance: ${money(extra.balanceCents, extra.currency)}${extra.totalCents === undefined ? "" : ` of ${money(extra.totalCents, extra.currency)}`}`,
    )
  }
  if (extra.monthlyUsedCents !== undefined) {
    rows.push(`  Used this month: ${money(extra.monthlyUsedCents, extra.currency)}`)
  }
  if (extra.monthlyChargeLimitCents !== undefined) {
    rows.push(`  Monthly limit: ${money(extra.monthlyChargeLimitCents, extra.currency)}`)
  }
  if (rows.length > 0) lines.push(["Extra Usage", ...rows].join("\n"))
}

export function formatKimiUsage(report: KimiUsageReport): string {
  const sections: string[] = []
  formatWindow(sections, "5-hour limit", report.fiveHour, true)
  formatWindow(sections, "Weekly limit", report.weekly)
  formatWindow(sections, "Monthly total", report.monthlyTotal)
  formatWindow(sections, "Monthly Kimi Code", report.monthlyCode)
  formatExtra(sections, report.extraUsage)
  if (sections.length === 1 && !report.fiveHour) return "Kimi subscription usage\n\nKimi returned no recognized quota fields."
  return ["Kimi subscription usage", ...sections].join("\n\n")
}

export type KimiUsageErrorKind = "http" | "timeout" | "network" | "invalid-response"

export class KimiUsageError extends Error {
  constructor(
    readonly kind: KimiUsageErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = "KimiUsageError"
  }
}

export async function fetchKimiUsage(
  apiBase: string,
  accessToken: string,
  send: Fetch = fetch,
  signal?: AbortSignal,
): Promise<KimiUsageReport> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  let response: Response
  try {
    response = await send(`${stripTrailingSlashes(apiBase)}/usages`, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      ...(signal ? { signal: AbortSignal.any([signal, timeout]) } : { signal: timeout }),
    })
  } catch (cause) {
    if (cause instanceof Error && (cause.name === "AbortError" || cause.name === "TimeoutError")) {
      throw new KimiUsageError("timeout", "Kimi usage request timed out")
    }
    throw new KimiUsageError("network", "Kimi usage request failed")
  }
  if (!response.ok) {
    void response.body?.cancel()
    throw new KimiUsageError("http", `Kimi /usages returned HTTP ${response.status}`, response.status)
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new KimiUsageError("invalid-response", "Kimi returned an unreadable usage response")
  }
  return parseKimiUsage(payload)
}

export function kimiUsageErrorMessage(cause: unknown): string {
  if (!(cause instanceof KimiUsageError)) return "Kimi usage could not be loaded. Check the connection and try again."
  if (cause.kind === "http") {
    if (cause.status === 401 || cause.status === 403) {
      return `Kimi usage authentication failed (HTTP ${cause.status}). Run /connect and sign in again.`
    }
    if (cause.status === 404) return "Kimi usage endpoint is unavailable (HTTP 404)."
    if (cause.status === 429) return "Kimi usage request was rate limited (HTTP 429). Try again later."
    return `Kimi usage request failed (HTTP ${cause.status ?? "unknown"}). Try again later.`
  }
  if (cause.kind === "timeout") return "Kimi usage request timed out. Try again."
  if (cause.kind === "invalid-response") return "Kimi returned an unreadable usage response."
  return "Kimi usage request failed. Check the connection and try again."
}
