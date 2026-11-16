# HuvAI / JARVIS

Local-first Windows 11 assistant, built against the approved JARVIS requirements. The **Phase 0 technical feasibility probes have passed**: direct ChatGPT chat, a Codex app-server turn, and Windows local speech API checks. The desktop shell passes TypeScript checking and its Angular/Electron build; interactive window/tray/chat verification is pending. Continuous wake-word listening is not implemented yet. Audible confirmation and sustained voice/resource benchmarks remain acceptance checks.

## Desktop shell development

**Interface direction:** JARVIS is a voice-first assistant with a moving, sound-reactive 3D hologram as its eventual primary interface. The current chat/dashboard screen is a temporary console for backend testing, settings and troubleshooting. Visual redesign is paused until runtime capabilities are implemented and verified. The hologram will consume assistant-state and audio events; AI, permissions, tools and storage stay independent of that visual layer.

The Electron/Angular shell implementation is on `feature/desktop-shell`. Dependencies, TypeScript checking and its first build have succeeded. Target-PC window/tray/chat verification is pending. From the repository root in the normal VS Code terminal:

```powershell
npm install
npm run typecheck
npm start
```

`npm start` builds Angular and the Electron main/preload bundles, then opens JARVIS. The first launch may download the Electron runtime; later launches reuse it. The terminal stays occupied while the desktop process is running. `npm run start:built` opens the last built version without rebuilding. This is a desktop project; `aspire run` is not its launcher.

The development app restores the same protected JARVIS session used by the CLI; tokens are not copied into another credential store or exposed to Angular. Open Settings, review the model and confirm JARVIS credit spending is disabled in ChatGPT settings, then save preferences. Everyday chat uses the direct ChatGPT plan route; Codex is not started for general chat. Expired sessions currently require another Continue with ChatGPT sign-in; automatic token renewal remains pending.

The shell includes single-instance startup, a tray menu, close-to-hide behavior, streamed/cancellable chat, SQLite conversation/settings/activity storage, Windows/in-app error notices and lock-screen suppression of conversation content. Development data lives under ignored `.jarvis/desktop`; credentials and the host ID remain in `.jarvis`. Installed-app storage will use Electron's user-data directory. Windows startup is opt-in and available only for the packaged app; development does not register autostart.

Closing the window hides it. Click the tray icon to reopen it; choose **Quit JARVIS** to end the process. The microphone is inactive in this shell slice. Continuous voice, repository permissions/patch approvals, research, specialist routing, token renewal and installer hardening are later implementation slices. The Projects page explicitly disables repository access until its permission broker is implemented.

See [desktop shell verification](docs/desktop-shell-status.md) for current implementation and checks.

## Requirements

