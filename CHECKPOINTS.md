# Dev checkpoints (20–23 April 2026)

An **orphan branch**, sibling to `version-history`. 26 work-in-progress snapshots
taken between releases over four days, each one commit tagged
`checkpoint/<name>`. `git log --reverse dev-checkpoints` walks them in order.

## Why these were not in `version-history`

Releases carry a version number in `manifest.json`, which is how those 25 tags
were matched and verified. These do not — **every checkpoint declares `0.1.0`**,
whatever day it was taken. There was nothing to match them against, so when the
releases were replayed these were left on disk as loose folders and zips, the
last unprotected code in the tree.

## What they cover

`AFTER-fullglory`, `AFTER-standards`, `AFTER-inventory`, `AFTER-shadow-scroll`,
`AFTER-fullaudit`, `AFTER-reliability` (and `-v2`), `AFTER-discovery-fix`,
`AFTER-disclosure`, `AFTER-dedup`, `AFTER-human-journey`,
`MERGED-bigbuild-plus-fix5`, `FIXED-reportload-progress`, then the crawler series
`CRAWLER-human-browsing` through `CRAWLER-v12-discovery`.

No two consecutive checkpoints were byte-identical, so all 26 are distinct
states — none was dropped as a duplicate.

## How each was produced

- **Source**: the extracted folder where one existed (a superset for several),
  otherwise the zip.
- **Dates**: the zip's mtime — the only surviving real timestamp, since the
  OneDrive move rewrote every folder mtime to 26 July. Where only a folder
  survived, the timestamp in its own name was used.
- **Excluded**: `node_modules`, `.DS_Store`, and **any nested `.git`**.

## The `.git` exclusion is not cosmetic

Three of these archives (`AFTER-reliability-v2`, `AFTER-discovery-fix`,
`AFTER-disclosure`) wrap everything in a single `accessibility-extension-main/`
folder which contains its own `.git`. Stripping that common prefix — correct for
every other archive — promoted that `.git` to the repository root, where
extracting it **overwrote the live `.git/HEAD`** and silently redirected every
subsequent commit onto `main`.

The first attempt at this branch did exactly that and scattered its commits
across two branches before it was caught. The replay now refuses any path with a
`.git` component and re-checks `HEAD` after every commit.

One checkpoint exists only as a **zero-byte zip**
(`enableuser-AFTER-fullaudit-20260421-082137.zip`, nested inside
`accessibility-extension-main/`). It holds nothing and has no commit.
