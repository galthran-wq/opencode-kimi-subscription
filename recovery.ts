import { Effect, Semaphore } from "effect"
import { Credential } from "@opencode/plugin/effect"
import type { ConnectionInfo } from "@opencode/client"
import type { IntegrationDomain } from "@opencode/plugin/effect/integration"
import type { StorageDomain } from "@opencode/plugin/effect/storage"
import type { Fetch } from "./oauth.ts"
import { INTEGRATION_ID, METHOD_ID, REFRESH_SKEW_MS, errorMessage } from "./internal.ts"

export type OAuthRefresh = (credential: Credential.OAuth) => Effect.Effect<Credential.OAuth, unknown>

export interface PluginCredentialStore {
  readonly get: (connection: ConnectionInfo) => Effect.Effect<Credential.OAuth | undefined, Error>
  readonly forceRefresh: (
    connection: ConnectionInfo,
    rejectedAccess: string,
  ) => Effect.Effect<Credential.OAuth | undefined, Error>
  readonly adopt: (connection: ConnectionInfo, credential: Credential.OAuth) => Effect.Effect<void, Error>
}

export interface PluginCredentialStoreOptions {
  readonly storage: Pick<StorageDomain, "get" | "set">
  readonly connections: Pick<IntegrationDomain["connection"], "active" | "resolve">
  readonly refresh: OAuthRefresh
  readonly now?: () => number
}

const storageKey = (connectionID: string) => `oauth/${encodeURIComponent(connectionID)}`

function storedCredential(value: unknown, connectionID: string): Credential.OAuth | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const stored = value as { connectionID?: unknown; credential?: unknown }
  if (stored.connectionID !== connectionID || typeof stored.credential !== "object" || stored.credential === null) {
    return undefined
  }
  const candidate = stored.credential as {
    type?: unknown
    methodID?: unknown
    access?: unknown
    refresh?: unknown
    expires?: unknown
    metadata?: unknown
  }
  if (
    candidate.type !== "oauth" ||
    candidate.methodID !== METHOD_ID ||
    typeof candidate.access !== "string" ||
    !candidate.access ||
    typeof candidate.refresh !== "string" ||
    !candidate.refresh ||
    typeof candidate.expires !== "number" ||
    !Number.isInteger(candidate.expires)
  ) {
    return undefined
  }
  const metadata =
    typeof candidate.metadata === "object" && candidate.metadata !== null && !Array.isArray(candidate.metadata)
      ? (candidate.metadata as Readonly<Record<string, unknown>>)
      : undefined
  return Credential.OAuth.make({
    type: "oauth",
    methodID: METHOD_ID,
    access: candidate.access,
    refresh: candidate.refresh,
    expires: candidate.expires,
    ...(metadata === undefined ? {} : { metadata }),
  })
}

