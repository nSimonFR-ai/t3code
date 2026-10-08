import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type {
  IssueCapabilities,
  IssueEvent,
  IssueLinkedPullRequest,
  IssueRelative,
  IssueRelativeNode,
  IssueReaction,
  IssueReactionContent,
  IssueState,
  IssueViewerPermissions,
} from "@t3tools/contracts";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";

import * as ServerSettings from "../serverSettings.ts";
import * as LinearConnection from "./LinearConnection.ts";
import * as LinearApi from "./LinearApi.ts";
import {
  IssueProviderError,
  type IssueAdapter,
  type IssueAdapterSource,
  type ProviderIssue,
} from "./IssueProvider.ts";

/** A Linear team key, the letters before the dash in an identifier such as `ENG-123`. */
const TEAM_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;
/** How long the account that can read a team is believed without asking Linear again. */
const TEAM_ACCOUNT_CACHE_TTL = Duration.minutes(10);

const CAPABILITIES: IssueCapabilities = {
  sorts: ["created", "updated"],
  referenceStyle: "key-number",
  closesViaPullRequest: false,
  comment: true,
  actions: ["close", "reopen"],
  closeReasons: ["completed", "not-planned"],
  create: true,
  issueTemplates: true,
  edit: true,
  editComment: true,
  reactions: true,
  labels: true,
  assignees: true,
  maxAssignees: 1,
  typedAssignees: true,
  listLabelCandidates: true,
  listAssigneeCandidates: true,
  search: true,
  linkedPullRequests: true,
  timelineEvents: true,
};

const PERMISSIONS: IssueViewerPermissions = {
  actions: ["close", "reopen"],
  comment: true,
  edit: true,
  labels: true,
  assignees: true,
  create: true,
};

const EMOJI: Record<IssueReactionContent, string> = {
  "thumbs-up": "👍",
  "thumbs-down": "👎",
  laugh: "😄",
  hooray: "🎉",
  confused: "😕",
  heart: "❤️",
  rocket: "🚀",
  eyes: "👀",
};
const CONTENT = new Map(Object.entries(EMOJI).map(([content, emoji]) => [emoji, content] as const));

export function linearIssueState(type: string): IssueState {
  return type === "completed" || type === "canceled" || type === "duplicate" ? "closed" : "open";
}

export function linearReactions(
  reactions: ReadonlyArray<LinearApi.LinearReaction>,
  viewerId: string,
): ReadonlyArray<IssueReaction> {
  const grouped = new Map<
    IssueReactionContent,
    { actors: string[]; count: number; viewerHasReacted: boolean }
  >();
  for (const reaction of reactions) {
    const content = CONTENT.get(reaction.emoji) as IssueReactionContent | undefined;
    const actor = reaction.user?.id;
    if (content === undefined) continue;
    const group = grouped.get(content) ?? { actors: [], count: 0, viewerHasReacted: false };
    group.count += 1;
    if (actor !== undefined && !group.actors.includes(actor)) group.actors.push(actor);
    if (actor === viewerId) group.viewerHasReacted = true;
    grouped.set(content, group);
  }
  return [...grouped].map(([content, group]) => ({
    content,
    count: group.count,
    actors: group.actors,
    viewerHasReacted: group.viewerHasReacted,
  }));
}

function actor(user: LinearApi.LinearUser | null | undefined) {
  return user === null || user === undefined
    ? null
    : {
        login: user.id,
        name: user.name?.trim() || null,
        avatarUrl: user.avatarUrl?.trim() || null,
      };
}

function toComment(comment: LinearApi.LinearComment, viewerId: string) {
  return {
    id: comment.id,
    author: actor(comment.user),
    body: comment.body,
    createdAt: comment.createdAt,
    url: comment.url ?? null,
    reactions: linearReactions(comment.reactions ?? [], viewerId),
  };
}

