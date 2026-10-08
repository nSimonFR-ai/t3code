import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { OrchestrationProjectShell, ProjectId } from "@t3tools/contracts";

import * as ServerSettings from "../serverSettings.ts";
import * as LinearApi from "./LinearApi.ts";
import {
  linearIssueState,
  linearLinkedPullRequests,
  linearReactions,
  make,
} from "./LinearIssueProvider.ts";

const PROJECT: OrchestrationProjectShell = {
  id: "project-1" as ProjectId,
  title: "web",
  workspaceRoot: "/work/web",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-01T00:00:00Z",
};

it("maps Linear workflow states onto the neutral open/closed states", () => {
  assert.strictEqual(linearIssueState("started"), "open");
  assert.strictEqual(linearIssueState("completed"), "closed");
  assert.strictEqual(linearIssueState("canceled"), "closed");
  assert.strictEqual(linearIssueState("duplicate"), "closed");
});

it("reads pull requests from Linear's GitHub and GitLab attachments", () => {
  assert.deepStrictEqual(
    linearLinkedPullRequests([
      {
        url: "https://github.com/acme/web/pull/102",
        title: "feat: picker (ENG-63)",
        sourceType: "github",
        metadata: { status: "inReview", number: 102 },
      },
      {
        url: "https://gitlab.com/acme/group/api/-/merge_requests/7",
        title: "fix: api",
        sourceType: "gitlab",
        metadata: { status: "merged" },
      },
      { url: "https://github.com/acme/web/pull/9", title: "wip", metadata: { status: "draft" } },
      { url: "https://figma.com/file/abc", title: "Design", sourceType: "figma", metadata: {} },
    ]),
    [
      {
        repository: "acme/web",
        number: 102,
        title: "feat: picker (ENG-63)",
        url: "https://github.com/acme/web/pull/102",
        state: "open",
        isDraft: false,
        closesIssue: false,
      },
      {
        repository: "acme/group/api",
        number: 7,
        title: "fix: api",
        url: "https://gitlab.com/acme/group/api/-/merge_requests/7",
        state: "merged",
        isDraft: false,
        closesIssue: false,
      },
      {
        repository: "acme/web",
        number: 9,
        title: "wip",
        url: "https://github.com/acme/web/pull/9",
        state: "open",
        isDraft: true,
        closesIssue: false,
      },
    ],
  );
});

it("keeps reference-only Linear pull request attachments non-closing", () => {
  const links = linearLinkedPullRequests([
    {
      url: "https://github.com/acme/web/pull/12",
      title: "Refs ENG-63",
      sourceType: "github",
      metadata: { status: "merged", number: 12 },
    },
    {
      url: "https://github.com/acme/web/pull/13",
      title: "Related to ENG-63",
      sourceType: "github",
    },
  ]);
  assert.deepStrictEqual(
    links.map((link) => [link.number, link.closesIssue]),
    [
      [12, false],
      [13, false],
    ],
  );
});

it("deduplicates Linear attachments by PR identity and retains link order and status", () => {
  const links = linearLinkedPullRequests([
    {
      url: "https://github.com/Acme/Web/pull/7#issuecomment-9",
      title: "First",
      metadata: { status: "merged" },
    },
    { url: "https://github.com/acme/web/pull/8", title: "Second" },
    {
      url: "https://github.com/acme/web/pull/7?utm_source=linear",
      title: "Duplicate",
      metadata: { status: "closed" },
    },
    { url: "https://github.com/acme/web/pull/7", title: "Duplicate" },
    {
      url: "https://gitlab.com/acme/web/-/merge_requests/7",
      title: "GitLab",
      metadata: { status: "draft" },
    },
    { url: "https://github.com/acme/api/pull/7", title: "Other repository" },
    {
      url: "https://gitlab.com/acme/web/-/merge_requests/7#note_1",
      title: "Duplicate",
      metadata: { status: "merged" },
    },
  ]);

  assert.deepStrictEqual(
    links.map((link) => [link.title, link.url, link.state, link.isDraft]),
    [
      ["First", "https://github.com/Acme/Web/pull/7#issuecomment-9", "merged", false],
      ["Second", "https://github.com/acme/web/pull/8", "open", false],
      ["GitLab", "https://gitlab.com/acme/web/-/merge_requests/7", "open", true],
      ["Other repository", "https://github.com/acme/api/pull/7", "open", false],
    ],
  );
});

