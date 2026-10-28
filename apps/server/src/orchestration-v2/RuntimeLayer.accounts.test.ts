import { assert, it } from "@effect/vitest";
import {
  CommandId,
  IssueTrackerKind,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import type { IssueDetail } from "@t3tools/contracts";
import * as IssueService from "../issue/IssueService.ts";
import { issueCryptoLayer } from "../issue/IssueService.testkit.ts";
import * as ThreadIssueService from "./ThreadIssueService.ts";
import {
  emptyIssueDetailFields,
  issueRuntimeLayer,
  issueThreadCommand,
} from "./ThreadIssueService.testkit.ts";
import * as Layer from "effect/Layer";

import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";

const layerTest = issueRuntimeLayer("t3-issue-accounts-");

const projectId = ProjectId.make("account-project");
const ref = {
  tracker: IssueTrackerKind.make("linear"),
  host: "linear.app",
  scope: "acme/ENG",
  key: "ENG-7",
};
const snapshot = {
  displayKey: "ENG-7",
  title: "Initial",
  state: { category: "open" as const, name: "Todo" },
  syncedAt: "2026-10-15T00:00:00Z",
};

it.layer(layerTest)("account-qualified issue commands", (it) => {
  it.effect(
    "keeps same-key accounts, legacy refs and same-clock generations separate in SQLite projections",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make("account-thread");
        yield* orchestrator.dispatch(
          issueThreadCommand({
            commandId: CommandId.make("create"),
            threadId,
            projectId,
            title: "Accounts",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          }),
        );
        for (const connectionId of [undefined, "Account", "account"]) {
          yield* orchestrator.dispatch({
            type: "thread.issue.link",
            commandId: CommandId.make(`link-${connectionId ?? "default"}`),
            threadId,
            projectId,
            ...ref,
            ...(connectionId === undefined ? {} : { connectionId }),
            url: "https://linear.app/acme/issue/ENG-7",
            source: "manual",
            snapshot,
          });
        }
        const original = (yield* orchestrator.getThreadProjection(threadId)).thread.issues!;
        assert.deepEqual(
          original.map((link) => link.connectionId),
          [undefined, "Account", "account"],
        );
        yield* orchestrator.dispatch({
          type: "thread.issue.link",
          commandId: CommandId.make("duplicate"),
          threadId,
          projectId,
          ...ref,
          scope: "ACME/eng",
          key: "eng-7",
          connectionId: "Account",
          url: "https://linear.app/acme/issue/ENG-7",
          source: "manual",
          snapshot,
        });
        assert.deepEqual((yield* orchestrator.getThreadShell(threadId))?.issues, original);
        yield* orchestrator.dispatch({
          type: "thread.issue.unlink",
          commandId: CommandId.make("unlink"),
          threadId,
          ...ref,
          connectionId: "Account",
        });
        yield* orchestrator.dispatch({
          type: "thread.issue.link",
          commandId: CommandId.make("relink"),
          threadId,
          projectId,
          ...ref,
          connectionId: "Account",
          url: "https://linear.app/acme/issue/ENG-7",
          source: "manual",
          snapshot: { ...snapshot, title: "Fresh", state: { category: "closed", name: "Done" } },
        });
        const current = (yield* orchestrator.getThreadProjection(threadId)).thread.issues!;
        const old = original[1]!;
        const fresh = current.find((link) => link.connectionId === "Account")!;
        assert.equal(fresh.linkedAt, old.linkedAt);
        assert.notEqual(fresh.linkId, old.linkId);
        for (const connectionId of ["Account", "account"]) {
          yield* orchestrator.dispatch({
            type: "thread.issue-link.sync",
            commandId: CommandId.make(`stale-${connectionId}`),
            threadId,
            ...ref,
            connectionId,
            linkedAt: old.linkedAt,
            linkId: old.linkId,
            snapshot: { ...snapshot, title: "Old read" },
          });
        }
        yield* worker.drain();
        assert.deepEqual(
          (yield* orchestrator.getThreadProjection(threadId)).thread.issues,
          current,
        );
        assert.deepEqual((yield* orchestrator.getThreadShell(threadId))?.issues, current);
        let reads = 0;
        let serial = 0;
        const dependencies = Layer.mergeAll(
          Layer.succeed(Orchestrator.OrchestratorV2, orchestrator),
          issueCryptoLayer((size) => new Uint8Array(size).fill(++serial)),
          Layer.mock(IssueService.IssueService)({
            detail: (input) =>
              Effect.sync((): IssueDetail => {
                reads++;
                return {
                  ...input,
                  host: "linear.app",
                  displayKey: "ENG-7",
                  title: input.connectionId ?? "default",
                  url: "https://linear.app/acme/issue/ENG-7",
                  author: null,
                  state: snapshot.state,
                  createdAt: snapshot.syncedAt,
                  updatedAt: snapshot.syncedAt,
                  closedAt: null,
                  assignees: [],
                  labels: [],
                  commentCount: 0,
                  projectTitle: "Accounts",
                  ...emptyIssueDetailFields([snapshot.state]),
                };
              }),
          }),
        );
        const services = yield* Layer.build(
          ThreadIssueService.layer.pipe(Layer.provide(dependencies)),
        );
        const service = Context.get(services, ThreadIssueService.ThreadIssueService);
        yield* service.refresh(threadId);
        yield* service.drain;
        const refreshed = (yield* orchestrator.getThreadShell(threadId))!.issues!;
        assert.equal(reads, 3);
        assert.deepEqual(
          refreshed.map((link) => [link.connectionId, link.snapshot?.title]),
          [
            [undefined, "default"],
            ["account", "account"],
            ["Account", "Account"],
          ],
        );
        const supplied = yield* Context.get(
          yield* Layer.build(dependencies),
          IssueService.IssueService,
        ).detail({ ...ref, connectionId: "new-account", projectId });
        yield* service.link({
          threadId,
          ref: { ...ref, connectionId: "new-account", projectId },
          url: supplied.url,
          detail: supplied,
          source: "agent",
        });
        yield* service.drain;
        assert.equal(reads, 4);
        assert.equal(
          (yield* orchestrator.getThreadShell(threadId))!.issues!.at(-1)?.connectionId,
          "new-account",
        );
      }),
  );
});
