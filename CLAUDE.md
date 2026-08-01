# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

A GitHub Action that uploads release binaries to VirusTotal Monitor and prunes old ones to stay
under the storage quota. Implements CORE-440. Source in `src/`, tests in `__tests__/`, the shipped
bundle in `dist/`.

## Verify before calling a change done

```bash
npm run all   # typecheck && test && build && smoke
```

`npm run smoke` runs the **built bundle** as a child process against a fake VirusTotal API. Run it
after any dependency change: a green `npm run build` is not evidence the bundle works — ncc can
silently stub out a dependency and still exit 0, leaving typecheck, unit tests and the
dist-freshness check all passing on a bundle that dies with `Cannot find module` on the runner.
That has happened here.

## dist/ is committed

The action runs straight from `dist/index.js`, so `.gitignore` deliberately does not list it. Any
source change needs `npm run build` and the result committed in the same commit — CI fails
otherwise.

**Build from an LF working tree.** `dist/index.js.map` embeds source text, so a CRLF checkout
produces a map a few KB larger than CI's Linux build, and the freshness check fails on a bundle
that is otherwise byte-identical. `.gitattributes` enforces `eol=lf`; editors and scripts that
write CRLF (e.g. Python's default text mode on Windows) reintroduce it. Repair with:

```bash
git rm --cached -r . && git reset --hard && npm run build
```

## Releasing: two tags, not one

`v1` is a **moving tag** that consumers reference. Cutting a release means creating the version tag
*and* force-pushing `v1`. Miss the second and every consumer stays on old code while the release
notes claim otherwise. Use `/release`, or follow `## Releasing` in README.md.

Breaking input or behaviour changes get a new major (`v2` plus its own moving tag), leaving `v1`
where it is.

## The repository must stay public

`obs-streamelements-core` is public, and **a public repo cannot consume a private or internal
action**. Org-level action sharing (`actions/permissions/access`) only reaches private and internal
consumers. Flipping this repo to internal breaks the release pipeline with `Unable to resolve
action ... not found`, which reads like a bad tag and is not. Nothing here is sensitive — the API
key is always an input.

## Dependencies are pinned for reasons, not taste

Recorded in `package.json` under `//overrides`. Do not "helpfully" upgrade:

- **`@actions/core` stays on 1.x, `@actions/glob` on 0.5.x.** 3.x and 0.7 are ESM-only; this action
  bundles as CJS and ncc stubs them out silently.
- **`undici` is force-resolved to `^6.28.0`**, including the copy `@actions/http-client` pins —
  everything up to 6.26.0 carries HTTP smuggling and response-poisoning advisories.
- **`brace-expansion` is overridden** in jest's chain for the same reason; 5.0.8+ is the fixed line.

`npm audit` should report zero.

## Scope

Keep changes inside this repo. Workflow snippets for consuming repositories belong in `examples/`;
do not edit `obs-streamelements-core` or other consumers.

## VirusTotal API facts that are not guessable

Verify endpoint paths and field names against current docs rather than memory — the ticket asks for
this explicitly.

- No recursive listing exists, so the action walks the folder tree one request per folder. That is
  the slowest part of a run and why prune enumerates from `managed-prefixes`, not `/`.
- Files >= 32 MB must go to a **single-use** URL from `GET /monitor/items/upload_url`, fetched fresh
  per attempt. Retrying against a spent URL fails on the URL, not the upload.
- `QuotaExceededError` (429) means *either* the request quotas *or* Monitor being out of disk space
  or files. Waiting fixes the first and never the second.
- The API does not expose storage limits, which is why `quota-bytes` and `quota-files` are inputs.
  A `quota-bytes` set far above reality silently disables pruning forever.

## Style and conventions

- No linter or formatter is configured. Match surrounding style: 2-space indent, single quotes, no
  semicolons.
- Comments explain *why*, not what. Several non-obvious decisions are already commented in place —
  keep that when editing.
- Commit subjects: imperative mood, sentence case, no `feat:`/`fix:` prefixes.
- The API key must never reach a log. Request headers are never logged; the quota URL embeds the key
  in its path and is redacted to `/users/***/overall_quotas`. The smoke test asserts this.
