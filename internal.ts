import { Credential, Integration, Model, Provider } from "@opencode/plugin/effect"

export const PROVIDER_ID = Provider.ID.make("kimi-code")
export const INTEGRATION_ID = Integration.ID.make("kimi-code")
export const METHOD_ID = Integration.MethodID.make("device")
export const PROVIDER_PACKAGE = "@opencode/ai/providers/openai-compatible"
export const DEFAULT_OAUTH_HOST = "https://auth.kimi.com"
export const DEFAULT_API_BASE = "https://api.kimi.com/coding/v1"
export const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098"
export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
export const REFRESH_SKEW_MS = 450_000
export const CORE_REFRESH_SKEW_MS = 300_000
export const EXPIRY_STORAGE_SKEW_MS = REFRESH_SKEW_MS - CORE_REFRESH_SKEW_MS
export const MODEL_TTL_MS = 6 * 60 * 60 * 1000
export const DEFAULT_OUTPUT_LIMIT = 65_536

export const stripTrailingSlashes = (url: string) => url.replace(/\/+$/, "")
export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

export type UpstreamModel = {
  id?: string
  display_name?: string
  context_length?: number
  supports_reasoning?: boolean
  supports_image_in?: boolean
  supports_video_in?: boolean
  supports_tool_use?: boolean
  supports_thinking_type?: "only" | "no" | "both"
}

export type DiscoveredModel = UpstreamModel & { id: string }
export type ModelCache = { ts: number; models: DiscoveredModel[] }

export type DeviceAuthorization = {
  device_code: string
  verification_uri?: string
  verification_uri_complete?: string
  user_code?: string
  expires_in?: number
  interval?: number
}

export type TokenResponse = {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  error?: string
  interval?: number
}

export const STATIC_MODELS: readonly DiscoveredModel[] = [
  {
    id: "k3",
    display_name: "Kimi K3",
    context_length: 1_048_576,
    supports_reasoning: true,
    supports_tool_use: true,
  },
  {
    id: "kimi-for-coding",
    display_name: "Kimi K2.7 Coding",
    context_length: 262_144,
    supports_reasoning: true,
    supports_tool_use: true,
  },
  {
    id: "kimi-for-coding-highspeed",
    display_name: "Kimi K2.7 Coding Highspeed",
    context_length: 262_144,
    supports_reasoning: true,
    supports_tool_use: true,
  },
]

export function toOAuthCredential(
  data: TokenResponse,
  now = Date.now(),
  metadata?: Readonly<Record<string, unknown>>,
): Credential.OAuth {
  if (!data.access_token || !data.refresh_token) throw new Error("Kimi returned an incomplete token response")
  const expiresIn = Number.isFinite(data.expires_in) ? Number(data.expires_in) : 900
  const expires = Math.max(0, now + expiresIn * 1000 - EXPIRY_STORAGE_SKEW_MS)
  return Credential.OAuth.make({
    type: "oauth",
    methodID: METHOD_ID,
    access: data.access_token,
    refresh: data.refresh_token,
    expires,
    ...(metadata === undefined ? {} : { metadata }),
  })
}

export function coreRefreshesWithin450Seconds(actualExpires: number, now: number) {
  const storedExpires = Math.max(0, actualExpires - EXPIRY_STORAGE_SKEW_MS)
  return storedExpires <= now + CORE_REFRESH_SKEW_MS
}

export function toModelInfo(model: DiscoveredModel): Model.Info {
  const input = ["text"]
  if (model.supports_image_in) input.push("image")
  if (model.supports_video_in) input.push("video")
  return {
    ...Model.Info.default(PROVIDER_ID, Model.ID.make(model.id)),
    name: model.display_name || model.id,
    capabilities: {
      tools: model.supports_tool_use !== false,
      input,
      output: ["text"],
      temperature: false,
    },
    body: { temperature: 1 },
    limit: {
      context: Number(model.context_length) || 262_144,
      output: DEFAULT_OUTPUT_LIMIT,
    },
  }
}

export function providerInfo(apiBase: string): Provider.Info {
  return {
    ...Provider.Info.empty(PROVIDER_ID),
    integrationID: INTEGRATION_ID,
    name: "Kimi Code (subscription)",
    activation: "auto",
    package: PROVIDER_PACKAGE,
    settings: { baseURL: apiBase, transport: "http" },
    body: { temperature: 1 },
  }
}

export function isValidModelCache(value: unknown): value is ModelCache {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as { ts?: unknown; models?: unknown }
  return (
    typeof candidate.ts === "number" &&
    Number.isFinite(candidate.ts) &&
    Array.isArray(candidate.models) &&
    candidate.models.length > 0 &&
    candidate.models.every((model) => typeof model === "object" && model !== null && "id" in model && !!model.id)
  )
}

export function parseDiscoveredModels(payload: unknown): DiscoveredModel[] {
  if (typeof payload !== "object" || payload === null || !("data" in payload)) return []
  const data = (payload as { data?: unknown }).data
  if (!Array.isArray(data)) return []
  const models = new Map<string, DiscoveredModel>()
  for (const value of data) {
    if (typeof value !== "object" || value === null || !("id" in value)) continue
    const model = value as UpstreamModel
    if (typeof model.id !== "string" || !model.id) continue
    models.set(model.id, { ...model, id: model.id })
  }
  return Array.from(models.values())
}

export type PollResult =
  | { kind: "success"; data: TokenResponse }
  | { kind: "pending"; error: "authorization_pending" | "slow_down"; interval?: number }
  | { kind: "denied" }
  | { kind: "expired" }
  | { kind: "error"; status: number; error: string }

export function classifyPollResponse(status: number, data: TokenResponse): PollResult {
  if (status === 200 && data.access_token) return { kind: "success", data }
  if (data.error === "authorization_pending" || data.error === "slow_down") {
    return { kind: "pending", error: data.error, ...(data.interval === undefined ? {} : { interval: data.interval }) }
  }
  if (data.error === "access_denied") return { kind: "denied" }
  if (data.error === "expired_token") return { kind: "expired" }
  return { kind: "error", status, error: data.error || `HTTP ${status}` }
}
