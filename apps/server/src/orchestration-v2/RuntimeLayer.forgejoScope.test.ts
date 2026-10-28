import { issueRuntimeLayer, issueThreadCommand } from "./ThreadIssueService.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  IssueTrackerKind,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";

const layerTest = issueRuntimeLayer("t3-forgejo-scope-");

const projectId = ProjectId.make("forgejo-scope-project");
const upper = {
  tracker: IssueTrackerKind.make("forgejo"),
  host: "forgejo.test",
  scope: "Mount/Acme/Web",
  key: "42",
};
const lower = { ...upper, scope: "mount/acme/web" };
const snapshot = {
  displayKey: "#42",
  title: "Upper mount issue",
  state: { category: "open" as const, name: "open" },
  syncedAt: "2026-10-15T00:00:00.000Z",
};

it.layer(layerTest)("native Forgejo thread identity", (it) => {
  it.effect.each(["unlink", "sync", "link"] as const)(
    "keeps a different mount separate during %s and rejects an old link generation",
    (operation) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make(`forgejo-mount-${operation}`);
        yield* orchestrator.dispatch(
          issueThreadCommand({
            commandId: CommandId.make(`${operation}-create`),
            threadId,
            projectId,
            title: "Forgejo mounts",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          }),
        );
        const link = {
          type: "thread.issue.link" as const,
          threadId,
          projectId,
          ...upper,
          url: "https://forgejo.test/Mount/Acme/Web/issues/42",
          source: "manual" as const,
          snapshot,
        };
        yield* orchestrator.dispatch({ ...link, commandId: CommandId.make(`${operation}-link`) });
        const original = (yield* orchestrator.getThreadProjection(threadId)).thread.issues![0]!;
        yield* orchestrator.dispatch({
          ...link,
          commandId: CommandId.make(`${operation}-alias`),
          host: "Forgejo.test",
          scope: "Mount/acme/web",
        });
        assert.deepEqual((yield* orchestrator.getThreadProjection(threadId)).thread.issues, [
          original,
        ]);

        if (operation === "link") {
          yield* orchestrator.dispatch({
            ...link,
            ...lower,
            commandId: CommandId.make("lower-link"),
            url: "https://forgejo.test/mount/acme/web/issues/42",
            snapshot: { ...snapshot, title: "Lower mount issue" },
          });
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).thread.issues!.length,
            2,
          );
          yield* orchestrator.dispatch({
            type: "thread.issue.unlink",
            threadId,
            ...lower,
            commandId: CommandId.make("lower-unlink"),
          });
        } else if (operation === "unlink") {
          yield* orchestrator.dispatch({
            type: "thread.issue.unlink",
            threadId,
            ...lower,
            commandId: CommandId.make("foreign-unlink"),
          });
        } else {
          yield* orchestrator.dispatch({
            type: "thread.issue-link.sync",
            threadId,
            ...lower,
            commandId: CommandId.make("foreign-sync"),
            linkedAt: original.linkedAt,
            linkId: original.linkId,
            snapshot: { ...snapshot, title: "Wrong mount" },
          });
        }
        assert.deepEqual((yield* orchestrator.getThreadProjection(threadId)).thread.issues, [
          original,
        ]);
        yield* orchestrator.dispatch({
          type: "thread.issue.unlink",
          threadId,
          ...upper,
          scope: "Mount/acme/web",
          commandId: CommandId.make(`${operation}-remove-upper`),
        });
        yield* orchestrator.dispatch({
          ...link,
          commandId: CommandId.make(`${operation}-relink`),
          snapshot: { ...snapshot, title: "New generation" },
        });
        const relinked = (yield* orchestrator.getThreadProjection(threadId)).thread.issues![0]!;
        assert.equal(relinked.linkedAt, original.linkedAt);
        assert.notEqual(relinked.linkId, original.linkId);
        yield* orchestrator.dispatch({
          type: "thread.issue-link.sync",
          threadId,
          ...upper,
          scope: "Mount/acme/web",
          commandId: CommandId.make(`${operation}-stale-sync`),
          linkedAt: original.linkedAt,
          linkId: original.linkId,
          snapshot: { ...snapshot, title: "Stale generation" },
        });
        assert.deepEqual((yield* orchestrator.getThreadProjection(threadId)).thread.issues, [
          relinked,
        ]);
        yield* orchestrator.dispatch({
          type: "thread.issue-link.sync",
          threadId,
          ...upper,
          scope: "Mount/acme/web",
          commandId: CommandId.make(`${operation}-current-sync`),
          linkedAt: relinked.linkedAt,
          linkId: relinked.linkId,
          snapshot: { ...snapshot, title: "Current generation" },
        });
        yield* worker.drain();
        const current = (yield* orchestrator.getThreadProjection(threadId)).thread.issues![0]!;
        assert.equal(current.snapshot?.title, "Current generation");
        assert.deepEqual((yield* orchestrator.getThreadShell(threadId))?.issues, [current]);
      }),
  );
});
