import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  type IssueTemplate,
  type IssueCandidates,
  type IssueCandidatesInput,
  type IssueTemplatesInput,
} from "@t3tools/contracts";

type Props = Record<string, unknown> & { readonly children?: ReactNode };

const harness = vi.hoisted(() => {
  const controls = new Map<string, Record<string, unknown>>();
  const template = (key: string) => ({
    key,
    name: key,
    about: "",
    title: `${key} title`,
    body: `${key} body`,
    labels: [`${key}-label`],
    assignees: [],
  });
  return {
    template,
    catalog: [
      template("A"),
      { ...template("B"), title: "", body: "", labels: [], contentDeferred: true },
    ] as IssueTemplate[],
    bodies: new Map<string, IssueTemplate>(),
    controls,
    created: [] as unknown[],
    opened: [] as unknown[],
    metadata: null as IssueCandidates | null,
    metadataCalls: [] as IssueCandidatesInput[],
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
  useAtomValue: () => true,
}));
vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  Linking: { openURL: vi.fn() },
  Platform: { OS: "ios" },
  Pressable: ({ children }: Props) => children,
  View: ({ children }: Props) => children,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: Props) => children,
  AppTextInput: harness.capture("accessibilityLabel"),
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/Button", () => ({ Button: harness.capture("label") }));
vi.mock("../workspace/ListFilterMenu", () => ({
  ListFilterMenu: harness.capture("accessibilityLabel"),
}));
vi.mock("../pull-requests/PullRequestSheetContent", () => ({
  PullRequestSheetContent: ({ children, footer }: Props & { footer: ReactNode }) => (
    <>
      {footer}
      {children}
    </>
  ),
}));
vi.mock("./useOpenIssue", () => ({
  useOpenIssue: () => (input: unknown) => harness.opened.push(input),
}));
vi.mock("./issueList", () => ({ markIssueWritten: () => {} }));
vi.mock("../../state/issues", () => ({
  issueEnvironment: {
    templates: (target: unknown) => target,
    candidates: (target: { input: IssueCandidatesInput }) => ({ ...target, kind: "candidates" }),
    create: { permissionAtom: () => null },
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async (input: unknown) => {
    harness.created.push(input);
    return { _tag: "Success", value: { key: "1", displayKey: "#1" } };
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (
    target: { input: IssueTemplatesInput & IssueCandidatesInput; kind?: string } | null,
  ) => {
    if (target?.kind === "candidates") {
      harness.metadataCalls.push(target.input);
      return {
        data: harness.metadata,
        error: null,
        isPending: harness.metadata === null,
        refresh: () => {},
      };
    }
    const body = target?.input.templateKey && harness.bodies.get(target.input.templateKey);
    const data = target?.input.metadataOnly
      ? { templates: harness.catalog, blankIssuesEnabled: true }
      : body
        ? { templates: [body], blankIssuesEnabled: true }
        : null;
    return { data, error: null, isPending: target !== null && data === null, refresh: () => {} };
  },
}));

import type { IssueCreateScope } from "./issueList";
import { IssueCreateSheet } from "./IssueCreateSheet";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
const initialScopes: IssueCreateScope[] = [
  {
    environmentId: EnvironmentId.make("environment"),
    projectTitle: "Project",
    templates: true,
    scope: {
      projectId: ProjectId.make("project"),
      tracker: IssueTrackerKind.make("gitlab"),
      host: "gitlab.example",
      scope: "group/app",
    },
  },
];
let scopes = initialScopes;
const render = () => act(() => root.render(<IssueCreateSheet route={{ params: { scopes } }} />));
const control = (key: string) => harness.controls.get(key)!;
const value = (key: string) => control(key).value;
const choose = (key: string) =>
  act(() =>
    (control("Template").onSelect as (id: string) => void)(JSON.stringify(["template", key])),
  );
const type = (key: string, text: string) =>
  act(() => (control(key).onChangeText as (text: string) => void)(text));

beforeEach(() => {
  root = createRoot(document.createElement("div"));
  harness.bodies.clear();
  harness.created.length = 0;
  harness.opened.length = 0;
  harness.metadataCalls.length = 0;
  harness.metadata = null;
  harness.controls.clear();
  harness.catalog = [
    harness.template("A"),
    { ...harness.template("B"), title: "", body: "", labels: [], contentDeferred: true },
  ];
  scopes = initialScopes;
});

describe("IssueCreateSheet templates", () => {
  it("starts with the first native template and keeps an explicit blank after catalog refresh", async () => {
    await render();
    expect([value("Title"), value("Description")]).toEqual(["A title", "A body"]);
    await choose("");
    harness.catalog = [...harness.catalog];
    await render();
    expect(control("Template").label).toBe("Blank issue");
    await type("Title", "Blank draft");
    await act(() => (control("Create issue").onPress as () => void)());
    expect(harness.created).toMatchObject([{ input: { title: "Blank draft", labels: [] } }]);
    expect(harness.created[0]).not.toHaveProperty("input.templateKey");
  });

  it("sends native structured template fields and the selected account through create and open", async () => {
    harness.catalog = [
      {
        ...harness.template("A"),
        fields: [
          {
            kind: "input",
            id: "details",
            label: "Details",
            description: null,
            required: true,
            placeholder: null,
            value: null,
          },
        ],
      },
    ];
    scopes = [
      { ...initialScopes[0]!, scope: { ...initialScopes[0]!.scope, connectionId: "account-B" } },
    ];
    await render();
    expect(control("Create issue").disabled).toBe(true);
    await type("Details", "Native form response");
    await act(() => (control("Create issue").onPress as () => void)());
    expect(harness.created).toMatchObject([
      {
        input: {
          connectionId: "account-B",
          templateKey: "A",
          body: "### Details\n\nNative form response",
        },
      },
    ]);
    expect(harness.opened).toMatchObject([{ connectionId: "account-B", key: "1" }]);
  });

  it("loads native create metadata for the selected type and sends validated values", async () => {
    scopes = [
      { ...initialScopes[0]!, templates: false, createFields: true, createIssueTypes: true },
    ];
    harness.metadata = {
      labels: [],
      assignees: [],
      truncated: false,
      issueTypes: [
        { id: "bug", name: "Bug" },
        { id: "task", name: "Task" },
      ],
      fields: [
        { id: "environment", label: "Environment", kind: "textarea", required: true },
        { id: "due", label: "Due date", kind: "date", required: true },
      ],
    };
    await render();
    await act(() =>
      (control("Issue type").onSelect as (id: string) => void)(JSON.stringify(["type", "bug"])),
    );
    expect(harness.metadataCalls.at(-1)).toMatchObject({ issueType: "bug" });
    await type("Title", "Native issue");
    await type("Environment", "Production");
    await type("Due date", "2026-02-30");
    expect(control("Create issue").disabled).toBe(true);
    await type("Due date", "2026-10-19");
    await act(() => (control("Create issue").onPress as () => void)());
    expect(harness.created).toMatchObject([
      {
        input: { issueType: "bug", fieldValues: { environment: "Production", due: "2026-10-19" } },
      },
    ]);
    await act(() =>
      (control("Issue type").onSelect as (id: string) => void)(JSON.stringify(["type", "task"])),
    );
    expect(value("Environment")).toBe("");
    expect(control("Create issue").disabled).toBe(true);
  });

  it("clears native values when the selected account changes without changing the project", async () => {
    scopes = [
      {
        ...initialScopes[0]!,
        templates: false,
        createFields: true,
        scope: { ...initialScopes[0]!.scope, connectionId: "account-A" },
      },
    ];
    harness.metadata = {
      labels: [],
      assignees: [],
      truncated: false,
      fields: [{ id: "environment", label: "Environment", kind: "text", required: true }],
    };
    await render();
    await type("Title", "My draft");
    await type("Environment", "Account A value");
    scopes = [{ ...scopes[0]!, scope: { ...scopes[0]!.scope, connectionId: "account-B" } }];
    await render();
    expect(value("Title")).toBe("My draft");
    expect(value("Environment")).toBe("");
    expect(control("Create issue").disabled).toBe(true);
    await act(() => (control("Create issue").onPress as () => void)());
    expect(harness.created).toEqual([]);
    expect(harness.metadataCalls.at(-1)).toMatchObject({ connectionId: "account-B" });
  });

  it("blocks required fields that must be filled on the tracker", async () => {
    scopes = [{ ...initialScopes[0]!, templates: false, createFields: true }];
    harness.metadata = {
      labels: [],
      assignees: [],
      truncated: false,
      fields: [{ id: "plugin", label: "Plugin", kind: "json", required: true }],
    };
    await render();
    await type("Title", "Native issue");
    expect(control("Create issue").disabled).toBe(true);
    await act(() => (control("Create issue").onPress as () => void)());
    expect(harness.created).toEqual([]);
    expect(control("Open tracker")).toBeDefined();
  });
  it("replaces an untouched template's text with the next one, but keeps typed and cleared text", async () => {
    await render();
    await choose("A");
    expect([value("Title"), value("Description")]).toEqual(["A title", "A body"]);

    await choose("B");
    expect(control("Create issue").disabled).toBe(true);
    expect(value("Title")).toBe("A title");
    harness.bodies.set("B", harness.template("B"));
    await render();
    expect([value("Title"), value("Description")]).toEqual(["B title", "B body"]);

    await type("Title", "Mine");
    await type("Description", "");
    await choose("A");
    expect([value("Title"), value("Description")]).toEqual(["Mine", ""]);

    await act(() => (control("Create issue").onPress as () => void)());
    expect(harness.created).toMatchObject([
      { input: { title: "Mine", body: "", labels: ["A-label"] } },
    ]);
  });

  it("keeps text typed while a chosen template's body is still loading", async () => {
    await render();
    await choose("B");
    await type("Title", "Typed first");
    harness.bodies.set("B", harness.template("B"));
    await render();
    expect([value("Title"), value("Description")]).toEqual(["Typed first", "B body"]);
  });
});