export function createPluginCredentialStore(options: PluginCredentialStoreOptions): PluginCredentialStore {
  const now = options.now ?? Date.now
  const cache = new Map<string, Credential.OAuth>()
  const lock = Semaphore.makeUnsafe(1)

  const save = (connection: ConnectionInfo, credential: Credential.OAuth): Effect.Effect<void, Error> => {
    if (connection.type !== "credential" || connection.method !== "oauth") return Effect.void
    return Effect.try({
      try: () => JSON.parse(JSON.stringify({ connectionID: connection.id, credential })),
      catch: () => new Error("Kimi credential could not be serialized"),
    }).pipe(
      Effect.flatMap((value) => options.storage.set(storageKey(connection.id), value)),
      Effect.map(() => {
        cache.set(connection.id, credential)
      }),
    )
  }

  const read = (connection: ConnectionInfo): Effect.Effect<Credential.OAuth | undefined, Error> => {
    if (connection.type !== "credential" || connection.method !== "oauth") return Effect.succeed(undefined)
    const cached = cache.get(connection.id)
    if (cached) return Effect.succeed(cached)
    return Effect.gen(function* () {
      const stored = yield* options.storage.get(storageKey(connection.id))
      const credential = storedCredential(stored, connection.id)
      if (credential) {
        cache.set(connection.id, credential)
        return credential
      }
      const resolved = yield* options.connections.resolve(connection)
      if (resolved?.type !== "oauth") return undefined
      yield* save(connection, resolved)
      return resolved
    }).pipe(Effect.mapError((cause) => new Error(`Kimi credential resolution failed: ${errorMessage(cause)}`)))
  }

  const isActive = (connection: ConnectionInfo) =>
    options.connections.active(INTEGRATION_ID).pipe(
      Effect.map((active) =>
        connection.type === "credential" && active?.type === "credential" ? active.id === connection.id : false,
      ),
    )

  const rotate = (
    connection: ConnectionInfo,
    rejectedAccess: string | undefined,
  ): Effect.Effect<Credential.OAuth | undefined, Error> =>
    lock.withPermit(
      Effect.gen(function* () {
        if (!(yield* isActive(connection))) return undefined
        const current = yield* read(connection)
        if (!current) return undefined
        if (rejectedAccess !== undefined && current.access !== rejectedAccess) return current
        if (rejectedAccess === undefined && current.expires - now() > REFRESH_SKEW_MS) return current
        const next = yield* options.refresh(current)
        yield* save(connection, next)
        if (!(yield* isActive(connection))) return undefined
        return next
      }),
    ).pipe(Effect.mapError((cause) => new Error(`Kimi token refresh failed: ${errorMessage(cause)}`)))

  return {
    get: (connection) =>
      isActive(connection).pipe(
        Effect.flatMap((active) => {
          if (!active) return Effect.succeed(undefined)
          return read(connection).pipe(
            Effect.flatMap((credential) => {
              if (!credential || credential.expires - now() > REFRESH_SKEW_MS) return Effect.succeed(credential)
              return rotate(connection, undefined)
            }),
          )
        }),
      ),
    forceRefresh: (connection, rejectedAccess) => rotate(connection, rejectedAccess),
    adopt: save,
  }
}

export interface RecoverUnauthorizedInput {
  readonly connection: ConnectionInfo
  readonly request: Request
  readonly response: Response
  readonly replay: Request | undefined
  readonly store: Pick<PluginCredentialStore, "forceRefresh">
  readonly send: Fetch
}

export function recoverUnauthorized(input: RecoverUnauthorizedInput): Effect.Effect<Response, never> {
  if (input.response.status !== 401 && input.response.status !== 403) return Effect.succeed(input.response)
  if (!input.replay) return Effect.succeed(input.response)
  const authorization = input.request.headers.get("authorization")
  const rejectedAccess = authorization?.replace(/^Bearer\s+/i, "")
  if (!rejectedAccess) return Effect.succeed(input.response)

  return input.store.forceRefresh(input.connection, rejectedAccess).pipe(
    Effect.flatMap((credential) => {
      if (!credential) return Effect.succeed(input.response)
      return Effect.try({
        try: () => {
          const headers = new Headers(input.replay!.headers)
          headers.set("authorization", `Bearer ${credential.access}`)
          headers.delete("x-api-key")
          return new Request(input.replay!, { headers })
        },
        catch: (cause) => new Error(errorMessage(cause)),
      }).pipe(
        Effect.flatMap((request) =>
          Effect.tryPromise({
            try: (signal) => input.send(request, { signal }),
            catch: (cause) => new Error(`Kimi retry failed: ${errorMessage(cause)}`),
          }),
        ),
        Effect.map((response) => {
          void input.response.body?.cancel()
          return response
        }),
        Effect.catch((cause) =>
          Effect.logWarning("Kimi request retry after token refresh failed", { error: cause.message }).pipe(
            Effect.as(input.response),
          ),
        ),
      )
    }),
    Effect.catch((cause) =>
      Effect.logWarning("Kimi token refresh after rejected request failed", { error: cause.message }).pipe(
        Effect.as(input.response),
      ),
    ),
  )
}
