import { makeIssueDetail } from "./issue-test-fixtures";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { IssueTrackerKind, type IssueDetail } from "@t3tools/contracts";

type Props = Record<string, unknown> & { readonly children?: ReactNode };

const harness = vi.hoisted(() => {
  const controls = new Map<string, Record<string, unknown>>();
  return {
    controls,
    issue: null as unknown,
    updates: [] as unknown[],
    answers: [] as Array<"fail" | "ok">,
    wait: null as Promise<void> | null,
    back: 0,
    opened: [] as string[],
    connected: true,
    capture:
      (key: string) =>
      ({ children, ...props }: Props) => {
        controls.set(String(props[key]), props);
        return children ?? null;
      },
  };
});

vi.mock("@effect/atom-react", async () => ({
  RegistryContext: (await import("react")).createContext({}),
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: () => harness.back++ }),
}));
vi.mock("react-native", () => ({
  Linking: { openURL: (url: string) => harness.opened.push(url) },
  Platform: { OS: "ios" },
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: Props) => children,
  AppTextInput: harness.capture("accessibilityLabel"),
}));
vi.mock("../../components/ui/Button", () => ({ Button: harness.capture("label") }));
vi.mock("../pull-requests/PullRequestSheetContent", () => ({
  PullRequestSheetContent: ({ children, footer }: Props & { footer: ReactNode }) => (
    <>
      {footer}
      {children}
    </>
  ),
}));
vi.mock("../../state/issues", () => ({ issueEnvironment: { detail: () => null } }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: harness.issue, error: null }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async (input: unknown) => {
    harness.updates.push(input);
    if (harness.wait !== null) await harness.wait;
    return harness.answers.shift() === "fail"
      ? { _tag: "Failure", cause: new Error("Jira refused the update") }
      : { _tag: "Success", value: undefined };
  },
}));
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>();
  const Cause = await import("effect/Cause");
  return {
    ...actual,
    squashAtomCommandFailure: ({ cause }: { cause: unknown }) =>
      Cause.isCause(cause) ? Cause.squash(cause) : cause,
  };
});
vi.mock("./useIssueAccess", async () => {
  const { issueAccess } = await import("./issueDetail");
  const grants = { comment: true, update: true, setState: true, react: true };
  return {
    issueTarget: ({ environmentId, ...input }: Record<string, string>) => ({
      environmentId,
      input,
    }),
    markIssueTargetWritten: () => {},
    useIssueAccess: (_params: unknown, detail: IssueDetail | null) => ({
      connected: harness.connected,
      ...issueAccess(detail, { ...grants, connected: harness.connected }),
    }),
  };
});

import { IssueComposeSheet } from "./IssueComposeSheet";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function detail(bodyEditable?: boolean): IssueDetail {
  return makeIssueDetail({
    tracker: IssueTrackerKind.make("jira"),
    host: "acme.atlassian.net",
    scope: "ENG",
    key: "ENG-1",
    displayKey: "ENG-1",
    title: "Old title",
    url: "https://acme.atlassian.net/browse/ENG-1",
    state: { category: "open", name: "To Do" },
    body: "Rich *body*",
    ...(bodyEditable === undefined ? {} : { bodyEditable }),
  });
}

let root: Root;
const control = (key: string) => harness.controls.get(key);
const type = (key: string, text: string) =>
  act(() => (control(key)!.onChangeText as (text: string) => void)(text));
const save = () => act(async () => (control("Save")!.onPress as () => void)());
const render = (connectionId?: string) =>
  act(() =>
    root.render(
      <IssueComposeSheet
        route={{
          params: {
            environmentId: "environment",
            projectId: "project",
            tracker: "jira",
            host: "acme.atlassian.net",
            scope: "ENG",
            key: "ENG-1",
            mode: "edit",
            ...(connectionId === undefined ? {} : { connectionId }),
          },
        }}
      />,
    ),
  );
