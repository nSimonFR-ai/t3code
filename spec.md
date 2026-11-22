# nic-os fork: spec

What this fork (`nSimonFR-ai/t3code`, branch `nicos/fork-<version>`) changes on top of an upstream T3 Code release, and what each change must do. Releases are tagged `v<version>-issues.N` (the suffix is kept so the release workflow needs no change) and deployed by nic-os (`pkgs/agents/t3code.nix` for the rpi5 server, `pkgs/agents/t3code-desktop.nix` for the Mac app).

Requirements use MUST / SHOULD. Each section ends with where the change lives and how it's checked, so the next merge of a newer release can carry it forward or drop it on purpose.

Current base: `v0.1.11` (stable channel).

The fork used to carry the Issues stack (pingdotgg/t3code#19576). Upstream ships Issues itself since 0.1.11, so the fork dropped it there; `~/.t3/backups/t3-fork-exit.sql` converts a database written by the old fork builds before their first start on this one.

## 1. Sound while the screen is locked

- R1.1 Settings → Notifications MUST offer "Sound while the screen is locked", on by default. Turned off, the desktop app MUST NOT play a thread notification sound while the OS session is locked (on macOS, including a display asleep behind a password). Desktop notifications and the badge are unchanged.
- R1.2 The check MUST live in the web client only: the Mac app is upstream's with the fork's server and client swapped in (§4), so a change to Electron's main or preload process would not ship.
- R1.3 Where the lock can't be watched (a browser without the idle-detection permission), sounds MUST still play. The client MUST NOT prompt for that permission. The row shows only in the desktop app, with a sound mode selected.

Where: `notificationSoundWhileLocked` in `packages/contracts/src/settings.ts`, `isScreenLocked` in `apps/web/src/threadNotifications.ts` (Chromium's `IdleDetector`), the row in `components/settings/SettingsPanels.tsx`. Check: the "while the screen is locked" tests in `threadNotifications.test.ts`. Upstream: proposed in pingdotgg/t3code discussion #40771 (branch `feat/quiet-sound-when-locked`); drop this section if upstream ships it.

## 2. Claude artifact watchers

- R2.1 A Claude thread that published an Artifact MUST settle once its turn ends. Claude Code's session-long live-updates watcher (`task_started` with `task_type: "monitor_ws"`, `ambient: true`) MUST NOT be projected as a subagent or as Waiting work. Ambient subagents stay subagents.

Where: `isClaudeAmbientTaskStarted` and `handleSdkMessage` in `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`. Check: "does not keep the thread busy for Claude's ambient artifact watch" in `ClaudeAdapterV2.test.ts`. Upstream: pingdotgg/t3code#29331. Drop this section once upstream merges it.

## 3. One Linear key per project

- R3.1 A project MAY carry its own key for a standalone tracker (Linear), so two projects on one server reach two workspaces. A tracker call for a project MUST use that project's key when one is saved, else the server's shared key from Settings.
- R3.2 Keys live in the secret store as `issue-tracker-<base64url kind>-project-<base64url workspace root>-token`; the shared key keeps upstream's name. No migration, no settings change: a server without project keys behaves as upstream. There is no UI yet: a project key is written to the secrets folder by hand, the project bound to its team in Settings.

Where: `IssueTrackerCredentialProject` and `issueTrackerProjectSecretName` in `apps/server/src/issue/IssueTrackerHostLive.ts`; `withProjectCredentials` in `IssueTrackerRegistry.ts` runs each call with its target's `cwd` (the project's workspace root). Check: `IssueTrackerProjectCredentials.test.ts`. Upstream: pingdotgg/t3code#39179 (several Linear accounts, open); drop this section once it ships.

## 4. Build and release

- R3.1 Builds MUST bake in T3 Connect's public configuration: `T3CODE_RELAY_URL`, `T3CODE_CLERK_PUBLISHABLE_KEY`, `T3CODE_CLERK_JWT_TEMPLATE`, `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`. Without them, Connect is silently off.
- R3.2 The branch MUST keep the fork's `.github/workflows`. The bot token can't push workflow changes.
- R3.3 `apps/desktop`, `apps/server`, `apps/web` and `packages/contracts` MUST be stamped with the upstream version.
- R3.4 Mac app: the official app with `app.asar`'s `apps/server/dist` replaced, the same unpacked files, `server-compile-cache` removed, the asar integrity hash updated, `app-update.yml` removed, and an ad-hoc signature. It MUST NOT update itself back to the official build.
- R3.5 linux-arm64: the official archive with `t3` and `client/` replaced.
- R3.6 The fork MUST NOT add database migrations: a database it writes stays readable by upstream's build of the same version.

Built by `.github/workflows/t3code-fork-release.yml` and `scripts/t3code-fork/` in nSimonFR/nic-os.

## Dropped

- Issues stack (#19576), Linear issue trees, the combined "Linked items" panel, legacy Linear account import, saved-tab migration: dropped at 0.1.11, upstream ships Issues. Candidates to re-add on top of upstream's Issues, one at a time.
- Claude Code mod UI (pingdotgg/t3code#15827, #17432). Dropped at 0.1.4.