- [Product requirements v1.0](https://chatgpt.com/library?file_id=libfile_42397da7317481919f2a73a611d54fb7&account_id=personal)
- [Work mode implementation handoff](https://chatgpt.com/library?file_id=libfile_5d724c7e0ab08191a83d964a41e4736f&account_id=personal)

The handoff requires successful authorized plan-backed streamed inference and Codex/voice feasibility before a broad desktop implementation. No separately billed API or paid fallback is allowed.

### Default AI route

Everyday conversation will use the direct plan-backed ChatGPT chat route verified by `prove`. Codex is a specialist integration for appropriate complex coding/development tasks; the Codex feasibility test does not make it the default. Spreadsheet work will use dedicated spreadsheet tools where appropriate. This is the agreed routing direction; the production orchestrator is still to be implemented after the feasibility gate.

## Run the feasibility prototype

Requires Node.js 24+ and Windows. The direct OAuth/response prototype has no third-party dependencies; the Codex probe requires the project-local package described below.

```powershell
npm test
npm run preflight
npm run feasibility -- login
npm run feasibility -- status
```

`login` opens the system browser for **Continue with ChatGPT**, using a temporary `127.0.0.1` callback, fresh PKCE/state/nonce, and a persistent host ID. It validates the ID token signature and registration before storing the session with Windows CurrentUser DPAPI. It does not make an inference request.

Before testing inference, open [ChatGPT usage settings](https://chatgpt.com/settings/usage), find JARVIS and disable credit spending. Only then run:

```powershell
npm run feasibility -- prove --plan-only-confirmed
```

The confirmation flag is a **manual attestation**, not a provider-verified spending setting. The documented flow does not expose a billing-setting verification endpoint. Do not use this flag unless credit spending is disabled. Production Cost Guard remains unverified until this limitation is resolved and tested.

The probe uses only its own OAuth session, the account's model catalog, and `POST /v1/responses` with `stream: true`, `store: false`. It succeeds only after receiving text and `response.completed`. Sign-in and a listed model alone are insufficient. Errors halt; no retries or billing fallback are configured. Expired sessions require a new sign-in in this prototype; automatic refresh is a later implementation.

After a completed inference, the CLI saves a non-secret historical result under `.jarvis/last-inference-proof.json`; `status` shows its model and completion time alongside the saved session's granted plan permissions. This record contains no tokens or response text, does not prove future entitlement or the current billing setting, and does not mark the Codex/voice checks complete.

## Phase 0 probes

Direct plan-backed inference and a Codex app-server turn have been demonstrated on the owner's account using `gpt-6.1-sol`. The Windows local wake/dictation/synthesis probe also passed. Commands below rerun those probes; they do not start the desktop application.

Install the Codex package locally in this project (not globally), then test its app-server using JARVIS's own saved OAuth session:

```powershell
npm install --save-dev --save-exact @openai/codex
npm run feasibility -- codex --plan-only-confirmed
```

Keep JARVIS credit spending disabled before using the confirmation flag. This probe launches the package's native Windows executable over stdio, uses an isolated local Codex home and empty working directory, disables shell/apps/hooks/agents/search, refuses server action requests, and accepts only a completed streamed text turn. It does not sign in to Codex separately or consume another application's credentials. These probe restrictions do not replace the future repository permission broker. The installed native package and its lockfile must be reviewed before production packaging. A successful result is saved under `.jarvis/last-codex-proof.json`.

Test the installed Windows speech engines with:

```powershell
npm run feasibility -- voice
```

This command plays spoken instructions, briefly uses the default microphone to recognize **Hey Jarvis**, then asks for a short dictated sentence and speaks a confirmation. Follow the prompts; Ctrl+C stops the helper. Recognition input is disabled during speech output. The entire helper has a 75-second limit, and no audio or transcript is saved or uploaded. It uses installed Windows `System.Speech` components and makes no system changes. If required English recognition/voice components or microphone access are unavailable, it stops with a stage-specific error; it never activates a cloud audio fallback. The result records API completion only; the owner must also confirm hearing the speech. Wake accuracy, false activations and resource use still require sustained testing before release.

Prototype data is stored under ignored `.jarvis/` in the working directory. Run commands from this repository root. Tokens are encrypted; the stable host ID is not secret. DPAPI binds credentials to the current Windows user. Do not delete the host ID to resolve sign-in errors. A stale `session.lock` after a crash fails closed; confirm no feasibility process is running before removing only that lock file.

## Architecture

| Folder | Responsibility |
| --- | --- |
| `feasibility/` | Small command-line gate runner; no desktop scaffolding |
| `src/integrations/openai/` | Documented OAuth, identity validation, streaming Responses probe |
| `src/security/` | Plan-permission and cost checks; provider error classification |
| `src/storage/` | Windows DPAPI credential storage and single-process lock |
| `src/shared/` | Safe typed failures |
| `tests/` | Identity, callback, cost, streaming, and Windows persistence checks |

After the gate, desktop lifecycle, preload and Angular UI belong under `apps/desktop/`. Orchestration belongs in `src/core/`; voice and Codex are separate adapters under `src/integrations/`. Security-sensitive responsibilities stay outside the renderer and the model.

## Git workflow

Never commit or push to `main`. Use `dev` for integration and separate feature branches for major changes. Planned feature branches include `feature/chatgpt-feasibility`, `feature/desktop-shell`, `feature/local-voice`, and `feature/repository-permissions`. Create each when starting its work. The owner performs the final integration into `main`.

The owner created `dev` and `feature/chatgpt-feasibility`; the active checkout is now the feasibility feature branch. Pending implementation files are uncommitted. Remote publication has not been verified.

Review and commit the Phase 0 files on `feature/chatgpt-feasibility`, verify the checks, then integrate into `dev`. Push only feature branches and `dev`. Never use `git add .` when unrelated work is present. The agent session previously denied writes to Git metadata; if that restriction persists, staging, commits and pushes must be completed from a writable session.

See [Phase 0 status](docs/phase-0-status.md) for exact blockers and remaining acceptance checks.
