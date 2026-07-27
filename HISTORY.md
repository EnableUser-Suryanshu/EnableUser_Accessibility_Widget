# Version history (v0.1.12 – v0.4.8)

This is an **orphan branch**. It shares no ancestry with `main`, and that is
deliberate.

## Why it exists

`main`'s root commit is "Version 0.4.9", dated 25 July 2026. Every release before
that — 25 of them, from 0.1.12 to 0.4.8, spanning April to July 2026 — had never
been committed. They existed only as extracted folders and `.zip` files sitting
in the parent directory, where nothing verified them, nothing linked them, and a
misplaced delete would have ended them.

This branch puts that history in git. One commit per release, each tagged
`v<version>`, in version order.

## Why an orphan branch rather than a rewrite

Inserting these as ancestors of `main` would mean rewriting already-published
history, and it would buy nothing: these snapshots were never committed, so they
share no blobs with `main` to connect to. An orphan branch records the history
without touching what is already pushed.

`git log v0.4.8` shows the chain. `git diff v0.4.6 v0.4.7` works as normal.

## How each commit was produced

- **Source**: the extracted folder where one existed, because for nine releases
  the folder holds files the zip omits (`.gitignore`, `package-lock.json`). Where
  only a zip survived (v0.4.8) it was extracted.
- **Dates**: taken from each release's `.zip` mtime — the only surviving record of
  when it was cut. Moving the tree into OneDrive rewrote every folder and
  inner-file mtime to 26 July, so folders carry no date information. v0.4.2 and
  v0.4.3 have no surviving zip; their dates are interpolated between neighbours
  and their commit messages say so.
- **Excluded**: `node_modules/` and `.DS_Store`.
- **Also excluded: `lib/axe.min.js`.** Every release's own `.gitignore` lists it —
  it is build output, ~0.5 MB, and committing it 25 times would add ~13 MB of
  vendored binary. It is fully reproducible: each tag ships its
  `package-lock.json` pinning the exact axe-core build (4.11.3 for the early
  releases, 4.12.1 by v0.4.8), so `npm ci && node build.js` regenerates it
  byte-for-byte.

## Two releases had more than one build on disk

- **v0.2.2** — folder and `EnableUser-v0.2.2-final.zip` are byte-identical. No
  ambiguity.
- **v0.4.1** — the folder and `EnableUser-v0.4.1 (2).zip` (June, 1 MB) differ from
  `EnableUser-v0.4.1.zip` (April, 363 KB). The folder was used.
- **v0.4.8** — its zip contains the same 45 files *twice*, once at the top level
  and once nested under `EnableUser-v0.4.8/`, with **different contents**: two
  builds of one version number. The top-level copy was used, because 35 of its 45
  files are byte-identical to the committed v0.4.9 versus 30 for the nested one,
  and its `background.js` is larger — so it is the later build.

## Verified

Every tag was checked to declare in `manifest.json` the version its name claims
(25/25), and every source file to survive into its commit apart from the
deliberately ignored `axe.min.js`.
