import type {
  EnvironmentId,
  IssueLinkedPullRequest,
  ProjectId,
  ScopedThreadRef,
  ThreadIssueLink,
} from "@t3tools/contracts";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";
import { issueEnvironment } from "~/state/issues";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Spinner } from "../ui/spinner";
import {
  type IssueTreeRoot,
  IssueTreePullRequestRows,
  IssueTreeRow,
  mergeIssueTrees,
} from "./IssueTree";

/** How often an open panel re-reads its trees, for sub-issues filed outside this thread. */
const TREE_REFRESH_MS = 60_000;

interface ThreadIssueTreesProps {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef | null;
  linked: ReadonlyArray<ThreadIssueLink>;
  /** The project an issue is read through; null when none here can read it. */
  projectFor: (issue: ThreadIssueLink) => ProjectId | null;
  /** Opens `number`, an issue in the same tracker project as the linked `issue`. */
  onOpen: (issue: ThreadIssueLink, number: number) => void;
  /** Opens a pull request the tracker reports for an issue in a tree. */
  onOpenPullRequest: (link: IssueLinkedPullRequest) => void;
  /** Shown for an issue whose tree cannot be read; defaults to a plain row. */
  renderFallback?: (issue: ThreadIssueLink) => ReactNode;
  /** Controls for a linked issue, shown on its row. */
  renderActions?: (issue: ThreadIssueLink) => ReactNode;
  /** A fuller row for a tree pull request, or null to keep the tracker's short one. */
  renderPullRequest?: (link: IssueLinkedPullRequest, depth: number) => ReactNode;
  /** Every pull request the drawn trees list, so the caller can stop repeating them. */
  onTreePullRequests?: (links: ReadonlyArray<IssueLinkedPullRequest>) => void;
  className?: string | undefined;
}

type TreeRead = { readonly detail: IssueTreeRoot | null; readonly pending: boolean };

/**
 * The issues linked to a thread as trees, one per top ancestor, so linked issues that share an
 * epic read as one piece of work. Trees are re-read from the tracker when the agent finishes a
 * turn — when it is likely to have split work into new sub-issues — and on a slow timer while
 * they are on screen.
 */
