import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import PullRequestFilesViewed from "./Migrations/053_PullRequestFilesViewed.ts";
import RemoveRedundantProjectionIndexes from "./Migrations/056_RemoveRedundantProjectionIndexes.ts";
import OrchestrationV2 from "./Migrations/055_OrchestrationV2.ts";
import IssueTrackerBindings from "./Migrations/073_IssueTrackerBindings.ts";
import IssueTrackerBindingHost from "./Migrations/074_IssueTrackerBindingHost.ts";
import IssueTrackerAccounts from "./Migrations/075_IssueTrackerAccounts.ts";
import IssueAccountStorage from "./Migrations/076_IssueAccountStorage.ts";

const seedPreview = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 52 });
  yield* Migrator.make({})({
    loader: Migrator.fromRecord({ "53_OrchestrationV2": OrchestrationV2 }),
  });
  yield* sql`
    INSERT INTO orchestration_v2_legacy_imports
      (thread_id, source_updated_at, shell_imported_at, transcript_imported_at, imported_message_count)
    VALUES ('preview-thread', '2026-09-15', '2026-09-15', '2026-09-16', 42)
  `;
  yield* sql`
    UPDATE effect_sql_migrations SET created_at = '2026-09-15 00:00:00' WHERE migration_id = 53
  `;
});

