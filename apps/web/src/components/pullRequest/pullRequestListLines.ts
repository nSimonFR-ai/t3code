import type { IssueLinkedPullRequest, ThreadPullRequestLink } from "@t3tools/contracts";
import type { ThreadPullRequestChain } from "@t3tools/shared/threadPullRequests";

/** One line of a thread's pull-request list: a link plus how deep it sits in its stack. */
export interface PullRequestListLine {
  readonly link: ThreadPullRequestLink;
  /** 0 for a pull request on the base branch; each layer above steps in by one. */
  readonly depth: number;
  /** Which chain the line belongs to, so callers can tell one stack's lines from another's. */
  readonly chainKey: string;
  /** Set on the bottom layer of a multi-layer stack, so that row can name the whole stack. */
  readonly stack: { readonly kind: ThreadPullRequestChain["kind"]; readonly size: number } | null;
}

function activityAt(link: ThreadPullRequestLink): number {
  const ms = Date.parse(link.snapshot?.updatedAt ?? link.linkedAt);
  return Number.isNaN(ms) ? 0 : ms;
}

function chainKeyOf(chain: ThreadPullRequestChain): string {
  const bottom = chain.layers[0]!;
  return `${bottom.host}/${bottom.repository}#${bottom.number}`;
}

/**
 * Flattens chains into indented lines, newest first. A stack sorts by its most recent layer and
 * then reads bottom to top beneath that slot, so the layer you would review first is at the
 * bottom of the indent and a fresh push anywhere in the stack floats the whole stack up.
 */
export function pullRequestListLines(
  chains: ReadonlyArray<ThreadPullRequestChain>,
): ReadonlyArray<PullRequestListLine> {
  const ordered = [...chains].sort(
    (left, right) =>
      Math.max(...right.layers.map(activityAt)) - Math.max(...left.layers.map(activityAt)),
  );
  return ordered.flatMap((chain) => {
    const chainKey = chainKeyOf(chain);
    return chain.layers.map((link, depth) => ({
      link,
      depth,
      chainKey,
      stack:
        depth === 0 && chain.layers.length > 1
          ? { kind: chain.kind, size: chain.layers.length }
          : null,
    }));
  });
}

export function pullRequestLineKey(
  link: Pick<ThreadPullRequestLink, "host" | "repository" | "number">,
): string {
  return `${link.host.toLowerCase()}/${link.repository.toLowerCase()}#${link.number}`;
}

/** The line key of a pull request an issue tracker reports, or null for an unreadable URL. */
export function trackerPullRequestLineKey(link: IssueLinkedPullRequest): string | null {
  const url = URL.parse(link.url);
  return url === null ? null : pullRequestLineKey({ host: url.host, ...link });
}

/**
 * The lines a linked issue's tree can show in its place: pull requests outside any stack that the
 * tracker also reports. A stacked layer stays in the list, where its chain reads as one piece.
 */
export function issueNestedPullRequestLines(
  lines: ReadonlyArray<PullRequestListLine>,
  trackerLinks: ReadonlyArray<IssueLinkedPullRequest>,
): ReadonlyMap<string, PullRequestListLine> {
  const chainSizes = new Map<string, number>();
  for (const line of lines) {
    chainSizes.set(line.chainKey, (chainSizes.get(line.chainKey) ?? 0) + 1);
  }
  const reported = new Set(trackerLinks.map(trackerPullRequestLineKey));
  return new Map(
    lines
      .filter((line) => chainSizes.get(line.chainKey) === 1)
      .map((line) => [pullRequestLineKey(line.link), line] as const)
      .filter(([key]) => reported.has(key)),
  );
}
