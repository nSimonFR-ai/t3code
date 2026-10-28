import * as AzureDevOpsIssueTrackerDriver from "@t3tools/source-control-azure-devops/server/issueTrackerDriver";
import * as ForgejoIssueTrackerDriver from "@t3tools/source-control-forgejo/server/issueTrackerDriver";
import * as GitCafeIssueTrackerDriver from "@t3tools/source-control-gitcafe/server/issueTrackerDriver";
import * as GitHubIssueTrackerDriver from "@t3tools/source-control-github/server/issueTrackerDriver";
import * as GitLabIssueTrackerDriver from "@t3tools/source-control-gitlab/server/issueTrackerDriver";
import type {
  SourceControlDriver,
  SourceControlDriverInstance,
} from "@t3tools/source-control-core/server/driver";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSourceControlHost from "./ServerSourceControlHost.ts";
import { BUILT_IN_SOURCE_CONTROL_DRIVER_LIST } from "./sourceControlDefinitions.ts";

export interface SourceControlDriverEntry {
  readonly driver: Pick<SourceControlDriver, "kind" | "definition">;
  readonly instance: SourceControlDriverInstance;
}

/** Every driver's instance, in registry order. Everything that reads a host reads it here. */
export class SourceControlDrivers extends Context.Service<
  SourceControlDrivers,
  ReadonlyArray<SourceControlDriverEntry>
>()("t3/sourceControl/builtInDrivers/SourceControlDrivers") {}

// Git hosts whose issue tracker shares the host's rate limit with its other readers.
const hostIssueDrivers = [
  { issues: GitHubIssueTrackerDriver.driver, sharedIssueLimits: false },
  { issues: GitLabIssueTrackerDriver.driver, sharedIssueLimits: true },
  { issues: AzureDevOpsIssueTrackerDriver.driver, sharedIssueLimits: true },
  { issues: ForgejoIssueTrackerDriver.driver, sharedIssueLimits: true },
  { issues: GitCafeIssueTrackerDriver.driver, sharedIssueLimits: true },
];

export const BUILT_IN_GIT_HOST_ISSUE_DRIVERS = hostIssueDrivers.map(({ issues }) => issues);

export const SHARED_ISSUE_RATE_LIMIT_KINDS = new Set(
  hostIssueDrivers.flatMap(({ issues, sharedIssueLimits }) =>
    sharedIssueLimits ? [issues.kind] : [],
  ),
);

const make = Effect.forEach(BUILT_IN_SOURCE_CONTROL_DRIVER_LIST, (driver) =>
  driver.make.pipe(Effect.map((instance) => ({ driver, instance }))),
);

export const layer = Layer.effect(SourceControlDrivers, make).pipe(
  Layer.provideMerge(ServerSourceControlHost.layer),
  Layer.provideMerge(SourceControlRateLimit.layer),
);
