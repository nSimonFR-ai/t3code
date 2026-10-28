import { createIssueEnvironmentAtoms } from "@t3tools/client-runtime/state/issues";
import { createIssuePagedQuery } from "@t3tools/client-runtime/issue-pages";
import { issueScopeKeyOf } from "@t3tools/contracts";
import type {
  EnvironmentId,
  IssueListInput,
  IssueDependenciesInput,
  IssuePageRef,
  IssueLinkedPullRequest,
} from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";

import { useIssueViewRefresh } from "../hooks/useIssueViewRefresh";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  createMergedEnvironmentQuery,
  type EnvironmentQueryTarget,
} from "./mergedEnvironmentQuery";
import { formatEnvironmentQueryError } from "./query";
export type { IssuePagedView } from "@t3tools/client-runtime/issue-pages";

const pageOptions = {
  useRegistry: () => appAtomRegistry,
  formatError: formatEnvironmentQueryError,
  useRefresh: useIssueViewRefresh,
};

export const issueEnvironment = createIssueEnvironmentAtoms(connectionAtomRuntime);

export type IssueListTarget = EnvironmentQueryTarget<IssueListInput>;

export const useIssueList = createMergedEnvironmentQuery(
  "web-issues:list",
  (target: IssueListTarget) => issueEnvironment.list(target),
);

const pageOf = <P>(value: P) => value;

export const useIssueHistory = createIssuePagedQuery(
  pageOptions,
  "web-issues:history",
  issueEnvironment.history,
  pageOf,
);
export const useIssueComments = createIssuePagedQuery(
  pageOptions,
  "web-issues:comments",
  issueEnvironment.commentPages,
  (value) => ({ items: value.comments, nextCursor: value.nextCursor }),
);
const useLinkedPullRequestPages = createIssuePagedQuery(
  pageOptions,
  "web-issues:linked-pull-requests",
  issueEnvironment.linkedPullRequests,
  pageOf,
);
export function useIssueLinkedPullRequests(
  environmentId: EnvironmentId | null,
  input: IssuePageRef | null,
) {
  const page = useLinkedPullRequestPages(environmentId, input);
  const links = new Map<string, IssueLinkedPullRequest>();
  for (const link of page.items) {
    const parsed = sourceControlClients.parseChangeRequestUrl(link.url)?.link ?? null;
    const provider = link.provider ?? input?.tracker;
    const repositoryUrl = provider === "forgejo" ? (parsed?.repositoryUrl ?? null) : null;
    const repository =
      repositoryUrl === null
        ? (parsed?.repository ?? link.repository)
        : new URL(repositoryUrl).pathname.slice(1);
    let host = link.host?.toLowerCase() ?? link.url;
    try {
      host = new URL(link.url).host.toLowerCase() || host;
    } catch {}
    const key = JSON.stringify([
      provider,
      host,
      issueScopeKeyOf({ tracker: provider ?? "", scope: repository }),
      link.number,
    ]);
    links.set(key, {
      ...link,
      closesIssue: link.closesIssue || links.get(key)?.closesIssue === true,
    });
  }
  return { ...page, items: [...links.values()] };
}
export const useIssueHierarchy = createIssuePagedQuery(
  pageOptions,
  "web-issues:hierarchy",
  issueEnvironment.hierarchy,
  (value) => value.children,
  (first) => first?.parent ?? null,
);
export const useIssueLabelCandidates = createIssuePagedQuery(
  pageOptions,
  "web-issues:label-candidates",
  issueEnvironment.labelCandidates,
  pageOf,
);
export const useIssueAssigneeCandidates = createIssuePagedQuery(
  pageOptions,
  "web-issues:assignee-candidates",
  issueEnvironment.assigneeCandidates,
  pageOf,
);

const useDependencyPages = createIssuePagedQuery(
  pageOptions,
  "web-issues:dependencies",
  issueEnvironment.dependencies,
  pageOf,
);
export function useIssueDependencies(environmentId: EnvironmentId, input: IssueDependenciesInput) {
  const page = useDependencyPages(environmentId, input);
  const items = new Map<string, (typeof page.items)[number]>();
  for (const item of page.items) items.set(JSON.stringify([item.kind, item.scope, item.key]), item);
  return { ...page, items: [...items.values()] };
}
