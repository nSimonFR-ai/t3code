import { makeIssueDetail } from "./issue-test-fixtures";
import { describe, expect, it, vi } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentRegistry,
  EnvironmentSupervisor,
} from "@t3tools/client-runtime/connection";
import { createIssueEnvironmentAtoms } from "@t3tools/client-runtime/state/issues";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import * as RpcClient from "../../../../../packages/client-runtime/src/rpc/client";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import {
  AuthSourceControlWriteScope,
  EnvironmentId,
  IssueTrackerKind,
  type AuthSessionState,
  type IssueReactionInput,
  type IssueReactionContent,
  ProjectId,
  type IssueComment,
  type IssueDetail,
} from "@t3tools/contracts";
import {
  mergeIssueComments,
  confirmIssueReaction,
  issueReactionsView,
  type IssueConfirmedReactions,
} from "./issueComments";

import { issueAccess, issueReactionAllowed } from "./issueDetail";

const comment = (id: string, reactions?: IssueComment["reactions"]): IssueComment => ({
  id,
  author: null,
  body: id,
  createdAt: "2026-10-01T00:00:00Z",
  url: null,
  ...(reactions === undefined ? {} : { reactions }),
});

function detail(patch: Partial<IssueDetail> = {}): IssueDetail {
  const issue = makeIssueDetail({
    commentCount: 3,
    comments: [comment("c3")],
    commentsCursor: "page-2",
  });
  return { ...issue, capabilities: { ...issue.capabilities, reactions: true }, ...patch };
}

const heart = [{ content: "heart" as const, count: 1, actors: [], viewerHasReacted: false }];

it("keeps native first-page edits and rights when retained pages overlap the seed", () => {
  const current = { ...comment("c3", heart), body: "Edited", canEdit: false };
  const older = { ...comment("c3", [{ ...heart[0]!, viewerHasReacted: true }]), canEdit: true };
  const comments = mergeIssueComments([current], [comment("c2"), older]);
  expect(comments).toEqual([comment("c2"), current]);
  expect(comments[1]).toBe(current);
});

const environmentId = EnvironmentId.make("environment");
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, never>>(AsyncResult.initial()),
);
vi.mock("../../../../../packages/client-runtime/src/state/session", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));

