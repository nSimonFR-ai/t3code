import type {
  IssueFieldValues,
  IssueInputField,
  IssueTemplate,
  IssueTemplateList,
} from "@t3tools/contracts";
import type { EnvironmentQueryView } from "../../state/query";
import type { IssueCreateScope } from "./issueList";

type TemplateRead = Pick<EnvironmentQueryView<IssueTemplateList>, "data" | "error" | "isPending">;

export function issueTemplateCatalogRead(scope: IssueCreateScope | null) {
  return scope?.templates
    ? { environmentId: scope.environmentId, input: { ...scope.scope, metadataOnly: true } }
    : null;
}

export function issueTemplateBodyRead(
  scope: IssueCreateScope | null,
  catalog: IssueTemplateList | null,
  templateKey: string,
) {
  const deferred = catalog?.templates.some(
    (template) => template.key === templateKey && template.contentDeferred === true,
  );
  return scope?.templates && deferred
    ? { environmentId: scope.environmentId, input: { ...scope.scope, templateKey } }
    : null;
}

export function selectedIssueTemplate(
  templateKey: string,
  catalog: TemplateRead,
  selected: TemplateRead,
): { template: IssueTemplate | null; blocked: string | null; retry: boolean } {
  const entry = catalog.data?.templates.find((template) => template.key === templateKey);
  if (templateKey === "" || catalog.data === null) {
    return { template: null, blocked: null, retry: false };
  }
  if (!entry) {
    return {
      template: null,
      blocked: "The selected template is no longer available. Choose a template.",
      retry: false,
    };
  }
  if (entry.contentDeferred !== true) return { template: entry, blocked: null, retry: false };
  const loaded = selected.data?.templates.find(
    (template) => template.key === templateKey && template.contentDeferred !== true,
  );
  if (loaded) return { template: loaded, blocked: null, retry: false };
  if (selected.isPending || (selected.data === null && selected.error === null)) {
    return { template: null, blocked: "Loading template…", retry: false };
  }
  return { template: null, blocked: "The selected template could not be read.", retry: true };
}

export function fillIssueTemplate(
  draft: { readonly title: boolean; readonly body: boolean },
  template: IssueTemplate,
  form: { readonly title: string; readonly body: string },
) {
  return {
    title: draft.title ? template.title : form.title,
    body: draft.body ? template.body : form.body,
    labels: template.labels,
    assignees: template.assignees,
  };
}

export function mobileNativeFieldError(
  fields: readonly IssueInputField[],
  values: IssueFieldValues,
) {
  for (const field of fields) {
    if (field.kind === "json" || field.kind === "cascading-select") {
      if (field.required) return `Fill in ${field.label} on the tracker.`;
      continue;
    }
    const value = values[field.id];
    if (value === undefined || (typeof value === "string" ? !value.trim() : !value.length)) {
      if (field.required) return `Fill in ${field.label}.`;
      continue;
    }
    if (field.kind === "multiselect") {
      if (
        typeof value === "string" ||
        value.some((entry) => !field.options?.some((option) => option.value === entry))
      )
        return `Choose values for ${field.label}.`;
    } else if (typeof value !== "string") return `Enter a value for ${field.label}.`;
    else if (field.kind === "select" && !field.options?.some((option) => option.value === value))
      return `Choose a value for ${field.label}.`;
    else if (field.kind === "number" && !Number.isFinite(Number(value)))
      return `Enter a number for ${field.label}.`;
    else if (
      field.kind === "date" &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(new Date(value).getTime()) ||
        new Date(value).toISOString().slice(0, 10) !== value)
    )
      return `Enter a date for ${field.label}.`;
    else if (
      field.kind === "datetime" &&
      (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(new Date(value).getTime()))
    )
      return `Enter a date and time with a time zone for ${field.label}.`;
  }
  return null;
}

export function mobileNativeFieldValues(
  fields: readonly IssueInputField[],
  values: IssueFieldValues,
): IssueFieldValues {
  return Object.fromEntries(
    fields.flatMap((field) => {
      const value = values[field.id];
      if (value === undefined || field.kind === "json" || field.kind === "cascading-select")
        return [];
      if (
        !field.required &&
        typeof value === "string" &&
        !value.trim() &&
        field.kind !== "text" &&
        field.kind !== "textarea" &&
        !(field.kind === "select" && field.options?.some((option) => option.value === value))
      )
        return [];
      return [
        [
          field.id,
          field.kind === "datetime" && typeof value === "string" && value.trim()
            ? new Date(value).toISOString()
            : value,
        ],
      ];
    }),
  );
}