function toEvents(history: ReadonlyArray<LinearApi.LinearHistory>): IssueEvent[] {
  return history
    .flatMap((entry) => {
      const events: IssueEvent[] = [];
      const add = (kind: IssueEvent["kind"], detail: string | null) =>
        events.push({
          id: `${entry.id}:${kind}:${events.length}`,
          kind,
          actor: actor(entry.actor),
          createdAt: entry.createdAt,
          detail: detail?.trim() || null,
        });
      if (
        entry.fromState !== null &&
        entry.toState !== null &&
        linearIssueState(entry.fromState.type) !== linearIssueState(entry.toState.type)
      )
        add(
          linearIssueState(entry.toState.type) === "closed" ? "closed" : "reopened",
          entry.toState.name,
        );
      for (const label of entry.addedLabels ?? []) add("labeled", label.name);
      for (const label of entry.removedLabels ?? []) add("unlabeled", label.name);
      if (entry.fromAssignee !== null && entry.fromAssignee.id !== entry.toAssignee?.id)
        add("unassigned", entry.fromAssignee.name || entry.fromAssignee.id);
      if (entry.toAssignee !== null && entry.toAssignee.id !== entry.fromAssignee?.id)
        add("assigned", entry.toAssignee.name || entry.toAssignee.id);
      if (entry.toTitle !== null && entry.toTitle !== entry.fromTitle)
        add("renamed", entry.toTitle);
      return events;
    })
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

const PULL_REQUEST_URL =
  /^https:\/\/(?:github\.com\/([^/]+\/[^/]+)\/pull|gitlab\.com\/(.+?)\/-\/merge_requests)\/(\d+)\/?(?:[?#]|$)/u;

export function linearLinkedPullRequests(
  attachments: ReadonlyArray<LinearApi.LinearAttachment>,
): Array<IssueLinkedPullRequest> {
  const seen = new Set<string>();
  return attachments.flatMap((attachment) => {
    const match = PULL_REQUEST_URL.exec(attachment.url);
    if (match === null) return [];
    const reference = parseChangeRequestUrl(attachment.url);
    if (reference === null) return [];
    const key = `${reference.host}/${reference.repository}#${reference.number}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const status = attachment.metadata?.status;
    return [
      {
        repository: match[1] ?? match[2]!,
        number: Number(match[3]),
        title: attachment.title.trim() || attachment.url,
        url: attachment.url,
        state: status === "merged" ? "merged" : status === "closed" ? "closed" : "open",
        isDraft: status === "draft" || attachment.metadata?.draft === true,
        closesIssue: false,
      },
    ];
  });
}

function toRelative(issue: LinearApi.LinearRelative): IssueRelative {
  return {
    repository: issue.team.key,
    number: issue.number,
    title: issue.title,
    url: issue.url,
    state: linearIssueState(issue.state.type),
    ...(issue.attachments
      ? { linkedPullRequests: linearLinkedPullRequests(issue.attachments.nodes) }
      : {}),
  };
}

function toRelativeNode(issue: LinearApi.LinearRelative): IssueRelativeNode {
  return { ...toRelative(issue), subIssues: (issue.children?.nodes ?? []).map(toRelativeNode) };
}

/** Root first, ending with the direct parent. */
function linearAncestors(issue: LinearApi.LinearIssue): Array<IssueRelative> {
  const ancestors: Array<IssueRelative> = [];
  for (let parent = issue.parent; parent; parent = parent.parent) {
    ancestors.unshift(toRelative(parent));
  }
  return ancestors;
}

function toIssue(issue: LinearApi.LinearIssue): ProviderIssue {
  const state = linearIssueState(issue.state.type);
  return {
    number: issue.number,
    title: issue.title,
    url: issue.url,
    author: actor(issue.creator),
    state,
    stateReason:
      issue.state.type === "canceled"
        ? "not-planned"
        : issue.state.type === "completed"
          ? "completed"
          : null,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt:
      state === "closed" ? (issue.completedAt ?? issue.canceledAt ?? issue.updatedAt) : null,
    assignees:
      issue.assignee === null || issue.assignee === undefined ? [] : [actor(issue.assignee)!],
    labels: (issue.labels?.nodes ?? []).map((label) => ({
      name: label.name,
      color: label.color ?? null,
    })),
    milestone: null,
    commentCount: 0,
  };
}

export const make = Effect.gen(function* () {
  const api = yield* LinearApi.LinearApi;
  const settings = yield* ServerSettings.ServerSettingsService;

  const fail = (operation: string) => (error: LinearApi.LinearApiError) =>
    new IssueProviderError({
      provider: "linear",
      operation,
      reason: error.reason,
      ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
      detail: error.detail,
      cause: error,
    });
  const identifier = (repository: string, number: number) => `${repository}-${number}`;

  const teamAccounts = new Map<
    string,
    { readonly at: number; readonly source: IssueAdapterSource }
  >();
  /**
   * The connected account that can read a team, preferring the environment account like an
   * unbound request does. Only answers are held: a team that is missing now may be granted later.
   */
  const resolveTeam = (repository: string): Effect.Effect<IssueAdapterSource | null> =>
    Effect.gen(function* () {
      if (!TEAM_KEY.test(repository)) return null;
      const key = repository.toUpperCase();
      const now = yield* Clock.currentTimeMillis;
      const held = teamAccounts.get(key);
      if (held !== undefined && now - held.at <= Duration.toMillis(TEAM_ACCOUNT_CACHE_TTL)) {
        return held.source;
      }
      const connection = yield* api.connection;
      const readsTeam = (projects: ReadonlyArray<{ readonly key: string }>) =>
        projects.find((team) => team.key.toUpperCase() === key)?.key;
      const environment = connection.environmentAccount;
      const environmentTeam =
        environment?.status === "authenticated" ? readsTeam(environment.projects) : undefined;
      let source: IssueAdapterSource | null =
        environmentTeam === undefined ? null : { host: "linear.app", repository: environmentTeam };
      for (const account of connection.accounts) {
        if (source !== null) break;
        const team = account.status === "authenticated" ? readsTeam(account.projects) : undefined;
        if (team !== undefined) {
          source = { host: "linear.app", repository: team, credentialId: account.credentialId };
        }
      }
      if (source !== null) teamAccounts.set(key, { at: now, source });
      return source;
    }).pipe(Effect.orElseSucceed(() => null));

  return {
    kind: "linear",
    tracker: yield* LinearConnection.make,
    capabilities: CAPABILITIES,
    resolveSource: (project) =>
      settings.getSettings.pipe(
        Effect.map((value) => {
          const binding = value.issueTracking.connections.linear?.projectBindings[project.id];
          return binding == null
            ? null
            : {
                host: "linear.app",
                repository: binding.repository,
                ...(binding.credentialId === undefined
                  ? {}
                  : { credentialId: binding.credentialId }),
              };
        }),
        Effect.orElseSucceed(() => null),
      ),
    resolveReference: (_project, repository) => resolveTeam(repository),
    getViewer: ({ credentialId }) =>
      api.getViewer(credentialId === undefined ? {} : { credentialId }).pipe(
        Effect.map((viewer) => viewer.id),
        Effect.mapError(fail("getViewer")),
      ),
    listIssues: (input) =>
      api
        .listIssues({
          teamKey: input.repository,
          state: input.state,
          involvement: input.involvement,
          viewer: input.viewer,
          limit: input.limit,
          sort: input.sort,
          order: input.order,
          ...(input.query === undefined ? {} : { query: input.query }),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.credentialId === undefined ? {} : { credentialId: input.credentialId }),
        })
        .pipe(
          Effect.mapError(fail("listIssues")),
          Effect.map(({ issues, truncated }) => ({
            items: issues.map(toIssue),
            truncated,
            continues:
              (input.sort === undefined || input.sort === "updated") && input.order !== "asc",
          })),
        ),
    getIssueSummary: (input) =>
      api
        .getIssueSummary({
          identifier: identifier(input.repository, input.number),
          ...(input.credentialId === undefined ? {} : { credentialId: input.credentialId }),
        })
        .pipe(
          Effect.mapError(fail("getIssueSummary")),
          Effect.map((issue) => ({
            number: issue.number,
            title: issue.title,
            url: issue.url,
            state: linearIssueState(issue.state.type),
          })),
        ),
    getIssue: (input) =>
      api
        .getIssue({
          identifier: identifier(input.repository, input.number),
          ...(input.credentialId === undefined ? {} : { credentialId: input.credentialId }),
        })
        .pipe(
          Effect.mapError(fail("getIssue")),
          Effect.map((issue) => ({
            ...toIssue(issue),
            body: issue.description ?? "",
            linkedPullRequests: linearLinkedPullRequests(issue.attachments?.nodes ?? []),
            linkedPullRequestsTruncated: issue.attachments?.pageInfo?.hasNextPage ?? false,
            nextLinkedPullRequestsCursor:
              issue.attachments?.pageInfo?.hasNextPage === true
                ? (issue.attachments.pageInfo.endCursor ?? null)
                : null,
            ancestors: linearAncestors(issue),
            subIssues: (issue.children?.nodes ?? []).map(toRelativeNode),
            viewerPermissions: PERMISSIONS,
          })),
        ),
    getIssueActivity: (input) =>
      Effect.gen(function* () {
        const reference = {
          identifier: identifier(input.repository, input.number),
          ...(input.credentialId === undefined ? {} : { credentialId: input.credentialId }),
        };
        const activity = yield* api.getActivity(reference);
        const history = yield* api.getHistory(reference);
        return {
          comments: activity.comments.map((comment) => toComment(comment, activity.viewerId)),
          commentCount: activity.comments.length,
          commentsTruncated: activity.commentsTruncated,
          nextCommentsCursor: activity.nextCommentsCursor ?? null,
          events: toEvents(history.nodes),
          eventsTruncated: history.truncated,
          nextEventsCursor: history.nextCursor,
          reactions: linearReactions(activity.reactions, activity.viewerId),
        };
      }).pipe(Effect.mapError(fail("getIssueActivity"))),
    getIssueEvents: (input) =>
      api
        .getHistory({
          identifier: identifier(input.repository, input.number),
          cursor: input.cursor,
          ...(input.credentialId === undefined ? {} : { credentialId: input.credentialId }),
        })
        .pipe(
          Effect.mapError(fail("getIssueEvents")),
          Effect.map((history) => ({
            events: toEvents(history.nodes),
            nextCursor: history.nextCursor,
            truncated: history.truncated,
          })),
        ),
    getIssueComments: (input) =>
      api
        .getActivity({
          identifier: identifier(input.repository, input.number),
          cursor: input.cursor,
          ...(input.credentialId === undefined ? {} : { credentialId: input.credentialId }),
        })
        .pipe(
          Effect.mapError(fail("getIssueComments")),
          Effect.map((activity) => ({
            comments: activity.comments.map((comment) => toComment(comment, activity.viewerId)),
            nextCursor: activity.nextCommentsCursor,
          })),
        ),
    getIssueLinkedPullRequests: (input) =>
      api
        .getAttachments({
          identifier: identifier(input.repository, input.number),
          cursor: input.cursor,
          ...(input.credentialId === undefined ? {} : { credentialId: input.credentialId }),
        })
        .pipe(
          Effect.mapError(fail("getIssueLinkedPullRequests")),
          Effect.map((attachments) => ({
            linkedPullRequests: linearLinkedPullRequests(attachments.nodes),
            nextCursor: attachments.nextCursor,
            truncated: attachments.truncated,
          })),
        ),
    getViewerPermissions: () => Effect.succeed(PERMISSIONS),
    runAction: (input) =>
      api
        .runAction({
          teamKey: input.repository,
          identifier: identifier(input.repository, input.number),
          action: input.action,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          ...(input.credentialId === undefined ? {} : { credentialId: input.credentialId }),
        })
        .pipe(Effect.mapError(fail("runAction"))),
    comment: (input) =>
      api
        .comment({
          issueId: identifier(input.repository, input.number),
          body: input.body,
          ...(input.credentialId === undefined ? {} : { credentialId: input.credentialId }),
        })
        .pipe(Effect.mapError(fail("comment"))),
    updateComment: (input) =>
      api
        .updateComment({
          identifier: identifier(input.repository, input.number),
          commentId: input.commentId,
          body: input.body,
          ...(input.credentialId === undefined ? {} : { credentialId: input.credentialId }),
        })
        .pipe(Effect.mapError(fail("updateComment"))),
    setReaction: (input) =>
      api
        .setReaction({
          issueId: identifier(input.repository, input.number),
          ...(input.subjectId === undefined ? {} : { commentId: input.subjectId }),
          emoji: EMOJI[input.content],
          reacted: input.reacted,
          ...(input.credentialId === undefined ? {} : { credentialId: input.credentialId }),
        })
        .pipe(Effect.mapError(fail("setReaction"))),
    create: (input) =>
      api
        .createIssue({
          teamKey: input.repository,
          title: input.title,
          body: input.body,
          labels: input.labels,
          assignees: input.assignees,
          ...(input.credentialId === undefined ? {} : { credentialId: input.credentialId }),
        })
        .pipe(Effect.mapError(fail("create"))),
    update: (input) =>
      api
        .updateIssue({
          identifier: identifier(input.repository, input.number),
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { body: input.body }),
          ...(input.credentialId === undefined ? {} : { credentialId: input.credentialId }),
        })
        .pipe(Effect.mapError(fail("update"))),
    setLabels: (input) =>
      api
        .setLabels({
          teamKey: input.repository,
          identifier: identifier(input.repository, input.number),
          labels: input.labels,
          ...(input.credentialId === undefined ? {} : { credentialId: input.credentialId }),
        })
        .pipe(Effect.mapError(fail("setLabels"))),
    setAssignees: (input) =>
      api
        .setAssignees({
          teamKey: input.repository,
          identifier: identifier(input.repository, input.number),
          assignees: input.assignees,
          ...(input.credentialId === undefined ? {} : { credentialId: input.credentialId }),
        })
        .pipe(Effect.mapError(fail("setAssignees"))),
    listLabelCandidates: (input) =>
      Effect.gen(function* () {
        const labels = yield* api.listLabels({
          teamKey: input.repository,
          ...(input.credentialId === undefined ? {} : { credentialId: input.credentialId }),
        });
        const issue = yield* api.getIssueSelection({
          identifier: identifier(input.repository, input.number),
          ...(input.credentialId === undefined ? {} : { credentialId: input.credentialId }),
        });
        return {
          candidates: [
            ...labels.nodes,
            ...issue.labels.nodes
              .filter((applied) => !labels.nodes.some((label) => label.name === applied.name))
              .map((label) => ({ ...label, description: null })),
          ].map((label) => ({
            name: label.name,
            color: label.color ?? null,
            description: label.description,
            isApplied: issue.labels.nodes.some((applied) => applied.name === label.name),
          })),
          truncated: labels.truncated,
        };
      }).pipe(Effect.mapError(fail("listLabelCandidates"))),
    listAssigneeCandidates: (input) =>
      Effect.gen(function* () {
        const members = yield* api.listAssignees({
          teamKey: input.repository,
          ...(input.credentialId === undefined ? {} : { credentialId: input.credentialId }),
        });
        const issue = yield* api.getIssueSelection({
          identifier: identifier(input.repository, input.number),
          ...(input.credentialId === undefined ? {} : { credentialId: input.credentialId }),
        });
        return {
          candidates: [
            ...members.nodes,
            ...(issue.assignee !== null &&
            !members.nodes.some((user) => user.id === issue.assignee?.id)
              ? [issue.assignee]
              : []),
          ].map((user) => ({
            ...actor(user)!,
            id: user.id,
            isAssigned: issue.assignee?.id === user.id,
          })),
          truncated: members.truncated,
        };
      }).pipe(Effect.mapError(fail("listAssigneeCandidates"))),
    listIssueTemplates: (input) =>
      api
        .getIssueTemplates({
          teamKey: input.repository,
          ...(input.credentialId === undefined ? {} : { credentialId: input.credentialId }),
        })
        .pipe(Effect.mapError(fail("listIssueTemplates"))),
  } satisfies IssueAdapter;
});