describe("confirmed mobile issue reactions", () => {
  const first = detail({ reactions: heart, comments: [comment("c3", heart)] });

  it("keeps confirmed issue and comment counts when the same issue is read again", () => {
    let held = confirmIssueReaction(environmentId, first, first.comments, null, "heart", true);
    held = confirmIssueReaction(environmentId, first, first.comments, held, "heart", true, "c3");
    const refreshed = detail({ reactions: [...heart], comments: [comment("c3", [...heart])] });
    const view = issueReactionsView(environmentId, refreshed, refreshed.comments, held);
    expect(view.reactions?.[0]).toMatchObject({ count: 2, viewerHasReacted: true });
    expect(view.comments[0]?.reactions?.[0]).toMatchObject({ count: 2, viewerHasReacted: true });
  });

  it("keeps the confirmed viewer flag when another person changes counts, then yields to native acknowledgement", () => {
    const held = confirmIssueReaction(environmentId, first, first.comments, null, "heart", true);
    const changed = detail({ reactions: [{ ...heart[0]!, count: 4 }], comments: first.comments });
    const view = issueReactionsView(environmentId, changed, changed.comments, held);
    expect(view.reactions?.[0]).toMatchObject({ count: 5, viewerHasReacted: true });
    const acknowledged = {
      ...changed,
      reactions: [{ ...heart[0]!, count: 6, viewerHasReacted: true }],
    };
    const native = issueReactionsView(
      environmentId,
      acknowledged,
      acknowledged.comments,
      view.held,
    );
    expect(native.reactions).toBe(acknowledged.reactions);
    expect(native.held).toBeNull();
  });

  it("drops a confirmation from another signed-in viewer, including one that lands after the switch", () => {
    const asA = detail({ reactions: heart, viewer: "a" });
    const held = confirmIssueReaction(environmentId, asA, asA.comments, null, "heart", true);
    expect(
      issueReactionsView(environmentId, { ...asA, reactions: [...heart] }, [], held).reactions?.[0],
    ).toMatchObject({ count: 2, viewerHasReacted: true });
    const asB = detail({ reactions: [{ ...heart[0]!, count: 2 }], viewer: "b" });
    const switched = issueReactionsView(environmentId, asB, asB.comments, held);
    expect(switched.reactions).toBe(asB.reactions);
    expect(switched.held).toBeNull();
    const late = confirmIssueReaction(environmentId, asA, asA.comments, null, "heart", false);
    const afterLate = issueReactionsView(environmentId, asB, asB.comments, late);
    expect(afterLate.reactions).toBe(asB.reactions);
    expect(afterLate.held).toBeNull();
    const unknown = detail({ reactions: heart, viewer: null });
    const unknownHeld = confirmIssueReaction(environmentId, unknown, [], null, "heart", true);
    expect(issueReactionsView(environmentId, { ...unknown }, [], unknownHeld).held).not.toBeNull();
  });

  it.each(
    [undefined, "c3"].flatMap((subjectId) =>
      ["viewer", null].flatMap((viewer) =>
        [false, true].map((reacted) => ({ subjectId, viewer, reacted })),
      ),
    ),
  )(
    "keeps cached reactions but trusts refreshed unknown owners: %j",
    ({ subjectId, viewer, reacted }) => {
      const reactions = [{ ...heart[0]!, count: 2, viewerHasReacted: !reacted }];
      const before = detail({ viewer, reactions, comments: [comment("c3", reactions)] });
      const held = confirmIssueReaction(
        environmentId,
        before,
        before.comments,
        null,
        "heart",
        reacted,
        subjectId,
      );
      const cached = { ...before, comments: [...before.comments] };
      const shown = issueReactionsView(environmentId, cached, cached.comments, held);
      expect(subjectId === undefined ? shown.reactions : shown.comments[0]?.reactions).toEqual([
        { ...heart[0]!, count: reacted ? 3 : 1, viewerHasReacted: reacted },
      ]);
      const native = [...reactions];
      const after = { ...before, reactions: native, comments: [comment("c3", native)] };
      const fresh = issueReactionsView(environmentId, after, after.comments, held);
      expect(subjectId === undefined ? fresh.reactions : fresh.comments[0]?.reactions).toEqual(
        viewer === null
          ? reactions
          : [{ ...heart[0]!, count: reacted ? 3 : 1, viewerHasReacted: reacted }],
      );
      expect(fresh.held).toBe(viewer === null ? null : held);
    },
  );

  it("holds a confirmed remove against a later add read and removes a last reaction", () => {
    const added = confirmIssueReaction(environmentId, first, first.comments, null, "heart", true);
    const removed = confirmIssueReaction(
      environmentId,
      first,
      first.comments,
      added,
      "heart",
      false,
    );
    const lateAdd = { ...first, reactions: [{ ...heart[0]!, count: 2, viewerHasReacted: true }] };
    expect(issueReactionsView(environmentId, lateAdd, lateAdd.comments, removed).reactions).toEqual(
      heart,
    );
    const onlyMine = { ...first, reactions: [{ ...heart[0]!, viewerHasReacted: true }] };
    const held = confirmIssueReaction(
      environmentId,
      onlyMine,
      onlyMine.comments,
      null,
      "heart",
      false,
    );
    expect(issueReactionsView(environmentId, onlyMine, onlyMine.comments, held).reactions).toEqual(
      [],
    );
  });

  it("keeps an older comment confirmation when a shifted first page requires loading its page again", () => {
    const loaded = mergeIssueComments(first.comments, [comment("c2", heart)]);
    const held = confirmIssueReaction(environmentId, first, loaded, null, "heart", true, "c2");
    const shifted = { ...first, comments: [comment("c4", heart)] };
    const missing = issueReactionsView(environmentId, shifted, shifted.comments, held);
    const reloaded = mergeIssueComments(shifted.comments, [comment("c2", [...heart])]);
    const shown = issueReactionsView(environmentId, shifted, reloaded, missing.held);
    expect(shown.comments.find((each) => each.id === "c2")?.reactions?.[0]).toMatchObject({
      count: 2,
      viewerHasReacted: true,
    });
  });

  it("reconciles each content and subject separately when native viewer flags arrive", () => {
    let held = confirmIssueReaction(environmentId, first, first.comments, null, "heart", true);
    held = confirmIssueReaction(environmentId, first, first.comments, held, "rocket", true);
    held = confirmIssueReaction(environmentId, first, first.comments, held, "heart", true, "c3");
    const native = { ...first, reactions: [{ ...heart[0]!, count: 2, viewerHasReacted: true }] };
    const view = issueReactionsView(environmentId, native, native.comments, held);
    expect(view.reactions).toEqual([
      ...native.reactions,
      { content: "rocket", count: 1, actors: [], viewerHasReacted: true },
    ]);
    expect(view.comments[0]?.reactions?.[0]).toMatchObject({ count: 2, viewerHasReacted: true });
    const removed = { ...native, reactions: heart };
    expect(
      issueReactionsView(environmentId, removed, removed.comments, view.held).reactions?.[0],
    ).toEqual(heart[0]);
  });

  it.each([
    { environmentId: EnvironmentId.make("other"), issue: first },
    { environmentId, issue: { ...first, key: "other" } },
    { environmentId, issue: { ...first, tracker: IssueTrackerKind.make("jira") } },
    { environmentId, issue: { ...first, projectId: ProjectId.make("other") } },
    { environmentId, issue: { ...first, host: "other.example" } },
    { environmentId, issue: { ...first, scope: "other/repo" } },
    { environmentId, issue: { ...first, connectionId: "AccountB" } },
  ])("does not carry confirmed flags to another target %j", (target) => {
    const held = confirmIssueReaction(environmentId, first, first.comments, null, "heart", true);
    const view = issueReactionsView(
      target.environmentId,
      target.issue,
      target.issue.comments,
      held,
    );
    expect(view.reactions).toEqual(heart);
    expect(view.held).toBeNull();
  });
});

