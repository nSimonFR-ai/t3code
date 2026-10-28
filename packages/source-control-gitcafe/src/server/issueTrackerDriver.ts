import { IssueTrackerKind } from "@t3tools/contracts";
import { defineIssueTrackerDriver } from "@t3tools/issue-tracker-core/server/driver";
import { withOwnServices } from "@t3tools/source-control-core/server/driver";

import { services } from "./driver.ts";
import * as GitCafeIssueTracker from "./GitCafeIssueTracker.ts";

export const driver = defineIssueTrackerDriver({
  kind: IssueTrackerKind.make("gitcafe"),
  // The tracker builds its own copy of the host clients the source control driver uses.
  make: withOwnServices(GitCafeIssueTracker.make, services),
});
