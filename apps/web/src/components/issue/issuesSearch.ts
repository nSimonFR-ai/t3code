import { IssueRef, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { IssueListPreferences } from "./issueListPreferences";

export interface IssuesSearch extends IssueListPreferences {
  readonly selectedEnvironmentId?: EnvironmentId;
  readonly selectedProjectId?: ProjectId;
  readonly selectedHost?: string;
  readonly selectedConnectionId?: string;
  readonly tracker?: string | undefined;
  readonly scope?: string | undefined;
  readonly key?: string | undefined;
}

const bounded = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : undefined;
const issueKey = (value: unknown): string | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : bounded(value);
const decodeAccountSelector = Schema.decodeUnknownSync(IssueRef.fields.connectionId);
function selectedIssueHost(value: unknown): string | undefined {
  if (value !== undefined && typeof value !== "string")
    throw new Error("The selected issue host is invalid.");
  return bounded(value);
}
function accountSelector(value: unknown): string | undefined {
  const connectionId = decodeAccountSelector(value);
  if (connectionId !== value) throw new Error("The issue account selector is invalid.");
  return connectionId;
}
/** A search key that is either present as a string or absent, never present as undefined. */
function present<K extends string, V extends string>(
  key: K,
  value: string | undefined,
): { [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]: V });
}

export const validateIssuesSearch = (raw: Record<string, unknown>): IssuesSearch => ({
  who:
    raw.who === "assigned" || raw.who === "authored" || raw.who === "mentioned" ? raw.who : "all",
  status: raw.status === "closed" || raw.status === "all" ? raw.status : "open",
  ...(raw.issueSort === "created" || raw.issueSort === "updated" || raw.issueSort === "comments"
    ? { issueSort: raw.issueSort }
    : {}),
  ...(raw.issueOrder === "asc" || raw.issueOrder === "desc" ? { issueOrder: raw.issueOrder } : {}),
  ...present("host", bounded(raw.host)),
  ...present("connectionId", accountSelector(raw.connectionId)),
  ...present<"environmentId", EnvironmentId>("environmentId", bounded(raw.environmentId)),
  ...present<"projectId", ProjectId>("projectId", bounded(raw.projectId)),
  // Always an own key: the router lays this over the parent route's unvalidated search.
  q: bounded(raw.q),
  ...present<"selectedEnvironmentId", EnvironmentId>(
    "selectedEnvironmentId",
    bounded(raw.selectedEnvironmentId),
  ),
  ...present<"selectedProjectId", ProjectId>("selectedProjectId", bounded(raw.selectedProjectId)),
  ...present("selectedHost", selectedIssueHost(raw.selectedHost)),
  ...present("selectedConnectionId", accountSelector(raw.selectedConnectionId)),
  tracker: bounded(raw.tracker),
  scope: bounded(raw.scope),
  key: issueKey(raw.key),
});
