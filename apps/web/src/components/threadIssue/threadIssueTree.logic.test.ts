import type {
  IssueHierarchyRelative,
  IssueLinkedPullRequest,
  ThreadIssueLink,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadIssueTrees,
  pullRequestsOutsideIssueTrees,
  treePullRequestRows,
} from "./threadIssueTree.logic";

const OPEN = { name: "Todo", category: "open" } as const;

function link(key: string): ThreadIssueLink {
  return {
    tracker: "linear",
    host: "linear.app",
    scope: "ENG",
    key,
    projectId: "project-1",
    url: `https://linear.app/acme/issue/${key}`,
    source: "manual",
    linkedAt: "2026-10-28T00:00:00.000Z",
    snapshot: {
      displayKey: key,
      title: `Issue ${key}`,
      state: OPEN,
      syncedAt: "2026-10-28T00:00:00.000Z",
    },
  } as unknown as ThreadIssueLink;
}

function relative(
  key: string,
  extra: Partial<IssueHierarchyRelative> = {},
): IssueHierarchyRelative {
  return {
    scope: "ENG",
    key,
    displayKey: key,
    title: `Issue ${key}`,
    url: `https://linear.app/acme/issue/${key}`,
    state: OPEN,
    ...extra,
  } as IssueHierarchyRelative;
}

function pullRequest(number: number): IssueLinkedPullRequest {
  return {
    repository: "acme/web",
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/web/pull/${number}`,
    state: "open",
    closesIssue: false,
  } as IssueLinkedPullRequest;
}

const shape = (trees: ReturnType<typeof buildThreadIssueTrees>) =>
  trees.map((tree) =>
    tree.rows.map((row) => `${"  ".repeat(row.depth)}${row.issue.key}${row.link ? "*" : ""}`),
  );

describe("buildThreadIssueTrees", () => {
  it("draws ancestors above a linked issue and its children and grandchildren below", () => {
    const trees = buildThreadIssueTrees([
      {
        link: link("ENG-3"),
        ancestors: [relative("ENG-1"), relative("ENG-2")],
        children: [relative("ENG-4", { children: [relative("ENG-5")] })],
        pullRequests: [],
      },
    ]);
    expect(shape(trees)).toEqual([
      ["ENG-1", "  ENG-2", "    ENG-3*", "      ENG-4", "        ENG-5"],
    ]);
  });

  it("merges linked issues that share an epic into one tree, drawing shared issues once", () => {
    const trees = buildThreadIssueTrees([
      { link: link("ENG-2"), ancestors: [relative("ENG-1")], children: [], pullRequests: [] },
      { link: link("ENG-3"), ancestors: [relative("ENG-1")], children: [], pullRequests: [] },
      { link: link("ENG-9"), ancestors: [], children: [], pullRequests: [] },
    ]);
    expect(shape(trees)).toEqual([["ENG-1", "  ENG-2*", "  ENG-3*"], ["ENG-9*"]]);
  });

  it("places a linked child under a linked parent even when the child's read stopped short", () => {
    const trees = buildThreadIssueTrees([
      {
        link: link("ENG-2"),
        ancestors: [relative("ENG-1")],
        children: [relative("ENG-3")],
        pullRequests: [],
      },
      { link: link("ENG-3"), ancestors: [], children: [], pullRequests: [] },
    ]);
    expect(shape(trees)).toEqual([["ENG-1", "  ENG-2*", "    ENG-3*"]]);
  });

  it("keeps the pull requests a relative's read carries and the linked issue's own", () => {
    const trees = buildThreadIssueTrees([
      {
        link: link("ENG-2"),
        ancestors: [],
        children: [relative("ENG-3", { linkedPullRequests: [pullRequest(7)] })],
        pullRequests: [pullRequest(5)],
      },
    ]);
    expect(trees[0]!.rows.map((row) => row.pullRequests.map((pr) => pr.number))).toEqual([
      [5],
      [7],
    ]);
  });
});

describe("treePullRequestRows", () => {
  it("marks the thread's own pull request under the issue that lists it, once", () => {
    const trees = buildThreadIssueTrees([
      {
        link: link("ENG-2"),
        ancestors: [relative("ENG-1", { linkedPullRequests: [pullRequest(7)] })],
        children: [relative("ENG-3", { linkedPullRequests: [pullRequest(7), pullRequest(8)] })],
        pullRequests: [],
      },
    ]);
    const rows = treePullRequestRows(trees, [{ url: "https://github.com/acme/web/pull/7/" }]);
    const listed = trees[0]!.rows.map((row) =>
      (rows.get(row) ?? []).map((pr) => `${pr.number}${pr.inThread ? "*" : ""}`),
    );
    expect(listed).toEqual([["7*"], [], ["8"]]);
  });
});

describe("pullRequestsOutsideIssueTrees", () => {
  it("keeps only the thread's pull requests no issue in the trees lists", () => {
    const trees = buildThreadIssueTrees([
      {
        link: link("ENG-2"),
        ancestors: [],
        children: [],
        pullRequests: [pullRequest(7), pullRequest(9)],
      },
    ]);
    const threadPullRequests = [
      { url: "https://github.com/acme/web/pull/7/" },
      { url: "https://github.com/acme/web/pull/8" },
    ];
    const byRow = treePullRequestRows(trees, threadPullRequests);
    expect(pullRequestsOutsideIssueTrees(threadPullRequests, byRow)).toEqual([
      { url: "https://github.com/acme/web/pull/8" },
    ]);
  });

  it("returns every pull request when no issue lists any of them", () => {
    const threadPullRequests = [{ url: "https://github.com/acme/web/pull/8" }];
    expect(pullRequestsOutsideIssueTrees(threadPullRequests, new Map())).toBe(threadPullRequests);
  });
});
