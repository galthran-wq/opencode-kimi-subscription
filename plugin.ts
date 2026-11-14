import { Effect, Stream } from "effect"
import { Plugin } from "@opencode/plugin/effect"
import type { ConnectionInfo } from "@opencode/client"
import {
  DEFAULT_API_BASE,
  DEFAULT_OAUTH_HOST,
  INTEGRATION_ID,
  MODEL_TTL_MS,
  PROVIDER_ID,
  STATIC_MODELS,
  errorMessage,
  isValidModelCache,
  providerInfo,
  stripTrailingSlashes,
  toModelInfo,
  type DiscoveredModel,
  type ModelCache,
} from "./internal.ts"
import { createOAuthClient, createOAuthMethod, fetchDiscoveredModels, type Fetch } from "./oauth.ts"
import { recoverUnauthorized } from "./recovery.ts"
import { fetchKimiUsage, formatKimiUsage, kimiUsageErrorMessage } from "./usage.ts"

export interface PluginDependencies {
  readonly fetch?: Fetch
  readonly oauthHost?: string
  readonly apiBase?: string
  readonly now?: () => number
}

export function createKimiPlugin(dependencies: PluginDependencies = {}) {
  const send = dependencies.fetch ?? fetch
  const oauthHost = stripTrailingSlashes(dependencies.oauthHost ?? DEFAULT_OAUTH_HOST)
  const apiBase = stripTrailingSlashes(dependencies.apiBase ?? DEFAULT_API_BASE)
  const now = dependencies.now ?? Date.now

  return Plugin.define({
    id: "kimi-subscription",
    effect: Effect.fn("KimiSubscription.setup")(function* (ctx) {
      const oauthClient = createOAuthClient(oauthHost, send)
      const oauth = createOAuthMethod({ client: oauthClient, now })

      const noAccount = "No active Kimi subscription account. Run /connect and sign in, then try /kimi-usage again."
      const usageText = Effect.gen(function* () {
        const connection = yield* ctx.integration.connection.active(INTEGRATION_ID)
        if (!connection) return noAccount
        const credential = yield* ctx.integration.connection.resolve(connection)
        if (credential?.type !== "oauth") return noAccount
        const report = yield* Effect.tryPromise({
          try: (signal) => fetchKimiUsage(apiBase, credential.access, send, signal),
          catch: (cause) => cause,
        })
        return formatKimiUsage(report)
      }).pipe(
        Effect.catch((cause) => Effect.succeed(`Kimi subscription usage\n\n${kimiUsageErrorMessage(cause)}`)),
      )
      yield* ctx.command.transform((editor) => {
        editor.add({
          name: "kimi-usage",
          description: "Show real Kimi subscription quota without starting a model request",
          execute: ({ sessionID }) =>
            usageText.pipe(
              Effect.flatMap((text) =>
                ctx.session.synthetic({
                  sessionID,
                  text,
                  description: "Kimi subscription quota",
                  delivery: "queue",
                  resume: false,
                }),
              ),
              Effect.asVoid,
            ),
        })
      })

      const storedCache = yield* ctx.storage.get("models")
      let cache: ModelCache | undefined = isValidModelCache(storedCache) ? storedCache : undefined
      const active = yield* ctx.integration.connection.active(INTEGRATION_ID)
      const source: {
        models: readonly DiscoveredModel[]
        connection: ConnectionInfo | undefined
      } = { models: cache?.models ?? STATIC_MODELS, connection: active }
      let syncing = false

      yield* ctx.integration.transform((editor) => {
        editor.update(INTEGRATION_ID, (integration) => {
          integration.name = "Kimi Code (subscription)"
        })
        editor.method.update(oauth)
      })

      yield* ctx.provider.transform((editor) => {
        editor.add({
          info: providerInfo(apiBase),
          models: source.models.map(toModelInfo),
          ...(source.connection ? { sourceConnection: source.connection } : {}),
        })
      })
      yield* ctx.model.transform((editor) => {
        for (const model of editor.list(PROVIDER_ID)) {
          editor.update(model.providerID, model.id, (draft) => {
            draft.body = { ...draft.body, temperature: 1 }
            draft.capabilities.temperature = false
            draft.cost = []
          })
        }
      })

      const publishConnection = (connection: ConnectionInfo | undefined) => {
        source.connection = connection
        return ctx.provider.reload()
      }

      const syncModels = (force: boolean): Effect.Effect<void, never> =>
        Effect.suspend(() => {
          if (syncing) return Effect.void
          if (!force && cache && now() - cache.ts < MODEL_TTL_MS) return Effect.void
          syncing = true
          return Effect.gen(function* () {
            const connection = yield* ctx.integration.connection.active(INTEGRATION_ID)
            if (!connection) {
              source.models = STATIC_MODELS
              yield* publishConnection(undefined)
              return
            }
            yield* publishConnection(connection)
            const credential = yield* ctx.integration.connection.resolve(connection)
            if (credential?.type !== "oauth") return
            const models = yield* Effect.tryPromise({
              try: (signal) => fetchDiscoveredModels(apiBase, credential.access, send, signal),
              catch: (cause) => new Error(errorMessage(cause)),
            })
            if (models.length === 0) return yield* Effect.fail(new Error("Kimi /models returned an empty inventory"))
            cache = { ts: now(), models }
            const durable = JSON.parse(JSON.stringify(cache)) as ModelCache
            yield* ctx.storage.set("models", durable)
            source.models = models
            yield* ctx.provider.reload()
            yield* Effect.logDebug("Kimi model inventory refreshed", { count: models.length })
          }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Kimi model inventory refresh failed; keeping cached models", {
                error: errorMessage(cause),
              }),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                syncing = false
              }),
            ),
          )
        })

      yield* ctx.event.subscribe({ types: ["credential.switched"] }).pipe(
        Stream.filter((event) => event.data.integrationID === INTEGRATION_ID),
        Stream.runForEach(() => syncModels(true)),
        Effect.forkScoped,
      )
      yield* Effect.sleep(MODEL_TTL_MS).pipe(Effect.andThen(syncModels(false)), Effect.forever, Effect.forkScoped)
      yield* syncModels(false)

      for (const name of ["context", "compaction", "generate", "title"] as const) {
        yield* ctx.session.hook(
          name,
          (event) =>
            Effect.sync(() => {
              event.options.temperature = 1
            }),
          { providerID: PROVIDER_ID },
        )
      }

      const replays = new WeakMap<Request, Request>()
      yield* ctx.session.hook(
        "http.request",
        (event) =>
          Effect.gen(function* () {
            const connection = yield* ctx.integration.connection.active(INTEGRATION_ID)
            const credential = connection ? yield* ctx.integration.connection.resolve(connection) : undefined
            event.request.headers.delete("x-api-key")
            if (credential?.type !== "oauth") {
              event.request.headers.delete("authorization")
              replays.delete(event.request)
              return
            }
            event.request.headers.set("authorization", `Bearer ${credential.access}`)
            replays.set(event.request, event.request.clone())
          }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Kimi could not prepare the authenticated request", { error: errorMessage(cause) }),
            ),
          ),
        { providerID: PROVIDER_ID },
      )
      yield* ctx.session.hook(
        "http.response",
        (event) =>
          Effect.gen(function* () {
            const replay = replays.get(event.request)
            replays.delete(event.request)
            if (event.response.status !== 401 && event.response.status !== 403) return
            const connection = yield* ctx.integration.connection.active(INTEGRATION_ID)
            if (!connection) return
            event.response = yield* recoverUnauthorized({
              connection,
              request: event.request,
              response: event.response,
              replay,
              connections: ctx.integration.connection,
              send,
            })
          }),
        { providerID: PROVIDER_ID },
      )
      yield* Effect.logInfo("Kimi subscription plugin ready")
    }),
  })
}

