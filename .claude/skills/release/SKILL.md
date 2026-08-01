---
name: release
description: Cut a release of this action — run the full gate, tag the version, force-move the v1 tag, and publish a GitHub release. Use when asked to release, cut a version, or update the v1 tag.
disable-model-invocation: true
---

Cut a release. `$ARGUMENTS` may name the version (e.g. `v1.6.0`); if absent, work it out from the
change and confirm before tagging.

## 1. Decide the version

Compare against the latest tag: `git log --oneline $(git describe --tags --abbrev=0)..HEAD` and
`git diff $(git describe --tags --abbrev=0)..HEAD -- action.yml`.

- New or changed inputs/outputs, or added functionality → **minor**
- Bug fix or behaviour correction with no interface change → **patch**
- Removed or renamed inputs, or a change that breaks existing workflows → **major**, which means a
  new `v2` moving tag rather than moving `v1`

State the version and the reasoning before tagging. Do not silently pick.

## 2. Gate

```bash
npm run all
```

All four must pass. Then confirm the committed bundle matches a fresh build — a release whose
`dist/` is stale ships code nobody reviewed:

```bash
git status --porcelain dist   # must be empty after npm run build
git status --porcelain        # working tree must be clean
```

If `dist/` differs, the last commit was dishonest: commit the rebuild first (see CLAUDE.md on
building from an LF tree).

## 3. Tag — both of them

`v1` is a moving tag consumers reference. Creating the version tag without moving `v1` leaves every
consumer on old code while the release notes claim otherwise.

```bash
git tag -a v1.6.0 -F -     # annotated, with a real message: what changed and why
git tag -fa v1 -m "Moving tag: latest v1.x release (currently v1.6.0)"
git push origin v1.6.0
git push --force origin v1  # the moving tag must be force-pushed
```

## 4. Publish

```bash
gh release create v1.6.0 --title "v1.6.0 — <short summary>" --latest --notes-file -
```

Notes should explain the *why*, not list commits: what was broken, what changed, and anything the
reader must act on (a behaviour change that deletes more, a new input they should set). Link the
compare URL `.../compare/<previous>...<new>` at the end.

## 5. Verify what consumers actually get

```bash
gh release list --limit 2
git ls-remote --tags origin | grep -E "v1\^|<new-version>\^"   # both must resolve to the same commit
gh api repos/StreamElements/virustotal-monitor-action/contents/dist/index.js?ref=v1 -q '.sha'
git rev-parse HEAD:dist/index.js                                # must match the line above
```

The repo must be public or public consumers cannot resolve the action at all — see CLAUDE.md. A
quick anonymous check:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://raw.githubusercontent.com/StreamElements/virustotal-monitor-action/v1/action.yml
```

## 6. Report

Say which tag was created, where `v1` now points, the release URL, and whether CI passed on the
released commit.
