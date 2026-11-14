import { Effect } from "effect"
import type { ConnectionInfo } from "@opencode/client"
import type { IntegrationDomain } from "@opencode/plugin/effect/integration"
import type { Fetch } from "./oauth.ts"
import { errorMessage } from "./internal.ts"

export interface RecoverUnauthorizedInput {
  readonly connection: ConnectionInfo
  readonly request: Request
  readonly response: Response
  readonly replay: Request | undefined
  readonly connections: Pick<IntegrationDomain["connection"], "resolve">
  readonly send: Fetch
}

export function recoverUnauthorized(input: RecoverUnauthorizedInput): Effect.Effect<Response, never> {
  if (input.response.status !== 401 && input.response.status !== 403) return Effect.succeed(input.response)
  if (!input.replay) return Effect.succeed(input.response)
  const authorization = input.request.headers.get("authorization")
  const rejectedAccess = authorization?.replace(/^Bearer\s+/i, "")
  if (!rejectedAccess) return Effect.succeed(input.response)

  return input.connections.resolve(input.connection).pipe(
    Effect.flatMap((credential) => {
      if (credential?.type !== "oauth" || credential.access === rejectedAccess) {
        return Effect.succeed(input.response)
      }
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
          Effect.logWarning("Kimi request retry with the current Core credential failed", {
            error: cause.message,
          }).pipe(Effect.as(input.response)),
        ),
      )
    }),
    Effect.catch((cause) =>
      Effect.logWarning("Kimi could not resolve the current Core credential after a rejected request", {
        error: errorMessage(cause),
      }).pipe(Effect.as(input.response)),
    ),
  )
}