it("ignores invalid Linear PR attachment paths and numbers", () => {
  assert.deepStrictEqual(
    linearLinkedPullRequests(
      [
        "https://github.com/acme/web/pull/7abc",
        "https://github.com/acme/web/pull/7/not-a-pr",
        "https://gitlab.com/acme/web/-/merge_requests/7abc",
        "https://gitlab.com/acme/web/-/merge_requests/7/not-a-pr",
        "https://github.com/acme/web/pull/0",
        "https://github.com/acme/web/pull/9007199254740993",
      ].map((url) => ({ url, title: "Invalid" })),
    ),
    [],
  );
});

it("groups supported Linear emoji reactions and marks the viewer", () => {
  assert.deepStrictEqual(
    linearReactions(
      [
        { id: "r1", emoji: "👍", user: { id: "u1", name: "Ada" } },
        { id: "r2", emoji: "👍", user: { id: "u2", name: "Grace" } },
        { id: "r3", emoji: "🎉", user: { id: "u2", name: "Grace" } },
        { id: "r4", emoji: "🧵", user: { id: "u3", name: "Ignored" } },
      ],
      "u1",
    ),
    [
      { content: "thumbs-up", count: 2, actors: ["u1", "u2"], viewerHasReacted: true },
      { content: "hooray", count: 1, actors: ["u2"], viewerHasReacted: false },
    ],
  );
});

it.effect("reports duplicate issues as closed in linked summaries", () =>
  Effect.gen(function* () {
    const adapter = yield* make;
    const summary = yield* adapter.getIssueSummary!({
      cwd: PROJECT.workspaceRoot,
      host: "linear.app",
      repository: "ENG",
      number: 7,
    });
    assert.strictEqual(summary.state, "closed");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(LinearApi.LinearApi)({
          getIssueSummary: () =>
            Effect.succeed({
              number: 7,
              title: "Duplicate",
              url: "https://linear.app/acme/issue/ENG-7",
              state: { name: "Duplicate", type: "duplicate" },
            }),
        }),
        ServerSettings.layerTest({ issueTracking: { connections: { linear: {} } } } as never),
      ),
    ),
  ),
);

it.effect("uses Linear user ids for viewer-comparable issue actors", () => {
  const api = {
    listIssues: () =>
      Effect.succeed({
        issues: [
          {
            id: "issue-1",
            identifier: "ENG-7",
            number: 7,
            title: "Keep viewer identity stable",
            url: "https://linear.app/acme/issue/ENG-7",
            description: "",
            createdAt: "2026-08-17T00:00:00.000Z",
            updatedAt: "2026-08-17T00:00:00.000Z",
            state: { name: "Open", type: "started" },
            creator: { id: "user-1", name: "Ada", email: "ada@example.com" },
            assignee: { id: "user-2", name: "Grace", email: "grace@example.com" },
            labels: { nodes: [] },
          },
        ],
        truncated: false,
      }),
  } as unknown as LinearApi.LinearApi["Service"];

  return Effect.gen(function* () {
    const adapter = yield* make;
    const page = yield* adapter.listIssues({
      cwd: PROJECT.workspaceRoot,
      host: "linear.app",
      repository: "ENG",
      state: "open",
      involvement: "all",
      viewer: "user-1",
      limit: 99,
    });

    assert.strictEqual(page.items[0]?.author?.login, "user-1");
    assert.strictEqual(page.items[0]?.assignees[0]?.login, "user-2");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(LinearApi.LinearApi, api),
        ServerSettings.layerTest({ issueTracking: { connections: { linear: {} } } } as never),
      ),
    ),
  );
});

