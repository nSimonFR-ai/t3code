import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { IssueTrackerKind } from "@t3tools/contracts";
import * as LinearDriver from "@t3tools/issue-tracker-linear/server/driver";
import {
  type IssueTrackerError,
  isStandaloneIssueTracker,
  type IssueTrackerApi,
  type StandaloneIssueTrackerApi,
} from "@t3tools/source-control-core/server/IssueTracker";

import * as BuiltInDrivers from "../sourceControl/builtInDrivers.ts";
import * as IssueTrackerHostLive from "./IssueTrackerHostLive.ts";

/**
 * Runs each call of a standalone tracker with its target's workspace root in
 * `IssueTrackerCredentialProject`, so the tracker signs it with that project's own key.
 */
export function withProjectCredentials(
  tracker: StandaloneIssueTrackerApi,
): StandaloneIssueTrackerApi {
  const wrapped: Record<string, unknown> = { ...tracker };
  for (const [name, value] of Object.entries(tracker)) {
    if (typeof value !== "function") continue;
    wrapped[name] = (...args: Array<unknown>) => {
      const result = (value as (...a: Array<unknown>) => unknown).apply(tracker, args);
      const first = args[0] as { readonly cwd?: unknown } | null | undefined;
      const cwd = typeof first === "object" && first !== null ? first.cwd : undefined;
      if (typeof cwd !== "string" || !Effect.isEffect(result)) return result;
      // Every tracker method fails with IssueTrackerError; this only adds a service.
      return Effect.provideService(
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off unsafeEffectTypeAssertion:off
        result as Effect.Effect<unknown, IssueTrackerError>,
        IssueTrackerHostLive.IssueTrackerCredentialProject,
        cwd,
      );
    };
  }
  return wrapped as unknown as StandaloneIssueTrackerApi;
}

export class IssueTrackerRegistry extends Context.Service<
  IssueTrackerRegistry,
  {
    /** Null for a kind with no implementation, which the service reports as unsupported. */
    readonly get: (kind: IssueTrackerKind) => IssueTrackerApi | null;
    readonly kinds: ReadonlyArray<IssueTrackerKind>;
    /** The trackers a user connects with a credential of their own, in registration order. */
    readonly standalone: ReadonlyArray<StandaloneIssueTrackerApi>;
  }
>()("t3/issue/IssueTrackerRegistry") {}

/** Exported for tests, which stand a registry up from trackers they supply themselves. */
export function fromTrackers(
  trackers: ReadonlyArray<IssueTrackerApi>,
): IssueTrackerRegistry["Service"] {
  const byKind = new Map(trackers.map((tracker) => [tracker.kind, tracker]));
  return {
    get: (kind) => byKind.get(kind) ?? null,
    kinds: trackers.map((tracker) => tracker.kind),
    standalone: trackers.filter(isStandaloneIssueTracker),
  };
}

/** Trackers that are not a git host's own. Each signs requests with a credential from Settings. */
const STANDALONE_TRACKERS = [LinearDriver.make];

const make = Effect.gen(function* () {
  const drivers = yield* BuiltInDrivers.SourceControlDrivers;
  const standalone = (yield* Effect.all(STANDALONE_TRACKERS)).map(withProjectCredentials);
  return fromTrackers([...drivers.flatMap(({ instance }) => instance.issues ?? []), ...standalone]);
});

export const layer = Layer.effect(IssueTrackerRegistry, make).pipe(
  Layer.provide(Layer.merge(BuiltInDrivers.layer, IssueTrackerHostLive.layer)),
);
