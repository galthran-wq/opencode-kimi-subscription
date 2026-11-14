import { describe, expect, test } from "bun:test"
import {
  DEFAULT_API_BASE,
  EXPIRY_STORAGE_SKEW_MS,
  STATIC_MODELS,
  coreRefreshesWithin450Seconds,
  isValidModelCache,
  parseDiscoveredModels,
  providerInfo,
  toModelInfo,
  toOAuthCredential,
} from "../internal.ts"

describe("V2 provider and model definitions", () => {
  test("registers the native OpenAI-compatible endpoint and pins temperature", () => {
    const provider = providerInfo(DEFAULT_API_BASE)
    expect(String(provider.id)).toBe("kimi-code")
    expect(String(provider.integrationID)).toBe("kimi-code")
    expect(provider.package).toBe("@opencode/ai/providers/openai-compatible")
    expect(provider.settings?.baseURL).toBe("https://api.kimi.com/coding/v1")
    expect(provider.settings?.transport).toBe("http")
    expect(provider.body).toEqual({ temperature: 1 })
  })

  test("contains all three static baseline models", () => {
    expect(STATIC_MODELS.map((model) => model.id)).toEqual([
      "k3",
      "kimi-for-coding",
      "kimi-for-coding-highspeed",
    ])
  })

  test("maps live model capabilities, limits, and fixed temperature", () => {
    const model = toModelInfo({
      id: "future-kimi",
      display_name: "Future Kimi",
      context_length: 500_000,
      supports_image_in: true,
      supports_tool_use: true,
    })
    expect(String(model.providerID)).toBe("kimi-code")
    expect(model.name).toBe("Future Kimi")
    expect(model.limit).toEqual({ context: 500_000, output: 65_536 })
    expect(model.capabilities).toEqual({
      tools: true,
      input: ["text", "image"],
      output: ["text"],
      temperature: false,
    })
    expect(model.body).toEqual({ temperature: 1 })
  })

  test("parses and deduplicates the upstream inventory and rejects malformed cache", () => {
    const models = parseDiscoveredModels({
      data: [{ id: "k3" }, null, { display_name: "missing id" }, { id: "k3", display_name: "K3" }, { id: "new" }],
    })
    expect(models).toEqual([{ id: "k3", display_name: "K3" }, { id: "new" }])
    expect(isValidModelCache({ ts: 1, models })).toBe(true)
    expect(isValidModelCache({ ts: 1, models: [] })).toBe(false)
    expect(isValidModelCache({ models })).toBe(false)
  })
})

describe("OAuth credential expiry", () => {
  test("persists a V2 OAuth value with rotated tokens and the storage skew", () => {
    const now = 1_000_000_000
    const credential = toOAuthCredential(
      { access_token: "access-test", refresh_token: "refresh-test", expires_in: 900 },
      now,
      { account: "test" },
    )
    expect(credential.type).toBe("oauth")
    expect(String(credential.methodID)).toBe("device")
    expect(credential.access).toBe("access-test")
    expect(credential.refresh).toBe("refresh-test")
    expect(credential.expires).toBe(now + 900_000 - EXPIRY_STORAGE_SKEW_MS)
    expect(credential.metadata).toEqual({ account: "test" })
  })

  test("makes Core refresh at 450 seconds, but not earlier", () => {
    const now = 2_000_000_000
    expect(coreRefreshesWithin450Seconds(now + 450_000, now)).toBe(true)
    expect(coreRefreshesWithin450Seconds(now + 450_001, now)).toBe(false)
  })

  test("rejects incomplete token responses", () => {
    expect(() => toOAuthCredential({ access_token: "missing-refresh" })).toThrow("incomplete token response")
  })
})