it.effect("maps Linear comment reaction arrays into issue activity", () => {
  const api = {
    getHistory: () => Effect.succeed({ nodes: [], truncated: false, nextCursor: null }),
    getActivity: () =>
      Effect.succeed({
        viewerId: "user-1",
        comments: [
          {
            id: "comment-1",
            body: "Looks good",
            createdAt: "2026-08-17T00:00:00.000Z",
            reactions: [{ id: "reaction-1", emoji: "👍", user: { id: "user-1" } }],
          },
        ],
        reactions: [
          { id: "reaction-2", emoji: "🎉", user: { id: "user-2" } },
          { id: "reaction-3", emoji: "🎉", user: null },
        ],
        commentsTruncated: false,
      }),
  } as unknown as LinearApi.LinearApi["Service"];

  return Effect.gen(function* () {
    const adapter = yield* make;
    const activity = yield* adapter.getIssueActivity({
      cwd: PROJECT.workspaceRoot,
      host: "linear.app",
      repository: "ENG",
      number: 7,
    });
    assert.deepStrictEqual(activity, {
      comments: [
        {
          id: "comment-1",
          author: null,
          body: "Looks good",
          createdAt: "2026-08-17T00:00:00.000Z",
          url: null,
          reactions: [
            { content: "thumbs-up", count: 1, actors: ["user-1"], viewerHasReacted: true },
          ],
        },
      ],
      commentCount: 1,
      commentsTruncated: false,
      nextCommentsCursor: null,
      events: [],
      eventsTruncated: false,
      nextEventsCursor: null,
      reactions: [{ content: "hooray", count: 2, actors: ["user-2"], viewerHasReacted: false }],
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(LinearApi.LinearApi, api),
        ServerSettings.layerTest({ issueTracking: { connections: { linear: {} } } } as never),
      ),
    ),
  );
});

it.effect(
  "continues Linear comment pages with the cursor, credential, and viewer reactions",
  () => {
    let asked: Parameters<LinearApi.LinearApi["Service"]["getActivity"]>[0] | undefined;
    const api = {
      getActivity: (input) => {
        asked = input;
        return Effect.succeed({
          viewerId: "user-1",
          comments: [
            {
              id: "comment-51",
              body: "Next page",
              createdAt: "2026-08-17T00:00:00.000Z",
              reactions: [{ id: "reaction-1", emoji: "👍", user: { id: "user-1" } }],
            },
          ],
          reactions: [],
          commentsTruncated: false,
          nextCommentsCursor: null,
        });
      },
    } satisfies Partial<LinearApi.LinearApi["Service"]>;
    return Effect.gen(function* () {
      const adapter = yield* make;
      const page = yield* adapter.getIssueComments!({
        cwd: PROJECT.workspaceRoot,
        host: "linear.app",
        repository: "ENG",
        number: 7,
        credentialId: "account-1",
        cursor: "cursor-50",
      });
      assert.deepStrictEqual(asked, {
        identifier: "ENG-7",
        credentialId: "account-1",
        cursor: "cursor-50",
      });
      assert.strictEqual(page.nextCursor, null);
      assert.deepStrictEqual(page.comments[0]?.reactions, [
        { content: "thumbs-up", count: 1, actors: ["user-1"], viewerHasReacted: true },
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(LinearApi.LinearApi)(api),
          ServerSettings.layerTest({ issueTracking: { connections: { linear: {} } } } as never),
        ),
      ),
    );
  },
);

it.effect("uses the project binding credential for Linear requests", () => {
  const asked: Array<string | undefined> = [];
  const api = {
    getViewer: (input: { readonly credentialId?: string }) => {
      asked.push(input.credentialId);
      return Effect.succeed({ id: "user-1" });
    },
  } as unknown as LinearApi.LinearApi["Service"];

  return Effect.gen(function* () {
    const adapter = yield* make;
    const source = yield* adapter.resolveSource!(PROJECT);
    assert.deepStrictEqual(source, {
      host: "linear.app",
      repository: "ENG",
      credentialId: "user-1",
    });

    yield* (
      adapter.getViewer as (input: {
        readonly cwd: string;
        readonly host: string;
        readonly credentialId: string;
      }) => Effect.Effect<string>
    )({
      cwd: PROJECT.workspaceRoot,
      host: "linear.app",
      credentialId: "user-1",
    });
    assert.deepStrictEqual(asked, ["user-1"]);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(LinearApi.LinearApi, api),
        ServerSettings.layerTest({
          issueTracking: {
            connections: {
              linear: {
                projectBindings: {
                  "project-1": { credentialId: "user-1", repository: "ENG" },
                },
              },
            },
          },
        } as never),
      ),
    ),
  );
});

it.effect("reads an explicit environment-account project binding", () =>
  Effect.gen(function* () {
    const adapter = yield* make;
    assert.deepStrictEqual(yield* adapter.resolveSource!(PROJECT), {
      host: "linear.app",
      repository: "ENG",
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(LinearApi.LinearApi, {} as LinearApi.LinearApi["Service"]),
        ServerSettings.layerTest({
          issueTracking: {
            connections: { linear: { projectBindings: { [PROJECT.id]: { repository: "ENG" } } } },
          },
        }),
      ),
    ),
  ),
);

it.effect("does not resolve a cleared project binding", () =>
  Effect.gen(function* () {
    const adapter = yield* make;
    assert.isNull(yield* adapter.resolveSource!(PROJECT));
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(LinearApi.LinearApi, {} as LinearApi.LinearApi["Service"]),
        ServerSettings.layerTest({
          issueTracking: {
            connections: {
              linear: {
                projectBindings: { [PROJECT.id]: null },
              },
            },
          },
        }),
      ),
    ),
  ),
);

it.effect("carries mixed-team ancestors and same-number sub-issues on a Linear detail", () => {
  const attachments = {
    nodes: [
      {
        url: "https://github.com/acme/web/pull/31",
        title: "Done part",
        sourceType: "github",
        metadata: { status: "merged" },
      },
      { url: "https://github.com/acme/web/pull/31#issuecomment-9", title: "Duplicate" },
    ],
  };
  return Effect.gen(function* () {
    const adapter = yield* make;
    const detail = yield* adapter.getIssue({
      cwd: PROJECT.workspaceRoot,
      host: "linear.app",
      repository: "ENG",
      number: 2,
    });
    assert.deepStrictEqual(
      detail.ancestors?.map((issue) => [issue.repository, issue.number]),
      [
        ["OPS", 0],
        ["ENG", 1],
      ],
    );
    assert.deepStrictEqual(
      detail.subIssues?.map((issue) => [
        issue.repository,
        issue.number,
        issue.state,
        issue.subIssues.length,
      ]),
      [
        ["ENG", 3, "closed", 1],
        ["OPS", 3, "open", 0],
      ],
    );
    assert.strictEqual(detail.subIssues?.[0]?.subIssues[0]?.number, 5);
    assert.strictEqual(detail.subIssues?.[0]?.subIssues[0]?.repository, "OPS");
    assert.strictEqual(detail.subIssues?.[1]?.url, "https://linear.app/acme/issue/OPS-3");
    assert.deepStrictEqual(
      detail.subIssues?.[0]?.linkedPullRequests?.map((link) => [link.number, link.state]),
      [[31, "merged"]],
    );
    for (const links of [
      detail.linkedPullRequests,
      detail.ancestors?.[0]?.linkedPullRequests,
      detail.ancestors?.[1]?.linkedPullRequests,
      detail.subIssues?.[0]?.subIssues[0]?.linkedPullRequests,
    ]) {
      assert.deepStrictEqual(
        links?.map((link) => [link.number, link.state]),
        [[31, "merged"]],
      );
    }
    assert.strictEqual(detail.subIssues?.[1]?.linkedPullRequests, undefined);
    assert.strictEqual(detail.linkedPullRequestsTruncated, false);
    assert.strictEqual(detail.nextLinkedPullRequestsCursor, null);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(LinearApi.LinearApi)({
          getIssue: () =>
            Effect.succeed({
              id: "issue-2",
              identifier: "ENG-2",
              number: 2,
              title: "Slice",
              url: "https://linear.app/acme/issue/ENG-2",
              description: null,
              createdAt: "2026-08-17T00:00:00.000Z",
              updatedAt: "2026-08-17T00:00:00.000Z",
              state: { name: "Todo", type: "unstarted" },
              attachments,
              parent: {
                number: 1,
                team: { key: "ENG" },
                title: "Epic",
                url: "https://linear.app/acme/issue/ENG-1",
                state: { name: "In Progress", type: "started" },
                attachments,
                parent: {
                  number: 0,
                  team: { key: "OPS" },
                  title: "Initiative",
                  url: "https://linear.app/acme/issue/OPS-0",
                  state: { name: "In Progress", type: "started" },
                  attachments,
                },
              },
              children: {
                nodes: [
                  {
                    number: 3,
                    team: { key: "ENG" },
                    title: "Done part",
                    url: "https://linear.app/acme/issue/ENG-3",
                    state: { name: "Done", type: "completed" },
                    attachments,
                    children: {
                      nodes: [
                        {
                          number: 5,
                          team: { key: "OPS" },
                          title: "Leaf",
                          url: "https://linear.app/acme/issue/OPS-5",
                          state: { name: "Todo", type: "unstarted" },
                          attachments,
                        },
                      ],
                    },
                  },
                  {
                    number: 3,
                    team: { key: "OPS" },
                    title: "Open part",
                    url: "https://linear.app/acme/issue/OPS-3",
                    state: { name: "Todo", type: "unstarted" },
                  },
                ],
              },
            }),
        }),
        ServerSettings.layerTest({ issueTracking: { connections: { linear: {} } } } as never),
      ),
    ),
  );
});

