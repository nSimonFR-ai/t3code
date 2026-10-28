import {
  type IssueDetail,
  type IssueSummary,
  type IssueRef,
  type IssueTrackerKind,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as IssueService from "../../../issue/IssueService.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadIssueService from "../../../orchestration-v2/ThreadIssueService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  IssuesToolkit,
  type IssueTargetInput,
  IssueThreadRequiredError,
  type ListThreadIssuesResult,
} from "./tools.ts";

function listThreadIssues(
  thread: Pick<OrchestrationV2ThreadShell, "issues">,
): ListThreadIssuesResult {
  return {
    issues: (thread.issues ?? []).map((link) => ({
      projectId: link.projectId,
      tracker: link.tracker,
      ...(link.connectionId === undefined ? {} : { connectionId: link.connectionId }),
      host: link.host,
      scope: link.scope,
      key: link.key,
      url: link.url,
      source: link.source,
      displayKey: link.snapshot?.displayKey ?? null,
      title: link.snapshot?.title ?? null,
      state: link.snapshot?.state ?? null,
    })),
  };
}

function summaryFields(issue: IssueSummary) {
  return {
    ...(issue.itemType === undefined ? {} : { itemType: issue.itemType }),
    displayKey: issue.displayKey,
    title: issue.title,
    state: issue.state,
    author: issue.author?.login ?? null,
    authorDetails: issue.author,
    assigneeDetails: issue.assignees,
    assignees: issue.assignees.map((actor) => actor.login),
    labels: issue.labels.map((label) => label.name),
    labelDetails: issue.labels,
    ...(issue.labelsTruncated === undefined ? {} : { labelsTruncated: issue.labelsTruncated }),
    ...(issue.milestone === undefined ? {} : { milestone: issue.milestone }),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    commentCount: issue.commentCount,
    ...(issue.reactions === undefined ? {} : { reactions: issue.reactions }),
    ...(issue.reactionsTruncated === undefined
      ? {}
      : { reactionsTruncated: issue.reactionsTruncated }),
  };
}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const issues = yield* IssueService.IssueService;
  const threadIssues = yield* ThreadIssueService.ThreadIssueService;
  const projects = yield* ProjectService.ProjectService;

  /** The caller's own thread, read when a tool defaults to it. */
  const callerThread = Effect.fn("IssuesToolkit.callerThread")(function* () {
    const scope = yield* McpInvocationContext.requireMcpCapability("issues");
    return scope.thread === undefined
      ? undefined
      : yield* engine.getThreadShell(scope.thread.threadId).pipe(
          Effect.orElseSucceed(() => null),
          Effect.map((shell) => shell ?? undefined),
        );
  });

  const requireThread = Effect.fn("IssuesToolkit.requireThread")(function* (
    requested: ThreadId | undefined,
  ) {
    const scope = yield* McpInvocationContext.requireMcpCapability("issues");
    const threadId = requested ?? scope.thread?.threadId;
    if (threadId === undefined) return yield* new IssueThreadRequiredError();
    const thread = yield* engine
      .getThreadShell(threadId)
      .pipe(Effect.map(Option.fromNullishOr))
      .pipe(Effect.mapError((cause) => new IssueService.IssueLinkFailedError({ cause })));
    if (Option.isNone(thread) || thread.value.deletedAt !== null) {
      return yield* new ThreadIssueService.IssueThreadNotFoundError({ threadId });
    }
    return thread.value;
  });

  /** The project a key-only reference is read through: named, or the caller's thread's own. */
  const requireProject = Effect.fn("IssuesToolkit.requireProject")(function* (
    requested: ProjectId | undefined,
  ) {
    yield* McpInvocationContext.requireMcpCapability("issues");
    const projectId = requested ?? (yield* callerThread())?.projectId;
    if (projectId === undefined) return yield* new IssueService.IssueProjectRequiredError();
    const project = yield* projects
      .getShell(projectId)
      .pipe(Effect.mapError((cause) => new IssueService.IssueLinkFailedError({ cause })));
    if (Option.isNone(project)) {
      return yield* new IssueService.IssueProjectNotFoundError({ projectId });
    }
    return { project: project.value };
  });

  const requireSource = Effect.fn("IssuesToolkit.requireSource")(function* (
    requestedProject: ProjectId | undefined,
    requestedTracker: IssueTrackerKind | undefined,
    connectionId: string | undefined,
  ) {
    yield* McpInvocationContext.requireMcpCapability("issues");
    const projectId = requestedProject ?? (yield* callerThread())?.projectId;
    return yield* issues.resolveSource({ projectId, tracker: requestedTracker, connectionId });
  });

  const resolveTarget = Effect.fn("IssuesToolkit.resolveTarget")(function* (
    input: IssueTargetInput,
  ) {
    yield* McpInvocationContext.requireMcpCapability("issues");
    const needsProject = input.url !== undefined || input.key !== undefined;
    const projectId =
      input.projectId ?? (needsProject ? (yield* callerThread())?.projectId : undefined);
    return yield* issues.resolveTarget({ ...input, projectId });
  });

  const identityOf = (
    target: Omit<IssueService.ResolvedIssueTarget, "writable">,
    detail?: Pick<IssueDetail, "url">,
  ) => ({
    projectId: target.projectId,
    tracker: target.tracker,
    ...(target.connectionId === undefined ? {} : { connectionId: target.connectionId }),
    host: target.host,
    scope: target.scope,
    key: target.key,
    url: target.url ?? detail?.url ?? "",
  });

  const refOf = (
    target: IssueService.ResolvedIssueTarget,
  ): IssueRef & { readonly host: string } => ({
    projectId: target.projectId,
    tracker: target.tracker,
    ...(target.connectionId === undefined ? {} : { connectionId: target.connectionId }),
    host: target.host,
    scope: target.scope,
    key: target.key,
  });

  const readsTarget = <P extends IssueTargetInput, A, E, R>(
    read: (input: P, target: IssueService.ResolvedIssueTarget) => Effect.Effect<A, E, R>,
  ) =>
    McpToolAccess.reads((input: P) =>
      resolveTarget(input).pipe(Effect.flatMap((target) => read(input, target))),
    );

  const writesTarget = <P extends IssueTargetInput, E, R>(
    write: (input: P, target: IssueService.ResolvedIssueTarget) => Effect.Effect<void, E, R>,
  ) =>
    McpToolAccess.writesWithCapability((input: P) =>
      Effect.gen(function* () {
        const target = yield* resolveTarget(input);
        yield* write(input, target);
        return identityOf(target);
      }),
    );

  const linkFailure = <E>(cause: Cause.Cause<E>) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.failCause(cause as Cause.Cause<never>)
      : Effect.fail(new IssueService.IssueLinkFailedError({ cause }));

  /** A tool that changes `threadId`, or the caller's own thread when it is omitted. */
  const writesThread = <P extends { readonly threadId?: ThreadId | undefined }, A, E, R>(
    handle: (params: P) => Effect.Effect<A, E, R>,
  ) => McpToolAccess.writesThreads((params: P) => [params.threadId], handle);

  return {
    list_issue_sources: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.requireMcpCapability("issues");
        const projectId = input.projectId ?? (yield* callerThread())?.projectId;
        if (projectId !== undefined) yield* requireProject(projectId);
        else if (scope.thread !== undefined)
          return yield* new IssueService.IssueProjectRequiredError();
        return {
          sources: yield* issues.listSources({
            ...input,
            ...(projectId === undefined ? {} : { projectId }),
          }),
        };
      }),
    ),
    read_issue_history: readsTarget((input, target) =>
      issues.history({
        ...refOf(target),
        ...(input.order === undefined ? {} : { order: input.order }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      }),
    ),
    read_issue_dependencies: readsTarget((input, target) =>
      issues.dependencies({
        ...refOf(target),
        direction: input.direction,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      }),
    ),
    set_issue_dependency: writesTarget((input, target) =>
      issues.setDependency({
        ...refOf(target),
        direction: input.direction,
        targetScope: input.targetScope,
        targetKey: input.targetKey,
        linked: input.linked,
      }),
    ),
    read_issue_hierarchy: readsTarget((input, target) =>
      issues.hierarchy({
        ...refOf(target),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      }),
    ),
    read_issue_linked_pull_requests: readsTarget((input, target) =>
      issues.linkedPullRequests({
        ...refOf(target),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      }),
    ),
    read_issue_templates: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const { project, binding } = yield* requireSource(
          input.projectId,
          input.tracker,
          input.connectionId,
        );
        return yield* issues.templates({
          projectId: project.id,
          ...binding,
          ...(input.host === undefined ? {} : { host: input.host }),
          ...(input.scope === undefined ? {} : { scope: input.scope }),
          ...(input.metadataOnly === undefined ? {} : { metadataOnly: input.metadataOnly }),
          ...(input.templateKey === undefined ? {} : { templateKey: input.templateKey }),
        });
      }),
    ),
    list_issue_labels: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const { project, binding } = yield* requireSource(
          input.projectId,
          input.tracker,
          input.connectionId,
        );
        return yield* issues.labelCandidates({
          projectId: project.id,
          ...binding,
          ...(input.host === undefined ? {} : { host: input.host }),
          ...(input.scope === undefined ? {} : { scope: input.scope }),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        });
      }),
    ),
    list_issue_assignees: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const { project, binding } = yield* requireSource(
          input.projectId,
          input.tracker,
          input.connectionId,
        );
        return yield* issues.assigneeCandidates({
          projectId: project.id,
          ...binding,
          ...(input.host === undefined ? {} : { host: input.host }),
          ...(input.scope === undefined ? {} : { scope: input.scope }),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        });
      }),
    ),
    update_issue: writesTarget((input, target) =>
      issues.update({
        ...refOf(target),
        ...(input.richBody === undefined ? {} : { richBody: input.richBody }),
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.labels === undefined ? {} : { labels: input.labels }),
        ...(input.assignees === undefined ? {} : { assignees: input.assignees }),
      }),
    ),
    edit_issue_comment: writesTarget((input, target) =>
      issues.editComment({
        ...refOf(target),
        commentId: input.commentId,
        body: input.body,
        ...(input.richBody === undefined ? {} : { richBody: input.richBody }),
      }),
    ),
    set_issue_reaction: writesTarget((input, target) =>
      issues.react({
        ...refOf(target),
        ...(input.subjectId === undefined ? {} : { subjectId: input.subjectId }),
        content: input.content,
        reacted: input.reacted,
      }),
    ),
    set_issue_labels: writesTarget((input, target) =>
      issues.update({ ...refOf(target), labels: input.labels }),
    ),
    set_issue_assignees: writesTarget((input, target) =>
      issues.update({ ...refOf(target), assignees: input.assignees }),
    ),
    set_issue_parent: writesTarget((input, target) =>
      issues.setParent({ ...refOf(target), parentKey: input.parentKey }),
    ),
    list_issues: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const { project } = yield* requireProject(input.projectId);
        const result = yield* issues.list({
          projectId: project.id,
          state: input.state ?? "open",
          ...(input.tracker === undefined ? {} : { tracker: input.tracker }),
          ...(input.host === undefined ? {} : { host: input.host }),
          ...(input.scope === undefined ? {} : { scope: input.scope }),
          ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
          ...(input.stateCategories === undefined
            ? {}
            : { stateCategories: input.stateCategories }),
          ...(input.sort === undefined ? {} : { sort: input.sort }),
          ...(input.order === undefined ? {} : { order: input.order }),
          ...(input.involvement === undefined ? {} : { involvement: input.involvement }),
          ...(input.query === undefined ? {} : { query: input.query }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.cursors === undefined ? {} : { cursors: input.cursors }),
        });
        return {
          issues: result.entries.map((entry) => ({
            projectId: entry.projectId,
            tracker: entry.tracker,
            ...(entry.connectionId === undefined ? {} : { connectionId: entry.connectionId }),
            host: entry.host,
            scope: entry.scope,
            key: entry.key,
            url: entry.url,
            ...summaryFields(entry),
          })),
          nextCursors: result.nextCursors,
          errors: result.errors.map((error) => ({
            projectId: error.projectId,
            ...(error.connectionId === undefined ? {} : { connectionId: error.connectionId }),
            message: error.message,
          })),
        };
      }),
    ),
    read_issue: readsTarget((input, target) =>
      Effect.gen(function* () {
        const detail = yield* issues.detail(refOf(target));
        return {
          ...identityOf(target, detail),
          ...summaryFields(detail),
          writable: detail.writable,
          capabilities: detail.capabilities,
          ...(detail.states === undefined ? {} : { states: detail.states }),
          viewer: detail.viewer,
          viewerPermissions: detail.viewerPermissions,
          body: detail.body,
          ...(detail.richBody === undefined ? {} : { richBody: detail.richBody }),
          ...(detail.externalLinks === undefined ? {} : { externalLinks: detail.externalLinks }),
          ...(detail.bodyEditable === undefined ? {} : { bodyEditable: detail.bodyEditable }),
          events: detail.events,
          ...(detail.historyTruncated === undefined
            ? {}
            : { historyTruncated: detail.historyTruncated }),
          comments: detail.comments.map((comment) => ({
            id: comment.id,
            author: comment.author?.login ?? null,
            authorDetails: comment.author,
            body: comment.body,
            ...(comment.richBody === undefined ? {} : { richBody: comment.richBody }),
            ...(comment.url === undefined ? {} : { url: comment.url }),
            createdAt: comment.createdAt,
            ...(comment.editedAt === undefined ? {} : { editedAt: comment.editedAt }),
            ...(comment.canEdit === undefined ? {} : { canEdit: comment.canEdit }),
            ...(comment.reactions === undefined ? {} : { reactions: comment.reactions }),
            ...(comment.reactionsTruncated === undefined
              ? {}
              : { reactionsTruncated: comment.reactionsTruncated }),
          })),
          commentsTruncated: detail.commentsCursor !== null,
          commentsCursor: detail.commentsCursor,
          linkedPullRequests: detail.linkedPullRequests.map((pullRequest) => ({
            url: pullRequest.url,
            title: pullRequest.title,
            state: pullRequest.state,
            closesIssue: pullRequest.closesIssue,
          })),
        };
      }),
    ),
    read_issue_comments: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        if (input.tracker !== undefined && input.scope !== undefined && input.key !== undefined) {
          const { project } = yield* requireProject(input.projectId);
          return yield* issues.comments({
            projectId: project.id,
            tracker: input.tracker,
            ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
            ...(input.host === undefined ? {} : { host: input.host }),
            scope: input.scope,
            key: input.key,
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
            ...(input.order === undefined ? {} : { order: input.order }),
            ...(input.viewer === undefined ? {} : { viewer: input.viewer }),
          });
        }
        const target = yield* resolveTarget(input);
        return yield* issues.comments({
          ...refOf(target),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.order === undefined ? {} : { order: input.order }),
          ...(input.viewer === undefined ? {} : { viewer: input.viewer }),
        });
      }),
    ),
    create_issue: McpToolAccess.writesWithCapability((input) =>
      Effect.gen(function* () {
        const { project, binding } = yield* requireSource(
          input.projectId,
          input.tracker,
          input.connectionId,
        );
        const created = yield* issues.create({
          projectId: project.id,
          ...binding,
          title: input.title,
          body: input.body ?? "",
          labels: input.labels ?? [],
          assignees: input.assignees ?? [],
          ...(input.fieldValues === undefined ? {} : { fieldValues: input.fieldValues }),
          ...(input.issueType === undefined ? {} : { issueType: input.issueType }),
          ...(input.parentKey === undefined ? {} : { parentKey: input.parentKey }),
          ...(input.templateKey === undefined ? {} : { templateKey: input.templateKey }),
        });
        return {
          projectId: project.id,
          ...binding,
          ...created,
        };
      }),
    ),
    read_issue_candidates: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const { project, binding } = yield* requireSource(
          input.projectId,
          input.tracker,
          input.connectionId,
        );
        return yield* issues.candidates({
          projectId: project.id,
          ...binding,
          ...(input.key === undefined ? {} : { key: input.key }),
          ...(input.issueType === undefined ? {} : { issueType: input.issueType }),
        });
      }),
    ),
    comment_on_issue: writesTarget((input, target) =>
      issues.comment({ ...refOf(target), body: input.body }),
    ),
    set_issue_state: writesTarget((input, target) =>
      issues.setState({
        ...refOf(target),
        state: input.state,
        ...(input.transitionId === undefined ? {} : { transitionId: input.transitionId }),
        ...(input.fieldValues === undefined ? {} : { fieldValues: input.fieldValues }),
        ...(input.closeReason === undefined ? {} : { closeReason: input.closeReason }),
      }),
    ),
    link_issue: writesThread((input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread(input.threadId);
        const target = yield* resolveTarget({
          ...input,
          projectId: input.projectId ?? thread.projectId,
        });
        const initial =
          target.url === null
            ? yield* issues
                .detail(refOf(target))
                .pipe(Effect.map((detail) => ({ url: detail.url, detail })))
            : { url: target.url };
        const { alreadyLinked } = yield* threadIssues
          .link({ threadId: thread.id, ref: refOf(target), ...initial, source: "agent" })
          .pipe(Effect.catchCause(linkFailure));
        return { ...identityOf(target), url: initial.url, alreadyLinked };
      }),
    ),
    unlink_issue: writesThread((input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.requireMcpCapability("issues");
        const threadId = input.threadId ?? scope.thread?.threadId;
        if (threadId === undefined) return yield* new IssueThreadRequiredError();
        const result = yield* threadIssues.unlinkByIdentity({ threadId, identity: input });
        return { ...identityOf(result), wasLinked: result.wasLinked };
      }),
    ),
    list_thread_issues: McpToolAccess.reads((input) =>
      requireThread(input.threadId).pipe(Effect.map(listThreadIssues)),
    ),
  } satisfies McpToolAccess.Handlers<typeof IssuesToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(IssuesToolkit, make);
