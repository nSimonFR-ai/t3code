/**
 * Standalone tracker credentials from the secret store, one per tracker kind (stable names).
 * Fork: a key saved for a project's workspace root wins over the shared one.
 *
 * @module issue/IssueTrackerHostLive
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { IssueTrackerKind } from "@t3tools/contracts";
import { IssueTrackerError } from "@t3tools/source-control-core/server/IssueTracker";
import * as IssueTrackerHost from "@t3tools/source-control-core/server/IssueTrackerHost";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export function issueTrackerSecretName(tracker: IssueTrackerKind): string {
  return `issue-tracker-${Buffer.from(tracker, "utf8").toString("base64url")}-token`;
}

/** The workspace root of the project a tracker call serves, if any. */
export const IssueTrackerCredentialProject = Context.Reference<string | undefined>(
  "t3/issue/IssueTrackerCredentialProject",
  { defaultValue: () => undefined },
);

/** A project's own key, named after its workspace root (base64url, so no path separators). */
export function issueTrackerProjectSecretName(
  tracker: IssueTrackerKind,
  workspaceRoot: string,
): string {
  const encode = (value: string) => Buffer.from(value, "utf8").toString("base64url");
  return `issue-tracker-${encode(tracker)}-project-${encode(workspaceRoot)}-token`;
}

const decoder = new TextDecoder();

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const readCredential = Effect.fn("IssueTrackerHost.readCredential")(function* (
    tracker: IssueTrackerKind,
  ) {
    const project = yield* IssueTrackerCredentialProject;
    const own =
      project === undefined
        ? Option.none<Uint8Array>()
        : yield* secrets.get(issueTrackerProjectSecretName(tracker, project));
    return Option.isSome(own) ? own : yield* secrets.get(issueTrackerSecretName(tracker));
  });
  return IssueTrackerHost.IssueTrackerHost.of({
    credentials: {
      get: (tracker) =>
        readCredential(tracker).pipe(
          Effect.map(Option.map((bytes) => decoder.decode(bytes))),
          Effect.mapError(
            (cause) =>
              new IssueTrackerError({
                tracker,
                operation: "readCredential",
                reason: "failed",
                detail: "The stored credential could not be read.",
                cause,
              }),
          ),
        ),
    },
  });
});

export const layer = Layer.effect(IssueTrackerHost.IssueTrackerHost, make);
