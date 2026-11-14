import { describe, expect, mock, test } from "bun:test"
import { Effect } from "effect"
import { CLIENT_ID, DEVICE_GRANT } from "../internal.ts"
import { createOAuthClient, createOAuthMethod, fetchDiscoveredModels } from "../oauth.ts"

const json = (value: unknown, status = 200) => Response.json(value, { status })

describe("mocked Kimi OAuth endpoints", () => {
  test("uses the required device authorization and refresh form fields", async () => {
    const calls: { url: string; body: URLSearchParams }[] = []
    const send = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const body = new URLSearchParams(String(init?.body))
      calls.push({ url, body })
      if (url.endsWith("/device_authorization")) {
        return json({ device_code: "device-test", verification_uri: "https://example.test/verify", interval: 1 })
      }
      return json({ access_token: "access-new", refresh_token: "refresh-new", expires_in: 900 })
    })
    const client = createOAuthClient("https://auth.example.test/", send)

    const device = await client.requestDevice()
    expect(device.device_code).toBe("device-test")
    const refreshed = await client.refresh("refresh-old")
    expect(refreshed.refresh_token).toBe("refresh-new")

    expect(calls[0]?.url).toBe("https://auth.example.test/api/oauth/device_authorization")
    expect(calls[0]?.body.get("client_id")).toBe(CLIENT_ID)
    expect(calls[1]?.url).toBe("https://auth.example.test/api/oauth/token")
    expect(calls[1]?.body.get("grant_type")).toBe("refresh_token")
    expect(calls[1]?.body.get("refresh_token")).toBe("refresh-old")
  })

  test("runs the V2 auto device flow and handles authorization_pending", async () => {
    let polls = 0
    const client = {
      requestDevice: mock(async () => ({
        device_code: "device-test",
        verification_uri_complete: "https://example.test/verify?code=test",
        user_code: "TEST-CODE",
        expires_in: 60,
        interval: 1,
      })),
      poll: mock(async (_deviceCode: string) => {
        polls++
        if (polls === 1) return { status: 400, data: { error: "authorization_pending" } }
        return {
          status: 200,
          data: { access_token: "access-test", refresh_token: "refresh-test", expires_in: 900 },
        }
      }),
      refresh: mock(async () => {
        throw new Error("not used")
      }),
    }
    const method = createOAuthMethod({ client, now: () => 10_000_000 })
    expect(method.method.label).toBe("Sign in with Kimi (subscription)")

    const authorization = await Effect.runPromise(Effect.scoped(method.authorize({})))
    expect(authorization.mode).toBe("auto")
    expect(authorization.url).toBe("https://example.test/verify?code=test")
    expect(authorization.instructions).toContain("TEST-CODE")
    if (authorization.mode !== "auto") throw new Error("expected auto flow")
    const credential = await Effect.runPromise(authorization.callback)
    expect(credential.access).toBe("access-test")
    expect(credential.refresh).toBe("refresh-test")
    expect(client.poll).toHaveBeenCalledTimes(2)
  }, 10_000)

  test("uses the device_code grant and propagates rotated refresh tokens", async () => {
    const send = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body))
      expect(body.get("grant_type")).toBe(DEVICE_GRANT)
      expect(body.get("device_code")).toBe("device-test")
      return json({ access_token: "access-test", refresh_token: "refresh-test" })
    })
    const client = createOAuthClient("https://auth.example.test", send)
    const result = await client.poll("device-test")
    expect(result.data.refresh_token).toBe("refresh-test")
  })
})

describe("mocked model discovery", () => {
  test("fetches /models with the bearer token and parses live entries", async () => {
    const send = mock(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.example.test/coding/v1/models")
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-test")
      return json({ data: [{ id: "k3" }, { id: "future", display_name: "Future", context_length: 123_456 }] })
    })
    const models = await fetchDiscoveredModels("https://api.example.test/coding/v1/", "access-test", send)
    expect(models.map((model) => model.id)).toEqual(["k3", "future"])
    expect(models[1]?.context_length).toBe(123_456)
  })

  test("surfaces an inventory HTTP error without exposing credentials", async () => {
    const send = mock(async () => json({ error: "secret-upstream-detail" }, 503))
    await expect(fetchDiscoveredModels("https://api.example.test", "access-test", send)).rejects.toThrow(
      "Kimi /models returned HTTP 503",
    )
  })
})
