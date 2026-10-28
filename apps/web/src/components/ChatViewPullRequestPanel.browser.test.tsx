import { EnvironmentId, ProjectId, ThreadId, type ServerConfig } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("./pullRequest/PullRequestDetailPanel", () => ({
  PullRequestDetailPanel: ({
    environmentId,
    reference,
    onSelectPullRequest,
    onBack,
  }: ComponentProps<
    typeof import("./pullRequest/PullRequestDetailPanel").PullRequestDetailPanel
  >) => (
    <>
      <h2>
        PR on {environmentId}: {reference.repository}#{reference.number}
      </h2>
      <input aria-label="Review draft" defaultValue="" />
      <button onClick={() => onSelectPullRequest?.({ ...reference, number: 43 })}>
        Open sibling PR
      </button>
      {onBack ? <button onClick={onBack}>Back</button> : null}
    </>
  ),
}));
vi.mock("./pullRequest/PullRequestGhosts", () => ({
  PullRequestDetailGhost: () => <h2>Loading PR</h2>,
}));
vi.mock("./issue/IssueDetailPanel", () => ({
  IssueDetailPanel: ({
    onSelectPullRequest,
    environmentId,
  }: ComponentProps<typeof import("./issue/IssueDetailPanel").IssueDetailPanel>) => (
    <button
      onClick={() =>
        onSelectPullRequest?.({
          projectId: ProjectId.make("project-b"),
          repository: "acme/web",
          number: 42,
          host: "github.com",
          url: "https://github.com/acme/web/pull/42",
        })
      }
    >
      Linked PR on {environmentId}
    </button>
  ),
}));
vi.mock("./threadIssue/ThreadIssuesPanel", () => ({
  ThreadIssuesPanel: ({ threadRef }: { threadRef: { environmentId: EnvironmentId } }) => (
    <h2>Linked issues on {threadRef.environmentId}</h2>
  ),
}));

import { useRightPanelStore, selectSelectedRightPanelSurface } from "../rightPanelStore";
import { ChatViewIssuePanel } from "./ChatViewIssuePanel";
import { RightPanelSurfaceContent } from "./chat/RightPanelSurfaceContent";

const threadRef = { environmentId: EnvironmentId.make("a"), threadId: ThreadId.make("thread") };
const surfaceProps = {
  threadRef,
  environmentId: threadRef.environmentId,
  visible: true,
  activeSurfaceId: null,
  composerDraftTarget: threadRef,
  keybindings: [],
  configuredPreviewUrls: [],
  workspaceMutationId: null,
  getShortcutContext: () => ({
    terminalFocus: false,
    terminalOpen: false,
    previewFocus: false,
    previewOpen: false,
    isWeb: true,
    isDesktop: false,
  }),
  onSendAnnotation: vi.fn(),
  onCloseSurface: vi.fn(),
  terminal: {
    launchContext: null,
    focusRequestId: 0,
    keybindings: [],
    onAddTerminalContext: vi.fn(),
    onSplitTerminal: vi.fn(),
    onSplitTerminalVertical: vi.fn(),
    onNewTerminal: vi.fn(),
    onActiveTerminalChange: vi.fn(),
    onCloseTerminal: vi.fn(),
  },
  pullRequest: {
    projectId: ProjectId.make("project-a"),
    pullRequests: [],
    linkedPullRequest: null,
    branchPullRequest: null,
    onBack: () => useRightPanelStore.getState().open(threadRef, "pull-requests"),
  },
  files: {
    projectName: null,
    workspaceRoot: undefined,
    availableEditors: [],
    pendingSurfaceIds: new Set<string>(),
    onOpenFile: vi.fn(),
    onPendingChange: vi.fn(),
  },
} satisfies Omit<ComponentProps<typeof RightPanelSurfaceContent>, "surface" | "environmentById">;
let element: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useRightPanelStore.setState(useRightPanelStore.getInitialState(), true);
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  useRightPanelStore.setState(useRightPanelStore.getInitialState(), true);
  vi.unstubAllGlobals();
});

it.each(["issues", "issue"] as const)(
  "waits for the %s source config before checking support",
  async (kind) => {
    const environmentId = kind === "issues" ? threadRef.environmentId : EnvironmentId.make("b");
    const surface =
      kind === "issues"
        ? { kind, id: "issues" as const }
        : {
            kind,
            id: "issue:test" as const,
            environmentId,
            projectId: "project-b",
            tracker: "linear",
            scope: "workspace/ENG",
            key: "ENG-7",
          };
    for (const supported of [null, false, true]) {
      const config = (issues: boolean | null) =>
        issues === null ? null : ({ environment: { capabilities: { issues } } } as ServerConfig);
      const environmentById = new Map([
        [threadRef.environmentId, { serverConfig: config(kind === "issues" ? supported : true) }],
        [EnvironmentId.make("b"), { serverConfig: config(kind === "issue" ? supported : true) }],
      ]);
      await act(async () =>
        root.render(
          <ChatViewIssuePanel
            surface={surface}
            threadRef={threadRef}
            environmentById={environmentById}
          />,
        ),
      );
      expect(element.textContent).toContain(
        supported === null
          ? "Loading PR"
          : supported === false
            ? "Issues unavailable"
            : kind === "issues"
              ? "Linked issues on a"
              : "Linked PR on b",
      );
      if (supported === null) expect(element.textContent).not.toContain("Update this environment");
    }
  },
);

