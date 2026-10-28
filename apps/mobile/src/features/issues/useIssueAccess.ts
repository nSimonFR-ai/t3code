import { useAtomValue } from "@effect/atom-react";
import type { AtomRegistry } from "effect/reactivity";
import { EnvironmentId, type IssueDetail } from "@t3tools/contracts";
import { issueEnvironment } from "../../state/issues";
import { usePullRequestConnected } from "../pull-requests/usePullRequestConnected";
import { issueAccess, issueTarget } from "./issueDetail";
import { markIssueWritten } from "./issueList";
import type { IssueParams } from "./issueSelection";

export { issueTarget } from "./issueDetail";

/** Tells the list which source to re-read after a confirmed write to this issue. */
export function markIssueTargetWritten(registry: AtomRegistry.AtomRegistry, params: IssueParams) {
  const { environmentId, input } = issueTarget(params);
  markIssueWritten(registry, environmentId, { ...input, host: params.host }, params.key);
}

export function useIssueAccess(params: IssueParams, detail: IssueDetail | null) {
  const environmentId = EnvironmentId.make(params.environmentId);
  const connected = usePullRequestConnected(params.environmentId);
  const comment = useAtomValue(issueEnvironment.comment.permissionAtom(environmentId));
  const update = useAtomValue(issueEnvironment.update.permissionAtom(environmentId));
  const setState = useAtomValue(issueEnvironment.setState.permissionAtom(environmentId));
  const react = useAtomValue(issueEnvironment.react.permissionAtom(environmentId));
  return { connected, ...issueAccess(detail, { connected, comment, update, setState, react }) };
}