const sent = () =>
  harness.updates.map((update) => {
    const { title, body } = (update as { input: { title?: string; body?: string } }).input;
    return { title, body };
  });

beforeEach(() => {
  root = createRoot(document.createElement("div"));
  harness.controls.clear();
  harness.updates.length = 0;
  harness.answers = [];
  harness.back = 0;
  harness.opened.length = 0;
  harness.connected = true;
  harness.wait = null;
});

afterEach(() => act(async () => root.unmount()));

it("clears a prior account's draft before editing and saving the next account", async () => {
  harness.issue = detail(true);
  await render("A");
  await type("Title", "Account A draft");
  await type("Description", "Account A body");
  harness.issue = { ...detail(true), title: "Account B title", body: "Account B body" };
  await render("B");
  expect(control("Title")!.value).toBe("Account B title");
  expect(control("Description")!.value).toBe("Account B body");
  expect(control("Save")!.disabled).toBe(true);
  await type("Title", "Account B edit");
  await save();
  expect(harness.updates).toEqual([
    {
      environmentId: "environment",
      input: expect.objectContaining({ connectionId: "B", title: "Account B edit" }),
    },
  ]);
  expect(sent()).toEqual([{ title: "Account B edit", body: undefined }]);
});

it("does not close the next account's sheet when a prior account write completes", async () => {
  let release!: () => void;
  harness.wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  harness.issue = detail(true);
  await render("A");
  await type("Title", "Account A edit");
  await save();
  harness.issue = { ...detail(true), title: "Account B title" };
  await render("B");
  await act(() => release());
  expect(harness.back).toBe(0);
  expect(control("Title")!.value).toBe("Account B title");
  expect(harness.updates).toEqual([
    {
      environmentId: "environment",
      input: expect.objectContaining({ connectionId: "A", title: "Account A edit" }),
    },
  ]);
});

it("saves only the title when the description cannot round-trip, and keeps the draft on failure", async () => {
  harness.issue = detail(false);
  harness.answers = ["fail", "ok"];
  await render();
  expect(control("Description")!.editable).toBe(false);
  await act(() => (control("Edit description in browser")!.onPress as () => void)());
  expect(harness.opened).toEqual(["https://acme.atlassian.net/browse/ENG-1"]);

  await type("Title", "New title");
  await save();
  expect(harness.back).toBe(0);
  expect(control("Title")!.value).toBe("New title");

  await save();
  expect(sent()).toEqual([
    { title: "New title", body: undefined },
    { title: "New title", body: undefined },
  ]);
  expect(harness.back).toBe(1);
});

it.each([undefined, true])("edits a plain description when bodyEditable is %s", async (flag) => {
  harness.issue = detail(flag);
  await render();
  expect(control("Description")!.editable).toBe(true);
  expect(control("Edit description in browser")).toBeUndefined();
  await type("Description", "Plain body");
  await save();
  expect(sent()).toEqual([{ title: undefined, body: "Plain body" }]);
});

it("says the environment is offline instead of blaming access when it disconnects", async () => {
  harness.issue = detail();
  harness.connected = false;
  const container = document.createElement("div");
  root = createRoot(container);
  await render();
  expect(control("Save")!.disabled).toBe(true);
  expect(container.textContent).toContain(
    "This environment is offline. Reconnect to edit this issue.",
  );
  expect(container.textContent).not.toContain("with your access");
});

it.each([
  ["Title", "New title", { body: "Teammate body" }, { title: "New title", body: undefined }],
  ["Description", "My body", { title: "Teammate title" }, { title: undefined, body: "My body" }],
] as const)(
  "keeps the refreshed issue's other field after editing %s",
  async (field, text, refreshed, expected) => {
    harness.issue = detail(true);
    await render();
    await type(field, text);
    harness.issue = { ...detail(true), ...refreshed };
    await render();
    expect(control(field === "Title" ? "Description" : "Title")!.value).toBe(
      Object.values(refreshed)[0],
    );
    await save();
    expect(sent()).toEqual([expected]);
  },
);