it.effect.each(["user-1", "late-user", null])(
  "offers single-assignee writes and reports assigned candidate %s",
  (assignedId) =>
    Effect.gen(function* () {
      const adapter = yield* make;
      assert.strictEqual(adapter.capabilities.maxAssignees, 1);
      assert.strictEqual(adapter.capabilities.typedAssignees, true);
      assert.strictEqual(adapter.capabilities.create, true);
      assert.strictEqual(adapter.capabilities.editComment, true);
      const target = {
        cwd: PROJECT.workspaceRoot,
        host: "linear.app",
        repository: "ENG",
        number: 7,
        credentialId: "account-1",
      };
      const labels = yield* adapter.listLabelCandidates(target);
      assert.deepStrictEqual(labels, {
        candidates: [
          { name: "Bug", color: "#ff0000", description: "Team bug", isApplied: true },
          { name: "Shared", color: "#0000ff", description: null, isApplied: false },
        ],
        truncated: false,
      });
      const assignees = yield* adapter.listAssigneeCandidates(target);
      assert.deepStrictEqual(assignees, {
        candidates: [
          {
            id: "user-1",
            login: "user-1",
            name: "Ada",
            avatarUrl: null,
            isAssigned: assignedId === "user-1",
          },
          { id: "user-2", login: "user-2", name: "Grace", avatarUrl: null, isAssigned: false },
          ...(assignedId === "late-user"
            ? [
                {
                  id: "late-user",
                  login: "late-user",
                  name: "Ada",
                  avatarUrl: null,
                  isAssigned: true,
                },
              ]
            : []),
        ],
        truncated: true,
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(LinearApi.LinearApi)({
            listLabels: (input) => {
              assert.deepStrictEqual(input, { teamKey: "ENG", credentialId: "account-1" });
              return Effect.succeed({
                nodes: [
                  {
                    id: "bug",
                    name: "Bug",
                    color: "#ff0000",
                    description: "Team bug",
                    team: { id: "eng", key: "ENG", name: "Engineering" },
                  },
                  { id: "global", name: "Shared", color: "#0000ff", description: null, team: null },
                ],
                truncated: false,
              });
            },
            listAssignees: (input) => {
              assert.deepStrictEqual(input, { teamKey: "ENG", credentialId: "account-1" });
              return Effect.succeed({
                nodes: [
                  { id: "user-1", name: "Ada" },
                  { id: "user-2", name: "Grace" },
                ],
                truncated: true,
              });
            },
            getIssueSelection: (input) => {
              assert.deepStrictEqual(input, { identifier: "ENG-7", credentialId: "account-1" });
              return Effect.succeed({
                id: "issue-7",
                assignee: assignedId === null ? null : { id: assignedId, name: "Ada" },
                labels: { nodes: [{ id: "bug", name: "Bug" }] },
              });
            },
          }),
          ServerSettings.layerTest(),
        ),
      ),
    ),
);

it.effect.each([2, 400])(
  "keeps applied archived labels selectable and removable with %s listed labels",
  (count) => {
    const nodes = Array.from({ length: count }, (_, index) => ({
      id: `label-${index}`,
      name: index === 0 ? "Bug" : `Label ${index}`,
      color: "#ff0000",
      description: "Native description",
      team: null,
    }));
    const writes: ReadonlyArray<string>[] = [];
    return Effect.gen(function* () {
      const adapter = yield* make;
      const target = {
        cwd: PROJECT.workspaceRoot,
        host: "linear.app",
        repository: "ENG",
        number: 7,
      };
      const labels = yield* adapter.listLabelCandidates(target);
      assert.strictEqual(labels.candidates.length, count + 1);
      assert.strictEqual(labels.truncated, count === 400);
      assert.deepStrictEqual(labels.candidates[0], {
        name: "Bug",
        color: "#ff0000",
        description: "Native description",
        isApplied: true,
      });
      assert.deepStrictEqual(labels.candidates.at(-1), {
        name: "Old archived",
        color: count === 400 ? null : "#0000ff",
        description: null,
        isApplied: true,
      });
      const applied = labels.candidates
        .filter((label) => label.isApplied)
        .map((label) => label.name);
      assert.deepStrictEqual(applied, ["Bug", "Old archived"]);
      yield* adapter.setLabels({ ...target, labels: [...applied, "Label 1"] });
      yield* adapter.setLabels({
        ...target,
        labels: [...applied.filter((name) => name !== "Old archived"), "Label 1"],
      });
      assert.deepStrictEqual(writes, [
        ["Bug", "Old archived", "Label 1"],
        ["Bug", "Label 1"],
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(LinearApi.LinearApi)({
            listLabels: () => Effect.succeed({ nodes, truncated: count === 400 }),
            getIssueSelection: () =>
              Effect.succeed({
                id: "issue-7",
                assignee: null,
                labels: {
                  nodes: [
                    { id: "other-bug", name: "Bug", color: "#000000" },
                    {
                      id: "archived",
                      name: "Old archived",
                      ...(count === 400 ? {} : { color: "#0000ff" }),
                    },
                  ],
                },
              }),
            setLabels: (input) =>
              Effect.sync(() => {
                writes.push(input.labels);
              }),
          }),
          ServerSettings.layerTest(),
        ),
      ),
    );
  },
);

it.effect("maps native history into real state, label, assignment, and title events", () => {
  const empty = {
    actor: null,
    fromState: null,
    toState: null,
    fromAssignee: null,
    toAssignee: null,
    addedLabels: null,
    removedLabels: null,
    fromTitle: null,
    toTitle: null,
  };
  return Effect.gen(function* () {
    const adapter = yield* make;
    const activity = yield* adapter.getIssueActivity({
      cwd: PROJECT.workspaceRoot,
      host: "linear.app",
      repository: "ENG",
      number: 7,
      credentialId: "account-1",
    });
    assert.deepStrictEqual(
      activity.events.map((event) => [event.kind, event.detail, event.actor?.login ?? null]),
      [
        ["assigned", "Grace", "user-1"],
        ["closed", "Canceled", "user-1"],
        ["labeled", "Bug", "user-1"],
        ["renamed", "New title", "user-1"],
        ["unassigned", "Ada", "user-1"],
        ["unlabeled", "Old", "user-1"],
        ["reopened", "Doing", null],
      ],
    );
    assert.strictEqual(new Set(activity.events.map((event) => event.id)).size, 7);
    assert.strictEqual(activity.comments[0]?.body, "Still here");
    assert.strictEqual(activity.reactions?.[0]?.viewerHasReacted, true);
    assert.strictEqual(activity.nextCommentsCursor, "next-comments");
    assert.strictEqual(activity.eventsTruncated, true);
    assert.strictEqual(activity.nextEventsCursor, "next-events");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(LinearApi.LinearApi)({
          getActivity: () =>
            Effect.succeed({
              viewerId: "user-1",
              comments: [
                { id: "comment", body: "Still here", createdAt: "2026-10-01T00:00:00.000Z" },
              ],
              reactions: [{ id: "r", emoji: "👍", user: { id: "user-1" } }],
              commentsTruncated: true,
              nextCommentsCursor: "next-comments",
            }),
          getHistory: (input) => {
            assert.deepStrictEqual(input, { identifier: "ENG-7", credentialId: "account-1" });
            return Effect.succeed({
              nodes: [
                {
                  ...empty,
                  id: "reopen",
                  createdAt: "2026-10-02T00:00:00.000Z",
                  fromState: { name: "Done", type: "completed" },
                  toState: { name: "Doing", type: "started" },
                },
                {
                  ...empty,
                  id: "change",
                  createdAt: "2026-10-01T00:00:00.000Z",
                  actor: { id: "user-1" },
                  fromState: { name: "Doing", type: "started" },
                  toState: { name: "Canceled", type: "canceled" },
                  addedLabels: [{ name: "Bug" }],
                  removedLabels: [{ name: "Old" }],
                  fromAssignee: { id: "user-1", name: "Ada" },
                  toAssignee: { id: "user-2", name: "Grace" },
                  fromTitle: "Old title",
                  toTitle: "New title",
                },
                {
                  ...empty,
                  id: "same-closed",
                  createdAt: "2026-10-01T00:00:00.000Z",
                  fromState: { name: "Done", type: "completed" },
                  toState: { name: "Duplicate", type: "duplicate" },
                },
              ],
              truncated: true,
              nextCursor: "next-events",
            });
          },
        }),
        ServerSettings.layerTest(),
      ),
    ),
  );
});

it.effect("continues native events without reading comments or issue details", () => {
  let reads = 0;
  return Effect.gen(function* () {
    const adapter = yield* make;
    const page = yield* adapter.getIssueEvents({
      cwd: PROJECT.workspaceRoot,
      host: "linear.app",
      repository: "ENG",
      number: 7,
      credentialId: "account-1",
      cursor: "page-50",
    });
    assert.deepStrictEqual(page, {
      events: [
        {
          id: "history:renamed:0",
          kind: "renamed",
          actor: null,
          createdAt: "2026-10-01T00:00:00.000Z",
          detail: "New title",
        },
      ],
      nextCursor: null,
      truncated: false,
    });
    assert.strictEqual(reads, 1);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(LinearApi.LinearApi)({
          getHistory: (input) => {
            reads++;
            assert.deepStrictEqual(input, {
              identifier: "ENG-7",
              credentialId: "account-1",
              cursor: "page-50",
            });
            return Effect.succeed({
              nodes: [
                {
                  id: "history",
                  createdAt: "2026-10-01T00:00:00.000Z",
                  actor: null,
                  fromState: null,
                  toState: null,
                  fromAssignee: null,
                  toAssignee: null,
                  addedLabels: null,
                  removedLabels: null,
                  fromTitle: "Old title",
                  toTitle: "New title",
                },
              ],
              truncated: false,
              nextCursor: null,
            });
          },
        }),
        ServerSettings.layerTest(),
      ),
    ),
  );
});