const seedIssuePreview = Effect.fnUntraced(function* (throughId: number, startId = 63) {
  yield* runMigrations({ toMigrationInclusive: startId - 1 });
  return yield* Migrator.make({})({
    loader: Migrator.fromRecord(
      Object.fromEntries(
        (
          [
            [63, "IssueTrackerBindings", IssueTrackerBindings],
            [64, "IssueTrackerBindingHost", IssueTrackerBindingHost],
            [65, "IssueTrackerAccounts", IssueTrackerAccounts],
            [66, "IssueAccountStorage", IssueAccountStorage],
          ] as const
        )
          .map(([id, name, migration]) => [id + startId - 63, name, migration] as const)
          .filter(([id]) => id <= throughId)
          .map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
  });
});

describe("Issues preview upgrade", () => {
  it.effect.each(
    [63, 65].flatMap((startId) =>
      [0, 1, 2, 3].map((offset) => ({ startId, throughId: startId + offset })),
    ),
  )(
    "preserves data and canonical history from preview $startId through $throughId",
    ({ startId, throughId }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedIssuePreview(throughId, startId);
        const legacyThroughId = throughId - startId + 63;
        yield* sql`UPDATE effect_sql_migrations SET created_at = '2026-10-15 00:00:00'
          WHERE migration_id >= ${startId}`;
        const oldHistory = yield* sql<{ migration_id: number; name: string; created_at: string }>`
          SELECT migration_id, name, created_at FROM effect_sql_migrations
          WHERE migration_id >= ${startId} ORDER BY migration_id`;
        const historyBefore = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        const schemaBefore = yield* sql`SELECT name, sql FROM sqlite_master ORDER BY name`;
        assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: startId - 1 }), []);
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
          historyBefore,
        );
        assert.deepStrictEqual(
          yield* sql`SELECT name, sql FROM sqlite_master ORDER BY name`,
          schemaBefore,
        );
        if (legacyThroughId >= 65) {
          yield* sql`INSERT INTO issue_tracker_accounts
            VALUES ('linear', 'Account', 'linear.app', 'native-account')`;
        }
        const storedTracker =
          legacyThroughId === 66
            ? JSON.stringify({ tracker: "linear", connectionId: "Account" })
            : "linear";
        yield* sql`INSERT INTO issue_tracker_bindings ${sql.insert({
          project_id: "project",
          tracker: storedTracker,
          scope: "acme/ENG",
          updated_at: "2026-10-15T00:00:00Z",
          ...(legacyThroughId >= 64 ? { host: "linear.app" } : {}),
          ...(legacyThroughId >= 65 ? { connection_id: "Account" } : {}),
          ...(legacyThroughId >= 66 ? { native_tracker: "linear" } : {}),
        })}`;
        const selectedProject = { value: "project", connectionId: "Account" };
        const issue = {
          projectId: legacyThroughId === 66 ? selectedProject : "project",
          ...(legacyThroughId === 65 ? { connectionId: "Account" } : {}),
          tracker: "linear",
          key: "ENG-7",
          preserved: "issue-data",
        };
        const payload = JSON.stringify({
          issues: [issue],
          ...(startId === 63
            ? {
                linkedPullRequest: {
                  projectId: "project",
                  repository: "acme/web",
                  number: 42,
                  url: "https://github.com/acme/web/pull/42",
                },
              }
            : {
                pullRequests: [
                  {
                    provider: "github",
                    host: "github.com",
                    repository: "acme/web",
                    number: 42,
                    url: "https://github.com/acme/web/pull/42",
                    source: "manual",
                    linkedAt: "2026-10-15T00:00:00Z",
                    snapshot: null,
                    stack: null,
                  },
                ],
              }),
          preserved: "thread-data",
        });
        yield* sql`INSERT INTO orchestration_v2_projection_threads
          (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            created_at, updated_at, payload_json)
          VALUES ('thread', 'project', 'Thread', 'codex', 'full-access', 'default',
            '2026-10-15T00:00:00Z', '2026-10-15T00:00:00Z', ${payload})`;

        assert.deepStrictEqual(
          yield* runMigrations({ toMigrationInclusive: startId + 1 }),
          migrationManifest.filter(([id]) => id === startId || id === startId + 1),
        );
        yield* runMigrations();
        assert.deepStrictEqual(yield* runMigrations(), []);
        const history = yield* sql<{ migration_id: number; name: string }>`
          SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
        assert.deepStrictEqual(
          history.map((row) => [row.migration_id, row.name] as const),
          migrationManifest,
        );
        const shiftedHistory = yield* sql`SELECT migration_id, name, created_at
          FROM effect_sql_migrations WHERE migration_id BETWEEN 73 AND ${throughId + 73 - startId}
          ORDER BY migration_id`;
        assert.deepStrictEqual(
          shiftedHistory,
          oldHistory.map((row) => ({
            ...row,
            migration_id: row.migration_id + 73 - startId,
          })),
        );
        const bindings = yield* sql`SELECT * FROM issue_tracker_bindings`;
        assert.deepStrictEqual(bindings, [
          {
            project_id: "project",
            tracker:
              legacyThroughId >= 65
                ? JSON.stringify({ tracker: "linear", connectionId: "Account" })
                : "linear",
            native_tracker: "linear",
            scope: "acme/ENG",
            host: legacyThroughId >= 64 ? "linear.app" : null,
            connection_id: legacyThroughId >= 65 ? "Account" : null,
            updated_at: "2026-10-15T00:00:00Z",
          },
        ]);
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM issue_tracker_accounts`,
          legacyThroughId >= 65
            ? [
                {
                  tracker: "linear",
                  connection_id: "Account",
                  host: "linear.app",
                  account_id: "native-account",
                },
              ]
            : [],
        );
        const rows = yield* sql<{ payload_json: string }>`
          SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = 'thread'`;
        const stored = JSON.parse(rows[0]!.payload_json);
        const { connectionId: _connectionId, ...expectedIssue } = issue;
        assert.deepStrictEqual(stored.issues, [
          {
            ...expectedIssue,
            projectId: legacyThroughId >= 65 ? selectedProject : "project",
          },
        ]);
        assert.equal(stored.preserved, "thread-data");
        assert.equal(stored.pullRequests[0].number, 42);
        assert.equal(stored.pullRequests[0].repository, "acme/web");
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([64, 66, 72])(
    "upgrades released main %s to Issues without changing released history",
    (releasedId) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: releasedId });
        const released = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        assert.deepStrictEqual(
          yield* runMigrations(),
          migrationManifest.filter(([id]) => id > releasedId),
        );
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM effect_sql_migrations
        WHERE migration_id <= ${releasedId} ORDER BY migration_id`,
          released,
        );
        assert.deepStrictEqual(yield* runMigrations(), []);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([63, 65])(
    "rolls back preview %s schema and history on a ledger write failure and can retry",
    (startId) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedIssuePreview(startId + 3, startId);
        const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        const schema = yield* sql`SELECT name, sql FROM sqlite_master ORDER BY name`;
        yield* sql`CREATE TRIGGER fail_issue_upgrade BEFORE INSERT ON effect_sql_migrations
        WHEN NEW.name IN ('CanonicalizeThreadPullRequestLinks', 'RepairClientSettlementTimestamps')
        BEGIN SELECT RAISE(ABORT, 'injected failure'); END`;
        assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
          history,
        );
        yield* sql`DROP TRIGGER fail_issue_upgrade`;
        assert.deepStrictEqual(
          yield* sql`SELECT name, sql FROM sqlite_master ORDER BY name`,
          schema,
        );
        yield* runMigrations();
        assert.deepStrictEqual(yield* runMigrations(), []);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("wraps an invalid legacy PR link and rolls back schema and history before retry", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedIssuePreview(66);
      const payload = JSON.stringify({ linkedPullRequest: { url: "invalid" }, issues: [] });
      yield* sql`INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, payload_json)
        VALUES ('thread', 'project', 'Thread', 'codex', 'full-access', 'default',
          '2026-10-15T00:00:00Z', '2026-10-15T00:00:00Z', ${payload})`;
      const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      const schema = yield* sql`SELECT name, sql FROM sqlite_master ORDER BY name`;
      const result = yield* runMigrations().pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "MigrationError");
        if (result.failure._tag === "MigrationError") {
          assert.equal(result.failure.kind, "Failed");
        }
      }
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        history,
      );
      assert.deepStrictEqual(yield* sql`SELECT name, sql FROM sqlite_master ORDER BY name`, schema);
      assert.deepStrictEqual(
        yield* sql`SELECT payload_json FROM orchestration_v2_projection_threads`,
        [{ payload_json: payload }],
      );
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = '{}'`;
      yield* runMigrations();
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each(
    [63, 65].flatMap((startId) =>
      ["later", "renamed", "gap"].map((invalidHistory) => ({ startId, invalidHistory })),
    ),
  )(
    "rejects $invalidHistory preview $startId history without changing data or history",
    ({ startId, invalidHistory }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedIssuePreview(startId + 3, startId);
        if (invalidHistory === "later") {
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${startId + 4}, 'UnknownFork')`;
        } else if (invalidHistory === "renamed") {
          yield* sql`UPDATE effect_sql_migrations SET name = 'UnknownFork' WHERE migration_id = ${startId + 1}`;
        } else {
          yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = ${startId + 1}`;
        }
        const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        const schema = yield* sql`SELECT name, sql FROM sqlite_master ORDER BY name`;
        const result = yield* runMigrations().pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.include(
            result.failure.message,
            "Cannot upgrade Issues preview with unexpected later migrations",
          );
        }
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
          history,
        );
        assert.deepStrictEqual(
          yield* sql`SELECT name, sql FROM sqlite_master ORDER BY name`,
          schema,
        );
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});

