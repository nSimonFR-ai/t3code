import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { IssueTrackerKind } from "@t3tools/contracts";
import * as IssueTrackerHost from "@t3tools/source-control-core/server/IssueTrackerHost";
import type { StandaloneIssueTrackerApi } from "@t3tools/source-control-core/server/IssueTracker";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as IssueTrackerHostLive from "./IssueTrackerHostLive.ts";
import { withProjectCredentials } from "./IssueTrackerRegistry.ts";

const encoder = new TextEncoder();
const LINEAR = "linear" as IssueTrackerKind;

const secretsLayer = (entries: Record<string, string>) =>
  Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    ServerSecretStore.ServerSecretStore.of({
      get: (name: string) =>
        Effect.succeed(
          name in entries ? Option.some(encoder.encode(entries[name])) : Option.none(),
        ),
    } as unknown as ServerSecretStore.ServerSecretStore["Service"]),
  );

const trackerReadingKey = Effect.gen(function* () {
  const host = yield* IssueTrackerHost.IssueTrackerHost;
  return {
    kind: "linear",
    getIssue: (_input: { readonly cwd: string }) =>
      host.credentials.get(LINEAR).pipe(Effect.map(Option.getOrElse(() => "none"))),
    parseIssueUrl: () => null,
  } as unknown as StandaloneIssueTrackerApi;
});

const keyFor = (cwd: string, entries: Record<string, string>) =>
  Effect.gen(function* () {
    const tracker = withProjectCredentials(yield* trackerReadingKey);
    return yield* (
      tracker.getIssue as unknown as (input: { readonly cwd: string }) => Effect.Effect<string>
    )({ cwd });
  }).pipe(Effect.provide(IssueTrackerHostLive.layer.pipe(Layer.provide(secretsLayer(entries)))));

it.effect("signs a project's calls with its own key, others with the shared one", () =>
  Effect.gen(function* () {
    const entries = {
      [IssueTrackerHostLive.issueTrackerSecretName(LINEAR)]: "shared-key",
      [IssueTrackerHostLive.issueTrackerProjectSecretName(LINEAR, "/work/perso")]: "perso-key",
    };
    expect(yield* keyFor("/work/perso", entries)).toBe("perso-key");
    expect(yield* keyFor("/work/trusk", entries)).toBe("shared-key");
  }),
);

it.effect("leaves non-Effect methods alone", () =>
  Effect.gen(function* () {
    const tracker = withProjectCredentials(yield* trackerReadingKey);
    expect(tracker.parseIssueUrl(new URL("https://linear.app/x/issue/A-1"))).toBeNull();
  }).pipe(Effect.provide(IssueTrackerHostLive.layer.pipe(Layer.provide(secretsLayer({}))))),
);
