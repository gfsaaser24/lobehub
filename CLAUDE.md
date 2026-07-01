# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md
@DEPLOYMENT-STATUS.md

# Working notes for this fork

`AGENTS.md` is the upstream LobeHub dev guide — keep it untouched (it syncs from upstream). `DEPLOYMENT-STATUS.md` is the live state of *our* Coolify deployment, including credentials, API keys, and runbooks. Both are loaded into context automatically via the `@` imports above.

## When in doubt

- **Code changes** → follow `AGENTS.md`. Push to `canary`, Coolify auto-deploys.
- **Domain conventions** → check `.agents/skills/<topic>/SKILL.md` before touching unfamiliar areas (e.g. `spa-routes`, `drizzle`, `db-migrations`, `trpc-router`, `i18n`, `testing`, `review-checklist`, `pr`, `version-release`). `AGENTS.md` only links a couple inline.
- **Deploy/infra/credentials** → see `DEPLOYMENT-STATUS.md`. Don't paste secrets back into chat unless asked — they're already loaded.
- **Coolify MCP** → use `mcp__coolify__*` tools. App UUID: `j10ip3rcpokqyfm2l1jjmxta`.
- **Direct shell on the box** → `ssh -o StrictHostKeyChecking=no -i ~/.ssh/coolify -p 2222 root@178.156.197.219`.

## Don't

- Don't run `git push --force` on `canary` — Coolify treats every push as a deploy trigger; a force-push that breaks the build takes the live app offline.
- Don't change `KEY_VAULTS_SECRET` without re-encrypting `ai_providers.key_vaults` — see `DEPLOYMENT-STATUS.md` for the migration pattern.
- Don't edit auto-managed Coolify env vars (`SERVICE_FQDN_*`, `SERVICE_URL_*`, `COOLIFY_*`) — Coolify rewrites them on every deploy.
