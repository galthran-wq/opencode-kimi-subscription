import { describe, expect, mock, test } from "bun:test"
import {
  fetchKimiUsage,
  formatKimiUsage,
  KimiUsageError,
  kimiUsageErrorMessage,
  parseKimiUsage,
} from "../usage.ts"

const reset5h = "2026-11-14T15:00:00Z"
const resetWeek = "2026-11-21T00:00:00Z"
const resetMonth = "2026-12-01T00:00:00Z"

const wallet = {
  balance: { type: "BOOSTER", amount: "20000000000", amountLeft: "10000000000" },
  monthlyChargeLimitEnabled: true,
  monthlyChargeLimit: { currency: "CNY", priceInCents: "20000" },
  monthlyUsed: { currency: "CNY", priceInCents: "5000" },
}

describe("Kimi usage response variants", () => {
  test("parses ratio pools, absolute 5h and weekly counters, and the raw Extra Usage wallet", () => {
    const report = parseKimiUsage({
      version: "ignored",
      limits: [
        {
          window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
          detail: { limit: "100", used: "25", remaining: "75", resetTime: reset5h },
        },
      ],
      usage: { limit: "100", used: "20", remaining: "80", resetTime: resetWeek },
      usages: {
        limit_5h: { used_ratio: 0.25, reset_time: reset5h },
        limit_7d: { used_ratio: 0.2, reset_time: resetWeek },
        limit_month_total: { used_ratio: 0.4, reset_time: resetMonth },
        limit_month_code: { used_ratio: "0.25", reset_time: resetMonth },
      },
      boosterWallet: wallet,
      unknownFutureField: { secret: "not-rendered" },
    })

    expect(report).toEqual({
      fiveHour: {
        usedRatio: 0.25,
        resetTime: reset5h,
        absolute: { used: 25, limit: 100, remaining: 75 },
      },
      weekly: {
        usedRatio: 0.2,
        resetTime: resetWeek,
        absolute: { used: 20, limit: 100, remaining: 80 },
      },
      monthlyTotal: { usedRatio: 0.4, resetTime: resetMonth },
      monthlyCode: { usedRatio: 0.25, resetTime: resetMonth },
      extraUsage: {
        balanceCents: 10_000,
        totalCents: 20_000,
        monthlyUsedCents: 5_000,
        monthlyChargeLimitCents: 20_000,
        currency: "CNY",
      },
    })

    const text = formatKimiUsage(report)
    expect(text).toContain("5-hour limit\n  Used: 25% (25 / 100)\n  Remaining: 75% (75)")
    expect(text).toContain("Weekly limit\n  Used: 20% (20 / 100)\n  Remaining: 80% (80)")
    expect(text).toContain("Monthly total\n  Used: 40%\n  Remaining: 60%")
    expect(text).toContain("Monthly Kimi Code\n  Used: 25%\n  Remaining: 75%")
    expect(text).toContain("Balance: CNY 100.00 of CNY 200.00")
    expect(text).toContain("Used this month: CNY 50.00")
    expect(text).toContain("Monthly limit: CNY 200.00")
    expect(text).not.toContain("unknownFutureField")
    expect(text).not.toContain("not-rendered")
  })

  test("parses the wrapped camelCase quota and normalized Extra Usage form", () => {
    const report = parseKimiUsage({
      code: 0,
      data: {
        kind: "ok",
        quota: {
          usages: {
            limit5h: { usedRatio: 0.3, resetAt: reset5h },
            limit7d: { usedRatio: 0.2, resetAt: resetWeek },
            monthTotal: { usedRatio: 0.4, resetAt: resetMonth },
            monthCode: { usedRatio: 0.25, resetAt: resetMonth },
          },
          extraUsage: {
            balanceCents: 10_000,
            totalCents: 20_000,
            monthlyChargeLimitEnabled: true,
            monthlyChargeLimitCents: 20_000,
            monthlyUsedCents: 5_000,
            currency: "USD",
          },
        },
      },
    })

    expect(report.fiveHour).toEqual({ usedRatio: 0.3, resetTime: reset5h })
    expect(report.weekly).toEqual({ usedRatio: 0.2, resetTime: resetWeek })
    expect(report.monthlyTotal).toEqual({ usedRatio: 0.4, resetTime: resetMonth })
    expect(report.monthlyCode).toEqual({ usedRatio: 0.25, resetTime: resetMonth })
    const text = formatKimiUsage(report)
    expect(text).toContain("Used: 30%")
    expect(text).toContain("Remaining: 70%")
    expect(text).toContain("Balance: USD 100.00 of USD 200.00")
    expect(text).not.toContain("code\":0")
  })

  test("accepts monthly aliases and the booster_wallet spelling without inventing missing currency", () => {
    const report = parseKimiUsage({
      usages: {
        month_total: { used_ratio: 0.125 },
        month_code: { used_ratio: 0.0625 },
      },
      booster_wallet: {
        ...wallet,
        monthlyChargeLimit: { priceInCents: "20000" },
        monthlyUsed: { priceInCents: "5000" },
      },
    })

    expect(report.monthlyTotal?.usedRatio).toBe(0.125)
    expect(report.monthlyCode?.usedRatio).toBe(0.0625)
    const text = formatKimiUsage(report)
    expect(text).toContain("Used: 12.5%")
    expect(text).toContain("Used: 6.25%")
    expect(text).toContain("100.00 (currency not returned)")
    expect(text).not.toContain("USD")
    expect(text).not.toContain("CNY")
  })

  test("uses an enforced absolute counter when its ratio summary is stale", () => {
    const text = formatKimiUsage(
      parseKimiUsage({
        limits: [
          {
            window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" },
            detail: { limit: 100, used: 88, resetTime: reset5h },
          },
        ],
        usages: { limit_5h: { used_ratio: 0, reset_time: reset5h } },
      }),
    )

    expect(text).toContain("Used: 88% (88 / 100)")
    expect(text).toContain("Remaining: 12% (12)")
    expect(text).toContain(`Resets: ${reset5h}`)
  })

  test.each([
    { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
    { duration: 5, timeUnit: "TIME_UNIT_HOUR" },
    { duration: 18_000, timeUnit: "TIME_UNIT_SECOND" },
  ])("recognizes the 5h window variant $duration $timeUnit", (window) => {
    const report = parseKimiUsage({ limits: [{ window, detail: { used: 1, limit: 10 } }] })
    expect(report.fiveHour?.absolute).toEqual({ used: 1, limit: 10 })
  })

  test("omits malformed and unknown values instead of manufacturing quota", () => {
    expect(parseKimiUsage(null)).toEqual({})
    expect(parseKimiUsage("invalid")).toEqual({})
    expect(parseKimiUsage({ unknown: { limit_5h: { used_ratio: 0.9 } } })).toEqual({})
    const report = parseKimiUsage({
      usages: {
        limit_5h: { used_ratio: -1, reset_time: "not-a-date" },
        limit_7d: { used_ratio: Number.NaN },
        limit_month_total: { used_ratio: "not-a-number", reset_time: 42 },
        limit_month_code: null,
      },
      limits: [
        { window: { duration: 60, timeUnit: "TIME_UNIT_MINUTE" }, detail: { used: 90, limit: 100 } },
        { window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { used: -1, limit: 100 } },
      ],
      boosterWallet: { balance: { type: "PLAN", amount: "1000000", amountLeft: "1000000" } },
      extraUsage: null,
    })
    expect(report).toEqual({})
    expect(formatKimiUsage(report)).toBe("Kimi subscription usage\n\nKimi returned no recognized quota fields.")
  })

  test("shows partial data conservatively and clamps only remaining percentage at zero", () => {
    const text = formatKimiUsage(
      parseKimiUsage({
        usages: {
          limit_5h: { used_ratio: 1.2 },
          limit_month_total: { reset_time: resetMonth },
        },
      }),
    )
    expect(text).toContain("Used: 120%")
    expect(text).toContain("Remaining: 0%")
    expect(text).toContain("Monthly total\n  Used: not returned\n  Remaining: not returned")
    expect(text).toContain(`Resets: ${resetMonth}`)
    expect(text).not.toContain("Extra Usage")
  })
})

describe("Kimi usage network handling", () => {
  test("performs one authenticated GET and parses the response", async () => {
    const send = mock(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.example.test/coding/v1/usages")
      expect(init?.method).toBe("GET")
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-test")
      expect(new Headers(init?.headers).get("accept")).toBe("application/json")
      expect(init?.body).toBeUndefined()
      return Response.json({ usages: { limit_5h: { used_ratio: 0.3, reset_time: reset5h } } })
    })

    const report = await fetchKimiUsage("https://api.example.test/coding/v1/", "access-test", send)

    expect(report.fiveHour?.usedRatio).toBe(0.3)
    expect(send).toHaveBeenCalledTimes(1)
  })

  test.each([401, 403, 404, 429, 503])("contains HTTP %i failures without echoing upstream details", async (status) => {
    const secret = `secret-response-${status}`
    const send = mock(async () => Response.json({ message: secret }, { status }))
    let error: unknown
    try {
      await fetchKimiUsage("https://api.example.test", "access-test", send)
    } catch (cause) {
      error = cause
    }
    expect(error).toBeInstanceOf(KimiUsageError)
    expect(error).toMatchObject({ kind: "http", status })
    expect(kimiUsageErrorMessage(error)).toContain(String(status))
    expect(kimiUsageErrorMessage(error)).not.toContain(secret)
    expect(kimiUsageErrorMessage(error)).not.toContain("access-test")
  })

  test("sanitizes invalid JSON, network failures, and timeouts", async () => {
    await expect(
      fetchKimiUsage("https://api.example.test", "access-test", async () => new Response("not-json")),
    ).rejects.toMatchObject({ kind: "invalid-response" })

    const networkSecret = "network-error-with-access-test"
    await expect(
      fetchKimiUsage("https://api.example.test", "access-test", async () => {
        throw new Error(networkSecret)
      }),
    ).rejects.toMatchObject({ kind: "network", message: "Kimi usage request failed" })

    const timeout = new Error("timed out")
    timeout.name = "TimeoutError"
    await expect(
      fetchKimiUsage("https://api.example.test", "access-test", async () => {
        throw timeout
      }),
    ).rejects.toMatchObject({ kind: "timeout" })
    expect(kimiUsageErrorMessage(new Error(networkSecret))).not.toContain(networkSecret)
  })
})
