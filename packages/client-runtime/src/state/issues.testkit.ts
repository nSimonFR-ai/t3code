import type {
  AuthEnvironmentScopes,
  AuthSessionState,
  EnvironmentId,
  IssueListInput,
  IssueListResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { createIssueEnvironmentAtoms, issueEntryKey, refreshIssueListPage } from "./issues.ts";

const createIssueTestRuntime = () => {
  const supervisor = {} as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
  return Atom.runtime(
    Layer.succeed(
      EnvironmentRegistry.EnvironmentRegistry,
      EnvironmentRegistry.EnvironmentRegistry.of({
        run: (_id, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
    ),
  );
};

export const makeIssueTestRuntime = Effect.gen(function* () {
  const supervisor = {
    state: yield* SubscriptionRef.make({ phase: "connected" }),
    session: yield* SubscriptionRef.make(Option.some({})),
  } as unknown as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
  return Atom.runtime(
    Layer.succeed(
      EnvironmentRegistry.EnvironmentRegistry,
      EnvironmentRegistry.EnvironmentRegistry.of({
        run: (_id, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        followStream: (_id, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
    ),
  );
});

export const createIssueTestContext = (runtime = createIssueTestRuntime()) => {
  const registry = AtomRegistry.make();
  const atoms = createIssueEnvironmentAtoms(runtime);
  const readListPage = async (environmentId: EnvironmentId, input: IssueListInput) => {
    const result = await atoms.listPage.run(registry, { environmentId, input });
    if (result._tag !== "Success") throw new Error("list read failed");
    return result.value;
  };
  return { registry, atoms, readListPage };
};

type IssueTestPage = Parameters<typeof refreshIssueListPage>[1];

export const issueTestPage = (
  entries: IssueListResult["entries"],
  nextCursors: IssueListResult["nextCursors"] = {},
): IssueTestPage => ({ entries, nextCursors, errors: [] });

export const issueTestHeld = (
  entries: IssueListResult["entries"],
  nextCursors: IssueListResult["nextCursors"] = {},
  fields: Partial<Omit<Parameters<typeof refreshIssueListPage>[0], "entries" | "nextCursors">> = {},
) => ({
  entries,
  nextCursors,
  firstCursors: nextCursors,
  firstKeys: new Set(entries.map(issueEntryKey)) as ReadonlySet<string>,
  errors: [] as IssueListResult["errors"],
  ...fields,
});

export const makeIssueTestSession = (...scopes: AuthEnvironmentScopes): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes,
  permissions: [...scopes],
});
