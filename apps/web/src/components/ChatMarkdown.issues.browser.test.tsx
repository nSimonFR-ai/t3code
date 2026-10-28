import {
  AuthStandardClientScopes,
  EnvironmentId,
  IssueResolvedUrl,
  IssueResolveUrlInput,
  IssueTrackerKind,
  ProjectId,
  ThreadId,
  type AuthSessionState,
  type ServerConfig,
} from "@t3tools/contracts";
import type {
  EnvironmentRegistry,
  EnvironmentSupervisor,
} from "@t3tools/client-runtime/connection";
import type { RpcSession } from "@t3tools/client-runtime/rpc";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { AppAtomRegistryProvider, appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../state/server";
import { ISSUES_PANEL_REF, useRightPanelStore, type RightPanelSurface } from "../rightPanelStore";
import { PullRequestMarkdown } from "./pullRequest/PullRequestMarkdown";
import { PullRequestCommentBody } from "./pullRequest/PullRequestCommentBody";
import { PullRequestMarkdownEditor } from "./pullRequest/PullRequestMarkdownEditor";
import { ChatViewIssuePanel } from "./ChatViewIssuePanel";

vi.mock("./issue/IssueDetailPanel", () => ({
  IssueDetailPanel: ({ environmentId }: { environmentId: EnvironmentId }) => (
    <h2>Issue on {environmentId}</h2>
  ),
}));
vi.mock("./pullRequest/PullRequestsUnavailableState", () => ({
  PullRequestsUnavailableState: ({ title }: { title: string }) => <h2>{title}</h2>,
}));
vi.mock("./pullRequest/PullRequestGhosts", () => ({
  PullRequestDetailGhost: () => <h2>Loading issue</h2>,
}));
vi.mock("./threadIssue/ThreadIssuesPanel", () => ({
  ThreadIssuesPanel: ({ threadRef }: { threadRef: { environmentId: EnvironmentId } }) => (
    <h2>Linked issues on {threadRef.environmentId}</h2>
  ),
}));

const issueLinks = vi.hoisted(() => ({
  resolve: vi.fn(),
  navigate: vi.fn(),
  enabled: false,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => issueLinks.navigate,
}));

vi.mock("../connection/runtime", async () => {
  const { Atom } = await import("effect/reactivity");
  const Layer = await import("effect/Layer");
  const Option = await import("effect/Option");
  const SubscriptionRef = await import("effect/SubscriptionRef");
  const services = await import("@t3tools/client-runtime/connection");
  const decodeResolved = Schema.decodeUnknownEffect(IssueResolvedUrl);
  const decodeInput = Schema.decodeUnknownSync(IssueResolveUrlInput);
  return {
    connectionAtomRuntime: Atom.runtime(
      Layer.succeed(
        services.EnvironmentRegistry.EnvironmentRegistry,
        services.EnvironmentRegistry.EnvironmentRegistry.of({
          run: <A, E, R>(environmentId: EnvironmentId, effect: Effect.Effect<A, E, R>) =>
            Effect.gen(function* () {
              const client = {
                "issues.resolveUrl": (input: Record<string, unknown>) =>
                  Effect.sync(() =>
                    issueLinks.resolve({ environmentId, input: decodeInput(input) }),
                  ).pipe(Effect.andThen(decodeResolved)),
              } as unknown as RpcSession["client"];
              const session = yield* SubscriptionRef.make(Option.some({ client } as RpcSession));
              return yield* Effect.provideService(
                effect,
                services.EnvironmentSupervisor.EnvironmentSupervisor,
                {
                  target: { environmentId },
                  session,
                } as EnvironmentSupervisor.EnvironmentSupervisor["Service"],
              );
            }),
        } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]),
      ),
    ),
  };
});
vi.mock("@t3tools/client-runtime/state/session", async (importOriginal) => {
  const original = await importOriginal<typeof import("@t3tools/client-runtime/state/session")>();
  const { Atom, AsyncResult } = await import("effect/reactivity");
  return {
    ...original,
    createEnvironmentSessionAtoms: () => ({
      sessionStateAtom: Atom.family(() =>
        Atom.make(
          AsyncResult.success({
            authenticated: true,
            auth: {
              policy: "remote-reachable",
              bootstrapMethods: [],
              sessionMethods: [],
              sessionCookieName: "test",
            },
            scopes: AuthStandardClientScopes,
            permissions: AuthStandardClientScopes,
          } satisfies AuthSessionState),
        ),
      ),
    }),
  };
});

vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
    environmentServerConfigsAtom: Atom.make(
      () =>
        new Map(
          issueLinks.enabled
            ? ["env-a", "env-b"].map((id) => [
                id,
                { environment: { capabilities: { issues: true } } },
              ])
            : [],
        ),
    ) as never,
  };
});
vi.mock(import("../state/session"), async (original) => {
  const granted = new Set<string>(AuthStandardClientScopes);
  const hasScope = (environmentId: unknown, scope: string) =>
    environmentId !== null && granted.has(scope);
  return {
    ...(await original()),
    useEnvironmentScope: hasScope as never,
    readEnvironmentScope: hasScope as never,
  };
});
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  readThreadShell: (() => (issueLinks.enabled ? { projectId: "project-a" } : null)) as never,
  useThreadShell: (() => (issueLinks.enabled ? { projectId: "project-a" } : null)) as never,
  useProjects: (() => []) as never,
}));
vi.mock(import("../remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }) as never,
}));

describe("pull request Markdown issue destinations", () => {
  const threadRef = {
    environmentId: EnvironmentId.make("env-a"),
    threadId: ThreadId.make("thread"),
  };
  const url = "https://github.com/example/repo/issues/7";
  const text = `[Issue](${url})`;
  let element: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  async function showPanel(
    surface: RightPanelSurface,
    sourceIssues: boolean | null,
    destinationIssues: boolean | null = true,
  ) {
    const config = (issues: boolean | null) =>
      issues === null ? null : ({ environment: { capabilities: { issues } } } as ServerConfig);
    const serverConfig = config(sourceIssues);
    await act(async () =>
      root.render(
        <ChatViewIssuePanel
          surface={surface as Extract<RightPanelSurface, { kind: "issue" | "issues" }>}
          threadRef={threadRef}
          environmentById={
            new Map([
              [threadRef.environmentId, { serverConfig }],
              [EnvironmentId.make("env-b"), { serverConfig: config(destinationIssues) }],
            ])
          }
        />,
      ),
    );
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    issueLinks.enabled = true;
    appAtomRegistry.refresh(environmentServerConfigsAtom);
    issueLinks.navigate.mockReset();
    issueLinks.resolve.mockReset().mockImplementation(({ input }) => ({
      projectId: ProjectId.make("resolved-project"),
      tracker: "github",
      host: "github.com",
      scope: "example/repo",
      key: "7",
      writable: true,
      ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
    }));
    useRightPanelStore.setState(useRightPanelStore.getInitialState(), true);
    element = document.createElement("div");
    document.body.append(element);
    root = createRoot(element);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    element.remove();
    useRightPanelStore.setState(useRightPanelStore.getInitialState(), true);
    issueLinks.enabled = false;
    appAtomRegistry.refresh(environmentServerConfigsAtom);
    vi.unstubAllGlobals();
  });

  it.each(
    (
      [
        ["body", false],
        ["comment", null],
        ["editor preview", true],
        ["same environment", true],
        ["standalone", true],
      ] as const
    ).flatMap(([surface, sourceIssues]) =>
      [undefined, "Account/B"].map((connectionId) => ({ surface, sourceIssues, connectionId })),
    ),
  )(
    "opens an issue from $surface in its source environment and account $connectionId",
    async ({ surface, sourceIssues, connectionId }) => {
      const environmentId =
        surface === "same environment" ? threadRef.environmentId : EnvironmentId.make("env-b");
      const props = {
        cwd: "/repo",
        text,
        environmentId,
        threadRef: surface === "standalone" ? null : threadRef,
        ...(connectionId === undefined
          ? {}
          : {
              issueLinkContext: {
                environmentId,
                projectId: ProjectId.make("source-project"),
                tracker: IssueTrackerKind.make("github"),
                host: "github.com",
                connectionId,
              },
            }),
      };
      await act(async () => {
        root.render(
          <AppAtomRegistryProvider>
            {surface === "editor preview" ? (
              <PullRequestMarkdownEditor
                {...props}
                value={text}
                label="Description"
                saving={false}
                onSave={vi.fn()}
                onCancel={vi.fn()}
              />
            ) : surface === "comment" ? (
              <PullRequestCommentBody {...props} />
            ) : (
              <PullRequestMarkdown {...props} />
            )}
          </AppAtomRegistryProvider>,
        );
      });
      if (surface === "editor preview") {
        const preview = [...element.querySelectorAll("button")].find(
          (button) => button.textContent === "Preview",
        );
        expect(preview).toBeDefined();
        await act(async () => preview!.click());
      }
      const link = element.querySelector<HTMLAnchorElement>(`a[href="${url}"]`);
      expect(link).not.toBeNull();
      const opened = new Promise<void>((resolve) => {
        const unsubscribe = useRightPanelStore.subscribe(() => {
          unsubscribe();
          resolve();
        });
      });
      await act(async () => {
        link!.click();
        await opened;
      });
      expect(issueLinks.resolve).toHaveBeenCalledExactlyOnceWith({
        environmentId,
        input: {
          url,
          ...(connectionId === undefined && surface === "same environment"
            ? { projectId: "project-a" }
            : {}),
          ...(connectionId === undefined ? {} : { projectId: "source-project", connectionId }),
        },
      });
      const panelRef = surface === "standalone" ? ISSUES_PANEL_REF : threadRef;
      const panels = useRightPanelStore.getState().byThreadKey;
      expect(Object.keys(panels)).toEqual([scopedThreadKey(panelRef)]);
      expect(panels[scopedThreadKey(panelRef)]?.surfaces).toEqual([
        expect.objectContaining({
          kind: "issue",
          ...(panelRef.environmentId === environmentId ? {} : { environmentId }),
          projectId: "resolved-project",
          ...(connectionId === undefined ? {} : { connectionId }),
          tracker: "github",
          host: "github.com",
          scope: "example/repo",
          key: "7",
          url,
        }),
      ]);
      if (surface === "standalone") {
        expect(issueLinks.navigate).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            to: "/issues",
            search: expect.objectContaining({ selectedEnvironmentId: environmentId }),
          }),
        );
      } else {
        expect(issueLinks.navigate).not.toHaveBeenCalled();
      }
      if (surface !== "standalone") {
        const issue = panels[scopedThreadKey(panelRef)]!.surfaces[0]!;
        await showPanel(issue, sourceIssues);
        expect(element.querySelector("h2")?.textContent).toBe(`Issue on ${environmentId}`);
        if (surface === "body") {
          await showPanel(issue, true, false);
          expect(element.querySelector("h2")?.textContent).toBe("Issues unavailable");
          await showPanel(issue, true, null);
          expect(element.querySelector("h2")?.textContent).toBe("Loading issue");
        }
      }
    },
  );

  it.each([false, true])(
    "keeps the linked Issues tab on A when its capability is %s",
    async (supported) => {
      useRightPanelStore.getState().open(threadRef, "issues");
      const surface =
        useRightPanelStore.getState().byThreadKey[scopedThreadKey(threadRef)]!.surfaces[0]!;
      await showPanel(surface, supported, !supported);
      expect(element.querySelector("h2")?.textContent).toBe(
        supported ? "Linked issues on env-a" : "Issues unavailable",
      );
    },
  );
});
