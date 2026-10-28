import { makeIssueDetail } from "./issue-test-fixtures";
import { createIssueTestRoot } from "./issue-testkit";
import { act, type ReactNode } from "react";
import * as Effect from "effect/Effect";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { IssueOperationError, WS_METHODS, type IssueDetail } from "@t3tools/contracts";
import { Alert, Linking } from "react-native";
import type {
  EnvironmentRegistry as Registry,
  EnvironmentSupervisor as Supervisor,
} from "@t3tools/client-runtime/connection";
import * as RpcClient from "../../../../../packages/client-runtime/src/rpc/client";

type Props = { readonly children?: ReactNode; readonly onPress?: () => void };

const harness = vi.hoisted(() => ({
  focus: () => {},
  back: 0,
  command: (() => undefined) as (input: unknown) => unknown,
  projects: new Map<string, { workspaceRoot: string }>(),
  assets: [] as Array<{ environmentId: unknown; resource: unknown }>,
  scroll: () => {},
  setState: false,
  menus: new Map<
    string,
    {
      actions: ReadonlyArray<{ id: string }>;
      onPressAction: (event: { nativeEvent: { event: string } }) => void;
    }
  >(),
}));

vi.mock("react-native", () => ({
  ActivityIndicator: () => null,
  Alert: { alert: vi.fn() },
  Linking: { openURL: vi.fn() },
  Platform: { OS: "ios" },
  Pressable: ({
    children,
    onPress,
    disabled,
    accessibilityLabel,
  }: Props & { disabled?: boolean; accessibilityLabel?: string }) => (
    <button aria-label={accessibilityLabel} disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
  RefreshControl: () => null,
  ScrollView: ({ children, onScroll }: Props & { onScroll: (event: unknown) => void }) => {
    harness.scroll = () =>
      onScroll({
        nativeEvent: {
          contentOffset: { y: 1000 },
          layoutMeasurement: { height: 500 },
          contentSize: { height: 1200 },
        },
      });
    return children;
  },
  View: ({ children }: Props) => children,
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
  useFocusEffect: (effect: () => void) => {
    harness.focus = effect;
  },
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../components/ui/AppText", () => ({ AppText: ({ children }: Props) => children }));
vi.mock("../../components/ui/AndroidScreenHeader", () => ({ AndroidScreenHeader: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/Menu", () => ({
  Menu: ({
    title,
    children,
    actions,
    onPressAction,
  }: Props & {
    title: string;
    actions: ReadonlyArray<{ id: string }>;
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
  }) => {
    harness.menus.set(title, { actions, onPressAction });
    return children;
  },
}));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../../components/ui/Toolbar", () => ({
  Toolbar: Object.assign(() => null, {
    Menu: () => null,
    MenuAction: () => null,
    Label: () => null,
  }),
}));
vi.mock("../../native/useOpenPullRequest", () => ({ useOpenPullRequest: () => vi.fn() }));
vi.mock("../../state/entities", () => ({
  useProjects: () => [],
  useServerConfigs: () => new Map(),
  useProject: (ref: { environmentId: string; projectId: string } | null) =>
    ref ? (harness.projects.get(`${ref.environmentId}:${ref.projectId}`) ?? null) : null,
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => (input: unknown) => harness.command(input),
}));
vi.mock("../../state/assets", () => ({
  useAssetUrlState: (environmentId: unknown, resource: { url: string } | null) => {
    if (resource) harness.assets.push({ environmentId, resource });
    return resource ? { _tag: "Success", url: `signed:${resource.url}` } : { _tag: "Initial" };
  },
  useRefreshAssetUrl: () => async () => null,
}));
vi.mock("expo-image", () => ({ Image: () => null }));
vi.mock("../../components/MediaVideoPlayer", () => ({ MediaVideoPlayer: () => null }));
vi.mock("../../components/VideoAttachmentTile", () => ({ VideoAttachmentTile: () => null }));
vi.mock("../../components/VideoPreviewModal", () => ({ VideoPreviewModal: () => null }));
vi.mock("../../components/FilePreviewModal", () => ({ FilePreviewModal: () => null }));
vi.mock("../../components/FilePreviewGallery", () => ({
  useFilePreviewGallery: () => (item: unknown) => item,
}));
vi.mock("../threads/ThreadMarkdownImage", () => ({ ThreadMarkdownImageView: () => null }));
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({ layout: { usesSplitView: false } }),
}));
vi.mock("../layout/workspace-sidebar-toolbar", () => ({
  AndroidWorkspaceSidebarButton: () => null,
}));
vi.mock("../workspace/useAndroidWorkspaceNavigation", () => ({
  useAndroidWorkspaceBack: () => () => harness.back++,
}));
vi.mock("../pull-requests/PullRequestControls", () => ({
  PullRequestCardGroup: ({ children }: Props) => children,
  PullRequestCardRow: ({ title }: { title: string }) => <span>{title}</span>,
}));
vi.mock("../pull-requests/PullRequestMarkdown", async () => {
  const { usePullRequestMediaUrl } = await import("../pull-requests/PullRequestMedia");
  const { markdownImageSources } = await import("../../lib/markdownImageSources");
  function MarkdownImage({ url }: { readonly url: string }) {
    return <i data-uri={usePullRequestMediaUrl(url).uri ?? ""} />;
  }
  return {
    PullRequestMarkdown: ({ markdown }: { readonly markdown: string }) => (
      <>
        <span>{markdown}</span>
        {markdownImageSources(markdown).map((url) => (
          <MarkdownImage key={url} url={url} />
        ))}
      </>
    ),
  };
});
vi.mock("../pull-requests/PullRequestPresentation", () => ({ PullRequestAvatar: () => null }));
vi.mock("./useIssueAccess", async () => {
  const { issueAccess } = await import("./issueDetail");
  const grants = { connected: true, comment: false, update: false, react: false };
  return {
    issueTarget: ({ environmentId, ...input }: Record<string, string>) => ({
      environmentId,
      input,
    }),
    markIssueTargetWritten: vi.fn(),
    useIssueAccess: (_params: unknown, detail: IssueDetail | null) => ({
      connected: true,
      ...issueAccess(detail, { ...grants, setState: harness.setState }),
    }),
  };
});
vi.mock("../../state/issues", async () => {
  const { AVAILABLE_CONNECTION_STATE, EnvironmentRegistry, EnvironmentSupervisor } =
    await import("@t3tools/client-runtime/connection");
  const { createIssueEnvironmentAtoms } = await import("@t3tools/client-runtime/state/issues");
  const Effect = await import("effect/Effect");
  const Layer = await import("effect/Layer");
  const Option = await import("effect/Option");
  const Stream = await import("effect/Stream");
  const SubscriptionRef = await import("effect/SubscriptionRef");
  const { Atom } = await import("effect/reactivity");
  const { createIssuePagedQuery } = await import("@t3tools/client-runtime/issue-pages");
  const { use } = await import("react");
  const { RegistryContext } = await import("@effect/atom-react");
  const environments = Layer.effect(
    EnvironmentRegistry.EnvironmentRegistry,
    Effect.gen(function* () {
      const supervisor = {
        state: yield* SubscriptionRef.make({
          ...AVAILABLE_CONNECTION_STATE,
          phase: "connected" as const,
        }),
        session: yield* SubscriptionRef.make(Option.some({})),
      } as unknown as Supervisor.EnvironmentSupervisor["Service"];
      return EnvironmentRegistry.EnvironmentRegistry.of({
        run: (_id, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        followStream: (_id, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      } as Registry.EnvironmentRegistry["Service"]);
    }),
  );
  const issueEnvironment = createIssueEnvironmentAtoms(Atom.runtime(environments));
  const options = { useRegistry: () => use(RegistryContext), formatError: () => "Read failed" };
  return {
    issueEnvironment,
    useIssueComments: createIssuePagedQuery(
      options,
      "test:comments",
      issueEnvironment.commentPages,
      (page) => ({ items: page.comments, nextCursor: page.nextCursor }),
    ),
    useIssueHistory: createIssuePagedQuery(
      options,
      "test:history",
      issueEnvironment.history,
      (page) => page,
    ),
    useIssueLinkedPullRequests: createIssuePagedQuery(
      options,
      "test:links",
      issueEnvironment.linkedPullRequests,
      (page) => page,
    ),
  };
});

import { IssueRouteScreen } from "./IssueRouteScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function detail(title: string): IssueDetail {
  return makeIssueDetail({ title });
}

function createRouteRoot() {
  const root = createIssueTestRoot();
  return {
    ...root,
    renderRoute: (params: Parameters<typeof IssueRouteScreen>[0]["route"]["params"]) =>
      root.render(<IssueRouteScreen route={{ params }} />),
  };
}

const request = vi.spyOn(RpcClient, "request");
afterEach(() => {
  request.mockReset();
  harness.setState = false;
  harness.menus.clear();
  vi.useRealTimers();
});

const settle = async () => {
  for (let index = 0; index < 5; index += 1) await act(() => Promise.resolve());
};

it("pages an asc-only native account on scroll, retains partial history and fences the next account", async () => {
  const calls: Array<{
    tag: string;
    input: { connectionId?: string; cursor?: string; order?: string };
  }> = [];
  const comment = (id: string) => ({
    id,
    author: null,
    body: id,
    createdAt: "2026-10-01T00:00:00Z",
    url: null,
  });
  request.mockImplementation(((
    tag: string,
    input: { connectionId?: string; cursor?: string; order?: string },
  ) =>
    Effect.sync(() => {
      calls.push({ tag, input });
      const account = input.connectionId ?? "A";
      if (tag === WS_METHODS.issuesComments)
        return {
          comments: [comment(`${account}:${input.cursor}`)],
          nextCursor: input.cursor === "page-1" ? "page-2" : null,
        };
      if (tag === WS_METHODS.issuesHistory)
        return {
          items: [
            {
              id: "native-event",
              kind: "changed",
              actor: null,
              createdAt: "2026-10-01T00:00:00Z",
              detail: "Known partial event",
              url: "https://forgejo.example/native-event",
            },
          ],
          nextCursor: null,
          truncated: true,
        };
      const issue = detail(`Account ${account}`);
      return {
        ...issue,
        tracker: "forgejo",
        connectionId: account,
        comments: [comment(`${account}:seed`)],
        commentsCursor: "page-1",
        capabilities: {
          ...issue.capabilities,
          events: true,
          commentOrders: ["asc"],
          historyOrders: [],
        },
      };
    })) as unknown as Parameters<typeof request.mockImplementation>[0]);
  const { container, renderRoute, dispose } = createRouteRoot();
  const render = (connectionId: string) =>
    renderRoute({
      environmentId: "env",
      projectId: "project",
      tracker: "forgejo",
      host: "forgejo.example",
      scope: "org/repo",
      key: "1",
      connectionId,
    });
  await act(() => render("A"));
  await settle();
  expect(container.textContent).toContain("A:seed");
  expect(container.textContent).toContain("A:page-1");
  expect(container.textContent).toContain("Known partial event");
  expect(container.textContent).toContain("global order is unavailable");
  expect(harness.menus.get("Activity order")?.actions.map((action) => action.id)).toEqual(["asc"]);
  await act(() => harness.scroll());
  await settle();
  expect(container.textContent).toContain("A:page-2");
  expect(
    calls
      .filter((call) => call.tag === WS_METHODS.issuesComments)
      .map((call) => [call.input.connectionId, call.input.order, call.input.cursor]),
  ).toEqual([
    ["A", "asc", "page-1"],
    ["A", "asc", "page-2"],
  ]);
  expect(calls.find((call) => call.tag === WS_METHODS.issuesHistory)?.input).not.toHaveProperty(
    "order",
  );
  await act(() => render("B"));
  await settle();
  expect(container.textContent).not.toContain("A:page-2");
  expect(container.textContent).toContain("B:page-1");
  expect(
    calls
      .filter((call) => call.input.connectionId === "B" && call.tag === WS_METHODS.issuesComments)
      .map((call) => call.input.cursor),
  ).toEqual(["page-1"]);
  await dispose();
});

it("starts the true oldest window without a cursor and sends distinct native transitions safely", async () => {
  const comments: Array<{ cursor?: string; order?: string }> = [];
  const writes: unknown[] = [];
  harness.setState = true;
  harness.command = async (input) => {
    writes.push(input);
    return { _tag: "Success", value: undefined };
  };
  request.mockImplementation(((tag: string, input: { cursor?: string; order?: string }) =>
    Effect.sync(() => {
      if (tag === WS_METHODS.issuesComments) {
        comments.push(input);
        return {
          comments: [
            {
              id: input.order,
              body: input.order === "asc" ? "True oldest comment" : "Older descending comment",
              author: null,
              createdAt: "2026-10-01T00:00:00Z",
              url: null,
            },
          ],
          nextCursor: null,
        };
      }
      const issue = detail("Native transitions");
      return {
        ...issue,
        state: { id: "open", name: "Open", category: "open" },
        states: [
          { id: "open", transitionId: "transition-1", name: "Open", category: "open" },
          {
            id: "open",
            transitionId: "transition-2",
            name: "Open",
            category: "open",
            fields: [{ id: "resolution", name: "Resolution", type: "text", required: true }],
          },
        ],
        commentsCursor: "desc-tail",
      };
    })) as unknown as Parameters<typeof request.mockImplementation>[0]);
  const { container, renderRoute, dispose } = createRouteRoot();
  await act(() =>
    renderRoute({
      environmentId: "env",
      projectId: "project",
      tracker: "jira",
      host: "jira.example",
      scope: "ENG",
      key: "ENG-1",
      connectionId: "Account-A",
    }),
  );
  await settle();
  await act(() =>
    harness.menus.get("Activity order")!.onPressAction({ nativeEvent: { event: "asc" } }),
  );
  await settle();
  expect(container.textContent).toContain("True oldest comment");
  expect(container.textContent).not.toContain("Older descending comment");
  expect(comments.map((input) => [input.order, input.cursor])).toEqual([
    ["desc", "desc-tail"],
    ["asc", undefined],
  ]);
  await act(() =>
    harness.menus.get("Issue state")!.onPressAction({ nativeEvent: { event: '[0,""]' } }),
  );
  await settle();
  expect(writes).toEqual([
    {
      environmentId: "env",
      input: expect.objectContaining({
        connectionId: "Account-A",
        state: "open",
        transitionId: "transition-1",
      }),
    },
  ]);
  await act(() =>
    harness.menus.get("Issue state")!.onPressAction({ nativeEvent: { event: '[1,""]' } }),
  );
  expect(writes).toHaveLength(1);
  expect(Alert.alert).toHaveBeenCalledWith(
    "Complete this transition on the tracker",
    "This transition needs native fields.",
    expect.any(Array),
  );
  await dispose();
});

it.each([false, true])(
  "loads native linked pages sequentially and keeps a repeated cursor honest: %s",
  async (repeated) => {
    const cursors: Array<string | undefined> = [];
    const link = (number: number) => ({
      number,
      title: `Linked PR ${number}`,
      url: `https://github.com/org/repo/pull/${number}`,
      repository: "org/repo",
      state: "open",
      closesIssue: false,
    });
    request.mockImplementation(((tag: string, input: { cursor?: string }) =>
      Effect.sync(() => {
        if (tag === WS_METHODS.issuesLinkedPullRequests) {
          cursors.push(input.cursor);
          return {
            items: input.cursor ? [link(4), link(5)] : [link(1), link(2), link(3)],
            nextCursor: input.cursor && !repeated ? null : "tail",
          };
        }
        const issue = detail("Linked pull requests");
        return { ...issue, capabilities: { ...issue.capabilities, linkedPullRequests: true } };
      })) as unknown as Parameters<typeof request.mockImplementation>[0]);
    const { container, renderRoute, dispose } = createRouteRoot();
    await act(() =>
      renderRoute({
        environmentId: "env",
        projectId: "project",
        tracker: "github",
        host: "github.com",
        scope: "org/repo",
        key: "1",
      }),
    );
    await settle();
    expect(cursors).toEqual([undefined, "tail"]);
    expect(container.textContent).toContain("Linked PR 3");
    expect(container.textContent).not.toContain("Linked PR 4");
    const label = repeated ? "Show known pull requests" : "Show 2 more";
    const expand = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === label,
    );
    expect(expand).toBeDefined();
    expect(container.textContent.includes("More linked pull requests may be on the tracker.")).toBe(
      repeated,
    );
    if (repeated) expect(container.textContent).not.toContain("Show 2 more");
    await act(() => expand!.click());
    expect(container.textContent).toContain("Linked PR 5");
    await act(() =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Show less")!
        .click(),
    );
    expect(container.textContent).not.toContain("Linked PR 4");
    expect(cursors).toHaveLength(2);
    await dispose();
  },
);

