import { describe, expect, mock, test } from "bun:test"
import { Effect, Stream } from "effect"
import { Credential, Model, Provider } from "@opencode/plugin/effect"
import type { ConnectionInfo } from "@opencode/client"
import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/effect/integration"
import { METHOD_ID, PROVIDER_ID, STATIC_MODELS } from "../internal.ts"
import type { Fetch } from "../oauth.ts"
import { createKimiPlugin } from "../plugin.ts"

const now = 5_000_000
const connection = {
  type: "credential",
  id: Credential.ID.make("cred_kimi_test"),
  label: "Kimi test",
  method: "oauth",
} satisfies ConnectionInfo

const oauth = (access: string, refresh: string) =>
  Credential.OAuth.make({ type: "oauth", methodID: METHOD_ID, access, refresh, expires: now + 900_000 })

const modelsResponse = () =>
  Response.json({ data: [{ id: "future-kimi", display_name: "Future Kimi", context_length: 400_000 }] })

interface HarnessOptions {
  readonly active?: () => ConnectionInfo | undefined
  readonly credentials?: Map<string, Credential.OAuth>
  readonly storage?: Map<string, unknown>
  readonly send?: Fetch
}

function createHarness(options: HarnessOptions = {}) {
  const active = options.active ?? (() => connection)
  const credentials = options.credentials ?? new Map([[connection.id, oauth("access-test", "refresh-test")]])
  const storage = options.storage ?? new Map<string, unknown>()
  const send = options.send ?? mock(async () => modelsResponse())
  let added: { info: Provider.Info; models: readonly Model.Info[]; sourceConnection?: ConnectionInfo } | undefined
  let providerTransform: ((editor: unknown) => void) | undefined
  let oauthMethod: IntegrationOAuthMethodRegistration | undefined
  let reloads = 0
  const hooks: { name: string; callback: (event: any) => Effect.Effect<any, any> }[] = []
  const commands: { name: string; description?: string; execute: (input: any) => Effect.Effect<void, unknown> }[] = []
  const synthetics: Record<string, unknown>[] = []
  let prompts = 0
  let generations = 0
  const resolve = mock((selected: ConnectionInfo) =>
    Effect.succeed(selected.type === "credential" ? credentials.get(selected.id) : undefined),
  )

  const ctx = {
    storage: {
      get: (key: string) => Effect.succeed(storage.get(key) as never),
      set: (key: string, value: unknown) =>
        Effect.sync(() => {
          storage.set(key, value)
        }),
    },
    integration: {
      connection: {
        active: () => Effect.sync(active),
        resolve,
      },
      transform: (callback: (editor: any) => void) => {
        callback({
          update: () => {},
          method: {
            update: (method: typeof oauthMethod) => {
              oauthMethod = method
            },
          },
        })
        return Effect.succeed({ dispose: Effect.void })
      },
    },
    command: {
      transform: (callback: (editor: any) => void) => {
        callback({
          add: (definition: (typeof commands)[number]) => {
            commands.push(definition)
          },
        })
        return Effect.succeed({ dispose: Effect.void })
      },
    },
    provider: {
      transform: (callback: (editor: any) => void) => {
        providerTransform = callback
        callback({
          add: (input: NonNullable<typeof added>) => {
            added = input
          },
        })
        return Effect.succeed({ dispose: Effect.void })
      },
      reload: () =>
        Effect.sync(() => {
          reloads++
        }),
    },
    model: {
      transform: (callback: (editor: any) => void) => {
        callback({
          list: () => added?.models ?? [],
          update: (_provider: string, id: string, update: (model: Model.Info) => void) => {
            const model = added?.models.find((candidate) => candidate.id === id)
            if (model) update(model)
          },
        })
        return Effect.succeed({ dispose: Effect.void })
      },
    },
    event: { subscribe: () => Stream.empty },
    session: {
      hook: (name: string, callback: (event: any) => Effect.Effect<any, any>) => {
        hooks.push({ name, callback })
        return Effect.succeed({ dispose: Effect.void })
      },
      synthetic: (input: Record<string, unknown>) =>
        Effect.sync(() => {
          synthetics.push(input)
          return input
        }),
      prompt: () =>
        Effect.sync(() => {
          prompts++
          throw new Error("The usage command must not submit a prompt")
        }),
      generate: () =>
        Effect.sync(() => {
          generations++
          throw new Error("The usage command must not generate text")
        }),
    },
  }

  return {
    ctx,
    hooks,
    commands,
    synthetics,
    send,
    storage,
    credentials,
    resolve,
    promptCalls: () => prompts,
    generationCalls: () => generations,
    added: () => added,
    oauthMethod: () => oauthMethod,
    reloads: () => reloads,
    replayProviderTransform: () =>
      providerTransform?.({
        add: (input: NonNullable<typeof added>) => {
          added = input
        },
      }),
  }
}

