import { Effect } from "effect"
import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/effect/integration"
import type { Credential } from "@opencode/plugin/effect"
import {
  CLIENT_ID,
  DEFAULT_OAUTH_HOST,
  DEVICE_GRANT,
  INTEGRATION_ID,
  METHOD_ID,
  classifyPollResponse,
  errorMessage,
  parseDiscoveredModels,
  stripTrailingSlashes,
  toOAuthCredential,
  type DeviceAuthorization,
  type DiscoveredModel,
  type TokenResponse,
} from "./internal.ts"

export const FETCH_TIMEOUT_MS = 30_000
export const LOGIN_TIMEOUT_MS = 900_000

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface OAuthClient {
  requestDevice(signal?: AbortSignal): Promise<DeviceAuthorization>
  poll(deviceCode: string, signal?: AbortSignal): Promise<{ status: number; data: TokenResponse }>
  refresh(refreshToken: string, signal?: AbortSignal): Promise<TokenResponse>
}

export function createOAuthClient(host = DEFAULT_OAUTH_HOST, send: Fetch = fetch): OAuthClient {
  const base = stripTrailingSlashes(host)
  const post = async (path: string, params: Record<string, string>, signal?: AbortSignal) => {
    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS)
    const response = await send(`${base}${path}`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
      ...(signal ? { signal: AbortSignal.any([signal, timeout]) } : { signal: timeout }),
    })
    const data = (await response.json().catch(() => ({}))) as TokenResponse & Record<string, unknown>
    return { status: response.status, data }
  }

  return {
    async requestDevice(signal) {
      const { status, data } = await post("/api/oauth/device_authorization", { client_id: CLIENT_ID }, signal)
      if (status !== 200 || typeof data.device_code !== "string" || !data.device_code) {
        throw new Error(`Kimi device authorization failed (HTTP ${status})`)
      }
      return data as DeviceAuthorization
    },
    poll(deviceCode, signal) {
      return post(
        "/api/oauth/token",
        { client_id: CLIENT_ID, device_code: deviceCode, grant_type: DEVICE_GRANT },
        signal,
      )
    },
    async refresh(refreshToken, signal) {
      const { status, data } = await post(
        "/api/oauth/token",
        { client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: refreshToken },
        signal,
      )
      if (status !== 200 || !data.access_token || !data.refresh_token) {
        throw new Error(`Kimi token refresh failed (HTTP ${status})`)
      }
      return data
    },
  }
}

export async function fetchDiscoveredModels(
  apiBase: string,
  accessToken: string,
  send: Fetch = fetch,
  signal?: AbortSignal,
): Promise<DiscoveredModel[]> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  const response = await send(`${stripTrailingSlashes(apiBase)}/models`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    ...(signal ? { signal: AbortSignal.any([signal, timeout]) } : { signal: timeout }),
  })
  if (!response.ok) throw new Error(`Kimi /models returned HTTP ${response.status}`)
  return parseDiscoveredModels(await response.json())
}

export interface OAuthMethodOptions {
  readonly client: OAuthClient
  readonly now?: () => number
}

export function createOAuthMethod(options: OAuthMethodOptions): IntegrationOAuthMethodRegistration {
  const now = options.now ?? Date.now
  return {
    integrationID: INTEGRATION_ID,
    method: {
      id: METHOD_ID,
      type: "oauth",
      label: "Sign in with Kimi (subscription)",
    },
    authorize: () =>
      Effect.gen(function* () {
        const device = yield* Effect.tryPromise({
          try: (signal) => options.client.requestDevice(signal),
          catch: (cause) => new Error(`Kimi device authorization failed: ${errorMessage(cause)}`),
        })
        const deviceLifetime = Math.max(1, Number(device.expires_in) || 600) * 1000
        const deadline = now() + Math.min(LOGIN_TIMEOUT_MS, deviceLifetime)
        const initialInterval = Math.max(1, Number(device.interval) || 5)

        const poll = (interval: number): Effect.Effect<Credential.OAuth, Error> =>
          Effect.sleep(interval * 1000).pipe(
            Effect.andThen(
              Effect.tryPromise({
                try: (signal) => options.client.poll(device.device_code, signal),
                catch: (cause) => new Error(`Kimi device polling failed: ${errorMessage(cause)}`),
              }),
            ),
            Effect.flatMap(({ status, data }) => {
              const result = classifyPollResponse(status, data)
              if (result.kind === "success") {
                return Effect.try({
                  try: () => toOAuthCredential(result.data, now()),
                  catch: (cause) => new Error(errorMessage(cause)),
                })
              }
              if (result.kind === "pending") {
                if (now() >= deadline) return Effect.fail(new Error("Kimi device authorization timed out"))
                const next = result.error === "slow_down" ? Math.max(interval + 5, result.interval ?? 0) : interval
                return poll(next)
              }
              if (result.kind === "denied") return Effect.fail(new Error("Kimi device authorization was denied"))
              if (result.kind === "expired") return Effect.fail(new Error("Kimi device authorization expired"))
              return Effect.fail(new Error(`Kimi device authorization failed: ${result.error}`))
            }),
          )

        return {
          mode: "auto" as const,
          url: device.verification_uri_complete || device.verification_uri || "",
          instructions: `Approve the sign-in in your browser.${device.user_code ? ` Code: ${device.user_code}` : ""}`,
          expiresAt: deadline,
          callback: poll(initialInterval),
        }
      }),
    refresh: (credential) =>
      Effect.tryPromise({
        try: (signal) => options.client.refresh(credential.refresh, signal),
        catch: (cause) => new Error(errorMessage(cause)),
      }).pipe(
        Effect.map((tokens) => toOAuthCredential(tokens, now(), credential.metadata)),
      ),
  }
}