it.effect("continues an empty attachment page using its native cursor", () => {
  return Effect.gen(function* () {
    const adapter = yield* make;
    const page = yield* adapter.getIssueLinkedPullRequests({
      cwd: PROJECT.workspaceRoot,
      host: "linear.app",
      repository: "ENG",
      number: 7,
      credentialId: "account-1",
      cursor: "page-50",
    });
    assert.deepStrictEqual(page, {
      linkedPullRequests: [],
      nextCursor: "page-100",
      truncated: true,
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(LinearApi.LinearApi)({
          getAttachments: (input) => {
            assert.deepStrictEqual(input, {
              identifier: "ENG-7",
              credentialId: "account-1",
              cursor: "page-50",
            });
            return Effect.succeed({
              nodes: [{ url: "https://figma.com/file/design", title: "Design" }],
              nextCursor: "page-100",
              truncated: true,
            });
          },
        }),
        ServerSettings.layerTest(),
      ),
    ),
  );
});

it.effect.each(["events", "attachments"] as const)(
  "preserves a Linear quota failure when %s continuation is denied",
  (kind) => {
    const failure = new LinearApi.LinearApiError({
      operation: "issue history",
      reason: "rate-limited",
      retryAt: 61000,
    });
    return Effect.gen(function* () {
      const adapter = yield* make;
      const reference = {
        cwd: PROJECT.workspaceRoot,
        host: "linear.app",
        repository: "ENG",
        number: 7,
        cursor: "page-50",
      };
      const error = yield* kind === "events"
        ? adapter.getIssueEvents(reference).pipe(Effect.flip)
        : adapter.getIssueLinkedPullRequests(reference).pipe(Effect.flip);
      assert.strictEqual(
        error.operation,
        kind === "events" ? "getIssueEvents" : "getIssueLinkedPullRequests",
      );
      assert.strictEqual(error.reason, "rate-limited");
      assert.strictEqual(error.retryAt, 61000);
      assert.strictEqual(error.cause, failure);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(LinearApi.LinearApi)({
            getHistory: () => Effect.fail(failure),
            getAttachments: () => Effect.fail(failure),
          }),
          ServerSettings.layerTest(),
        ),
      ),
    );
  },
);

