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
        closesIssue: true,
      },
      {
        repository: "acme/group/api",
        number: 7,
        title: "fix: api",
        url: "https://gitlab.com/acme/group/api/-/merge_requests/7",
        state: "merged",
        isDraft: false,
        closesIssue: true,
      },
      {
        repository: "acme/web",
        number: 9,
        title: "wip",
        url: "https://github.com/acme/web/pull/9",
        state: "open",
        isDraft: true,
        closesIssue: true,
      },
    ],
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
      events: [],
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

it.effect("carries a Linear issue's ancestors and nested sub-issues on its detail", () =>
  Effect.gen(function* () {
    const adapter = yield* make;
    const detail = yield* adapter.getIssue({
      cwd: PROJECT.workspaceRoot,
      host: "linear.app",
      repository: "ENG",
      number: 2,
    });
    assert.deepStrictEqual(
      detail.ancestors?.map((issue) => issue.number),
      [0, 1],
    );
    assert.deepStrictEqual(
      detail.subIssues?.map((issue) => [issue.number, issue.state, issue.subIssues.length]),
      [
        [3, "closed", 1],
        [4, "open", 0],
      ],
    );
    assert.strictEqual(detail.subIssues?.[0]?.subIssues[0]?.number, 5);
    assert.deepStrictEqual(
      detail.subIssues?.[0]?.linkedPullRequests?.map((link) => [link.number, link.state]),
      [[31, "merged"]],
    );
    assert.strictEqual(detail.subIssues?.[1]?.linkedPullRequests, undefined);
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
              parent: {
                number: 1,
                title: "Epic",
                url: "https://linear.app/acme/issue/ENG-1",
                state: { name: "In Progress", type: "started" },
                parent: {
                  number: 0,
                  title: "Initiative",
                  url: "https://linear.app/acme/issue/ENG-0",
                  state: { name: "In Progress", type: "started" },
                },
              },
              children: {
                nodes: [
                  {
                    number: 3,
                    title: "Done part",
                    url: "https://linear.app/acme/issue/ENG-3",
                    state: { name: "Done", type: "completed" },
                    attachments: {
                      nodes: [
                        {
                          url: "https://github.com/acme/web/pull/31",
                          title: "Done part",
                          sourceType: "github",
                          metadata: { status: "merged" },
                        },
                      ],
                    },
                    children: {
                      nodes: [
                        {
                          number: 5,
                          title: "Leaf",
                          url: "https://linear.app/acme/issue/ENG-5",
                          state: { name: "Todo", type: "unstarted" },
                        },
                      ],
                    },
                  },
                  {
                    number: 4,
                    title: "Open part",
                    url: "https://linear.app/acme/issue/ENG-4",
                    state: { name: "Todo", type: "unstarted" },
                  },
                ],
              },
            }),
        }),
        ServerSettings.layerTest({ issueTracking: { connections: { linear: {} } } } as never),
      ),
    ),
  ),
);

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
