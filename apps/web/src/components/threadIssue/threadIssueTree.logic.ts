import {
  issueHostKey,
  type IssueHierarchyRelative,
  type IssueLinkedPullRequest,
  type IssueRelation,
  type IssueState,
  type ThreadIssueLink,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";

/** What a tree row shows. A linked issue not read yet has no state. */
export type ThreadIssueTreeIssue = Omit<IssueRelation, "state"> & {
  readonly state: IssueState | null;
};

/** A linked issue as read from its tracker: its parents from the top down and its children. */
export interface LinkedIssueRead {
  readonly link: ThreadIssueLink;
  readonly ancestors: ReadonlyArray<IssueHierarchyRelative>;
  readonly children: ReadonlyArray<IssueHierarchyRelative>;
  readonly pullRequests: ReadonlyArray<IssueLinkedPullRequest>;
}

export interface ThreadIssueTreeRow {
  readonly issue: ThreadIssueTreeIssue;
  readonly depth: number;
  /** Set on the issues linked to the thread. */
  readonly link: ThreadIssueLink | null;
  /** The link a relative is read through: its tracker, host, account and project. */
  readonly via: ThreadIssueLink;
  readonly pullRequests: ReadonlyArray<IssueLinkedPullRequest>;
}

export interface ThreadIssueTree {
  readonly key: string;
  readonly rows: ReadonlyArray<ThreadIssueTreeRow>;
}

type TreeIssue = ThreadIssueTreeIssue & Partial<Pick<IssueHierarchyRelative, "linkedPullRequests">>;

interface TreeNode {
  issue: ThreadIssueTreeIssue;
  link: ThreadIssueLink | null;
  via: ThreadIssueLink;
  pullRequests: ReadonlyArray<IssueLinkedPullRequest>;
  readonly children: Map<string, TreeNode>;
}

function identity(via: ThreadIssueLink, key: string) {
  return `${via.tracker}:${issueHostKey(via.host)}:${via.connectionId ?? ""}:${key.toLowerCase()}`;
}

export function linkedIssueOf(link: ThreadIssueLink): ThreadIssueTreeIssue {
  return {
    scope: link.scope,
    key: link.key,
    displayKey: link.snapshot?.displayKey ?? link.key,
    title: link.snapshot?.title ?? link.url,
    url: link.url,
    state: link.snapshot?.state ?? null,
  };
}

/**
 * One tree per top ancestor, so linked issues that share an epic read as one piece of work.
 * Each linked issue sits where it is in its tree, and an issue two linked trees reach is drawn
 * once. A parent one read knows extends another read's chain, so a linked issue and its linked
 * grandchild end up in the same tree even when the grandchild's read stopped short of the top.
 */
export function buildThreadIssueTrees(
  reads: ReadonlyArray<LinkedIssueRead>,
): ReadonlyArray<ThreadIssueTree> {
  // The issue above each one any read has seen, to extend a chain that stopped short of the top.
  const parents = new Map<string, TreeIssue>();
  for (const read of reads) {
    const self = linkedIssueOf(read.link);
    const chain: ReadonlyArray<TreeIssue> = [...read.ancestors, self];
    for (let index = 1; index < chain.length; index += 1) {
      parents.set(identity(read.link, chain[index]!.key), chain[index - 1]!);
    }
    for (const child of read.children) parents.set(identity(read.link, child.key), self);
  }

  const roots = new Map<string, TreeNode>();
  const place = (
    container: Map<string, TreeNode>,
    issue: TreeIssue,
    via: ThreadIssueLink,
  ): TreeNode => {
    const key = identity(via, issue.key);
    const existing = container.get(key);
    if (existing === undefined) {
      const created: TreeNode = {
        issue,
        link: null,
        via,
        pullRequests: issue.linkedPullRequests ?? [],
        children: new Map(),
      };
      container.set(key, created);
      return created;
    }
    // Keep whichever copy carries pull requests, which only some reads include.
    if (existing.pullRequests.length === 0 && (issue.linkedPullRequests?.length ?? 0) > 0) {
      existing.pullRequests = issue.linkedPullRequests!;
    }
    if (existing.issue.state === null && issue.state !== null) existing.issue = issue;
    return existing;
  };

  for (const read of reads) {
    const chain: Array<TreeIssue> = [...read.ancestors];
    const seen = new Set(chain.map((issue) => identity(read.link, issue.key)));
    seen.add(identity(read.link, read.link.key));
    let above = parents.get(identity(read.link, (chain[0] ?? read.link).key));
    while (above !== undefined && !seen.has(identity(read.link, above.key))) {
      seen.add(identity(read.link, above.key));
      chain.unshift(above);
      above = parents.get(identity(read.link, above.key));
    }
    let container = roots;
    for (const issue of chain) container = place(container, issue, read.link).children;
    const node = place(container, linkedIssueOf(read.link), read.link);
    node.link = read.link;
    node.via = read.link;
    if (read.pullRequests.length > 0) node.pullRequests = read.pullRequests;
    for (const child of read.children) {
      const childNode = place(node.children, child, read.link);
      for (const grandchild of child.children ?? [])
        place(childNode.children, grandchild, read.link);
    }
  }

  return [...roots].map(([key, root]) => {
    const rows: Array<ThreadIssueTreeRow> = [];
    const visit = (node: TreeNode, depth: number) => {
      rows.push({
        issue: node.issue,
        depth,
        link: node.link,
        via: node.via,
        pullRequests: node.pullRequests,
      });
      for (const child of node.children.values()) visit(child, depth + 1);
    };
    visit(root, 0);
    return { key, rows };
  });
}

function pullRequestUrlKey(url: string) {
  return url.trim().replace(/\/+$/u, "").toLowerCase();
}

/**
 * The pull requests a tree row lists, with the ones linked to the thread marked so the thread's
 * own change reads under the issue it closes. Each is shown once, under the first row listing it.
 */
export function treePullRequestRows(
  trees: ReadonlyArray<ThreadIssueTree>,
  threadPullRequests: ReadonlyArray<Pick<ThreadPullRequestLink, "url">>,
): ReadonlyMap<
  ThreadIssueTreeRow,
  ReadonlyArray<IssueLinkedPullRequest & { readonly inThread: boolean }>
> {
  const inThread = new Set(threadPullRequests.map((link) => pullRequestUrlKey(link.url)));
  const shown = new Set<string>();
  const byRow = new Map<
    ThreadIssueTreeRow,
    ReadonlyArray<IssueLinkedPullRequest & { readonly inThread: boolean }>
  >();
  for (const tree of trees) {
    for (const row of tree.rows) {
      const links = row.pullRequests.flatMap((link) => {
        const key = pullRequestUrlKey(link.url);
        if (shown.has(key)) return [];
        shown.add(key);
        return [{ ...link, inThread: inThread.has(key) }];
      });
      if (links.length > 0) byRow.set(row, links);
    }
  }
  return byRow;
}

/**
 * The thread's pull requests not already drawn under an issue in the trees, for the flat list
 * below them: each linked pull request shows once in the linked items panel.
 */
export function pullRequestsOutsideIssueTrees<P extends Pick<ThreadPullRequestLink, "url">>(
  threadPullRequests: ReadonlyArray<P>,
  pullRequestsByRow: ReturnType<typeof treePullRequestRows>,
): ReadonlyArray<P> {
  const nested = new Set<string>();
  for (const links of pullRequestsByRow.values()) {
    for (const link of links) if (link.inThread) nested.add(pullRequestUrlKey(link.url));
  }
  if (nested.size === 0) return threadPullRequests;
  return threadPullRequests.filter((link) => !nested.has(pullRequestUrlKey(link.url)));
}
