/**
 * The GitLab issue tracker driver, registered beside the source control driver so the server's
 * issue registry can list it without knowing the package.
 *
 * @module source-control-gitlab/server/issueTrackerDriver
 */
import { IssueTrackerKind } from "@t3tools/contracts";
import { defineIssueTrackerDriver } from "@t3tools/issue-tracker-core/server/driver";
import { withOwnServices } from "@t3tools/source-control-core/server/driver";

import { services } from "./driver.ts";
import * as GitLabIssueTracker from "./GitLabIssueTracker.ts";

export const driver = defineIssueTrackerDriver({
  kind: IssueTrackerKind.make("gitlab"),
  // The tracker builds its own copy of the host clients the source control driver uses.
  make: withOwnServices(GitLabIssueTracker.make, services),
});