export function ThreadIssueTrees({
  environmentId,
  threadRef,
  linked,
  projectFor,
  onOpen,
  onOpenPullRequest,
  renderFallback,
  renderActions,
  renderPullRequest,
  onTreePullRequests,
  className,
}: ThreadIssueTreesProps) {
  const running = threadRuntimeIsActive(useThreadShell(threadRef)?.runtime ?? null);
  const [refreshToken, setRefreshToken] = useState(0);
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) setRefreshToken((token) => token + 1);
    wasRunning.current = running;
  }, [running]);
  useEffect(() => {
    const timer = setInterval(() => setRefreshToken((token) => token + 1), TREE_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const [reads, setReads] = useState<Record<string, TreeRead>>({});
  const report = useCallback((key: string, read: TreeRead) => {
    setReads((previous) =>
      previous[key]?.detail === read.detail && previous[key]?.pending === read.pending
        ? previous
        : { ...previous, [key]: read },
    );
  }, []);

  const byKey = useMemo(
    () => new Map(linked.map((issue) => [threadIssueKey(issue), issue])),
    [linked],
  );
  const readable = linked.filter((issue) => projectFor(issue) !== null);
  const trees = useMemo(
    () =>
      mergeIssueTrees(
        linked.flatMap((issue) => {
          const detail = reads[threadIssueKey(issue)]?.detail;
          return detail && projectFor(issue) !== null
            ? [
                {
                  scope: `${issue.provider}:${issue.repository}`,
                  linkKey: threadIssueKey(issue),
                  detail,
                },
              ]
            : [];
        }),
      ),
    [linked, projectFor, reads],
  );
  const treePullRequests = useMemo(
    () => trees.flatMap((tree) => tree.rows.flatMap((row) => row.issue.linkedPullRequests ?? [])),
    [trees],
  );
  useEffect(() => onTreePullRequests?.(treePullRequests), [onTreePullRequests, treePullRequests]);
  const unread = linked.filter(
    (issue) => projectFor(issue) === null || !reads[threadIssueKey(issue)]?.detail,
  );

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {readable.map((issue) => (
        <LinkedIssueRead
          key={threadIssueKey(issue)}
          environmentId={environmentId}
          projectId={projectFor(issue)!}
          issue={issue}
          refreshToken={refreshToken}
          onRead={report}
        />
      ))}
      {trees.map((tree) => {
        const scopeIssue = byKey.get(tree.rows.find((row) => row.linkKey)!.linkKey!)!;
        return (
          <div
            key={tree.key}
            role="tree"
            aria-label={tree.rows[0]!.issue.title}
            className="space-y-0.5 rounded-lg border border-border/50 p-1"
          >
            {tree.rows.map((row) => {
              const linkedIssue = row.linkKey === null ? undefined : byKey.get(row.linkKey);
              return (
                <Fragment key={`${row.depth}:${row.issue.number}`}>
                  <div className="group relative">
                    <IssueTreeRow
                      row={{
                        issue: row.issue,
                        depth: row.depth,
                        current: linkedIssue !== undefined,
                      }}
                      repository={scopeIssue.repository}
                      onOpen={(relative) => onOpen(scopeIssue, relative.number)}
                      onOpenCurrent={() => onOpen(scopeIssue, row.issue.number)}
                    />
                    {linkedIssue && renderActions ? (
                      <div className="absolute top-1/2 right-1 -translate-y-1/2 rounded-md bg-background opacity-0 group-hover:opacity-100 has-[:focus-visible]:opacity-100 has-[[data-popup-open]]:opacity-100">
                        {renderActions(linkedIssue)}
                      </div>
                    ) : null}
                  </div>
                  <IssueTreePullRequestRows
                    links={row.issue.linkedPullRequests}
                    depth={row.depth}
                    onOpen={onOpenPullRequest}
                    renderPullRequest={renderPullRequest}
                  />
                </Fragment>
              );
            })}
          </div>
        );
      })}
      {unread.map((issue) => {
        const key = threadIssueKey(issue);
        if (reads[key]?.pending) {
          return (
            <div
              key={key}
              className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground"
            >
              <Spinner className="size-3.5" />
              <span className="min-w-0 flex-1 truncate">{issue.title}</span>
            </div>
          );
        }
        return (
          <div key={key}>
            {renderFallback?.(issue) ?? (
              <PlainIssueRow issue={issue} onOpen={() => onOpen(issue, issue.number)} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function threadIssueKey(issue: {
  readonly provider: string;
  readonly repository: string;
  readonly number: number;
}) {
  return `${issue.provider}:${issue.repository}#${issue.number}`;
}

function PlainIssueRow({ issue, onOpen }: { issue: ThreadIssueLink; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent/60"
    >
      <span className="min-w-0 flex-1 truncate">{issue.title}</span>
      <span className="shrink-0 text-muted-foreground tabular-nums">
        {issue.repository}-{issue.number}
      </span>
    </button>
  );
}

/** Reads one linked issue's tree and hands it up; the trees are drawn merged, above. */
function LinkedIssueRead({
  environmentId,
  projectId,
  issue,
  refreshToken,
  onRead,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  issue: ThreadIssueLink;
  refreshToken: number;
  onRead: (key: string, read: TreeRead) => void;
}) {
  const reference = useMemo(
    () => ({
      projectId,
      provider: issue.provider,
      repository: issue.repository,
      number: issue.number,
    }),
    [projectId, issue.provider, issue.repository, issue.number],
  );
  const detailQuery = useEnvironmentQuery(
    issueEnvironment.detail({ environmentId, input: reference }),
  );
  const invalidate = useAtomCommand(issueEnvironment.invalidate, { reportFailure: false });
  const { refresh } = detailQuery;
  const applied = useRef(refreshToken);
  useEffect(() => {
    if (applied.current === refreshToken) return;
    applied.current = refreshToken;
    // Around the server's cache, so a sub-issue filed a moment ago is in the answer.
    void Promise.resolve(invalidate({ environmentId, input: { reference } })).finally(refresh);
  }, [environmentId, invalidate, reference, refresh, refreshToken]);

  const detail = detailQuery.data ?? null;
  const pending = detail === null && detailQuery.isPending;
  const key = threadIssueKey(issue);
  useEffect(() => onRead(key, { detail, pending }), [detail, key, onRead, pending]);
  return null;
}
