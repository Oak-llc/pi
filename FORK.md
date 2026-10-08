# Oak fork of pi

This is Oak's fork of [earendil-works/pi](https://github.com/earendil-works/pi), based on upstream release **v1.1.0**.
Maple embeds the built `@earendil-works/pi-coding-agent` from this repository. The package names, binaries and
`dist` layout are unchanged on purpose so consumers need no renames.

**Product requirement: local models only.** The fork is otherwise identical to upstream.

## What differs from upstream

### `/login` and `/logout` are removed
- `core/slash-commands.ts`: no `login`/`logout` entries.
- `modes/interactive/interactive-mode.ts`: dispatch, autocomplete and the whole login handler block removed.
- Deleted: `components/oauth-selector.ts`, `login-dialog.ts`, `radius-login-selector.ts` (and their exports).
- `pi auth ...` subcommand and `--api-key` removed (`cli/auth-command.ts`, `auth-check.ts`, `credential-print.ts`).
- `/share` (Radius/gist upload) and `/bug` (Radius upload) removed. `session-share.ts` keeps only the local JSONL helpers.

### Only loopback models can be used
- `packages/ai/src/local-only.ts`: `isLoopbackUrl`, `assertLoopbackBaseUrl`, `isLocalChatApi`, `blockedStream`.
- Enforcement points (defense in depth): `api/lazy.ts` (`lazyStream`), `models.ts` (`applyAuth`), `compat.ts`
  (`stream`/`streamSimple`), `api/openai-completions.ts` and `api/openai-responses.ts` (client creation),
  `coding-agent/src/core/model-runtime.ts` (`prepareRequest`), `provider-composer.ts` (composition-time validation),
  and `core/http-dispatcher.ts` (every global `fetch` goes through a loopback-only undici dispatcher; no proxy support).
- `packages/ai/src/providers/all.ts`: `builtinProviders()` returns `[]`. Model catalog data files
  (`packages/ai/src/providers/data/*.json`) are committed as empty stubs, so nothing is generated or downloaded.
  `packages/ai` builds with plain `tsc` (no `generate-models`, no network).
- `provider-composer.ts`: models must be loopback and use `openai-completions`/`openai-responses`; OAuth providers
  are rejected; a custom provider without an API key is available (placeholder key `local`).
- `model-runtime.ts`: no remote catalog, no Radius providers, and an `AuthContext` that never reads `process.env`.
  `env-api-keys.ts`/`compat.ts` never inject environment API keys.
- `main.ts`: offline mode is always on (`PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`).

### Node 20 compatibility
`core/package-manager.ts` no longer imports `fs.globSync` (Node 22+). It uses a small `minimatch` walker so the CLI
loads on Node 20.19, the runtime inside Electron 34. Run the bundle through `dist/bundle/cli-runtime.js` on Node 20
(the `cli.js` launcher needs `module.enableCompileCache`), and preload a shim for `worker_threads.markAsUncloneable`
and `Promise.withResolvers` (see Maple's `electron/services/pi-shims/node-compat.cjs`).

### Tests
- Added: `packages/ai/test/local-only.test.ts`, `packages/coding-agent/test/local-only-models.test.ts`.
- Removed: tests of removed features (login dialogs, OAuth, Radius, bug reports, share) and the cloud-provider /
  catalog tests in `packages/ai/test` and `packages/coding-agent/test`.
- `packages/coding-agent/test/model-fixtures.ts` and `model-runtime-test-utils.ts` give tests loopback stand-ins for the
  `anthropic`/`openai` models they use as fixtures.
- `package-command-paths.test.ts` stubs `HOME` so a developer's real `~/.agents` skills do not leak into discovery.

### CI
Only `ci.yml` and `npm-audit.yml` are kept. Upstream's release, contributor-gate and catalog workflows are removed.

## Not removed (dormant)
The cloud provider implementations, OAuth modules, MCP OAuth code and the experimental server/client still exist in
the tree but are unreachable: no built-in provider is registered, composition rejects non-loopback endpoints, and the
global dispatcher refuses non-loopback hosts. Deleting them (and their SDK dependencies) is a possible follow-up.

## Building
```
npm ci --ignore-scripts
for p in chord tui telemetry codemode mcp ai agent; do (cd packages/$p && npm run build); done
cd packages/coding-agent && npm run build   # tsc + assets + esbuild bundle
```
Needs Node >= 22.19 on the build machine. No network access is required.

## Merging upstream
`git remote add upstream https://github.com/earendil-works/pi.git`, then merge a release tag. Conflicts will be in
the files listed above; keep this file up to date when you change the divergence.
