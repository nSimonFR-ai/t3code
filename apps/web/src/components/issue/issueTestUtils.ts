import {
  IssueTrackerKind,
  ProjectId,
  type AuthEnvironmentScopes,
  type AuthSessionState,
} from "@t3tools/contracts";
import { createRoot } from "react-dom/client";

export function createIssueTestRoot() {
  const container = document.createElement("div");
  document.body.append(container);
  return { container, root: createRoot(container) };
}

export function setIssueTestValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!.call(
    element,
    value,
  );
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

export function githubIssueTestRef() {
  return {
    projectId: ProjectId.make("project"),
    tracker: IssueTrackerKind.make("github"),
    host: "github.com",
    scope: "org/repo",
    key: "1",
  };
}

export const makeIssueTestSession = (...scopes: AuthEnvironmentScopes): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes,
  permissions: [...scopes],
});
