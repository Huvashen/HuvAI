# Desktop shell slice

Branch: `feature/desktop-shell`. Default conversation route: direct ChatGPT plan-backed Responses. Codex remains a specialist integration.

## Product direction and work order

The owner has seen the current interface and clarified that the final product must be voice-first, with a moving 3D hologram reacting to assistant state, sound and speech. The chat/dashboard shell is retained as a temporary testing/settings console. Its successful display does not establish live chat, tray or restart acceptance. Do not spend further implementation time polishing this dashboard as the primary experience.

Complete backend/runtime slices before final visual work:

1. Continuous local Hey Jarvis detection, mute/device state, local transcription and spoken responses, echo suppression, cancellation and Windows lock/sleep recovery.
2. Reliable direct ChatGPT conversation, session renewal/sign-out, local history, lifecycle supervision and cost/notification enforcement. Codex remains a specialist route, never the default conversation engine.
3. Persistent scoped repository approvals, safe context filtering, exact patch review and separate execution permissions. Spreadsheet tasks use appropriate local tools rather than automatically routing everything to Codex.
4. Permitted current-source research with citations, capability-based tool routing and clear unavailable states when a no-extra-cost integration is unsupported.
5. Installer/startup/shutdown and restart checks, security boundaries, resource/voice benchmarks and the PRD acceptance matrix.
6. Then build the original hologram as the primary surface, driven by shared idle/listening/thinking/speaking/muted/error and audio-level events. Keep optional text/settings controls secondary and reuse the verified backend.

Each substantial slice uses its own feature branch. The current desktop implementation still needs a checkpoint on `feature/desktop-shell` before beginning the separate voice feature; only verified work is integrated into `dev`, and the owner retains control of `main`.

## Implemented for verification

- Electron main, sandboxed preload and Angular renderer with a validated IPC allowlist.
- Custom local application protocol, restrictive CSP, denied browser permissions/navigation/popups and main-frame sender validation.
- One-instance tray lifecycle, open/hide window, explicit quit and cancellation on quit/sleep/Windows lock.
- ChatGPT sign-in and restoration of the existing development session without cloning credentials; OS-protected token storage remains outside Angular.
- Direct streamed/cancellable chat, local SQLite conversations/settings/activity, recovered interrupted messages and native-confirmed history deletion.
- Cost confirmation default-off, no API-key fallback, deduplicated notices within the process and no automatic Codex dispatch for chat.
- Settings, conversation selection, activity view and explicit disabled Projects page.
- Opt-in packaged-app login startup; no development autostart or microphone activation.

## Automated checks

Latest `npm test`: **38 passed, 0 failed, 0 skipped** on the Windows target session. `git diff --check` also passed.

New focused checks cover IPC payload rejection, SQL persistence/restart/cascade deletion, SQL-looking input stored as plain text, the default direct Responses route, streamed output persistence, credential exclusion from UI events, cost rejection before network calls, notification deduplication and lock-screen privacy.

The owner installed the desktop dependencies. Re-ran and verified `npm run typecheck` and `npm run build` successfully after installation. Electron 44.11.3's first-run runtime download completed; its executable and version metadata are present, and the app created its development SQLite/user-data files. Interactive window/tray/chat behavior still requires verification; the desktop-inspection helper failed to start in the agent session.

## Required target-PC checks

1. Dependency installation, TypeScript checking and the complete Angular/Electron build have passed. First-run Electron download completed. Confirm the visible application window opens after launch.
2. Exactly one tray icon and one main app instance appear; launching again focuses the same window.
3. The existing ChatGPT sign-in is restored, cost confirmation begins off and saving preferences enables a real streamed chat response.
4. Stop cancels a response. Close hides the window; the tray reopens it with conversation history intact.
5. Quit closes all app processes. Restart restores history/settings and does not leave a streaming message marked active after interruption.
6. Windows lock hides conversation data and blocks protected actions; unlock restores it. No microphone is active in this slice.
7. History deletion requires the native confirmation. UI cannot invoke arbitrary file, shell or external URL operations.

## Not delivered by this slice

Continuous Hey Jarvis listening, live voice chat, project grants/patch review, research tools, specialist task routing, automatic OAuth renewal/revocation/account switching, packaged installer, sustained resource/false-trigger benchmarks and production hardening remain pending. A passed feasibility probe does not complete these features.
