# HuvAI / JARVIS development rules

- Never commit to or push to `main`. The owner performs the final integration into `main`.
- Use `dev` for integration. Start a separate `feature/<name>` branch for each substantial feature and merge verified work into `dev`.
- If branch creation or GitHub access fails, report it. Do not claim local branches or remote pushes succeeded.
- Follow the JARVIS PRD and work mode handoff linked in README.md. Phase 0 must pass before scaffolding the full desktop application.
- Use a lean TypeScript modular monolith: Electron main for privileged services; Angular renderer for UI; shared typed contracts. Keep provider integrations, policy, and persistence separate.
- Everyday conversation defaults to direct plan-backed ChatGPT chat. Codex is a specialist route for suitable demanding coding/development tasks, not the general conversation backend. Spreadsheet work should use the appropriate spreadsheet tools rather than automatically invoking Codex.
- Reuse existing implementations and avoid duplicate services. Explain the changes and checks in plain English.
- R0 additional spending: no API-key billing fallback, purchased credits, paid provider, or automatic top-up. Block requests until plan-only spending is confirmed.
- Never read unrelated repositories, change operating-system settings, install privileged services, or enable autostart during development without the required explicit approval.
- Keep credentials out of Git, logs, renderer state, and prompts. Validate identity and permissions outside the model.
- Report implemented, verified, blocked, and deferred work accurately. Mock tests do not prove live provider entitlement or Windows voice behavior.
