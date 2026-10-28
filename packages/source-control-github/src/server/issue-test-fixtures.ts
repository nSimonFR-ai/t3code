import type { IssueTemplatesRepositoryRepository } from "./issueTracker.graphql.ts";

export const templateEntry = (name: string, text: string) => ({
  name,
  object: { __typename: "Blob" as const, text },
});

export const templateTree = (
  entries: ReturnType<typeof templateEntry>[],
  oid = "a".repeat(40),
) => ({
  __typename: "Tree" as const,
  oid,
  entries,
});

export function templateResponse<Overrides extends Partial<IssueTemplatesRepositoryRepository>>(
  nameWithOwner: string,
  overrides?: Overrides,
) {
  return {
    data: {
      repository: {
        nameWithOwner,
        isPrivate: false,
        forms: null,
        rootForms: null,
        docsForms: null,
        issueTemplates: [],
        ...overrides,
      },
    },
  };
}

export function templateTarget(host = "github.com") {
  return { cwd: "/w", host, scope: "acme/web" };
}

export function issueTarget(host = "github.com") {
  return { ...templateTarget(host), key: "42" };
}