describe("V2 preview upgrade", () => {
  it.effect("upgrades a published preview without replaying V2 or losing import progress", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedPreview;
      const imports = yield* sql`SELECT * FROM orchestration_v2_legacy_imports`;
      assert.deepStrictEqual(yield* runMigrations(), [
        [53, "PullRequestFilesViewed"],
        [54, "ProjectionThreadsAutoSettleDisabledAt"],
        [56, "RemoveRedundantProjectionIndexes"],
        [57, "ScheduledTaskWebhooks"],
        [58, "WebhookRelayDeliveries"],
        [59, "McpAppModelContext"],
        [60, "ThreadSnapshotWindowIndexes"],
        [61, "PullRequestReviewGuides"],
        [62, "ThreadFailureLookupIndex"],
        [63, "DropUnusedV1Projections"],
        [64, "CanonicalizeThreadPullRequestLinks"],
        [65, "CodexUsageNativeTurnIndex"],
        [66, "RepairClientSettlementTimestamps"],
        [67, "WebhookDedupe"],
        [68, "ShellStopRequestIndex"],
        [69, "ThreadMessageSearch"],
        [70, "PeerLinks"],
        [71, "PeerLinkFence"],
        [72, "WaitingLinkRequestIndex"],
        [73, "IssueTrackerBindings"],
        [74, "IssueTrackerBindingHost"],
        [75, "IssueTrackerAccounts"],
        [76, "IssueAccountStorage"],
      ]);
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* sql`SELECT * FROM orchestration_v2_legacy_imports`, imports);
      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        history.map((row) => [row.migration_id, row.name] as const),
        migrationManifest,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT created_at FROM effect_sql_migrations WHERE migration_id = 55`,
        [{ created_at: "2026-09-15 00:00:00" }],
      );
      yield* sql`
        INSERT INTO pull_request_files_viewed
          (provider, host, repository, number, viewer, path, revision, viewed_at)
        VALUES ('github', 'github.com', 'owner/repo', 1, 'viewer', 'file.ts', 'revision', '2026-09-17')
      `;
      assert.strictEqual((yield* sql`SELECT * FROM pull_request_files_viewed`).length, 1);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([false, true])(
    "upgrades preview migration 54 with index cleanup %s",
    (withIndexes) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 52 });
        yield* Migrator.make({})({
          loader: Migrator.fromRecord({
            "53_PullRequestFilesViewed": PullRequestFilesViewed,
            "54_OrchestrationV2": OrchestrationV2,
            ...(withIndexes
              ? { "55_RemoveRedundantProjectionIndexes": RemoveRedundantProjectionIndexes }
              : {}),
          }),
        });
        yield* runMigrations();
        assert.deepStrictEqual(yield* runMigrations(), []);
        const history = yield* sql<{
          readonly migration_id: number;
          readonly name: string;
        }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
        assert.deepStrictEqual(
          history.map((row) => [row.migration_id, row.name] as const),
          migrationManifest,
        );
        const columns = yield* sql<{
          readonly name: string;
        }>`PRAGMA table_info(projection_threads)`;
        assert.ok(columns.some((column) => column.name === "auto_settle_disabled_at"));
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rolls back schema and ledger together on failure and can retry", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedPreview;
      yield* sql`
        CREATE TRIGGER fail_preview_upgrade BEFORE INSERT ON effect_sql_migrations
        WHEN NEW.name = 'PullRequestFilesViewed'
        BEGIN SELECT RAISE(ABORT, 'injected failure'); END
      `;
      assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(
        yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 53`,
        [{ migration_id: 53, name: "OrchestrationV2" }],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'pull_request_files_viewed'`,
        [],
      );
      assert.strictEqual((yield* sql`SELECT * FROM orchestration_v2_legacy_imports`).length, 1);
      yield* sql`DROP TRIGGER fail_preview_upgrade`;
      assert.deepStrictEqual(yield* runMigrations(), [
        [53, "PullRequestFilesViewed"],
        [54, "ProjectionThreadsAutoSettleDisabledAt"],
        [56, "RemoveRedundantProjectionIndexes"],
        [57, "ScheduledTaskWebhooks"],
        [58, "WebhookRelayDeliveries"],
        [59, "McpAppModelContext"],
        [60, "ThreadSnapshotWindowIndexes"],
        [61, "PullRequestReviewGuides"],
        [62, "ThreadFailureLookupIndex"],
        [63, "DropUnusedV1Projections"],
        [64, "CanonicalizeThreadPullRequestLinks"],
        [65, "CodexUsageNativeTurnIndex"],
        [66, "RepairClientSettlementTimestamps"],
        [67, "WebhookDedupe"],
        [68, "ShellStopRequestIndex"],
        [69, "ThreadMessageSearch"],
        [70, "PeerLinks"],
        [71, "PeerLinkFence"],
        [72, "WaitingLinkRequestIndex"],
        [73, "IssueTrackerBindings"],
        [74, "IssueTrackerBindingHost"],
        [75, "IssueTrackerAccounts"],
        [76, "IssueAccountStorage"],
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses unexpected later migrations without modifying their history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedPreview;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (54, 'UnknownFork')`;
      const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        history,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});

describe("nic-os fork Issues stack upgrade", () => {
  it.effect("retires the fork's 62/63 issue migrations and runs main's", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 61 });
      yield* sql`ALTER TABLE projection_threads ADD COLUMN issue_links_json TEXT NOT NULL DEFAULT '[]'`;
      yield* sql`CREATE TABLE work_item_links (id TEXT PRIMARY KEY)`;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (62, 'ProjectionThreadIssues'), (63, 'WorkItemLinks')`;

      yield* runMigrations();

      assert.deepStrictEqual(
        (yield* sql<{ migration_id: number; name: string }>`
          SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`).map(
          (row) => [row.migration_id, row.name],
        ),
        migrationManifest.map(([id, name]) => [id, name]),
      );
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'work_item_links'`,
        [],
      );
      const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
      assert.isFalse(columns.some((column) => column.name === "issue_links_json"));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
