import type {
  IssueTrackerProjectBinding,
  OrchestrationProjectShell,
  ProjectId,
} from "@t3tools/contracts";
import type { IssueTrackerApi } from "@t3tools/issue-tracker-core/server/IssueTracker";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as IssueTrackerBindings from "../persistence/IssueTrackerBindings.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as IssueService from "./IssueService.ts";
import * as IssueTrackerRegistry from "./IssueTrackerRegistry.ts";

export const issueCryptoLayer = (randomBytes: (size: number) => Uint8Array) =>
  Layer.succeed(
    Crypto.Crypto,
    Crypto.make({ randomBytes, digest: (_algorithm, data) => Effect.succeed(data) }),
  );

export const makeIssueService = (input: {
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly trackers: ReadonlyArray<IssueTrackerApi>;
  readonly bindings?: Effect.Effect<
    ReadonlyMap<ProjectId, ReadonlyArray<IssueTrackerProjectBinding>>
  >;
  readonly getShell?: ProjectService.ProjectService["Service"]["getShell"];
  readonly resolveRepository?: RepositoryIdentityResolver.RepositoryIdentityResolver["Service"]["resolve"];
}) =>
  IssueService.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(IssueTrackerBindings.IssueTrackerBindingsRepository)({
          list: input.bindings ?? Effect.succeed(new Map()),
        }),
        Layer.succeed(
          IssueTrackerRegistry.IssueTrackerRegistry,
          IssueTrackerRegistry.fromTrackers(input.trackers),
        ),
        Layer.mock(ProjectService.ProjectService)({
          listShells: () => Effect.succeed(input.projects),
          getShell:
            input.getShell ??
            ((id) =>
              Effect.succeed(
                Option.fromNullishOr(input.projects.find((project) => project.id === id)),
              )),
        }),
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve:
            input.resolveRepository ??
            ((cwd) =>
              Effect.succeed(
                input.projects.find((project) => project.workspaceRoot === cwd)
                  ?.repositoryIdentity ?? null,
              )),
        }),
      ),
    ),
  );
