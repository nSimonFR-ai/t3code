import { RegistryContext } from "@effect/atom-react";
import { createIssuePagedQuery } from "@t3tools/client-runtime/issue-pages";
import { createIssueEnvironmentAtoms } from "@t3tools/client-runtime/state/issues";
import * as Cause from "effect/Cause";
import { use } from "react";
import { connectionAtomRuntime } from "../connection/runtime";

export const issueEnvironment = createIssueEnvironmentAtoms(connectionAtomRuntime);

const pageOptions = {
  useRegistry: () => use(RegistryContext),
  formatError: (cause: Cause.Cause<unknown>) => {
    const error = Cause.squash(cause);
    return error instanceof Error ? error.message : "The environment request failed.";
  },
};
const pageOf = <P>(page: P) => page;

export const useIssueComments = createIssuePagedQuery(
  pageOptions,
  "mobile-issues:comments",
  issueEnvironment.commentPages,
  (page) => ({ items: page.comments, nextCursor: page.nextCursor }),
);
export const useIssueHistory = createIssuePagedQuery(
  pageOptions,
  "mobile-issues:history",
  issueEnvironment.history,
  pageOf,
);
export const useIssueLinkedPullRequests = createIssuePagedQuery(
  pageOptions,
  "mobile-issues:linked-pull-requests",
  issueEnvironment.linkedPullRequests,
  pageOf,
);
export const useIssueLabelCandidates = createIssuePagedQuery(
  pageOptions,
  "mobile-issues:label-candidates",
  issueEnvironment.labelCandidates,
  pageOf,
);
export const useIssueAssigneeCandidates = createIssuePagedQuery(
  pageOptions,
  "mobile-issues:assignee-candidates",
  issueEnvironment.assigneeCandidates,
  pageOf,
);
