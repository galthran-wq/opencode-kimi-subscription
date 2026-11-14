import { describe, expect, mock, test } from "bun:test"
import { Effect } from "effect"
import { Credential } from "@opencode/plugin/effect"
import type { ConnectionInfo } from "@opencode/client"
import {
  createPluginCredentialStore,
  recoverUnauthorized,
  type OAuthRefresh,
  type PluginCredentialStore,
} from "../recovery.ts"
import { METHOD_ID, REFRESH_SKEW_MS } from "../internal.ts"

const now = 5_000_000
const connection = {
  type: "credential",
  id: Credential.ID.make("cred_kimi_test"),
  label: "Kimi test",
  method: "oauth",
} satisfies ConnectionInfo

const oauth = (access: string, refresh: string, expires = now + 900_000) =>
  Credential.OAuth.make({ type: "oauth", methodID: METHOD_ID, access, refresh, expires })

function credentialStore(
  initial: Credential.OAuth,
  refresh: OAuthRefresh,
  active: () => ConnectionInfo | undefined = () => connection,
) {
  const values = new Map<string, unknown>([
    [`oauth/${connection.id}`, { connectionID: connection.id, credential: initial }],
  ])
  const writes: Credential.OAuth[] = []
  const resolve = mock(() => Effect.succeed(initial))
  const store = createPluginCredentialStore({
    storage: {
      get: (key) => Effect.succeed(values.get(key) as never),
      set: (key, value) =>
        Effect.sync(() => {
          values.set(key, value)
          writes.push((value as { credential: Credential.OAuth }).credential)
        }),
    },
    connections: {
      active: () => Effect.sync(active),
      resolve,
    },
    refresh,
    now: () => now,
  })
  return { store, writes, values, resolve }
}

describe("plugin-owned OAuth credentials", () => {
  test("proactively refreshes inside 450 seconds and persists the rotating refresh token", async () => {
    const refreshed = oauth("access-new", "refresh-new", now + 1_800_000)
    const refresh = mock((credential: Credential.OAuth) => {
      expect(credential.refresh).toBe("refresh-old")
      return Effect.succeed(refreshed)
    })
    const stored = credentialStore(oauth("access-old", "refresh-old", now + REFRESH_SKEW_MS), refresh)

    const credential = await Effect.runPromise(stored.store.get(connection))

    expect(credential).toEqual(refreshed)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(stored.resolve).not.toHaveBeenCalled()
    expect(stored.writes).toEqual([refreshed])
    expect(stored.values.get(`oauth/${connection.id}`)).toEqual({ connectionID: connection.id, credential: refreshed })

    const again = await Effect.runPromise(stored.store.get(connection))
    expect(again).toEqual(refreshed)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  test("coalesces concurrent proactive refreshes", async () => {
    const refreshed = oauth("access-new", "refresh-new", now + 1_800_000)
    const refresh = mock(() => Effect.sleep(10).pipe(Effect.as(refreshed)))
    const stored = credentialStore(oauth("access-old", "refresh-old", now + REFRESH_SKEW_MS), refresh)

    const credentials = await Promise.all([
      Effect.runPromise(stored.store.get(connection)),
      Effect.runPromise(stored.store.get(connection)),
    ])

    expect(credentials).toEqual([refreshed, refreshed])
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(stored.writes).toEqual([refreshed])
  })

  test("never falls back to the previous account or a missing active connection", async () => {
    const other: ConnectionInfo = { ...connection, id: "cred_kimi_other", label: "Other account" }
    let active: ConnectionInfo | undefined = connection
    const values = new Map<string, unknown>([
      [`oauth/${connection.id}`, { connectionID: connection.id, credential: oauth("access-a", "refresh-a") }],
      [`oauth/${other.id}`, { connectionID: other.id, credential: oauth("access-b", "refresh-b") }],
    ])
    const refresh = mock(() => Effect.succeed(oauth("access-unexpected", "refresh-unexpected")))
    const store: PluginCredentialStore = createPluginCredentialStore({
      storage: {
        get: (key) => Effect.succeed(values.get(key) as never),
        set: (key, value) => Effect.sync(() => values.set(key, value)),
      },
      connections: {
        active: () => Effect.sync(() => active),
        resolve: () => Effect.succeed(undefined),
      },
      refresh,
      now: () => now,
    })

    expect((await Effect.runPromise(store.get(connection)))?.access).toBe("access-a")
    active = other
    expect((await Effect.runPromise(store.get(connection)))?.access).toBeUndefined()
    expect((await Effect.runPromise(store.get(other)))?.access).toBe("access-b")
    active = undefined
    expect(await Effect.runPromise(store.get(other))).toBeUndefined()
    expect(refresh).not.toHaveBeenCalled()
  })
})

describe("401/403 recovery", () => {
  test.each([401, 403])("refreshes, persists the rotation, and retries once for HTTP %i", async (status) => {
    const refreshed = oauth("access-new", "refresh-new")
    const refresh = mock((credential: Credential.OAuth) => {
      expect(credential.refresh).toBe("refresh-old")
      return Effect.succeed(refreshed)
    })
    const stored = credentialStore(oauth("access-old", "refresh-old"), refresh)
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
        store: stored.store,
        send,
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("recovered")
    expect(JSON.parse(retriedBody).temperature).toBe(1)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(1)
    expect(stored.writes).toEqual([refreshed])
    expect((await Effect.runPromise(stored.store.get(connection)))?.access).toBe("access-new")
  })

  test("reuses a rotation already persisted by another caller", async () => {
    const stored = credentialStore(
      oauth("access-new", "refresh-new"),
      mock(() => Effect.succeed(oauth("access-unexpected", "refresh-unexpected"))),
    )
    const send = mock(async () => new Response("ok"))
    const request = new Request("https://api.example.test/chat/completions", {
      headers: { Authorization: "Bearer access-old" },
    })

    await Effect.runPromise(
      recoverUnauthorized({
        connection,
        request,
        response: new Response(null, { status: 401 }),
        replay: request.clone(),
        store: stored.store,
        send,
      }),
    )

    expect(send).toHaveBeenCalledTimes(1)
    expect(stored.writes).toHaveLength(0)
  })

  test("leaves non-authentication responses untouched", async () => {
    const stored = credentialStore(
      oauth("access-old", "refresh-old"),
      mock(() => Effect.succeed(oauth("access-new", "refresh-new"))),
    )
    const send = mock(async () => new Response("unexpected"))
    const request = new Request("https://api.example.test/chat/completions")
    const original = new Response("rate limited", { status: 429 })

    const response = await Effect.runPromise(
      recoverUnauthorized({
        connection,
        request,
        response: original,
        replay: request.clone(),
        store: stored.store,
        send,
      }),
    )

    expect(response).toBe(original)
    expect(send).not.toHaveBeenCalled()
  })
})
