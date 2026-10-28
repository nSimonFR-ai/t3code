import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type IssueTrackerBindProjectInput,
  type IssueTrackerConnectInput,
  type IssueTrackerConnection,
  IssueTrackerConnectionError,
  IssueTrackerKind,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as IssueTrackerConnections from "./IssueTrackerConnections.ts";
import {
  importLegacyLinear,
  LEGACY_LINEAR_BINDINGS_SECRET,
  LEGACY_LINEAR_SECRET,
  stashLegacyLinearBindings,
} from "./LegacyLinearImport.ts";

const linear = IssueTrackerKind.make("linear");

const layerBase = ServerSecretStore.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-legacy-linear-" })),
  Layer.provideMerge(NodeServices.layer),
);

const seed = Effect.fnUntraced(function* (tokens: ReadonlyArray<string>) {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  yield* secrets.set(
    LEGACY_LINEAR_SECRET,
    new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        credentials: tokens.map((token, index) => ({ credentialId: `old-${index}`, token })),
      }),
    ),
  );
  yield* stashLegacyLinearBindings(
    JSON.stringify({
      issueTracking: {
        connections: {
          linear: {
            projectBindings: {
              "project-a": { credentialId: "old-0", repository: "NSI" },
              "project-b": { credentialId: "old-1", repository: "CO" },
              "project-c": null,
            },
          },
        },
      },
    }),
  );
});

const run = (rejectedTokens: ReadonlySet<string>) =>
  Effect.gen(function* () {
    const connects: Array<IssueTrackerConnectInput> = [];
    const binds: Array<IssueTrackerBindProjectInput> = [];
    yield* importLegacyLinear.pipe(
      Effect.provideService(IssueTrackerConnections.IssueTrackerConnections, {
        list: Effect.die("unused"),
        listScopes: () => Effect.die("unused"),
        connect: (input) => {
          connects.push(input);
          const token = (input.token as { value: string }).value;
          return rejectedTokens.has(token)
            ? Effect.fail(
                new IssueTrackerConnectionError({
                  tracker: input.tracker,
                  reason: "rejected",
                  detail: "rejected",
                }),
              )
            : Effect.succeed({
                connectionId: `new-${token}`,
                // tok-a lists its team; tok-b only reveals its workspace through another team.
                scopes:
                  token === "tok-a"
                    ? [{ key: "trusk/nsi", name: "NSI" }]
                    : [{ key: "acme/OPS", name: "Ops" }],
              } as unknown as IssueTrackerConnection);
        },
        bindProject: (input) => Effect.sync(() => void binds.push(input)),
      }),
    );
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    return {
      connects,
      binds,
      secret: yield* secrets.get(LEGACY_LINEAR_SECRET),
      bindingsSecret: yield* secrets.get(LEGACY_LINEAR_BINDINGS_SECRET),
    };
  });

describe("importLegacyLinear", () => {
  it.effect("reconnects each account, rebinds its projects, then retires the old secret", () =>
    Effect.gen(function* () {
      yield* seed(["tok-a", "tok-b"]);
      const { connects, binds, secret, bindingsSecret } = yield* run(new Set());
      assert.deepStrictEqual(
        connects.map((input) => input.addAccount),
        [true, true],
      );
      assert.deepStrictEqual(
        binds.map((input) => [input.projectId, input.connectionId, input.binding]),
        [
          [
            "project-a",
            "new-tok-a",
            { value: { connectionId: "new-tok-a", tracker: linear, scope: "trusk/nsi" } },
          ],
          [
            "project-b",
            "new-tok-b",
            { value: { connectionId: "new-tok-b", tracker: linear, scope: "acme/CO" } },
          ],
        ],
      );
      assert.isTrue(Option.isNone(secret));
      assert.isTrue(Option.isNone(bindingsSecret));
      // A second start finds nothing left to import.
      assert.deepStrictEqual((yield* run(new Set())).connects, []);
    }).pipe(Effect.provide(layerBase)),
  );

  it.effect("keeps the old secret when an account can't reconnect, so the next start retries", () =>
    Effect.gen(function* () {
      yield* seed(["tok-a", "tok-b"]);
      const { binds, secret, bindingsSecret } = yield* run(new Set(["tok-b"]));
      assert.deepStrictEqual(
        binds.map((input) => input.projectId),
        ["project-a"],
      );
      assert.isTrue(Option.isSome(secret));
      assert.isTrue(Option.isSome(bindingsSecret));
    }).pipe(Effect.provide(layerBase)),
  );
});
