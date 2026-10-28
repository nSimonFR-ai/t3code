import { issueEntryKey } from "@t3tools/client-runtime/state/issues";
import type {
  EnvironmentId,
  IssueComment,
  IssueDetail,
  IssueReaction,
  IssueReactionContent,
} from "@t3tools/contracts";

export const mergeIssueComments = (
  current: ReadonlyArray<IssueComment>,
  previous: ReadonlyArray<IssueComment>,
) => [...new Map([...previous, ...current].map((comment) => [comment.id, comment])).values()];

function applyIssueReaction(
  reactions: ReadonlyArray<IssueReaction>,
  content: IssueReactionContent,
  reacted: boolean,
): ReadonlyArray<IssueReaction> {
  const current = reactions.find((reaction) => reaction.content === content);
  if (!current)
    return reacted
      ? [...reactions, { content, count: 1, actors: [], viewerHasReacted: true }]
      : reactions;
  if (current.viewerHasReacted === reacted) return reactions;
  const count = current.count + (reacted ? 1 : -1);
  return count <= 0
    ? reactions.filter((reaction) => reaction !== current)
    : reactions.map((reaction) =>
        reaction === current ? { ...reaction, count, viewerHasReacted: reacted } : reaction,
      );
}

export type IssueConfirmedReactions = {
  readonly environmentId: EnvironmentId;
  readonly issue: string;
  readonly values: ReadonlyArray<{
    readonly subjectId: string | undefined;
    readonly content: IssueReactionContent;
    readonly reacted: boolean;
    readonly base: ReadonlyArray<IssueReaction> | undefined;
  }>;
};

const reactionIssueKey = (issue: IssueDetail) =>
  JSON.stringify([issue.tracker, issueEntryKey(issue), issue.viewer]);
const reactionBase = (
  issue: IssueDetail,
  comments: ReadonlyArray<IssueComment>,
  subjectId?: string,
) =>
  subjectId === undefined
    ? issue.reactions
    : comments.find((comment) => comment.id === subjectId)?.reactions;

export function issueReactionsView(
  environmentId: EnvironmentId,
  issue: IssueDetail,
  comments: ReadonlyArray<IssueComment>,
  confirmed: IssueConfirmedReactions | null,
) {
  const current =
    confirmed?.environmentId === environmentId && confirmed.issue === reactionIssueKey(issue)
      ? confirmed
      : null;
  if (!current) return { reactions: issue.reactions, comments, held: null };
  const values = current.values.filter((value) => {
    if (
      value.subjectId !== undefined &&
      !comments.some((comment) => comment.id === value.subjectId)
    )
      return true;
    const reactions = reactionBase(issue, comments, value.subjectId);
    if (issue.viewer === null && reactions !== undefined && reactions !== value.base) return false;
    return (
      reactions === value.base ||
      (reactions?.find((reaction) => reaction.content === value.content)?.viewerHasReacted ??
        false) !== value.reacted
    );
  });
  const held = !values.length
    ? null
    : values.length === current.values.length
      ? current
      : { ...current, values };
  const shown = (reactions: ReadonlyArray<IssueReaction> | undefined, subjectId?: string) =>
    values
      .filter((value) => value.subjectId === subjectId)
      .reduce(
        (result, value) => applyIssueReaction(result ?? [], value.content, value.reacted),
        reactions,
      );
  return {
    reactions: shown(issue.reactions),
    comments: comments.map((comment) => {
      const reactions = shown(comment.reactions, comment.id);
      return reactions === comment.reactions ? comment : { ...comment, reactions };
    }),
    held,
  };
}

export function confirmIssueReaction(
  environmentId: EnvironmentId,
  issue: IssueDetail,
  comments: ReadonlyArray<IssueComment>,
  confirmed: IssueConfirmedReactions | null,
  content: IssueReactionContent,
  reacted: boolean,
  subjectId?: string,
): IssueConfirmedReactions {
  const held = issueReactionsView(environmentId, issue, comments, confirmed).held;
  return {
    environmentId,
    issue: reactionIssueKey(issue),
    values: [
      ...(held?.values.filter(
        (value) => value.subjectId !== subjectId || value.content !== content,
      ) ?? []),
      { subjectId, content, reacted, base: reactionBase(issue, comments, subjectId) },
    ],
  };
}
