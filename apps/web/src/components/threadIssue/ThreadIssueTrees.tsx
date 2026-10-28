import type {
  EnvironmentId,
  IssueLinkedPullRequest,
  IssuePageRef,
  ScopedThreadRef,
  ThreadIssueLink,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import { threadIssueKeyOf } from "@t3tools/contracts";
import { CircleDotIcon } from "lucide-react";
import { Fragment, type ReactNode } from "react";

import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { useRightPanelStore } from "~/rightPanelStore";
import { useIssueHierarchyReads, useIssueLinkedPullRequestReads } from "~/state/issues";
import { IssueStateGlyph } from "../issue/issuePresentation";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { PullRequestStateGlyph } from "../pullRequest/pullRequestPresentation";
import {
  buildThreadIssueTrees,
  type LinkedIssueRead,
  type ThreadIssueTreeRow,
  treePullRequestRows,
} from "./threadIssueTree.logic";

function pageRefOf(
  link: ThreadIssueLink,
  issue: { readonly scope: string; readonly key: string } = link,
): IssuePageRef {
  return {
    ...(link.connectionId === undefined ? {} : { connectionId: link.connectionId }),
    projectId: link.projectId,
    tracker: link.tracker,
    host: link.host,
    scope: issue.scope,
    key: issue.key,
  };
}

/**
 * Each linked issue's parent chain, three levels up, and its first page of children. A tracker
 * that reads more per request (Linear) adds the children's own children and pull requests.
 */
function useLinkedIssueReads(
  environmentId: EnvironmentId,
  links: ReadonlyArray<ThreadIssueLink>,
): ReadonlyArray<LinkedIssueRead> {
  const targets = links.map((link) => ({ environmentId, input: pageRefOf(link) }));
  const own = useIssueHierarchyReads(targets).answers;
  const pullRequests = useIssueLinkedPullRequestReads(targets).answers;
  const parents = links.map((link, index) => own[index]?.value?.parent ?? null);
  const above = (level: ReadonlyArray<(typeof parents)[number]>) =>
    links.flatMap((link, index) => {
      const parent = level[index];
      return parent ? [{ environmentId, input: pageRefOf(link, parent) }] : [];
    });
  const spread = <A,>(level: ReadonlyArray<unknown>, answers: ReadonlyArray<A>) => {
    const asked = level.flatMap((parent, index) => (parent ? [index] : []));
    return level.map((_, index) => {
      const answer = asked.indexOf(index);
      return answer === -1 ? null : (answers[answer] ?? null);
    });
  };
  const grandparents = spread(parents, useIssueHierarchyReads(above(parents)).answers).map(
    (answer) => answer?.value?.parent ?? null,
  );
  const greatGrandparents = spread(
    grandparents,
    useIssueHierarchyReads(above(grandparents)).answers,
  ).map((answer) => answer?.value?.parent ?? null);
  return links.flatMap((link, index) => {
    const page = own[index]?.value;
    if (!page) return [];
    return [
      {
        link,
        ancestors: [greatGrandparents[index], grandparents[index], parents[index]].filter(
          (issue) => issue != null,
        ),
        children: page.children.items,
        pullRequests: pullRequests[index]?.value?.items ?? [],
      },
    ];
  });
}

function TreeRelativeRow({
  row,
  threadRef,
}: {
  row: ThreadIssueTreeRow;
  threadRef: ScopedThreadRef;
}) {
  const { via, issue } = row;
  return (
    <button
      type="button"
      className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent/60"
      onClick={() =>
        useRightPanelStore.getState().openIssue(threadRef, {
          projectId: via.projectId,
          tracker: via.tracker,
          host: via.host,
          connectionId: via.connectionId,
          scope: issue.scope,
          key: issue.key,
          url: issue.url,
        })
      }
    >
      {issue.state ? (
        <IssueStateGlyph state={issue.state} className="size-3.5" />
      ) : (
        <CircleDotIcon className="size-3.5 shrink-0" />
      )}
      <span className="shrink-0 font-mono text-xs text-muted-foreground">{issue.displayKey}</span>
      <span className="min-w-0 truncate text-muted-foreground">{issue.title}</span>
    </button>
  );
}

function TreePullRequestRow({
  link,
  depth,
  threadRef,
}: {
  link: IssueLinkedPullRequest & { readonly inThread: boolean };
  depth: number;
  threadRef: ScopedThreadRef;
}) {
  const openPrLink = useOpenPrLink(threadRef);
  return (
    <a
      href={link.url}
      onClick={(event) => openPrLink(event, link.url, threadRef)}
      style={{ paddingLeft: `${0.5 + depth}rem` }}
      className="flex w-full min-w-0 items-center gap-2 rounded-md py-1 pr-2 text-xs hover:bg-accent/60"
    >
      {link.state === null ? (
        <PullRequestGlyph.pullRequest
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground"
        />
      ) : (
        <PullRequestStateGlyph state={link.state} isDraft={link.isDraft === true} />
      )}
      <span className="min-w-0 flex-1 truncate">{link.title}</span>
      {link.inThread ? (
        <span className="shrink-0 text-2xs text-muted-foreground">this thread</span>
      ) : null}
      <span className="shrink-0 font-mono text-muted-foreground">
        {link.repository}#{link.number}
      </span>
    </a>
  );
}

export interface ThreadIssueTreeModel {
  readonly trees: ReturnType<typeof buildThreadIssueTrees>;
  readonly pullRequestsByRow: ReturnType<typeof treePullRequestRows>;
  /** Linked issues whose tree cannot be read yet; they keep their plain row. */
  readonly unread: ReadonlyArray<ThreadIssueLink>;
}

/**
 * Reads the thread's linked issues into trees, one per top ancestor, with the pull requests the
 * tracker reports under each issue and the thread's own pull requests marked where listed.
 */
export function useThreadIssueTreeModel(
  threadRef: ScopedThreadRef,
  links: ReadonlyArray<ThreadIssueLink>,
  threadPullRequests: ReadonlyArray<Pick<ThreadPullRequestLink, "url">>,
): ThreadIssueTreeModel {
  const reads = useLinkedIssueReads(threadRef.environmentId, links);
  const trees = buildThreadIssueTrees(reads);
  const read = new Set(reads.map((entry) => threadIssueKeyOf(entry.link)));
  return {
    trees,
    pullRequestsByRow: treePullRequestRows(trees, threadPullRequests),
    unread: links.filter((link) => !read.has(threadIssueKeyOf(link))),
  };
}

/** Draws a tree model. The thread's own pull request shows under the issue that lists it. */
export function ThreadIssueTrees({
  threadRef,
  model,
  renderLinked,
}: {
  threadRef: ScopedThreadRef;
  model: ThreadIssueTreeModel;
  renderLinked: (link: ThreadIssueLink) => ReactNode;
}) {
  return (
    <>
      {model.trees.map((tree) => (
        <div key={tree.key} className="flex flex-col">
          {tree.rows.map((row) => (
            <Fragment key={`${row.depth}:${row.issue.key}`}>
              <div style={{ paddingLeft: `${row.depth}rem` }}>
                {row.link ? (
                  renderLinked(row.link)
                ) : (
                  <TreeRelativeRow row={row} threadRef={threadRef} />
                )}
              </div>
              {(model.pullRequestsByRow.get(row) ?? []).map((link) => (
                <TreePullRequestRow
                  key={link.url}
                  link={link}
                  depth={row.depth + 1}
                  threadRef={threadRef}
                />
              ))}
            </Fragment>
          ))}
        </div>
      ))}
      {model.unread.map((link) => (
        <Fragment key={threadIssueKeyOf(link)}>{renderLinked(link)}</Fragment>
      ))}
    </>
  );
}