it("reloads a shifted Jira window and reaches all 151 native comments without duplicate IDs", async () => {
  let shifted = false;
  const comment = (id: number) => ({
    id: String(id),
    author: null,
    body: `comment-${id}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, id)).toISOString(),
    url: null,
  });
  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, index) => comment(from + index));
  const cursors: string[] = [];
  request.mockImplementation(((tag: string, input: { cursor?: string }) =>
    Effect.sync(() => {
      if (tag === WS_METHODS.issuesComments) {
        cursors.push(input.cursor!);
        if (input.cursor === "50")
          return { comments: range(shifted ? 52 : 51, shifted ? 101 : 100), nextCursor: "100" };
        if (input.cursor === "100") return { comments: range(2, 51), nextCursor: "150" };
        return { comments: [comment(1), comment(2)], nextCursor: null };
      }
      const issue = detail("Jira window");
      return {
        ...issue,
        comments: range(shifted ? 102 : 101, shifted ? 151 : 150),
        commentsCursor: "50",
      };
    })) as unknown as Parameters<typeof request.mockImplementation>[0]);
  const { container, renderRoute, dispose } = createRouteRoot();
  await act(() =>
    renderRoute({
      environmentId: "env",
      projectId: "project",
      tracker: "jira",
      host: "jira.example",
      scope: "ENG",
      key: "ENG-1",
      connectionId: "A",
    }),
  );
  await settle();
  shifted = true;
  await act(() => harness.focus());
  await settle();
  await act(() => harness.scroll());
  await settle();
  await act(() => harness.scroll());
  await settle();
  const bodies = [...container.querySelectorAll("span")]
    .map((node) => node.textContent)
    .filter((value) => /^comment-\d+$/.test(value ?? ""));
  expect(new Set(bodies).size).toBe(151);
  expect(bodies).toHaveLength(151);
  expect(bodies[0]).toBe("comment-151");
  expect(bodies.at(-1)).toBe("comment-1");
  expect(cursors).toEqual(["50", "50", "100", "150"]);
  await dispose();
});

it("fences older reaction rights when an unknown viewer receives a fresh equal-ID seed", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-19T12:00:00Z"));
  let fresh = false;
  let reads = 0;
  let release: (() => void) | undefined;
  const comment = (id: string) => ({
    id,
    author: null,
    body: id,
    createdAt: "2026-10-01T00:00:00Z",
    url: null,
  });
  const page = () => ({
    comments: [
      {
        ...comment("Older comment"),
        canEdit: !fresh,
        reactions: [{ content: "heart", count: 1, actors: [], viewerHasReacted: !fresh }],
      },
    ],
    nextCursor: null,
  });
  request.mockImplementation(((tag: string) => {
    if (tag === WS_METHODS.issuesComments) {
      reads += 1;
      return fresh
        ? Effect.promise(
            () =>
              new Promise((resolve) => {
                release = () => resolve(page());
              }),
          )
        : Effect.sync(page);
    }
    return Effect.sync(() => ({
      ...detail("Unknown viewer"),
      viewer: null,
      comments: [comment("Same seed ID")],
      commentsCursor: "tail",
    }));
  }) as unknown as Parameters<typeof request.mockImplementation>[0]);
  const { container, renderRoute, dispose, registry } = createRouteRoot();
  await act(() =>
    renderRoute({
      environmentId: "env",
      projectId: "project",
      tracker: "jira",
      host: "jira.example",
      scope: "ENG",
      key: "ENG-1",
      connectionId: "A",
    }),
  );
  await settle();
  expect(container.querySelector('[aria-label="Heart, 1, including you"]')).not.toBeNull();
  fresh = true;
  const { issueEnvironment } = await import("../../state/issues");
  const { issueTarget } = await import("./useIssueAccess");
  await act(() =>
    registry.refresh(
      issueEnvironment.detail(
        issueTarget({
          environmentId: "env",
          projectId: "project",
          tracker: "jira",
          host: "jira.example",
          scope: "ENG",
          key: "ENG-1",
          connectionId: "A",
        }),
      ),
    ),
  );
  await settle();
  expect(reads).toBe(2);
  expect(container.querySelector('[aria-label="Heart, 1, including you"]')).toBeNull();
  expect(container.textContent).not.toContain("Older comment");
  await act(() => release!());
  await settle();
  expect(container.textContent).toContain("Older comment");
  expect(container.querySelector('[aria-label="Heart, 1, including you"]')).toBeNull();
  expect(container.querySelector('[aria-label="Heart, 1"]')).not.toBeNull();
  await dispose();
});

it("keeps a cached issue on a failed refresh, says so, and recovers through Retry", async () => {
  const answers = [detail("Old title"), new Error("API rate limit exceeded"), detail("New title")];
  let reads = 0;
  request.mockImplementation((() =>
    Effect.suspend(() => {
      const answer = answers[reads++]!;
      return answer instanceof Error ? Effect.fail(answer) : Effect.succeed(answer);
    })) as unknown as Parameters<typeof request.mockImplementation>[0]);
  const { container, renderRoute, dispose } = createRouteRoot();
  await act(() =>
    renderRoute({
      environmentId: "environment",
      projectId: "project",
      tracker: "github",
      host: "github.com",
      scope: "org/repo",
      key: "1",
    }),
  );
  await settle();
  expect(container.textContent).toContain("Old title");
  expect(container.textContent).not.toContain("Couldn't refresh");

  await act(() => harness.focus());
  await settle();
  expect(reads).toBe(2);
  expect(container.textContent).toContain("Old title");
  expect(container.textContent).toContain("Couldn't refresh this issue: API rate limit exceeded");

  const retry = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Retry",
  );
  await act(() => retry!.click());
  await settle();
  expect(reads).toBe(3);
  expect(container.textContent).toContain("New title");
  expect(container.textContent).not.toContain("Couldn't refresh");

  await dispose();
});

it.each([{ environmentId: " " }, { projectId: "" }, { tracker: "Not A Tracker" }])(
  "shows a way back instead of reading an issue from invalid link params %j",
  async (change) => {
    harness.back = 0;
    const { container, renderRoute, dispose } = createRouteRoot();
    await act(() =>
      renderRoute({
        environmentId: "environment",
        projectId: "project",
        tracker: "github",
        host: "github.com",
        scope: "org/repo",
        key: "1",
        ...change,
      }),
    );
    await settle();
    expect(request).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Couldn't open this issue");
    const back = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Back to issues",
    );
    await act(() => back!.click());
    expect(harness.back).toBe(1);
    await dispose();
  },
);

it.each([
  { originalURL: "https://github.com/acme/app/issues/456", opens: true },
  { originalURL: "javascript:alert(1)", opens: false },
])(
  "offers the original link in the browser when $originalURL names no readable issue",
  async ({ originalURL, opens }) => {
    let reads = 0;
    request.mockImplementation((() =>
      Effect.suspend(() => {
        reads += 1;
        return Effect.fail(
          new IssueOperationError({
            operation: "getIssue",
            reason: "not-found",
            detail: "Issue not found.",
          }),
        );
      })) as unknown as Parameters<typeof request.mockImplementation>[0]);
    vi.mocked(Linking.openURL).mockClear();
    const { container, renderRoute, dispose } = createRouteRoot();
    await act(() =>
      renderRoute({
        environmentId: "environment",
        projectId: "project",
        tracker: "github",
        host: "github.com",
        scope: "acme/app",
        key: "456",
        originalURL,
      }),
    );
    await settle();
    expect(container.textContent).toContain("Couldn't load this issue");
    const buttons = [...container.querySelectorAll("button")];
    const browser = buttons.find((button) => button.textContent === "Open in browser");
    expect(buttons.some((button) => button.textContent === "Retry")).toBe(true);
    expect(Linking.openURL).not.toHaveBeenCalled();
    if (opens) {
      await act(() => browser!.click());
      expect(Linking.openURL).toHaveBeenCalledWith(originalURL);
    } else {
      expect(browser).toBeUndefined();
    }
    expect(reads).toBe(1);
    await dispose();
  },
);

it.each([true, false])(
  "reads private GitHub images in the body and comments through the issue's project: %s",
  async (project) => {
    const media = {
      body: "https://github.com/user-attachments/assets/body-1",
      raw: "https://raw.githubusercontent.com/acme/app/main/body.png",
      plain: "https://example.com/plain.png",
      current: "https://github.com/user-attachments/assets/current-2",
      older: "https://raw.githubusercontent.com/acme/app/main/older.png",
    };
    const comment = (id: string, url: string) => ({
      id,
      author: null,
      body: `![](${url})`,
      createdAt: "2026-10-01T00:00:00Z",
      url: null,
    });
    harness.assets = [];
    harness.projects = new Map([
      ["thread-env:thread-project", { workspaceRoot: "/thread-repo" }],
      ...(project ? [["issue-env:issue-project", { workspaceRoot: "/issue-repo" }] as const] : []),
    ]);
    harness.command = async () => ({
      _tag: "Success",
      value: { comments: [comment("older", media.older)], nextCursor: null },
    });
    let reads = 0;
    request.mockImplementation(((tag: string) =>
      Effect.sync(() => {
        if (tag === WS_METHODS.issuesComments)
          return { comments: [comment("older", media.older)], nextCursor: null };
        reads += 1;
        return {
          ...detail("Images"),
          body: `![](${media.body}) ![](${media.raw}) ![](${media.plain})`,
          comments: [comment("current", media.current)],
          commentsCursor: "older-cursor",
        };
      })) as unknown as Parameters<typeof request.mockImplementation>[0]);
    const { container, renderRoute, dispose } = createRouteRoot();
    await act(() =>
      renderRoute({
        environmentId: "issue-env",
        projectId: "issue-project",
        tracker: "github",
        host: "github.com",
        scope: "acme/app",
        key: "1",
      }),
    );
    await settle();
    const uris = [...container.querySelectorAll("i")].map((image) => image.dataset.uri);
    const github = [media.body, media.raw, media.current, media.older];
    expect(uris.toSorted()).toEqual(
      [...github.map((url) => (project ? `signed:${url}` : url)), media.plain].toSorted(),
    );
    expect([...new Set(harness.assets.map((asset) => JSON.stringify(asset)))].toSorted()).toEqual(
      (project ? github : [])
        .map((url) =>
          JSON.stringify({
            environmentId: "issue-env",
            resource: { _tag: "github-media", cwd: "/issue-repo", url },
          }),
        )
        .toSorted(),
    );
    expect(reads).toBe(1);
    await dispose();
  },
);
