import { makeIssueDetail } from "./issue-test-fixtures";
import { RegistryContext } from "@effect/atom-react";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AtomRegistry } from "effect/reactivity";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { IssueTrackerKind, ProjectId, type IssueDetail } from "@t3tools/contracts";

type Props = { children?: ReactNode };
const harness = vi.hoisted(() => ({
  issue: null as IssueDetail | null,
  actors: [] as Array<{ id: string; login: string; name: null; avatarUrl: null }>,
  sent: [] as Array<{ input: { connectionId?: string; assignees?: readonly string[] } }>,
  end: () => {},
  more: false,
  loads: 0,
}));

vi.mock("react-native", () => ({
  ActivityIndicator: () => null,
  Platform: { OS: "android" },
  View: ({ children }: Props) => children,
  Pressable: ({
    children,
    onPress,
    disabled,
    accessibilityLabel,
  }: Props & {
    onPress: () => void;
    disabled: boolean;
    accessibilityLabel: string;
  }) => (
    <button disabled={disabled} aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
  FlatList: ({
    data,
    renderItem,
    keyExtractor,
    onEndReached,
    ListHeaderComponent,
    ListFooterComponent,
  }: {
    data: unknown[];
    renderItem: (input: { item: unknown }) => ReactNode;
    keyExtractor: (item: unknown) => string;
    onEndReached: () => void;
    ListHeaderComponent: ReactNode;
    ListFooterComponent: ReactNode;
  }) => {
    harness.end = onEndReached;
    return (
      <>
        {ListHeaderComponent}
        {data.map((item) => (
          <div key={keyExtractor(item)}>{renderItem({ item })}</div>
        ))}
        {ListFooterComponent}
      </>
    );
  },
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: () => {} }) }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: Props) => children,
  AppTextInput: () => null,
}));
vi.mock("../../components/ui/AndroidScreenHeader", () => ({ AndroidScreenHeader: () => null }));
vi.mock("../../components/ui/EmptyState", () => ({ EmptyState: () => null }));
vi.mock("../../components/ui/Button", () => ({ Button: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../../native/NativeHeaderToolbar", () => ({
  NativeHeaderToolbar: Object.assign(() => null, { Button: () => null }),
}));
vi.mock("../pull-requests/PullRequestPresentation", () => ({ PullRequestAvatar: () => null }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: harness.issue, isPending: false, error: null }),
}));
vi.mock("../../state/issues", () => ({
  issueEnvironment: { detail: () => null, update: {} },
  useIssueLabelCandidates: () => ({ items: [] }),
  useIssueAssigneeCandidates: () => ({
    items: harness.actors,
    truncated: false,
    hasMore: harness.more,
    isPending: false,
    error: null,
    refresh: () => {},
    loadMore: () => harness.loads++,
  }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async (input: (typeof harness.sent)[number]) => {
    harness.sent.push(input);
    return { _tag: "Success", value: undefined };
  },
}));
vi.mock("./useIssueAccess", () => ({
  issueTarget: ({ environmentId, ...input }: Record<string, string>) => ({ environmentId, input }),
  markIssueTargetWritten: () => {},
  useIssueAccess: () => ({ connected: true, labels: true, assignees: true }),
}));

import { IssueCandidatesScreen } from "./IssueCandidatesScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const actor = (id: string) => ({ id, login: id, name: null, avatarUrl: null });
const params = {
  environmentId: "environment",
  projectId: "project",
  tracker: "jira",
  host: "jira.example",
  scope: "ENG",
  key: "ENG-1",
  kind: "assignees" as const,
  connectionId: "AccountA",
};
let root: Root;
let container: HTMLDivElement;
let registry: AtomRegistry.AtomRegistry;
const render = (connectionId = "AccountA") =>
  act(() =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <IssueCandidatesScreen route={{ params: { ...params, connectionId } }} />
      </RegistryContext.Provider>,
    ),
  );
const click = (label: string) =>
  act(async () => {
    const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(button).not.toBeNull();
    button!.click();
  });

beforeEach(() => {
  harness.issue = makeIssueDetail({
    ...params,
    tracker: IssueTrackerKind.make("jira"),
    projectId: ProjectId.make("project"),
    displayKey: "ENG-1",
    url: "https://jira.example/browse/ENG-1",
    assignees: [actor("User")],
  });
  harness.actors = [actor("User"), actor("user"), actor("User")];
  harness.sent = [];
  harness.more = false;
  harness.loads = 0;
  registry = AtomRegistry.make();
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  registry.dispose();
});

it("keeps distinct native IDs, deduplicates page overlaps and retains an unavailable confirmed assignee", async () => {
  render();
  expect(container.querySelectorAll('button[aria-label="Remove User"]')).toHaveLength(1);
  await click("Add user");
  expect(harness.sent.at(-1)?.input).toMatchObject({
    connectionId: "AccountA",
    assignees: ["User", "user"],
  });
  harness.actors = [];
  render();
  await click("Remove User");
  expect(harness.sent.at(-1)?.input.assignees).toEqual(["user"]);
  await click("Remove user");
  expect(harness.sent.at(-1)?.input.assignees).toEqual([]);
});

it("fences held picks by account while loading only the next page when the list reaches its end", async () => {
  render();
  await click("Add user");
  harness.issue = { ...harness.issue!, connectionId: "AccountB", assignees: [actor("Other")] };
  harness.actors = [actor("User"), actor("user")];
  harness.more = true;
  render("AccountB");
  expect(container.querySelector('button[aria-label="Add user"]')).not.toBeNull();
  expect(container.querySelector('button[aria-label="Remove Other"]')).not.toBeNull();
  await click("Add user");
  expect(harness.sent.at(-1)?.input).toMatchObject({
    connectionId: "AccountB",
    assignees: ["Other", "user"],
  });
  act(() => harness.end());
  expect(harness.loads).toBe(1);
  harness.more = false;
  render("AccountB");
  act(() => harness.end());
  expect(harness.loads).toBe(1);
});