async function setup(harness: ReturnType<typeof createHarness>) {
  const plugin = createKimiPlugin({
    fetch: harness.send,
    now: () => now,
    apiBase: "https://api.example.test/coding/v1",
    oauthHost: "https://auth.example.test",
  })
  await Effect.runPromise(Effect.scoped(plugin.effect(harness.ctx as never)))
}

function hook(harness: ReturnType<typeof createHarness>, name: string) {
  const found = harness.hooks.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`Missing ${name} hook`)
  return found.callback
}

async function runCommand(harness: ReturnType<typeof createHarness>, name: string) {
  const command = harness.commands.find((candidate) => candidate.name === name)
  if (!command) throw new Error(`Missing ${name} command`)
  await Effect.runPromise(
    command.execute({ sessionID: "ses_kimi_usage_test", prompt: { text: "" }, delivery: "steer" }),
  )
}

describe("V2 plugin setup", () => {
  test("loads without Core Credential.Service and preserves transforms, discovery, and temperature", async () => {
    const harness = createHarness()
    await setup(harness)

    expect(harness.oauthMethod()?.method.label).toBe("Sign in with Kimi (subscription)")
    expect(harness.added()?.info.id).toBe(PROVIDER_ID)
    expect(harness.added()?.models.map((model) => String(model.id))).toEqual(STATIC_MODELS.map((model) => model.id))
    expect(harness.added()?.sourceConnection).toEqual(connection)
    expect(harness.added()?.models.every((model) => model.body?.temperature === 1)).toBe(true)
    expect(harness.added()?.models.every((model) => model.cost.length === 0)).toBe(true)
    expect(harness.send).toHaveBeenCalledTimes(1)
    expect(harness.storage.get("models")).toEqual({
      ts: now,
      models: [{ id: "future-kimi", display_name: "Future Kimi", context_length: 400_000 }],
    })
    expect(harness.reloads()).toBeGreaterThan(0)

    harness.replayProviderTransform()
    expect(harness.added()?.models.map((model) => String(model.id))).toEqual(["future-kimi"])

    for (const name of ["context", "compaction", "generate", "title"]) {
      const event = { options: { temperature: 0.2 } }
      await Effect.runPromise(hook(harness, name)(event))
      expect(event.options.temperature).toBe(1)
    }
    expect(harness.hooks.filter((candidate) => candidate.name === "http.request" || candidate.name === "http.response"))
      .toHaveLength(2)
  })

  test("registers Core's refresh callback and uses the rotated credential Core persists", async () => {
    const send = mock(async (input: string | URL | Request) => {
      if (String(input).startsWith("https://auth.example.test/")) {
        return Response.json({ access_token: "access-new", refresh_token: "refresh-new", expires_in: 900 })
      }
      return modelsResponse()
    })
    const harness = createHarness({
      credentials: new Map([[connection.id, oauth("access-old", "refresh-old")]]),
      send,
    })
    await setup(harness)
    const refresh = harness.oauthMethod()?.refresh
    expect(refresh).toBeDefined()
    if (!refresh) throw new Error("OAuth refresh must remain registered for Core")

    const current = harness.credentials.get(connection.id)!
    const refreshed = await Effect.runPromise(refresh(current))
    expect(refreshed.access).toBe("access-new")
    expect(refreshed.refresh).toBe("refresh-new")

    // Core owns persistence: its credential store is represented by this map, not plugin storage.
    harness.credentials.set(connection.id, refreshed)
    const requestHook = hook(harness, "http.request")
    for (let index = 0; index < 2; index++) {
      const request = new Request("https://api.example.test/coding/v1/chat/completions", {
        headers: { Authorization: "Bearer access-old" },
      })
      await Effect.runPromise(requestHook({ request }))
      expect(request.headers.get("authorization")).toBe("Bearer access-new")
    }

    expect(send.mock.calls.filter(([input]) => String(input).startsWith("https://auth.example.test/"))).toHaveLength(1)
    expect(harness.storage.get(`oauth/${connection.id}`)).toBeUndefined()
  })

  test("replays a rejected request only with a different token resolved from Core", async () => {
    const replays: Request[] = []
    const send = mock(async (input: string | URL | Request) => {
      if (input instanceof Request) {
        replays.push(input)
        return new Response("recovered", { status: 200 })
      }
      if (String(input).startsWith("https://auth.example.test/")) {
        throw new Error("The plugin must not refresh OAuth credentials")
      }
      return modelsResponse()
    })
    const harness = createHarness({
      credentials: new Map([[connection.id, oauth("access-old", "refresh-old")]]),
      send,
    })
    await setup(harness)
    const requestHook = hook(harness, "http.request")
    const responseHook = hook(harness, "http.response")
    const request = new Request("https://api.example.test/coding/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer stale", "x-api-key": "remove-me" },
      body: JSON.stringify({ temperature: 1 }),
    })

    await Effect.runPromise(requestHook({ request }))
    expect(request.headers.get("authorization")).toBe("Bearer access-old")
    expect(request.headers.get("x-api-key")).toBeNull()

    // Core refreshes and persists independently; the next resolve observes its current value.
    harness.credentials.set(connection.id, oauth("access-new", "refresh-new"))
    const responseEvent = { request, response: new Response("rejected", { status: 401 }) }
    await Effect.runPromise(responseHook(responseEvent))

    expect(responseEvent.response.status).toBe(200)
    expect(replays).toHaveLength(1)
    expect(replays[0]?.headers.get("authorization")).toBe("Bearer access-new")

    const subsequent = new Request("https://api.example.test/coding/v1/chat/completions", {
      headers: { Authorization: "Bearer access-old" },
    })
    await Effect.runPromise(requestHook({ request: subsequent }))
    expect(subsequent.headers.get("authorization")).toBe("Bearer access-new")
    expect(harness.storage.get(`oauth/${connection.id}`)).toBeUndefined()
  })

  test("does not refresh or replay when Core resolves the rejected token unchanged", async () => {
    const send = mock(async (input: string | URL | Request) => {
      if (input instanceof Request || String(input).startsWith("https://auth.example.test/")) {
        throw new Error("The plugin must not refresh or replay an unchanged credential")
      }
      return modelsResponse()
    })
    const harness = createHarness({
      credentials: new Map([[connection.id, oauth("access-old", "refresh-old")]]),
      send,
    })
    await setup(harness)
    const request = new Request("https://api.example.test/coding/v1/chat/completions")
    await Effect.runPromise(hook(harness, "http.request")({ request }))
    const original = new Response("rejected", { status: 403 })
    const responseEvent = { request, response: original }

    await Effect.runPromise(hook(harness, "http.response")(responseEvent))

    expect(responseEvent.response).toBe(original)
    expect(send).toHaveBeenCalledTimes(1)
    expect(harness.storage.get(`oauth/${connection.id}`)).toBeUndefined()
  })

  test("does not reuse credentials across account switches or without an active connection", async () => {
    const other: ConnectionInfo = { ...connection, id: "cred_kimi_other", label: "Other account" }
    let active: ConnectionInfo | undefined = connection
    const harness = createHarness({
      active: () => active,
      credentials: new Map([
        [connection.id, oauth("access-a", "refresh-a")],
        [other.id, oauth("access-b", "refresh-b")],
      ]),
    })
    await setup(harness)
    const requestHook = hook(harness, "http.request")

    const first = new Request("https://api.example.test/coding/v1/chat/completions", {
      headers: { Authorization: "Bearer stale" },
    })
    await Effect.runPromise(requestHook({ request: first }))
    expect(first.headers.get("authorization")).toBe("Bearer access-a")

    active = other
    const switched = new Request("https://api.example.test/coding/v1/chat/completions", {
      headers: first.headers,
    })
    await Effect.runPromise(requestHook({ request: switched }))
    expect(switched.headers.get("authorization")).toBe("Bearer access-b")

    active = undefined
    const disconnected = new Request("https://api.example.test/coding/v1/chat/completions", {
      headers: switched.headers,
    })
    await Effect.runPromise(requestHook({ request: disconnected }))
    expect(disconnected.headers.get("authorization")).toBeNull()
  })
})

