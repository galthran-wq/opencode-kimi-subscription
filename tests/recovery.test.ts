import { describe, expect, mock, test } from "bun:test"
import { Effect } from "effect"
import { Credential } from "@opencode/plugin/effect"
import type { ConnectionInfo } from "@opencode/client"
import { recoverUnauthorized } from "../recovery.ts"
import { METHOD_ID } from "../internal.ts"

const now = 5_000_000
const connection = {
  type: "credential",
  id: Credential.ID.make("cred_kimi_test"),
  label: "Kimi test",
  method: "oauth",
} satisfies ConnectionInfo

const oauth = (access: string, refresh = "refresh-core") =>
  Credential.OAuth.make({ type: "oauth", methodID: METHOD_ID, access, refresh, expires: now + 900_000 })

describe("401/403 recovery through Core", () => {
  test.each([401, 403])("resolves Core once and retries with a different access token for HTTP %i", async (status) => {
    const resolve = mock(() => Effect.succeed(oauth("access-new", "refresh-new")))
    let retriedBody = ""
    const send = mock(async (input: string | URL | Request) => {
      const request = input as Request
      expect(request.headers.get("authorization")).toBe("Bearer access-new")
      expect(request.headers.get("x-api-key")).toBeNull()
      retriedBody = await request.text()
      return new Response("recovered", { status: 200 })
    })
    const request = new Request("https://api.example.test/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer access-old", "Content-Type": "application/json", "x-api-key": "remove-me" },
      body: JSON.stringify({ temperature: 1, messages: [] }),
    })

    const response = await Effect.runPromise(
      recoverUnauthorized({
        connection,
        request,
        response: new Response("rejected", { status }),
        replay: request.clone(),
        connections: { resolve },
        send,
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("recovered")
    expect(JSON.parse(retriedBody).temperature).toBe(1)
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(resolve).toHaveBeenCalledWith(connection)
    expect(send).toHaveBeenCalledTimes(1)
  })

  test.each([401, 403])("returns the original HTTP %i response when Core has the same access token", async (status) => {
    const resolve = mock(() => Effect.succeed(oauth("access-old")))
    const send = mock(async () => new Response("unexpected"))
    const request = new Request("https://api.example.test/chat/completions", {
      headers: { Authorization: "Bearer access-old" },
    })
    const original = new Response("rejected", { status })

    const response = await Effect.runPromise(
      recoverUnauthorized({
        connection,
        request,
        response: original,
        replay: request.clone(),
        connections: { resolve },
        send,
      }),
    )

    expect(response).toBe(original)
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()
  })

  test("leaves non-authentication responses untouched without resolving Core", async () => {
    const resolve = mock(() => Effect.succeed(oauth("access-new")))
    const send = mock(async () => new Response("unexpected"))
    const request = new Request("https://api.example.test/chat/completions", {
      headers: { Authorization: "Bearer access-old" },
    })
    const original = new Response("rate limited", { status: 429 })

    const response = await Effect.runPromise(
      recoverUnauthorized({
        connection,
        request,
        response: original,
        replay: request.clone(),
        connections: { resolve },
        send,
      }),
    )

    expect(response).toBe(original)
    expect(resolve).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  test("returns the original response when Core resolution fails", async () => {
    const resolve = mock(() => Effect.fail(new Error("Core refresh failed")))
    const send = mock(async () => new Response("unexpected"))
    const request = new Request("https://api.example.test/chat/completions", {
      headers: { Authorization: "Bearer access-old" },
    })
    const original = new Response("rejected", { status: 401 })

    const response = await Effect.runPromise(
      recoverUnauthorized({
        connection,
        request,
        response: original,
        replay: request.clone(),
        connections: { resolve },
        send,
      }),
    )

    expect(response).toBe(original)
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()
  })
})