it.each([
  ["issue", false, true, "b", "PR on b: acme/web#42"],
  ["issue", null, true, "b", "PR on b: acme/web#42"],
  ["direct", false, true, "b", "PR on b: acme/web#42"],
  ["direct", null, true, "b", "PR on b: acme/web#42"],
  ["direct", true, false, "b", "Pull requests unavailable"],
  ["direct", true, null, "b", "Loading PR"],
  ["direct", true, true, "unknown", "Loading PR"],
  ["direct", true, true, "a", "PR on a: acme/web#42"],
  ["direct", true, true, undefined, "PR on a: acme/web#42"],
  ["direct", false, true, undefined, "Pull requests unavailable"],
  ["direct", null, true, undefined, "Loading PR"],
] as const)(
  "renders a %s PR with A=%s, B=%s, destination=%s",
  async (origin, sourceSupports, destinationSupports, destination, expected) => {
    const config = (pullRequests: boolean | null) =>
      pullRequests === null
        ? null
        : ({ environment: { capabilities: { pullRequests, issues: true } } } as ServerConfig);
    const environmentById = new Map([
      [threadRef.environmentId, { serverConfig: config(sourceSupports) }],
      [EnvironmentId.make("b"), { serverConfig: config(destinationSupports) }],
    ]);
    if (origin === "issue") {
      useRightPanelStore.getState().openIssue(threadRef, {
        environmentId: "b",
        projectId: "project-b",
        tracker: "linear",
        scope: "workspace/ENG",
        key: "ENG-7",
      });
      const issue = selectSelectedRightPanelSurface(
        useRightPanelStore.getState().byThreadKey,
        threadRef,
      );
      if (issue?.kind !== "issue") throw new Error("Missing issue surface");
      await act(async () =>
        root.render(
          <ChatViewIssuePanel
            surface={issue}
            threadRef={threadRef}
            environmentById={environmentById}
          />,
        ),
      );
      await act(async () => element.querySelector<HTMLButtonElement>("button")!.click());
    } else {
      useRightPanelStore.getState().openPullRequest(threadRef, {
        ...(destination === undefined ? {} : { environmentId: destination }),
        projectId: "project-b",
        repository: "acme/web",
        number: 42,
        host: "github.com",
      });
    }
    const surface = selectSelectedRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      threadRef,
    );
    if (surface?.kind !== "pull-request") throw new Error("Missing PR surface");
    expect(Object.keys(useRightPanelStore.getState().byThreadKey)).toEqual([
      scopedThreadKey(threadRef),
    ]);
    expect(surface.environmentId).toBe(destination);
    await act(async () =>
      root.render(
        <RightPanelSurfaceContent
          {...surfaceProps}
          surface={surface}
          environmentById={environmentById}
        />,
      ),
    );
    expect(element.textContent).toContain(expected);
  },
);

it("resets the review draft between environment tabs and keeps sibling PRs in their destination", async () => {
  const environmentById = new Map(
    ["a", "b"].map((id) => [
      EnvironmentId.make(id),
      { serverConfig: { environment: { capabilities: { pullRequests: true } } } as ServerConfig },
    ]),
  );
  const renderSelected = async () => {
    const surface = selectSelectedRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      threadRef,
    );
    await act(async () =>
      root.render(
        <RightPanelSurfaceContent
          {...surfaceProps}
          surface={surface}
          environmentById={environmentById}
        />,
      ),
    );
  };
  for (const environmentId of ["a", "b"]) {
    useRightPanelStore.getState().openPullRequest(threadRef, {
      environmentId,
      projectId: "project-b",
      host: "github.com",
      repository: "acme/web",
      number: 42,
    });
    await renderSelected();
    const draft = element.querySelector<HTMLInputElement>('input[aria-label="Review draft"]')!;
    expect(draft.value).toBe("");
    draft.value = "Review for this environment";
  }
  await act(async () =>
    [...element.querySelectorAll("button")]
      .find((button) => button.textContent === "Open sibling PR")!
      .click(),
  );
  expect(
    selectSelectedRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef),
  ).toMatchObject({
    kind: "pull-request",
    environmentId: "b",
    host: "github.com",
    repository: "acme/web",
    number: 43,
  });
  await renderSelected();
  expect(element.querySelector("h2")?.textContent).toBe("PR on b: acme/web#43");
  await act(async () =>
    [...element.querySelectorAll("button")]
      .find((button) => button.textContent === "Back")!
      .click(),
  );
  expect(
    selectSelectedRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef)?.kind,
  ).toBe("pull-requests");
});
