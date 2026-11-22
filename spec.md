# nic-os fork: spec

What this fork (`nSimonFR-ai/t3code`, branch `nicos/fork-<version>`) changes on top of an upstream T3 Code release, and what each change must do. Releases are tagged `v<version>-issues.N` (the suffix is kept so the release workflow needs no change) and deployed by nic-os (`pkgs/agents/t3code.nix` for the rpi5 server, `pkgs/agents/t3code-desktop.nix` for the Mac app).

Requirements use MUST / SHOULD. Each section ends with where the change lives and how it's checked, so the next merge of a newer release can carry it forward or drop it on purpose.

Current base: `v0.1.11` (stable channel).

The fork used to carry the Issues stack (pingdotgg/t3code#19576). Upstream ships Issues itself since 0.1.11, so the fork dropped it there; `~/.t3/backups/t3-fork-exit.sql` converts a database written by the old fork builds before their first start on this one.

## 1. Quiet while the screen is locked

- R1.1 The desktop app MUST NOT play a thread notification sound while the OS session is locked. On macOS this includes a display asleep behind a password. Desktop notifications and the badge are unchanged.
- R1.2 The check MUST live in the web client only: the Mac app is upstream's with the fork's server and client swapped in (§3), so a change to Electron's main or preload process would not ship.
- R1.3 Where the lock can't be watched (a browser without the idle-detection permission), sounds MUST still play. The client MUST NOT prompt for that permission.

Where: `watchScreenLock` / `isScreenLocked` in `apps/web/src/threadNotifications.ts` (Chromium's `IdleDetector`, started on the first audio unlock; Electron grants it without a prompt because the main window has no permission handler). Check: "stays quiet while the screen is locked" and "still plays when the lock screen can't be watched" in `threadNotifications.test.ts`.

## 2. Claude artifact watchers

- R2.1 A Claude thread that published an Artifact MUST settle once its turn ends. Claude Code's session-long live-updates watcher (`task_started` with `task_type: "monitor_ws"`, `ambient: true`) MUST NOT be projected as a subagent or as Waiting work. Ambient subagents stay subagents.

Where: `isClaudeAmbientTaskStarted` and `handleSdkMessage` in `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`. Check: "does not keep the thread busy for Claude's ambient artifact watch" in `ClaudeAdapterV2.test.ts`. Upstream: pingdotgg/t3code#29331. Drop this section once upstream merges it.

## 3. Build and release

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