it.effect("preserves a Linear quota failure when a workflow write is denied", () => {
  const failure = new LinearApi.LinearApiError({
    operation: "workflow states",
    reason: "rate-limited",
    retryAt: 61000,
  });
  return Effect.gen(function* () {
    const adapter = yield* make;
    const error = yield* adapter
      .runAction({
        cwd: PROJECT.workspaceRoot,
        host: "linear.app",
        repository: "ENG",
        number: 7,
        action: "close",
      })
      .pipe(Effect.flip);
    assert.strictEqual(error.operation, "runAction");
    assert.strictEqual(error.retryAt, 61000);
    assert.strictEqual(error.cause, failure);
    assert.strictEqual(error.reason, "rate-limited");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(LinearApi.LinearApi)({ runAction: () => Effect.fail(failure) }),
        ServerSettings.layerTest(),
      ),
    ),
  );
});

it.effect.each([
  ["canceled", "not-planned"],
  ["completed", "completed"],
  ["started", null],
] as const)("maps native %s state reason in detail and list", ([type, reason]) => {
  const issue = {
    id: "issue-7",
    identifier: "ENG-7",
    number: 7,
    title: "Issue",
    url: "https://linear.app/acme/issue/ENG-7",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
    state: { name: type, type },
  };
  return Effect.gen(function* () {
    const adapter = yield* make;
    const target = { cwd: PROJECT.workspaceRoot, host: "linear.app", repository: "ENG", number: 7 };
    assert.strictEqual((yield* adapter.getIssue(target)).stateReason, reason);
    const page = yield* adapter.listIssues({
      ...target,
      state: "all",
      involvement: "all",
      viewer: "user-1",
      limit: 10,
    });
    assert.strictEqual(page.items[0]?.stateReason, reason);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(LinearApi.LinearApi)({
          getIssue: () => Effect.succeed(issue),
          listIssues: () => Effect.succeed({ issues: [issue], truncated: false }),
        }),
        ServerSettings.layerTest(),
      ),
    ),
  );
});

