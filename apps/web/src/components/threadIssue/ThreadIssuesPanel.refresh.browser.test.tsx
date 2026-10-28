import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  IssueTrackerKind,
  type ThreadIssueLink,
} from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import * as DateTime from "effect/DateTime";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ refresh: vi.fn(), unlink: vi.fn() }));
vi.mock("~/state/issues", () => ({
  issueEnvironment: { refreshThreadLinks: { permissionAtom: () => allowed } },
}));
vi.mock("~/state/threads", () => ({ threadEnvironment: { unlinkIssue: "unlink" } }));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => (command === "unlink" ? state.unlink : state.refresh),
}));
vi.mock("~/state/session", async () => {
  const { useAtomValue } = await import("@effect/atom-react");
  return { useEnvironmentScope: () => useAtomValue(allowed) };
});
vi.mock("~/state/entities", async () => {
  const { useAtomValue } = await import("@effect/atom-react");
  return { useThreadShell: () => useAtomValue(thread) };
});
vi.mock("~/state/shell", () => ({ environmentSnapshotAtom: () => snapshot }));
vi.mock("~/state/query", () => ({ formatEnvironmentQueryError: () => "Operate access denied" }));
vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ openIssue: vi.fn() }) },
}));
vi.mock("~/localApi", () => ({ readLocalApi: () => null }));
vi.mock("~/hooks/useCopyToClipboard", () => ({ writeTextToClipboard: vi.fn() }));
vi.mock("./LinkThreadIssueDialog", () => ({ openLinkThreadIssueDialog: vi.fn() }));
vi.mock("../issue/issuePresentation", () => ({
  issueTrackerPresentation: () => ({ providerName: "GitHub", Icon: () => null }),
  IssueStateGlyph: () => null,
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/empty", () => ({
  Empty: "div",
  EmptyDescription: "div",
  EmptyHeader: "div",
  EmptyMedia: "div",
  EmptyTitle: "div",
}));
vi.mock("../ui/menu", () => ({
  Menu: () => null,
  MenuItem: "div",
  MenuPopup: "div",
  MenuTrigger: "div",
}));
vi.mock("../ui/scroll-area", () => ({ ScrollArea: "div" }));

import { ThreadIssuesPanel } from "./ThreadIssuesPanel";

const threadRef = {
  environmentId: EnvironmentId.make("remote"),
  threadId: ThreadId.make("thread"),
};
const projectId = ProjectId.make("project");
const link: ThreadIssueLink = {
  projectId,
  tracker: IssueTrackerKind.make("github"),
  host: "github.com",
  scope: "acme/web",
  key: "7",
  url: "https://github.com/acme/web/issues/7",
  source: "agent",
  linkedAt: "2026-10-14T00:00:00Z",
  snapshot: {
    title: "Seven",
    displayKey: "#7",
    state: { category: "open", name: "open" },
    syncedAt: "2026-10-14T00:00:00Z",
  },
};
const allowed = Atom.make(true);
const thread = Atom.make({ projectId, issues: [link] });
const snapshot = Atom.make({
  threads: [{ projectId, latestRunCompletedAt: DateTime.makeUnsafe(0) }],
});
let registry: ReturnType<typeof AtomRegistry.make>;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  registry = AtomRegistry.make();
  state.refresh.mockReset().mockResolvedValue({ _tag: "Success" });
  state.unlink.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  registry.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function mount() {
  await act(async () => {
    root.render(
      createElement(
        RegistryContext.Provider,
        { value: registry },
        createElement(ThreadIssuesPanel, { threadRef }),
      ),
    );
  });
}
it("keeps live snapshots and focus refresh without issuing another RPC for a completed turn", async () => {
  await mount();
  expect(state.refresh).toHaveBeenCalledTimes(1);
  await act(async () => {
    registry.set(snapshot, {
      threads: [{ projectId, latestRunCompletedAt: DateTime.makeUnsafe(1000) }],
    });
    registry.set(thread, {
      projectId,
      issues: [{ ...link, snapshot: { ...link.snapshot!, title: "Updated by server" } }],
    });
  });
  expect(state.refresh).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("Updated by server");
  vi.setSystemTime(10001);
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(state.refresh).toHaveBeenCalledTimes(2);
  vi.setSystemTime(20002);
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(state.refresh).toHaveBeenCalledTimes(3);
});
it("leaves a read-only view visible without a denied automatic refresh", async () => {
  registry.set(allowed, false);
  state.refresh.mockResolvedValue({ _tag: "Failure", cause: {} });
  await mount();
  expect(container.textContent).toContain("Seven");
  expect(container.textContent).not.toContain("Operate access denied");
  expect(state.refresh).not.toHaveBeenCalled();
  vi.setSystemTime(10001);
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(state.refresh).not.toHaveBeenCalled();
  await act(async () => registry.set(allowed, true));
  expect(state.refresh).toHaveBeenCalledTimes(1);
});
