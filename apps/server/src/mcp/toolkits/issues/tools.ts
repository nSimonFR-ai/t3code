import {
  IssueOperationError,
  IssueProviderKind,
  IssueUnavailableError,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  PositiveInt,
  PullRequestOperationError,
  PullRequestUnavailableError,
  ThreadIssueLink,
  TrimmedNonEmptyString,
  WorkItemLink,
  WorkItemLinkError,
  WorkItemLinksResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as IssueService from "../../../issue/IssueService.ts";
import * as PullRequestService from "../../../pullRequest/PullRequestService.ts";
import * as WorkItemLinks from "../../../workItems/WorkItemLinks.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const IssueTargetInput = Schema.Struct({
  repository: TrimmedNonEmptyString.annotate({
    description:
      "Where the issue lives: owner/name (or the host's full project path) for a Git host, or the team key for Linear, the letters before the dash in an identifier such as CO in CO-130.",
  }),
  number: PositiveInt.annotate({
    description: "Issue number; for Linear, the digits after the dash, such as 130 in CO-130.",
  }),
  provider: Schema.optional(
    IssueProviderKind.annotate({
      description:
        "Issue tracker. Defaults to the project's own. Pass linear for a Linear issue: it can be read and linked from any project while a connected Linear account can see its team.",
    }),
  ),
  url: Schema.optional(TrimmedNonEmptyString),
});

export class IssueThreadNotFoundError extends Schema.TaggedError<IssueThreadNotFoundError>()(
  "IssueThreadNotFoundError",
  { threadId: Schema.String },
) {}

export class IssueThreadLinkFailedError extends Schema.TaggedError<IssueThreadLinkFailedError>()(
  "IssueThreadLinkFailedError",
  { cause: Schema.Defect() },
) {}

export const IssueToolError = Schema.Union([
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  IssueUnavailableError,
  IssueOperationError,
  IssueThreadNotFoundError,
  IssueThreadLinkFailedError,
  WorkItemLinkError,
  PullRequestOperationError,
  PullRequestUnavailableError,
]);

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  Orchestrator.OrchestratorV2,
  IssueService.IssueService,
];

const ReadIssueTool = Tool.make("read_issue", {
  description:
    "Read an issue body and bounded pages of comments, history, and linked pull requests as Markdown. Linked issues use their saved project and host; references without a URL use this thread's project. Pass repository, number, and provider when needed; a Linear issue CO-130 is repository CO, number 130, provider linear, and can be read from any project while a connected Linear account sees its team. Pass a full issue URL to read another repository with existing server credentials, or choose between linked issues on different hosts. Pass nextCommentsCursor as commentsCursor, nextEventsCursor as eventsCursor, or nextLinkedPullRequestsCursor as linkedPullRequestsCursor to read that next page. Pass at most one cursor per call. Continuations return only the requested section. A section's truncated=true with a null cursor means this host cannot return the rest through T3.",
  parameters: Schema.Struct({
    ...IssueTargetInput.fields,
    commentsCursor: Schema.optional(TrimmedNonEmptyString),
    eventsCursor: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(16_384))),
    linkedPullRequestsCursor: Schema.optional(
      TrimmedNonEmptyString.check(Schema.isMaxLength(16_384)),
    ),
  }),
  success: Schema.Struct({
    markdown: Schema.String,
    commentsTruncated: Schema.Boolean,
    nextCommentsCursor: Schema.NullOr(TrimmedNonEmptyString),
    eventsTruncated: Schema.optional(Schema.Boolean),
    nextEventsCursor: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
    linkedPullRequestsTruncated: Schema.optional(Schema.Boolean),
    nextLinkedPullRequestsCursor: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  }),
  failure: IssueToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read issue")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const LinkIssueTool = Tool.make("link_issue", {
  description:
    "Link an issue to this thread. References without a URL use this thread's project, except a Linear issue: pass its team key as repository (CO for CO-130), its number, and provider linear, and it links from any project while a connected Linear account sees its team. Use after taking work on an issue. Pass a full issue URL to link another repository with existing server credentials. The link appears with the thread and its pull requests. Linking the same issue again succeeds with alreadyLinked=true.",
  parameters: IssueTargetInput,
  success: Schema.Struct({ issue: ThreadIssueLink, alreadyLinked: Schema.Boolean }),
  failure: IssueToolError,
  dependencies,
})
  .annotate(Tool.Title, "Link issue to thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const UnlinkIssueTool = Tool.make("unlink_issue", {
  description:
    "Remove an issue link from this thread. Pass its URL when the same repository and number are linked from more than one host. The issue itself stays unchanged. Unlinking an issue that is not linked succeeds with wasLinked=false.",
  parameters: Schema.Struct({
    ...IssueTargetInput.fields,
    url: Schema.optional(TrimmedNonEmptyString),
  }),
  success: Schema.Struct({ wasLinked: Schema.Boolean }),
  failure: IssueToolError,
  dependencies,
})
  .annotate(Tool.Title, "Unlink issue from thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ListThreadIssuesTool = Tool.make("list_thread_issues", {
  description: "List issues linked to this thread.",
  success: Schema.Struct({ issues: Schema.Array(ThreadIssueLink) }),
  failure: IssueToolError,
  dependencies,
})
  .annotate(Tool.Title, "List thread issues")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const PullRequestTargetInput = Schema.Struct({
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  host: Schema.optional(TrimmedNonEmptyString),
});

const IssuePullRequestTargetInput = Schema.Struct({
  issue: IssueTargetInput,
  pullRequest: PullRequestTargetInput,
});

const linkDependencies = [
  ...dependencies,
  PullRequestService.PullRequestService,
  WorkItemLinks.WorkItemLinks,
];

const LinkIssueToPullRequestTool = Tool.make("link_issue_to_pull_request", {
  description:
    "Save a local link between an issue and pull request. Both references use this thread's project. This does not edit either host item.",
  parameters: IssuePullRequestTargetInput,
  success: WorkItemLink,
  failure: IssueToolError,
  dependencies: linkDependencies,
})
  .annotate(Tool.Title, "Link issue to pull request")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const UnlinkIssueFromPullRequestTool = Tool.make("unlink_issue_from_pull_request", {
  description:
    "Remove a saved local issue and pull request link. Both references must still be readable from this thread's project. Neither host item is changed.",
  parameters: IssuePullRequestTargetInput,
  success: Schema.Void,
  failure: IssueToolError,
  dependencies: linkDependencies,
})
  .annotate(Tool.Title, "Unlink issue from pull request")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ListIssuePullRequestLinksTool = Tool.make("list_issue_pull_request_links", {
  description:
    "List saved local issue and pull request links for an item readable from this thread's project.",
  parameters: Schema.Struct({
    source: Schema.Struct({
      kind: Schema.Literals(["issue", "pull-request"]),
      repository: TrimmedNonEmptyString,
      number: PositiveInt,
      provider: Schema.optional(IssueProviderKind),
      host: Schema.optional(TrimmedNonEmptyString),
    }),
  }),
  success: WorkItemLinksResult,
  failure: IssueToolError,
  dependencies: linkDependencies,
})
  .annotate(Tool.Title, "List issue and pull request links")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const IssuesToolkit = Toolkit.make(
  ReadIssueTool,
  LinkIssueTool,
  UnlinkIssueTool,
  ListThreadIssuesTool,
  LinkIssueToPullRequestTool,
  UnlinkIssueFromPullRequestTool,
  ListIssuePullRequestLinksTool,
);