it.effect("resolves a named team to the connected account that can read it", () =>
  Effect.gen(function* () {
    let connectionReads = 0;
    const account = (credentialId: string, keys: ReadonlyArray<string>) => ({
      credentialId,
      status: "authenticated" as const,
      accountName: credentialId,
      accountEmail: null,
      projects: keys.map((key) => ({ id: key, key, name: key })),
    });
    const adapter = yield* make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(LinearApi.LinearApi)({
            connection: Effect.sync(() => {
              connectionReads += 1;
              return {
                status: "authenticated" as const,
                hasStoredToken: true,
                accountName: "first",
                accountEmail: null,
                projects: [],
                accounts: [account("first", ["ENG"]), account("second", ["CO"])],
              };
            }),
          }),
          ServerSettings.layerTest({ issueTracking: { connections: { linear: {} } } } as never),
        ),
      ),
    );

    assert.deepStrictEqual(yield* adapter.resolveReference!(PROJECT, "co"), {
      host: "linear.app",
      repository: "CO",
      credentialId: "second",
    });
    yield* adapter.resolveReference!(PROJECT, "CO");
    assert.strictEqual(connectionReads, 1);
    assert.isNull(yield* adapter.resolveReference!(PROJECT, "OPS"));
    assert.isNull(yield* adapter.resolveReference!(PROJECT, "acme/web"));
    assert.strictEqual(connectionReads, 2);
  }),
);
