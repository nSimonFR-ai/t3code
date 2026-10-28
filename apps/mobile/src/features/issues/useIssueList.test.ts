import { makeIssueListEntry } from "./issue-test-fixtures";
import { createIssueTestHook } from "./issue-testkit";
import {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  type IssueCapabilities,
  type IssueListInput,
  type IssueListEntry,
  type IssueListResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { expect, it, vi } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";

import * as RpcClient from "../../../../../packages/client-runtime/src/rpc/client.ts";
import * as EnvironmentRegistry from "../../../../../packages/client-runtime/src/connection/registry.ts";
import * as EnvironmentSupervisor from "../../../../../packages/client-runtime/src/connection/supervisor.ts";
import { AVAILABLE_CONNECTION_STATE } from "../../../../../packages/client-runtime/src/connection/model.ts";
import type { RpcSession } from "../../../../../packages/client-runtime/src/rpc/session.ts";
import { createIssueEnvironmentAtoms } from "@t3tools/client-runtime/state/issues";
import * as Layer from "effect/Layer";

vi.mock("../../state/issues", () => ({ issueEnvironment: {} }));

import { issueEnvironment } from "../../state/issues";
import { useIssueList, type IssueListTarget } from "./useIssueList";
import {
  issueCreateScopes,
  issueListTrackers,
  issueListNotices,
  markIssueWritten,
} from "./issueList";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (key: string, overrides: Partial<IssueListEntry> = {}): IssueListEntry =>
  makeIssueListEntry({
    tracker: IssueTrackerKind.make("gitlab"),
    host: "gitlab.example",
    scope: "group/app",
    displayKey: `#${key}`,
    title: key,
    url: `https://gitlab.example/group/app/-/issues/${key}`,
    state: { category: "open", name: "open" },
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
    key,
  });

const source = (entry: IssueListEntry) => ({ ...entry, capabilities: {} as IssueCapabilities });
const cursor = "gitlab gitlab.example group/app";
const failedCursor = "gitlab gitlab.example group/failed";
const otherCursor = "github github.example group/other";

function initializeConnectedIssueEnvironment() {
  const runtime = Atom.runtime(
    Layer.effect(
      EnvironmentRegistry.EnvironmentRegistry,
      Effect.gen(function* () {
        const supervisor = {
          state: yield* SubscriptionRef.make({
            ...AVAILABLE_CONNECTION_STATE,
            phase: "connected" as const,
          }),
          session: yield* SubscriptionRef.make(Option.some({} as RpcSession)),
        } as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
        return EnvironmentRegistry.EnvironmentRegistry.of({
          run: (_id, effect) =>
            Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          followStream: (_id, stream) =>
            Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
      }),
    ),
  );
  Object.assign(issueEnvironment, createIssueEnvironmentAtoms(runtime));
}

it.each([
  { viewer: "A", switchFilter: false, companion: null },
  { viewer: "B", switchFilter: false, companion: null },
  { viewer: "B", switchFilter: true, companion: null },
  { viewer: "A", switchFilter: false, companion: "waiting" },
  { viewer: "A", switchFilter: false, companion: "failed" },
  { viewer: "B", switchFilter: false, companion: "ready" },
  { viewer: "B", switchFilter: false, companion: null, restartFailure: "request" },
  { viewer: "B", switchFilter: false, companion: null, restartFailure: "source" },
])(
  "restarts only the current changed viewer from page one: %j",
  async ({ viewer, switchFilter, companion, restartFailure }) => {
    const firstRows = Array.from({ length: 50 }, (_, index) => row(`A-${index}`));
    const failed = row("failed", { scope: "group/failed", projectId: ProjectId.make("failed") });
    const other = row("other", {
      tracker: IssueTrackerKind.make("github"),
      host: "github.example",
      scope: "group/other",
      projectId: ProjectId.make("other"),
    });
    const otherTail = row("other-tail", other);
    const first: IssueListResult = {
      entries: [...firstRows, ...(restartFailure ? [] : [failed]), other],
      sources: [source(firstRows[0]!), ...(restartFailure ? [] : [source(failed)]), source(other)],
      nextCursors: {
        [cursor]: "2",
        ...(restartFailure ? {} : { [failedCursor]: "F2" }),
        [otherCursor]: "O2",
      },
      viewers: { "gitlab gitlab.example": "A", "github github.example": "other" },
      trackers: [],
      errors: [],
    };
    const continued: IssueListResult = {
      ...first,
      entries: [otherTail],
      viewers: { ...first.viewers, "gitlab gitlab.example": viewer },
      nextCursors: { [otherCursor]: "O3" },
      errors: restartFailure
        ? []
        : [
            {
              projectId: failed.projectId,
              projectTitle: failed.projectTitle,
              tracker: failed.tracker,
              host: failed.host,
              message: "unavailable",
            },
          ],
    };
    const fresh: IssueListResult = {
      ...continued,
      entries: [row("B-first")],
      sources: [source(firstRows[0]!)],
      nextCursors: {},
      errors: [],
    };
    const pageRequest = vi.spyOn(RpcClient, "requestGuarded");
    const restarts = viewer === "B" && !switchFilter;
    const replies = restarts ? [first, continued, fresh] : [first, continued];
    let restartFailed = false;
    const companionPage = Promise.withResolvers<IssueListResult>();
    const continuation = Promise.withResolvers<IssueListResult>();
    const started = Promise.withResolvers<void>();
    pageRequest.mockImplementation(((_tag: string, input: IssueListInput) => {
      if (companion === "ready" && input.cursors?.[cursor] === "offline-2")
        return Effect.promise(() => companionPage.promise);
      const reply = replies.shift()!;
      if (reply === fresh)
        companionPage.resolve({
          ...offline,
          entries: [row("offline-tail")],
          nextCursors: { [cursor]: "offline-3" },
        });
      if (switchFilter && reply === continued) {
        started.resolve();
        return Effect.promise(() => continuation.promise);
      }
      if (restartFailure && reply === fresh && !restartFailed) {
        restartFailed = true;
        if (restartFailure === "request") return Effect.fail(new Error("restart failed"));
        return Effect.succeed({
          ...fresh,
          entries: [],
          errors: [
            {
              projectId: firstRows[0]!.projectId,
              projectTitle: "Project",
              message: "restart failed",
            },
          ],
        });
      }
      return Effect.succeed(reply);
    }) as unknown as Parameters<typeof pageRequest.mockImplementation>[0]);
    const runtime = Atom.runtime(
      Layer.succeed(
        EnvironmentRegistry.EnvironmentRegistry,
        EnvironmentRegistry.EnvironmentRegistry.of({
          run: (_environmentId, effect) =>
            Effect.provideService(
              effect,
              EnvironmentSupervisor.EnvironmentSupervisor,
              {} as EnvironmentSupervisor.EnvironmentSupervisor["Service"],
            ),
        } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
      ),
    );
    Object.assign(issueEnvironment, createIssueEnvironmentAtoms(runtime));
    const registry = AtomRegistry.make();
    const target: IssueListTarget = {
      environmentId: EnvironmentId.make(`environment-${viewer}-${switchFilter}-${companion}`),
      input: { state: "all", involvement: "assigned", limit: 50 },
    };
    const initial = await issueEnvironment.listPage.run(registry, target);
    if (initial._tag !== "Success") throw new Error("initial list failed");
    const offlineTarget = {
      ...target,
      environmentId: EnvironmentId.make(`${target.environmentId}-offline`),
    };
    const offline = { ...first, entries: [row("offline")], nextCursors: { [cursor]: "offline-2" } };
    const list = Atom.family((selected: IssueListTarget) =>
      Atom.make<AsyncResult.AsyncResult<IssueListResult, Error>>(
        AsyncResult.success(
          selected.environmentId === offlineTarget.environmentId ? offline : initial.value,
        ),
      ),
    );
    issueEnvironment.list = list;
    let targets = companion ? [target, offlineTarget] : [target];
    const hook = createIssueTestHook(registry, () => useIssueList(targets));
    try {
      await act(async () => hook.render());
      expect(hook.current.lists[0]?.held.entries).toHaveLength(restartFailure ? 51 : 52);
      if (companion === "waiting" || companion === "failed") {
        await act(async () =>
          registry.set(
            list(offlineTarget),
            companion === "waiting"
              ? AsyncResult.waiting(registry.get(list(offlineTarget)))
              : AsyncResult.failure(Cause.fail(new Error("offline"))),
          ),
        );
      }
      if (switchFilter) {
        let pending: Promise<void>;
        await act(async () => {
          pending = hook.current.loadMore();
          await started.promise;
        });
        targets = [{ ...target, input: { ...target.input, state: "open" } }];
        await act(async () => hook.render());
        await act(async () => {
          continuation.resolve(continued);
          await pending!;
        });
      } else {
        await act(async () => hook.current.loadMore());
      }
      expect(pageRequest.mock.calls.map(([tag]) => tag)).toEqual(
        Array(restarts ? (companion === "ready" ? 4 : 3) : 2).fill("issues.list"),
      );
      expect(pageRequest.mock.calls[1]?.[1]).toMatchObject({ cursors: first.nextCursors });
      if (restartFailure) {
        expect(hook.current.lists[0]?.held.entries.map((entry) => entry.key)).toEqual([
          "other",
          "other-tail",
        ]);
        expect(hook.current.lists[0]?.held.nextCursors).toEqual({ [otherCursor]: "O3" });
        expect(hook.current.loadingMore).toBe(false);
        expect(hook.current.refreshing).toBe(false);
        expect(hook.current.loadMoreError).toContain("restart failed");
        await act(async () => hook.current.loadMore());
        expect(pageRequest).toHaveBeenCalledTimes(3);
        replies.push(fresh);
        await act(async () => hook.current.loadMore(true));
        expect(pageRequest).toHaveBeenCalledTimes(4);
        expect(pageRequest.mock.calls[3]?.[1]).toEqual(pageRequest.mock.calls[2]?.[1]);
        expect(hook.current.loadMoreError).toBeNull();
        expect(hook.current.lists[0]?.held.pendingWrites.size).toBe(0);
      }
      if (restarts) {
        expect(pageRequest.mock.calls[companion === "ready" ? 3 : 2]?.[1]).toEqual({
          state: "all",
          involvement: "assigned",
          projectId: firstRows[0]!.projectId,
          host: "gitlab.example",
          limit: 50,
        });
        expect(hook.current.lists[0]?.held.entries.map((entry) => entry.key)).toEqual([
          ...(restartFailure ? [] : ["failed"]),
          "other",
          "other-tail",
          "B-first",
        ]);
      } else {
        expect(hook.current.lists[0]?.held.entries.map((entry) => entry.key)).toEqual(
          (switchFilter ? first.entries : [...first.entries, otherTail]).map((entry) => entry.key),
        );
      }
      expect(hook.current.lists[0]?.held.nextCursors).toEqual(
        switchFilter
          ? first.nextCursors
          : { ...(restartFailure ? {} : { [failedCursor]: "F2" }), [otherCursor]: "O3" },
      );
      expect(replies).toEqual([]);
      if (companion) {
        const held = hook.current.lists.find(
          (source) => source.environmentId === offlineTarget.environmentId,
        )!.held;
        expect(held.entries).toEqual(
          companion === "ready" ? [...offline.entries, row("offline-tail")] : offline.entries,
        );
        expect(held.nextCursors).toEqual(
          companion === "ready" ? { [cursor]: "offline-3" } : offline.nextCursors,
        );
        targets = [offlineTarget];
        await act(async () => hook.render());
        expect(hook.current.hasMore).toBe(companion === "ready");
      }
    } finally {
      await hook.unmount();
      registry.dispose();
      pageRequest.mockRestore();
    }
  },
);

effectIt.effect.each(["connecting", "failed-connected"])(
  "manually refreshes ready targets beside a %s peer",
  (peerState) =>
    Effect.gen(function* () {
      const readyId = EnvironmentId.make(`ready-${peerState}`);
      const peerId = EnvironmentId.make(`peer-${peerState}`);
      const readyProject = ProjectId.make("ready-project");
      const peerProject = ProjectId.make("peer-project");
      const first: IssueListResult = {
        entries: Array.from({ length: 50 }, (_, index) =>
          row(`ready-${index}`, { projectId: readyProject }),
        ),
        nextCursors: { [cursor]: "2" },
        viewers: { "gitlab gitlab.example": "A" },
        trackers: [],
        errors: [],
      };
      const peer: IssueListResult = {
        ...first,
        entries: [row("peer", { projectId: peerProject })],
        nextCursors: { [cursor]: "peer-2" },
        errors:
          peerState === "connecting"
            ? [{ projectId: peerProject, projectTitle: "Peer", message: "saved warning" }]
            : [],
      };
      const supervisors = new Map<
        EnvironmentId,
        EnvironmentSupervisor.EnvironmentSupervisor["Service"]
      >();
      const runtime = Atom.runtime(
        Layer.effect(
          EnvironmentRegistry.EnvironmentRegistry,
          Effect.gen(function* () {
            for (const id of [readyId, peerId]) {
              supervisors.set(id, {
                state: yield* SubscriptionRef.make({
                  ...AVAILABLE_CONNECTION_STATE,
                  phase: "connected" as const,
                }),
                session: yield* SubscriptionRef.make(Option.some({} as RpcSession)),
              } as EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
            }
            return EnvironmentRegistry.EnvironmentRegistry.of({
              run: (id, effect) =>
                Effect.provideService(
                  effect,
                  EnvironmentSupervisor.EnvironmentSupervisor,
                  supervisors.get(id)!,
                ),
              followStream: (id, stream) =>
                Stream.provideService(
                  stream,
                  EnvironmentSupervisor.EnvironmentSupervisor,
                  supervisors.get(id)!,
                ),
            } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
          }),
        ),
      );
      Object.assign(issueEnvironment, createIssueEnvironmentAtoms(runtime));
      const reads: Array<ProjectId | undefined> = [];
      let peerFails = false;
      const refreshed = Promise.withResolvers<void>();
      const request = vi.spyOn(RpcClient, "request");
      request.mockImplementation(((_tag: string, input: IssueListInput) =>
        Effect.suspend(() => {
          reads.push(input.projectId);
          if (
            input.projectId === readyProject &&
            reads.filter((id) => id === readyProject).length === 2
          )
            refreshed.resolve();
          return input.projectId === peerProject
            ? peerFails
              ? Effect.fail(new Error("query failed"))
              : Effect.succeed(peer)
            : Effect.succeed(first);
        })) as unknown as Parameters<typeof request.mockImplementation>[0]);
      const page = vi.spyOn(RpcClient, "requestGuarded");
      page.mockImplementation((() =>
        Effect.succeed({
          ...first,
          entries: [row("ready-tail", { projectId: readyProject })],
          nextCursors: {},
        })) as unknown as Parameters<typeof page.mockImplementation>[0]);
      const targets: IssueListTarget[] = [
        { environmentId: readyId, input: { state: "all", limit: 50, projectId: readyProject } },
        { environmentId: peerId, input: { state: "all", limit: 50, projectId: peerProject } },
      ];
      const registry = AtomRegistry.make();
      const releases = targets.map((target) => registry.mount(issueEnvironment.list(target)));
      let refresh: Promise<void> | undefined;
      const hook = createIssueTestHook(registry, () => useIssueList(targets));
      try {
        yield* Effect.all(
          targets.map((target) => AtomRegistry.getResult(registry, issueEnvironment.list(target))),
        );
        yield* Effect.promise(() => act(async () => hook.render()));
        const peerQuery = issueEnvironment.list(targets[1]!);
        if (peerState === "connecting") {
          const waiting = Promise.withResolvers<void>();
          const unsubscribe = registry.subscribe(peerQuery, (value) => {
            if (value.waiting) waiting.resolve();
          });
          const releaseAct = Promise.withResolvers<void>();
          const flush = Promise.resolve(act(async () => releaseAct.promise));
          const supervisor = supervisors.get(peerId)!;
          yield* SubscriptionRef.set(supervisor.state, {
            ...AVAILABLE_CONNECTION_STATE,
            phase: "connecting" as const,
          });
          yield* Effect.promise(() => waiting.promise);
          releaseAct.resolve();
          yield* Effect.promise(() => flush);
          unsubscribe();
        } else {
          peerFails = true;
          const failed = Promise.withResolvers<void>();
          const unsubscribe = registry.subscribe(peerQuery, (value) => {
            if (value._tag === "Failure" && !value.waiting) failed.resolve();
          });
          yield* Effect.promise(() =>
            act(async () => {
              registry.refresh(peerQuery);
              await failed.promise;
            }),
          );
          unsubscribe();
          peerFails = false;
        }
        let complete = false;
        const readySettled = Promise.withResolvers<void>();
        const unsubscribe = registry.subscribe(issueEnvironment.list(targets[0]!), (value) => {
          if (!value.waiting && reads.filter((id) => id === readyProject).length === 2)
            readySettled.resolve();
        });
        yield* Effect.promise(() =>
          act(async () => {
            refresh = hook.current.onRefresh().then(() => {
              complete = true;
            });
            await refreshed.promise;
            await readySettled.promise;
          }),
        );
        unsubscribe();
        expect(complete).toBe(true);
        expect(hook.current.refreshing).toBe(false);
        if (peerState === "connecting") {
          expect(reads.filter((id) => id === peerProject)).toHaveLength(1);
          const held = hook.current.lists.find((source) => source.environmentId === peerId)!.held;
          expect(held.entries).toEqual(peer.entries);
          expect(held.nextCursors).toEqual(peer.nextCursors);
          expect(held.errors).toEqual(peer.errors);
          yield* Effect.promise(() => act(async () => hook.current.loadMore()));
          expect(page).toHaveBeenCalledExactlyOnceWith("issues.list", {
            ...targets[0]!.input,
            cursors: first.nextCursors,
          });
        } else {
          expect(reads.filter((id) => id === peerProject)).toHaveLength(3);
          expect(hook.current.errors).toEqual([]);
          expect(page).not.toHaveBeenCalled();
        }
        expect(reads.filter((id) => id === readyProject)).toHaveLength(2);
      } finally {
        yield* Effect.promise(() => hook.unmount());
        yield* Effect.promise(() => refresh ?? Promise.resolve());
        for (const release of releases) release();
        registry.dispose();
        request.mockRestore();
        page.mockRestore();
      }
    }),
);

effectIt.effect(
  "retries a failed viewer restart after a partial manual refresh before its sibling",
  () =>
    Effect.gen(function* () {
      const current = row("A-first");
      const other = row("other", {
        tracker: IssueTrackerKind.make("github"),
        host: "github.example",
        scope: "group/other",
        projectId: ProjectId.make("other"),
      });
      const first: IssueListResult = {
        entries: [current, other],
        sources: [source(current), source(other)],
        viewers: { "gitlab gitlab.example": "A", "github github.example": "other" },
        trackers: [],
        errors: [],
        nextCursors: { [cursor]: "2", [otherCursor]: "O2" },
      };
      const changed: IssueListResult = {
        ...first,
        entries: [row("other-tail", other)],
        viewers: { ...first.viewers, "gitlab gitlab.example": "B" },
        nextCursors: { [otherCursor]: "O3" },
      };
      const failed: IssueListResult = {
        ...first,
        entries: [other],
        viewers: { "github github.example": "other" },
        errors: [
          {
            projectId: current.projectId,
            projectTitle: current.projectTitle,
            tracker: current.tracker,
            host: current.host,
            message: "restart failed",
          },
        ],
        nextCursors: { [otherCursor]: "O2" },
      };
      initializeConnectedIssueEnvironment();
      let reads = 0;
      const request = vi.spyOn(RpcClient, "request");
      request.mockImplementation((() =>
        Effect.sync(() => (++reads === 1 ? first : failed))) as unknown as Parameters<
        typeof request.mockImplementation
      >[0]);
      const page = vi.spyOn(RpcClient, "requestGuarded");
      const pages: IssueListInput[] = [];
      page.mockImplementation(((_tag: string, input: IssueListInput) => {
        pages.push(input);
        if (pages.length === 1) return Effect.succeed(changed);
        if (pages.length === 2) return Effect.fail(new Error("restart failed"));
        return Effect.succeed({
          ...first,
          entries: input.cursors ? [row("other-tail-2", other)] : [row("B-first")],
          sources: [source(input.cursors ? other : current)],
          viewers: input.cursors
            ? { "github github.example": "other" }
            : { "gitlab gitlab.example": "B" },
          nextCursors: {},
        });
      }) as unknown as Parameters<typeof page.mockImplementation>[0]);
      const targets: IssueListTarget[] = [
        {
          environmentId: EnvironmentId.make("restart-refresh"),
          input: { state: "all", involvement: "assigned", limit: 50 },
        },
      ];
      const registry = AtomRegistry.make();
      const query = issueEnvironment.list(targets[0]!);
      const release = registry.mount(query);
      const hook = createIssueTestHook(registry, () => useIssueList(targets));
      try {
        yield* AtomRegistry.getResult(registry, query);
        yield* Effect.promise(() => act(async () => hook.render()));
        yield* Effect.promise(() => act(async () => hook.current.loadMore()));
        expect(hook.current.loadMoreError).toContain("restart failed");
        yield* Effect.promise(() => act(async () => hook.current.onRefresh()));
        expect(hook.current.loadMoreError).toContain("restart failed");
        expect(hook.current.lists[0]!.held.entries.map((entry) => entry.key)).toEqual([
          "other-tail",
          "other",
        ]);
        expect(hook.current.lists[0]!.held.nextCursors).toEqual({ [otherCursor]: "O3" });
        expect(reads).toBe(2);
        expect(pages).toHaveLength(2);
        yield* Effect.promise(() => act(async () => hook.current.loadMore()));
        expect(pages).toHaveLength(2);
        yield* Effect.promise(() => act(async () => hook.current.loadMore(true)));
        const restart = { ...targets[0]!.input, projectId: current.projectId, host: current.host };
        expect(pages).toEqual([
          { ...targets[0]!.input, cursors: first.nextCursors },
          restart,
          restart,
        ]);
        expect(reads).toBe(2);
        expect(hook.current.loadMoreError).toBeNull();
        expect(hook.current.lists[0]!.held.entries.map((entry) => entry.key)).toEqual([
          "other-tail",
          "other",
          "B-first",
        ]);
        expect(hook.current.lists[0]!.held.nextCursors).toEqual({ [otherCursor]: "O3" });
        expect(hook.current.lists[0]!.held.errors).toEqual([]);
      } finally {
        yield* Effect.promise(() => hook.unmount());
        release();
        registry.dispose();
        request.mockRestore();
        page.mockRestore();
      }
    }),
);

effectIt.effect.each([undefined, "Account-A"])(
  "keeps an exhausted native list terminal after a first-page refresh for account %s",
  (connectionId) =>
    Effect.gen(function* () {
      initializeConnectedIssueEnvironment();
      const rows = Array.from({ length: 75 }, (_, index) =>
        row(String(index + 1), {
          updatedAt: `2026-10-01T00:00:00.${String(999 - index).padStart(3, "0")}Z`,
          ...(connectionId === undefined ? {} : { connectionId }),
        }),
      );
      const first: IssueListResult = {
        entries: rows.slice(0, 50),
        sources: [source(rows[0]!)],
        nextCursors: {
          [connectionId === undefined ? cursor : `@${encodeURIComponent(connectionId)} ${cursor}`]:
            "2",
        },
        viewers: { "gitlab gitlab.example": "A" },
        trackers: [],
        errors: [],
      };
      const last = { ...first, entries: rows.slice(50), nextCursors: {} };
      const request = vi.spyOn(RpcClient, "request");
      request.mockImplementation((() => Effect.succeed(first)) as unknown as Parameters<
        typeof request.mockImplementation
      >[0]);
      const page = vi.spyOn(RpcClient, "requestGuarded");
      page.mockImplementation((() => Effect.succeed(last)) as unknown as Parameters<
        typeof page.mockImplementation
      >[0]);
      const targets: IssueListTarget[] = [
        {
          environmentId: EnvironmentId.make("terminal-list"),
          input: {
            state: "all",
            involvement: "assigned",
            limit: 50,
            ...(connectionId === undefined ? {} : { connectionId }),
          },
        },
      ];
      const registry = AtomRegistry.make();
      const query = issueEnvironment.list(targets[0]!);
      const release = registry.mount(query);
      const hook = createIssueTestHook(registry, () => useIssueList(targets));
      try {
        yield* AtomRegistry.getResult(registry, query);
        yield* Effect.promise(() => act(async () => hook.render()));
        expect(hook.current.hasMore).toBe(true);
        expect(hook.current.continued).toBe(false);
        yield* Effect.promise(() => act(async () => hook.current.loadMore()));
        expect(hook.current.continued).toBe(true);
        expect(hook.current.lists[0]!.held.entries).toEqual(rows);
        expect(hook.current.hasMore).toBe(false);
        yield* Effect.promise(() => act(async () => hook.current.onRefresh()));
        expect(hook.current.lists[0]!.held.entries).toEqual(rows);
        expect(hook.current.lists[0]!.held.nextCursors).toEqual({});
        expect(hook.current.hasMore).toBe(false);
        yield* Effect.promise(() => act(async () => hook.current.loadMore()));
        expect(request.mock.calls.map(([, input]) => input)).toEqual([
          targets[0]!.input,
          targets[0]!.input,
        ]);
        expect(page).toHaveBeenCalledExactlyOnceWith("issues.list", {
          ...targets[0]!.input,
          cursors: first.nextCursors,
        });
      } finally {
        yield* Effect.promise(() => hook.unmount());
        release();
        registry.dispose();
        request.mockRestore();
        page.mockRestore();
      }
    }),
);

effectIt.effect.each([false, true])(
  "keeps explicit default account paging and writes separate from All accounts: %s",
  (defaultAccount) =>
    Effect.gen(function* () {
      initializeConnectedIssueEnvironment();

      const environmentId = EnvironmentId.make(defaultAccount ? "default-only" : "all-accounts");
      const nativeTracker = IssueTrackerKind.make("linear");
      const capabilities: IssueCapabilities = {
        create: true,
        edit: true,
        comment: true,
        labels: true,
        assignees: true,
        reactions: false,
        templates: false,
        linkedPullRequests: false,
        events: true,
        search: true,
        states: [],
        closeReasons: [],
      };
      const native = (key: string, connectionId?: string) =>
        row(key, {
          tracker: nativeTracker,
          host: "api.linear.app",
          scope: "ENG",
          ...(connectionId === undefined ? {} : { connectionId }),
        });
      const a = native("default-first");
      const b = native("named-first", "Account-B");
      const defaultCursor = "linear api.linear.app ENG";
      const namedCursor = "@Account-B linear api.linear.app ENG";
      const first: IssueListResult = {
        entries: [a, b],
        sources: [a, b].map((entry) => ({ ...entry, capabilities })),
        nextCursors: { [defaultCursor]: "D2", [namedCursor]: "B2" },
        viewers: {
          "linear api.linear.app": "default-viewer",
          "@Account-B linear api.linear.app": "named-viewer",
        },
        errors: [
          {
            projectId: b.projectId,
            projectTitle: b.projectTitle,
            tracker: nativeTracker,
            host: b.host,
            connectionId: b.connectionId,
            message: "Named account warning",
          },
        ],
        trackers: [a, b].map((entry) => ({
          tracker: entry.tracker,
          host: entry.host,
          ...(entry.connectionId === undefined ? {} : { connectionId: entry.connectionId }),
          configured: true,
          projectCount: 1,
          capabilities,
          detail: null,
        })),
      };
      const request = vi.spyOn(RpcClient, "request");
      request.mockImplementation((() => Effect.succeed(first)) as unknown as Parameters<
        typeof request.mockImplementation
      >[0]);
      const page = vi.spyOn(RpcClient, "requestGuarded");
      page.mockImplementation(((_tag: string, input: IssueListInput) =>
        Effect.succeed({
          ...first,
          entries: input.cursors
            ? [native("default-tail"), native("named-tail", "Account-B")]
            : [native("default-refreshed"), native("named-refreshed", "Account-B")],
          errors: [],
          nextCursors: {},
        })) as unknown as Parameters<typeof page.mockImplementation>[0]);
      const targets: IssueListTarget[] = [
        {
          environmentId,
          input: {
            state: "all",
            involvement: "all",
            host: a.host,
            tracker: nativeTracker,
            limit: 50,
          },
          ...(defaultAccount ? { defaultAccount: true } : {}),
        },
      ];
      const registry = AtomRegistry.make();
      const query = issueEnvironment.list(targets[0]!);
      const release = registry.mount(query);
      const hook = createIssueTestHook(registry, () => useIssueList(targets));
      try {
        yield* AtomRegistry.getResult(registry, query);
        yield* Effect.promise(() => act(async () => hook.render()));
        expect(hook.current.lists[0]!.held.entries.map((entry) => entry.key)).toEqual(
          defaultAccount ? ["default-first"] : ["default-first", "named-first"],
        );
        expect(
          issueListTrackers(hook.current.lists).map((tracker) => tracker.connectionId),
        ).toEqual(defaultAccount ? [undefined] : ["Account-B", undefined]);
        expect(issueListNotices(hook.current.lists).map((error) => error.message)).toEqual(
          defaultAccount ? [] : ["Named account warning"],
        );
        expect(
          issueCreateScopes(hook.current.lists, []).map((scope) => scope.scope.connectionId),
        ).toEqual(defaultAccount ? [undefined] : [undefined, "Account-B"]);
        expect(Object.keys(hook.current.lists[0]!.held.answer.viewers)).toEqual(
          defaultAccount ? ["linear api.linear.app"] : Object.keys(first.viewers),
        );
        yield* Effect.promise(() => act(async () => hook.current.loadMore()));
        expect(page).toHaveBeenCalledExactlyOnceWith("issues.list", {
          ...targets[0]!.input,
          cursors: defaultAccount ? { [defaultCursor]: "D2" } : first.nextCursors,
        });
        expect(hook.current.lists[0]!.held.entries.map((entry) => entry.key)).toEqual(
          defaultAccount
            ? ["default-first", "default-tail"]
            : ["default-first", "named-first", "default-tail", "named-tail"],
        );
        const beforeNamedWrite = page.mock.calls.length;
        yield* Effect.promise(() =>
          act(async () => {
            markIssueWritten(registry, environmentId, b);
          }),
        );
        expect(page.mock.calls.length).toBe(beforeNamedWrite + (defaultAccount ? 0 : 1));
        const beforeDefaultWrite = page.mock.calls.length;
        yield* Effect.promise(() =>
          act(async () => {
            markIssueWritten(registry, environmentId, a);
          }),
        );
        expect(page.mock.calls.length).toBe(beforeDefaultWrite + 1);
        const defaultWrite = page.mock.calls.at(-1)!;
        expect(defaultWrite).toEqual([
          "issues.list",
          { ...targets[0]!.input, projectId: a.projectId },
        ]);
        expect(
          hook.current.lists[0]!.held.entries.some((entry) => entry.connectionId !== undefined),
        ).toBe(!defaultAccount);
        yield* Effect.promise(() => act(async () => hook.current.onRefresh()));
        expect(hook.current.loadMoreError).toBe(defaultAccount ? null : "Named account warning");
        expect(hook.current.lists[0]!.held.entries.map((entry) => entry.key)).toEqual(
          defaultAccount ? ["default-first"] : ["named-refreshed", "default-first"],
        );
        expect(
          issueCreateScopes(hook.current.lists, []).map((scope) => scope.scope.connectionId),
        ).toEqual(defaultAccount ? [undefined] : [undefined, "Account-B"]);
      } finally {
        yield* Effect.promise(() => hook.unmount());
        release();
        registry.dispose();
        request.mockRestore();
        page.mockRestore();
      }
    }),
);

it("retries a stale written-source answer once in the selected native account", async () => {
  const runtime = Atom.runtime(
    Layer.succeed(
      EnvironmentRegistry.EnvironmentRegistry,
      EnvironmentRegistry.EnvironmentRegistry.of({
        run: (_id, effect) =>
          Effect.provideService(
            effect,
            EnvironmentSupervisor.EnvironmentSupervisor,
            {} as EnvironmentSupervisor.EnvironmentSupervisor["Service"],
          ),
      } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
    ),
  );
  Object.assign(issueEnvironment, createIssueEnvironmentAtoms(runtime));
  const current = row("first", { connectionId: "Account-A" });
  const first: IssueListResult = {
    entries: [current],
    sources: [source(current)],
    nextCursors: {},
    viewers: { "@Account-A gitlab gitlab.example": "viewer" },
    trackers: [],
    errors: [],
  };
  const target: IssueListTarget = {
    environmentId: EnvironmentId.make("stale-written-source"),
    input: {
      state: "all",
      involvement: "all",
      connectionId: current.connectionId,
      host: current.host,
      limit: 50,
    },
  };
  const list = Atom.family((_target: IssueListTarget) =>
    Atom.make<AsyncResult.AsyncResult<IssueListResult, Error>>(AsyncResult.success(first)),
  );
  issueEnvironment.list = list;
  const stale = Promise.withResolvers<IssueListResult>();
  const started = Promise.withResolvers<void>();
  const retried = Promise.withResolvers<void>();
  const page = vi.spyOn(RpcClient, "requestGuarded");
  page.mockImplementation((() => {
    if (page.mock.calls.length === 1) {
      started.resolve();
      return Effect.promise(() => stale.promise);
    }
    retried.resolve();
    return Effect.succeed({ ...first, entries: [row("current-account-answer", current)] });
  }) as unknown as Parameters<typeof page.mockImplementation>[0]);
  const registry = AtomRegistry.make();
  const hook = createIssueTestHook(registry, () => useIssueList([target]));
  try {
    await act(async () => hook.render());
    await act(async () => {
      markIssueWritten(registry, target.environmentId, current);
      await started.promise;
    });
    await act(async () => {
      registry.set(
        list(target),
        AsyncResult.success({ ...first, entries: [row("new-first-page", current)] }),
      );
      stale.resolve({ ...first, entries: [row("stale-answer", current)] });
      await retried.promise;
    });
    expect(page.mock.calls).toEqual(
      Array.from({ length: 2 }, () => [
        "issues.list",
        { ...target.input, projectId: current.projectId },
      ]),
    );
    expect(hook.current.lists[0]!.held.entries.map((entry) => entry.key)).toEqual([
      "current-account-answer",
    ]);
    expect(
      hook.current.lists[0]!.held.entries.every((entry) => entry.connectionId === "Account-A"),
    ).toBe(true);
    expect(hook.current.refreshing).toBe(false);
  } finally {
    stale.resolve(first);
    await hook.unmount();
    registry.dispose();
    page.mockRestore();
  }
});
