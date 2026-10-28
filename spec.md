# nic-os Issues fork: spec

What this fork (`nSimonFR-ai/t3code`, branch `nicos/issues-nightly-<version>`) changes on top of an upstream T3 Code nightly, and what each change must do. Releases are tagged `v<nightly>-issues.N` and deployed by nic-os (`pkgs/agents/t3code.nix` for the rpi5 server, `pkgs/agents/t3code-desktop.nix` for the Mac app).

Requirements use MUST / SHOULD. Each section ends with where the change lives and how it's checked, so the next rebase onto a newer nightly can carry it forward or drop it on purpose.

Current base: `v0.1.4-nightly.20261028.3814` + pingdotgg/t3code#19576 at `4b44b92`.

## 1. Issues stack

The fork carries Bil0000's Issues rewrite, pingdotgg/t3code#19576 (it replaced #6315, which upstream closed).

- R1.1 The build MUST include #19576's Issues workspace: GitHub, GitLab, Azure DevOps, Forgejo/Gitea, GitCafe, Linear and Jira trackers, thread issue links, and the MCP issue tools.
- R1.2 Linear MUST work as a standalone tracker, with accounts and per-project team bindings under Settings → Source control.
- R1.3 Where upstream renamed or removed an API #19576 uses, the fork MUST adapt #19576's code to upstream's current API rather than restore the old one.
- R1.4 A Linear binding to one team MUST still read and update issues of every other team in the same workspace (a project bound to `trusk/CO` opens `TEC-399`). Writes that depend on a team (workflow states, labels, assignees) MUST use the issue's own team, not the bound one. Another workspace stays refused. Where: `requireIssueReference` and `issueScope` in `packages/issue-tracker-linear/src/server/LinearIssueTracker.ts`. Check: the cross-team tests in `LinearIssueTracker.test.ts`.
- R1.5 An issue link or reference saved without a `connectionId` (links from before saved accounts, or fixed by hand) MUST be read through the project's only source on that tracker; with two sources on one tracker it stays refused. A reference naming another account stays refused. Where: `requireProject` in `apps/server/src/issue/IssueService.ts`. Check: "reads a link saved without an account…" in `IssueService.test.ts`.

Where: merge commit on the branch, plus the follow-up port commit. Check: web, server, mobile and package typechecks are clean.

## 2. Database migrations

- R2.1 The issue migrations MUST be numbered after upstream's highest migration (73–76 at nightly 3814). On every rebase, recheck upstream's highest id and move the issue block past it.
- R2.2 Databases written by #19576 preview builds, which recorded the issue block at 63, 65 or 67, MUST be moved to the new ids. Any upstream migrations those ids shadowed MUST run.
- R2.3 Databases written by the earlier fork builds (ledger rows `62 ProjectionThreadIssues`, `63 WorkItemLinks`) MUST start cleanly. The server retires those two rows, drops the unused `work_item_links` table and `projection_threads.issue_links_json` column, then runs upstream's 62+ and the issue migrations.
- R2.4 Back up `statev2.sqlite` on both hosts before deploying. New migrations can't be rolled back.

Where: `apps/server/src/persistence/Migrations.ts` (`reconcileIssueMigrations`, `retireForkIssueStackMigrations`). Check: `reconcileV2PreviewMigration.test.ts`, plus a migration run against copies of the Mac's and the rpi5's databases.

## 3. Linear accounts from earlier builds

- R3.1 On startup, the server MUST reconnect every Linear account the earlier fork builds stored in the `issue-trackers.linear.credentials` secret.
- R3.2 It MUST restore each project's old team binding from settings.json's `issueTracking.connections.linear.projectBindings`. An old team key maps to this build's `<workspace>/<team>` scope.
- R3.3 Because the settings service may rewrite settings.json first, it MUST copy the old bindings into the secret store before it can rewrite the file.
- R3.4 The old secrets MUST be removed only after every account reconnects. A failed account keeps them, so the next start retries.
- R3.5 The import MUST NOT block server startup.

Where: `apps/server/src/issue/LegacyLinearImport.ts`, `serverSettings.ts` (stash), `server.ts` (startup task). Check: `LegacyLinearImport.test.ts`, plus a sandbox run on a copy of the Mac's data (2 accounts, 3 bindings restored).

## 4. Linear issue trees in a thread