describe("/kimi-usage", () => {
  test("registers and displays real quota through a synthetic message without invoking an LLM", async () => {
    const send = mock(async (input: string | URL | Request) => {
      if (String(input).endsWith("/usages")) {
        return Response.json({
          limits: [
            {
              window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
              detail: { limit: "100", used: "25", remaining: "75", resetTime: "2026-11-14T15:00:00Z" },
            },
          ],
          usages: {
            limit_5h: { used_ratio: 0.25, reset_time: "2026-11-14T15:00:00Z" },
            limit_month_total: { used_ratio: 0.4, reset_time: "2026-12-01T00:00:00Z" },
          },
        })
      }
      return modelsResponse()
    })
    const harness = createHarness({ send })
    await setup(harness)

    await runCommand(harness, "kimi-usage")

    expect(harness.commands[0]?.description).toContain("without starting a model request")
    expect(harness.synthetics).toHaveLength(1)
    expect(harness.synthetics[0]).toMatchObject({
      sessionID: "ses_kimi_usage_test",
      description: "Kimi subscription quota",
      delivery: "queue",
      resume: false,
    })
    const text = String(harness.synthetics[0]?.text)
    expect(text).toContain("Used: 25% (25 / 100)")
    expect(text).toContain("Remaining: 75% (75)")
    expect(text).toContain("Monthly total")
    expect(text).toContain("Used: 40%")
    expect(harness.promptCalls()).toBe(0)
    expect(harness.generationCalls()).toBe(0)
    expect(send.mock.calls.filter(([input]) => String(input).endsWith("/usages"))).toHaveLength(1)
    expect(send.mock.calls.filter(([input]) => String(input).endsWith("/chat/completions"))).toHaveLength(0)
  })

  test("reports no active account without making network or model requests", async () => {
    const send = mock(async () => modelsResponse())
    const harness = createHarness({ active: () => undefined, send })
    await setup(harness)

    await runCommand(harness, "kimi-usage")

    expect(String(harness.synthetics[0]?.text)).toContain("No active Kimi subscription account")
    expect(harness.synthetics[0]?.resume).toBe(false)
    expect(send).not.toHaveBeenCalled()
    expect(harness.promptCalls()).toBe(0)
    expect(harness.generationCalls()).toBe(0)
  })

  test("renders sanitized HTTP errors and still avoids inference", async () => {
    const secret = "upstream-token-must-not-leak"
    const send = mock(async (input: string | URL | Request) => {
      if (String(input).endsWith("/usages")) return Response.json({ message: secret }, { status: 503 })
      return modelsResponse()
    })
    const harness = createHarness({ send })
    await setup(harness)

    await runCommand(harness, "kimi-usage")

    const text = String(harness.synthetics[0]?.text)
    expect(text).toContain("HTTP 503")
    expect(text).not.toContain(secret)
    expect(text).not.toContain("access-test")
    expect(harness.promptCalls()).toBe(0)
    expect(harness.generationCalls()).toBe(0)
  })
})