effectIt.effect.each(
  [undefined, "c3", "c2"].flatMap((subjectId) =>
    [false, true].flatMap((viewerHasReacted) =>
      [false, true].map((failRead) => ({ subjectId, viewerHasReacted, failRead })),
    ),
  ),
)(
  "sends the opposite reaction after a confirmed write with native reads delayed or failed %j",
  ({ subjectId, viewerHasReacted, failRead }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const reactions = [{ ...heart[0]!, count: 2, viewerHasReacted }];
        const first = detail({ reactions, comments: [comment("c3", reactions)] });
        const older = [comment("c2", reactions)];
        const comments = mergeIssueComments(first.comments, older);
        const refreshStarted = Latch.makeUnsafe();
        const releaseRead = Latch.makeUnsafe();
        const readFailed = Latch.makeUnsafe();
        const state = yield* SubscriptionRef.make({
          ...AVAILABLE_CONNECTION_STATE,
          phase: "connected" as const,
        });
        const session = yield* SubscriptionRef.make(Option.some({}));
        const supervisor = {
          state,
          session,
        } as unknown as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
        const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
          run: (_id, effect) =>
            Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          followStream: (_id, stream) =>
            Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
        const runtime = Atom.runtime(
          Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
        );
        const atoms = createIssueEnvironmentAtoms(runtime);
        const registry = AtomRegistry.make();
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
        const mountSession = registry.mount(sessions(environmentId));
        yield* Effect.addFinalizer(() => Effect.sync(mountSession));
        registry.set(
          sessions(environmentId),
          AsyncResult.success({
            authenticated: true,
            auth: {
              policy: "remote-reachable",
              bootstrapMethods: [],
              sessionMethods: [],
              sessionCookieName: "test",
            },
            scopes: [AuthSourceControlWriteScope],
            permissions: [AuthSourceControlWriteScope],
          }),
        );
        let reads = 0;
        const read = vi.spyOn(RpcClient, "request");
        read.mockImplementation((() =>
          Effect.suspend(() => {
            reads++;
            if (reads === 1) return Effect.succeed(first);
            refreshStarted.openUnsafe();
            return releaseRead.await.pipe(
              Effect.andThen(
                failRead ? Effect.fail(new Error("detail read failed")) : Effect.succeed(first),
              ),
            );
          })) as unknown as Parameters<typeof read.mockImplementation>[0]);
        yield* Effect.addFinalizer(() => Effect.sync(() => read.mockRestore()));
        const calls: IssueReactionInput[] = [];
        let failWrite = false;
        const write = vi.spyOn(RpcClient, "requestGuarded");
        write.mockImplementation(((_tag: string, input: IssueReactionInput) =>
          Effect.sync(() => calls.push(input)).pipe(
            Effect.andThen(() =>
              failWrite ? Effect.fail(new Error("write failed")) : Effect.void,
            ),
          )) as unknown as Parameters<typeof write.mockImplementation>[0]);
        yield* Effect.addFinalizer(() => Effect.sync(() => write.mockRestore()));
        const target = {
          environmentId,
          input: {
            projectId: first.projectId,
            tracker: first.tracker,
            host: first.host,
            scope: first.scope,
            key: first.key,
          },
        };
        const query = atoms.detail(target);
        const stop = registry.subscribe(query, (result) => {
          if (result._tag === "Failure") readFailed.openUnsafe();
        });
        yield* Effect.addFinalizer(() => Effect.sync(stop));
        yield* AtomRegistry.getResult(registry, query, { suspendOnWaiting: true });
        let held: IssueConfirmedReactions | null = null;
        const shown = (input: { subjectId: string | undefined } = { subjectId }) => {
          const issue = Option.getOrThrow(AsyncResult.value(registry.get(query)));
          const view = issueReactionsView(
            environmentId,
            issue,
            mergeIssueComments(issue.comments, older),
            held,
          );
          return input.subjectId === undefined
            ? view.reactions
            : view.comments.find((each) => each.id === input.subjectId)?.reactions;
        };
        let currentIssue = first;
        const toggle = (
          input: { content: IssueReactionContent; subjectId: string | undefined } = {
            content: "heart",
            subjectId,
          },
        ) =>
          Effect.promise(async () => {
            const access = issueAccess(currentIssue, {
              connected: true,
              comment: true,
              update: true,
              setState: true,
              react: true,
            });
            if (
              !issueReactionAllowed(currentIssue, access, input.content, input.subjectId, comments)
            )
              return null;
            const reacted = !shown(input)?.find((reaction) => reaction.content === "heart")
              ?.viewerHasReacted;
            const response = await runAtomCommand(
              registry,
              atoms.react,
              {
                ...target,
                input: {
                  ...target.input,
                  ...(input.subjectId === undefined ? {} : { subjectId: input.subjectId }),
                  content: input.content,
                  reacted,
                },
              },
              { reportFailure: false },
            );
            if (response._tag === "Success")
              held = confirmIssueReaction(
                environmentId,
                first,
                comments,
                held,
                input.content,
                reacted,
                input.subjectId,
              );
            return response;
          });
        expect((yield* toggle())?._tag).toBe("Success");
        yield* refreshStarted.await;
        if (failRead) {
          releaseRead.openUnsafe();
          yield* readFailed.await;
        }
        expect(shown()?.[0]).toMatchObject({
          viewerHasReacted: !viewerHasReacted,
          count: viewerHasReacted ? 1 : 3,
        });
        expect((yield* toggle())?._tag).toBe("Success");
        expect(calls.map((call) => call.reacted)).toEqual([!viewerHasReacted, viewerHasReacted]);
        expect(calls.map((call) => call.subjectId)).toEqual([subjectId, subjectId]);
        expect(shown()).toEqual(reactions);
        const beforeFailure = held;
        const beforeReads = reads;
        failWrite = true;
        expect((yield* toggle())?._tag).toBe("Failure");
        expect(held).toBe(beforeFailure);
        expect(shown()).toEqual(reactions);
        expect(reads).toBe(beforeReads);
        currentIssue = {
          ...first,
          capabilities: {
            ...first.capabilities,
            reactions: false,
            commentReactions: true,
            reactionContents: ["thumbs-up", "thumbs-down", "laugh", "hooray", "confused", "heart"],
          },
        };
        const beforeDenied = calls.length;
        failWrite = false;
        expect(yield* toggle({ content: "heart", subjectId: undefined })).toBeNull();
        expect(yield* toggle({ content: "rocket", subjectId: "c2" })).toBeNull();
        expect(yield* toggle({ content: "eyes", subjectId: "c3" })).toBeNull();
        expect(yield* toggle({ content: "heart", subjectId: "unknown" })).toBeNull();
        expect(calls).toHaveLength(beforeDenied);
        const azure = currentIssue;
        currentIssue = { ...azure, capabilities: { ...azure.capabilities, reactionContents: [] } };
        expect(yield* toggle({ content: "heart", subjectId: "c3" })).toBeNull();
        expect(calls).toHaveLength(beforeDenied);
        currentIssue = azure;
        expect((yield* toggle({ content: "heart", subjectId: "c3" }))?._tag).toBe("Success");
        expect((yield* toggle({ content: "heart", subjectId: "c2" }))?._tag).toBe("Success");
        expect(calls.slice(beforeDenied).map((call) => [call.content, call.subjectId])).toEqual([
          ["heart", "c3"],
          ["heart", "c2"],
        ]);
      }),
    ),
);