- R4.1 A thread's linked issues MUST show as trees: up to three levels of parents, plus children and grandchildren.
- R4.2 Each node MUST list the pull requests its tracker reports.
- R4.3 Linked issues that share an ancestor MUST merge into one tree.
- R4.4 A PR that also belongs to the thread MUST appear once, under the issue that lists it, marked "this thread".
- R4.5 Trees MUST report their PRs to the parent panel only when the set changes, which avoids a re-render loop.
- R4.6 Linear issue lookup MUST accept `ENG-12`, `#12` and `12`.

Where: `apps/web/src/components/threadIssue/ThreadIssueTrees.tsx`, `threadIssueTree.logic.ts`, Linear hierarchy query in `packages/issue-tracker-linear`. Check: `threadIssueTree.logic.test.ts`, `LinearIssueTracker.test.ts`.

## 5. One "Linked items" panel

- R5.1 A thread MUST have a single right-panel tab, "Linked items", that lists linked issues (as trees, per §4) above linked PRs.
- R5.2 A thread PR nested under an issue MUST NOT repeat in the flat PR list.
- R5.3 Every entry point that opened the separate "Linked issues" tab (add-tab menu, command palette, keybinding, chat actions, reopen closed view) MUST open the combined tab instead.
- R5.4 Saved "issues" tabs MUST convert into the combined tab, without producing a duplicate.
- R5.5 PRs and issues MUST both be linkable from the combined panel.
- R5.6 Empty state: "No linked items". Footer: "N open · M linked".

Where: `apps/web/src/components/pullRequest/ThreadPullRequestsPanel.tsx` (the `pull-requests` surface), `threadIssue/ThreadIssueLinks.tsx`, `threadIssueTree.logic.ts` (`pullRequestsOutsideIssueTrees`), `rightPanelStore.ts` and `closedViewStore.ts` (`issues` → `pull-requests`). Check: logic tests for the flat list and the tab normalization. The add-tab launcher opens it with `L`; `I` no longer opens anything. Mobile keeps its separate PR and issue screens.

## 6. Saved client state from earlier builds

- R6.1 The right-panel and closed-views stores MUST validate saved tabs on every load, not only when their persist version changes. A build that reuses a version number must not render tabs it can't handle.
- R6.2 Issue tab titles MUST NOT crash on a missing scope or key.

Where: `apps/web/src/rightPanelStore.ts`, `closedViewStore.ts` (`merge`), `components/issue/issueDetail.logic.ts` (`issueDisplayLabel`). Check: load-path tests in `rightPanelStore.test.ts` and `closedViewStore.test.ts`; both fail without the fix.

## 7. Build and release

- R7.1 Builds MUST bake in T3 Connect's public configuration: `T3CODE_RELAY_URL`, `T3CODE_CLERK_PUBLISHABLE_KEY`, `T3CODE_CLERK_JWT_TEMPLATE`, `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`. Without them, Connect is silently off.
- R7.2 The branch MUST keep the fork's `.github/workflows`. The bot token can't push workflow changes.
- R7.3 `apps/desktop`, `apps/server`, `apps/web` and `packages/contracts` MUST be stamped with the nightly version.
- R7.4 Mac app: the official app with `app.asar`'s `apps/server/dist` replaced, the same unpacked files, the asar integrity hash updated, `app-update.yml` removed, and an ad-hoc signature. It MUST NOT update itself back to the official nightly.
- R7.5 linux-arm64: the official archive with `t3` and `client/` replaced. `t3` is a Node SEA built on a 16 KiB-page arm64 host (the rpi5) with Node = root `engines.node` plus postject.
- R7.6 Before release: run `t3 --version` on both builds, and boot the rpi5 build once on an empty home.

## Dropped

- Claude Code mod UI (pingdotgg/t3code#15827, #17432). Upstream closed both, and this fork dropped them at 0.1.4.

## Known gaps

- Thread issue links saved in the earlier builds' format (`provider`/`repository`/`number`, without `tracker`/`scope`/`key`) make the server fail to start. The live databases were fixed by hand, but the branch has no conversion, so the pre-0.1.4 backups can't be restored as-is. SHOULD convert or drop them when projections are read.
- A project can't link Linear issues unless some project is bound to a team of that Linear workspace (the earlier builds' fallback for projects without a git host isn't ported). Any team of a bound workspace works (R1.4).
- Trees show only the first page of children. Trackers other than Linear show direct children only, without PRs.
- Trees refresh with the panel's issue reads, not when an agent turn ends.
- Issue trackers build their own host clients, so GitHub issues don't share the PR reader's rate limit.
