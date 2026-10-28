import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useEnvironmentScope } from "~/state/session";
import type { ScopedThreadRef, ThreadIssueLink } from "@t3tools/contracts";
import {
  ArrowUpRightIcon,
  CircleDotIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PanelRightOpenIcon,
  UnlinkIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { useIssueViewRefresh } from "~/hooks/useIssueViewRefresh";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { readLocalApi } from "~/localApi";
import { useRightPanelStore } from "~/rightPanelStore";
import { useThreadShell } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { issueEnvironment } from "~/state/issues";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { issueTrackerPresentation, IssueStateGlyph } from "../issue/issuePresentation";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

export function ThreadIssueRow({
  link,
  canUnlink,
  onOpen,
  onUnlink,
}: {
  link: ThreadIssueLink;
  canUnlink: boolean;
  onOpen: (link: ThreadIssueLink) => void;
  onUnlink: (link: ThreadIssueLink) => void;
}) {
  const tracker = issueTrackerPresentation(link.tracker);
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div
      className="group/issue-row relative flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/60"
      onContextMenu={(event) => {
        event.preventDefault();
        setMenuOpen(true);
      }}
    >
      {link.snapshot ? (
        <IssueStateGlyph state={link.snapshot.state} />
      ) : (
        <CircleDotIcon className="size-4 shrink-0" />
      )}
      <button
        type="button"
        className="flex min-w-0 flex-1 flex-col items-start text-left"
        onClick={() => onOpen(link)}
      >
        <span className="flex w-full min-w-0 items-center gap-1.5">
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            {link.snapshot?.displayKey ?? link.key}
          </span>
          <span className="min-w-0 truncate text-sm">{link.snapshot?.title ?? link.url}</span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
          <tracker.Icon aria-hidden className="size-3 shrink-0" />
          <span className="truncate">
            {tracker.providerName} · {link.snapshot?.state.name ?? "Not read yet"} · updated{" "}
            {formatRelativeTimeLabel(link.snapshot?.syncedAt ?? link.linkedAt)}
          </span>
        </span>
      </button>
      <span className="flex opacity-0 group-hover/issue-row:opacity-100 has-[:focus-visible]:opacity-100 has-[[data-popup-open]]:opacity-100">
        <Menu open={menuOpen} onOpenChange={setMenuOpen}>
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-micro"
                aria-label={`Actions for ${link.snapshot?.displayKey ?? link.key}`}
              >
                <MoreHorizontalIcon className="size-3.5" />
              </Button>
            }
          />
          <MenuPopup align="end">
            <MenuItem onClick={() => onOpen(link)}>
              <PanelRightOpenIcon className="size-3.5" />
              Open in panel
            </MenuItem>
            <MenuItem onClick={() => void readLocalApi()?.shell.openExternal(link.url)}>
              <ArrowUpRightIcon className="size-3.5" />
              Open in {tracker.providerName}
            </MenuItem>
            <MenuItem onClick={() => void writeTextToClipboard(link.url, "link")}>
              <LinkIcon className="size-3.5" />
              Copy link
            </MenuItem>
            {canUnlink ? (
              <MenuItem onClick={() => onUnlink(link)}>
                <UnlinkIcon className="size-3.5" />
                Unlink from thread
              </MenuItem>
            ) : null}
          </MenuPopup>
        </Menu>
      </span>
    </div>
  );
}

export interface ThreadIssueLinks {
  readonly items: ReadonlyArray<ThreadIssueLink>;
  /** False until the thread's shell has loaded. */
  readonly loaded: boolean;
  readonly error: string | null;
  readonly syncedAt: string | undefined;
  readonly canLink: boolean;
  readonly canUnlink: boolean;
  readonly openIssue: (link: ThreadIssueLink) => void;
  readonly unlink: (link: ThreadIssueLink) => void;
}

/**
 * The thread's linked issues, re-read from their trackers when the panel opens on a thread and
 * on focus. With `enabled` false (an environment without issues) nothing is read or listed.
 */
export function useThreadIssueLinks(
  threadRef: ScopedThreadRef,
  enabled: boolean,
): ThreadIssueLinks {
  const environmentId = threadRef.environmentId;
  const thread = useThreadShell(threadRef);
  const canRefresh =
    useAtomValue(issueEnvironment.refreshThreadLinks.permissionAtom(environmentId)) && enabled;
  const refresh = useAtomCommand(issueEnvironment.refreshThreadLinks, {
    reportFailure: false,
  });
  const unlinkCommand = useAtomCommand(threadEnvironment.unlinkIssue, { reportFailure: true });
  const canUnlink = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope) && enabled;
  const refreshedThread = useRef<string | null>(null);
  const threadKey = `${environmentId}:${threadRef.threadId}`;
  const [refreshError, setRefreshError] = useState({
    threadKey,
    canRefresh,
    error: null as string | null,
  });
  if (refreshError.threadKey !== threadKey || refreshError.canRefresh !== canRefresh)
    setRefreshError({ threadKey, canRefresh, error: null });
  const refreshLinks = () => {
    if (!canRefresh) return;
    void refresh({ environmentId, input: { threadId: threadRef.threadId } }).then((result) => {
      if (refreshedThread.current !== threadKey) return;
      setRefreshError({
        threadKey,
        canRefresh,
        error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
      });
    });
  };
  const refreshOnScopeChange = useEffectEvent(refreshLinks);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- re-reads the thread's issue snapshots from their trackers each time this panel opens on a thread
  useEffect(() => {
    refreshedThread.current = threadKey;
    if (canRefresh) refreshOnScopeChange();
  }, [canRefresh, threadKey]);
  useIssueViewRefresh(refreshLinks, [], threadKey);

  const items = enabled ? (thread?.issues ?? []) : [];
  return {
    items,
    loaded: thread !== null,
    error: refreshError.error,
    syncedAt: items
      .flatMap((link) => (link.snapshot ? [link.snapshot.syncedAt] : []))
      .toSorted()
      .at(-1),
    canLink: canUnlink,
    canUnlink,
    openIssue: (link) => useRightPanelStore.getState().openIssue(threadRef, link),
    unlink: (link) =>
      void unlinkCommand({ environmentId, input: { threadId: threadRef.threadId, ...link } }),
  };
}
