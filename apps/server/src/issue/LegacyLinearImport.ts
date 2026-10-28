import { IssueTrackerKind, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as IssueTrackerConnections from "./IssueTrackerConnections.ts";

// Earlier nic-os fork Issues builds kept Linear tokens in this secret and project-to-team
// bindings under settings.json's issueTracking. This build stores neither there.
export const LEGACY_LINEAR_SECRET = "issue-trackers.linear.credentials";
// The bindings, copied out of settings.json before the settings service rewrites the file.
export const LEGACY_LINEAR_BINDINGS_SECRET = "issue-trackers.linear.legacy-bindings";

const LegacyCredentials = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    credentials: Schema.Array(Schema.Struct({ credentialId: Schema.String, token: Schema.String })),
  }),
);
const LegacyBindings = Schema.Record(
  Schema.String,
  Schema.NullOr(Schema.Struct({ credentialId: Schema.String, repository: Schema.String })),
);
const LegacyBindingsJson = Schema.fromJsonString(LegacyBindings);
const LegacySettings = Schema.fromJsonString(
  Schema.Struct({
    issueTracking: Schema.optional(
      Schema.Struct({
        connections: Schema.optional(
          Schema.Struct({
            linear: Schema.optional(
              Schema.Struct({ projectBindings: Schema.optional(LegacyBindings) }),
            ),
          }),
        ),
      }),
    ),
  }),
);

const decodeLegacyCredentials = Schema.decodeEffect(LegacyCredentials);
const decodeLegacyBindings = Schema.decodeEffect(LegacyBindingsJson);
const encodeLegacyBindings = Schema.encodeEffect(LegacyBindingsJson);
const decodeLegacySettings = Schema.decodeEffect(LegacySettings);

const linear = IssueTrackerKind.make("linear");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Called by the settings service with settings.json's raw text before it can rewrite the file:
 * keeps the old Linear bindings for importLegacyLinear while the old credentials await import.
 */
export const stashLegacyLinearBindings = Effect.fn("stashLegacyLinearBindings")(
  function* (rawSettings: string) {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    if (Option.isNone(yield* secrets.get(LEGACY_LINEAR_SECRET))) return;
    if (Option.isSome(yield* secrets.get(LEGACY_LINEAR_BINDINGS_SECRET))) return;
    const settings = yield* decodeLegacySettings(rawSettings);
    const bindings = settings.issueTracking?.connections?.linear?.projectBindings;
    if (bindings === undefined || Object.keys(bindings).length === 0) return;
    yield* secrets.set(
      LEGACY_LINEAR_BINDINGS_SECRET,
      encoder.encode(yield* encodeLegacyBindings(bindings)),
    );
  },
  Effect.catch((cause) =>
    Effect.logWarning("Legacy Linear bindings could not be kept").pipe(
      Effect.annotateLogs({ cause }),
    ),
  ),
);

/**
 * Reconnects the Linear accounts and project bindings an earlier fork build saved, once. The
 * old secrets are removed only after every account reconnects, so a failed run retries next start.
 */
export const importLegacyLinear = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const stored = yield* secrets.get(LEGACY_LINEAR_SECRET);
  if (Option.isNone(stored)) return;
  const { credentials } = yield* decodeLegacyCredentials(decoder.decode(stored.value));
  const connections = yield* IssueTrackerConnections.IssueTrackerConnections;

  const connectionIds = new Map<string, string>();
  // Old bindings name only the team key; this build scopes a team as `<workspace>/<team key>`.
  const scopeOf = new Map<string, (teamKey: string) => string | undefined>();
  for (const { credentialId, token } of credentials) {
    const connected = yield* connections
      .connect({ tracker: linear, addAccount: true, token: { value: token.trim() } })
      .pipe(Effect.option);
    if (Option.isNone(connected) || connected.value.connectionId === undefined) {
      yield* Effect.logWarning("Legacy Linear account could not be reconnected").pipe(
        Effect.annotateLogs({ credentialId }),
      );
      continue;
    }
    connectionIds.set(credentialId, connected.value.connectionId);
    const scopes = connected.value.scopes.map(({ key }) => key);
    const workspace = scopes[0]?.split("/")[0];
    scopeOf.set(
      credentialId,
      (teamKey) =>
        scopes.find((key) => key.toLowerCase().endsWith(`/${teamKey.toLowerCase()}`)) ??
        (workspace === undefined ? undefined : `${workspace}/${teamKey}`),
    );
  }

  const storedBindings = yield* secrets.get(LEGACY_LINEAR_BINDINGS_SECRET);
  const projectBindings = Option.isSome(storedBindings)
    ? yield* decodeLegacyBindings(decoder.decode(storedBindings.value))
    : {};
  for (const [projectId, binding] of Object.entries(projectBindings)) {
    const connectionId = binding && connectionIds.get(binding.credentialId);
    const scope = binding && scopeOf.get(binding.credentialId)?.(binding.repository);
    if (!binding || !connectionId || !scope) continue;
    yield* connections
      .bindProject({
        connectionId,
        tracker: linear,
        projectId: ProjectId.make(projectId),
        binding: { value: { connectionId, tracker: linear, scope } },
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Legacy Linear binding could not be restored").pipe(
            Effect.annotateLogs({ projectId, team: binding.repository, detail: error.detail }),
          ),
        ),
      );
  }

  if (connectionIds.size === credentials.length) {
    yield* secrets.remove(LEGACY_LINEAR_SECRET);
    yield* secrets.remove(LEGACY_LINEAR_BINDINGS_SECRET);
  }
  yield* Effect.log("Imported legacy Linear connections").pipe(
    Effect.annotateLogs({ accounts: connectionIds.size, of: credentials.length }),
  );
}).pipe(
  Effect.catch((cause) =>
    Effect.logWarning("Legacy Linear import failed").pipe(Effect.annotateLogs({ cause })),
  ),
  Effect.withSpan("importLegacyLinear"),
);
