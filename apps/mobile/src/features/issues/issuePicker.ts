import { issueEntryKey } from "@t3tools/client-runtime/state/issues";
import type { IssueDetail, IssueLabel } from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/reactivity";
import { issueAssigneeId } from "./issueDetail";

type IssuePickerKind = "labels" | "assignees";

export type IssuePickerConfirmed = {
  readonly base: IssueDetail;
  readonly environmentId: string;
  readonly kind: IssuePickerKind;
  readonly ids: ReadonlyArray<string>;
};

export const issuePickerConfirmed = Atom.family((_key: string) =>
  Atom.make<IssuePickerConfirmed | null>(null).pipe(Atom.setIdleTTL(5 * 60_000)),
);

export const issuePickerPending = Atom.family((_key: string) => Atom.make<string | null>(null));

export async function writeIssuePicker(
  registry: AtomRegistry.AtomRegistry,
  key: string,
  id: string,
  write: () => Promise<IssuePickerConfirmed>,
) {
  const pending = issuePickerPending(key);
  if (registry.get(pending) !== null) return;
  const release = registry.mount(pending);
  registry.set(pending, id);
  try {
    registry.set(issuePickerConfirmed(key), await write());
  } finally {
    registry.set(pending, null);
    release();
  }
}

export const issuePickerKey = (
  environmentId: string,
  issue: Parameters<typeof issueEntryKey>[0],
  kind: IssuePickerKind,
) => JSON.stringify([environmentId, issueEntryKey(issue), kind]);

export function clearAcknowledgedIssuePicker(
  registry: AtomRegistry.AtomRegistry,
  key: string,
  issue: IssueDetail,
  kind: IssuePickerKind,
  environmentId: string,
) {
  registry.update(issuePickerConfirmed(key), (confirmed) =>
    heldIssuePicker(issue, kind, confirmed, environmentId),
  );
}

export const issueLabelId = (label: IssueLabel) => label.id ?? label.name;

const nativeIssuePickerIds = (issue: IssueDetail, kind: IssuePickerKind) =>
  kind === "labels" ? issue.labels.map(issueLabelId) : issue.assignees.map(issueAssigneeId);

export function heldIssuePicker(
  issue: IssueDetail,
  kind: IssuePickerKind,
  confirmed: IssuePickerConfirmed | null,
  environmentId: string,
): IssuePickerConfirmed | null {
  if (
    !confirmed ||
    confirmed.environmentId !== environmentId ||
    confirmed.kind !== kind ||
    confirmed.base.viewer !== issue.viewer ||
    (issue.viewer === null && confirmed.base !== issue) ||
    confirmed.base.tracker !== issue.tracker ||
    issueEntryKey(confirmed.base) !== issueEntryKey(issue)
  )
    return null;
  const native = nativeIssuePickerIds(issue, kind);
  const acknowledged =
    confirmed.base !== issue &&
    native.length === confirmed.ids.length &&
    native.every((id) => confirmed.ids.includes(id));
  return acknowledged ? null : confirmed;
}

export function issuePickerIds(
  issue: IssueDetail,
  kind: IssuePickerKind,
  confirmed: IssuePickerConfirmed | null,
  environmentId: string,
): ReadonlyArray<string> {
  return (
    heldIssuePicker(issue, kind, confirmed, environmentId)?.ids ?? nativeIssuePickerIds(issue, kind)
  );
}

export function nextIssuePickerIds(
  issue: IssueDetail,
  kind: IssuePickerKind,
  confirmed: IssuePickerConfirmed | null,
  id: string,
  environmentId: string,
): string[] {
  const current = issuePickerIds(issue, kind, confirmed, environmentId);
  if (current.includes(id)) return current.filter((each) => each !== id);
  return kind === "assignees" && issue.capabilities.maxAssignees === 1 ? [id] : [...current, id];
}
