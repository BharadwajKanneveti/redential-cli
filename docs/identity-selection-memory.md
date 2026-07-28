# Remembering your identity selection, per repo

`scan` and `submit` share one interactive step: picking which author
email(s) in the repo's history are yours (see
[docs/scan.md](scan.md#how-it-works), step 3, "Select identity"). Starting
with this feature, the CLI **remembers that selection per repo** and offers
it back on the next run — so a repeat `scan`/`submit` on the same repo
confirms with a single Enter instead of re-typing or re-picking numbers
every time.

## Where it's stored

A new file, `identity-selections.json`, in the same OS-appropriate config
directory every other piece of local CLI state already lives in
(`config.ts`'s `DEFAULT_CONFIG_DIR` — see
[docs/login-submit.md](login-submit.md#where-the-token-lives)):

| Platform | Path |
|---|---|
| macOS / Linux | `~/.config/redential/identity-selections.json` |
| Windows | `%USERPROFILE%\AppData\Roaming\redential\identity-selections.json` |

Written with mode `0600` — same permission pattern as `credentials.json`
and the device `salt`, including the same Windows caveat: NTFS has no
POSIX permission bits, so `mode: 0o600` is a no-op there, and what actually
restricts access is NTFS ACL inheritance from the user's own profile
directory, not this CLI (see
[docs/login-submit.md](login-submit.md#where-the-token-lives) for the full
explanation of that mechanism).

## Keyed by fingerprint, never by path or name

Entries are keyed by the repo's **salted `repo_fingerprint`** — the exact
same non-reversible hash (`saltedHash(salt, rootCommitSha)`, see
`src/scan.ts`) the bundle itself already carries in its `repo` field. The
file never stores the repo's path, directory name, or remote URL — only a
fingerprint that was already going to leave the machine inside every bundle
this repo produces. Nothing new about "which repos you scan" is recorded
that a bundle wasn't already going to reveal to Redential's own servers.

## What's stored per entry

For each repo fingerprint:

- The selected author **emails** — the same emails you already picked in
  the interactive flow, which already exist in plaintext in the local git
  history you're scanning. Storing them locally is not a new exposure:
  they never leave the machine (unlike the bundle's
  `author_identity_hashes`, which are salted), they're just remembered
  between runs.
- A **hash of the repo's full author list** at the moment of selection —
  used only to detect staleness (below), never uploaded, never compared to
  anything server-side.
- A **timestamp** of when the selection was stored.

## Staleness: a changed author list re-asks, never silently reuses

Before offering a stored selection back, the CLI re-enumerates the repo's
current author list and compares it against the hash stored alongside the
selection. Two outcomes:

- **Unchanged.** The stored selection is offered as the default: on a real
  TTY, the full identity prompt is skipped in favor of a single
  confirmation with the previous selection pre-filled — press Enter to
  reuse it, or answer `n` to fall through to the normal selection flow.
- **Changed** (a new author email appears in the history, or one of the
  previously stored emails is no longer present). The full identity
  selection prompt is shown again, exactly as if no stored selection
  existed — with the previous selection pre-marked as the Enter-default
  inside that list, so choosing "still just those" costs one keystroke, but
  nothing is ever silently reused once it no longer matches the history it
  was chosen against. This matters because a repo gaining or losing a
  contributor is exactly the kind of change that could make an old
  selection wrong (a rebase folding in another author's commits, a
  history rewrite, or simply a new teammate's first commit), and this
  feature must never let a stale answer stand in for a fresh one.

## Non-interactive runs

A stored selection is used automatically in a non-interactive run (piped
stdout, `--json`, CI) only when it **still matches the repo's current
author list exactly** — the same staleness check as above, just without a
prompt to fall back on. If it doesn't match, nothing is inferred: the
existing non-interactive error naming `--author <email>` / `--yes` (see
[docs/scan.md](scan.md#how-it-works) and
[CHANGELOG.md](../CHANGELOG.md)) is unchanged, and the run still requires
an explicit `--author` flag or fails with that error.

`--author` flags, when given, always win outright — they bypass the store
entirely, on both interactive and non-interactive runs, and never read
from or write to `identity-selections.json`. Passing `--author` is exactly
as it always was: unaffected by whether a stored selection exists for this
repo.

## Privacy

`identity-selections.json` never leaves the machine. It is not part of the
bundle, never sent on `submit`'s upload request, never referenced by any
other request this CLI makes. It lives only in the config directory,
alongside `credentials.json` and `last-submission.json` — never inside or
near the scanned repo itself, so it can't be accidentally committed or
shipped with the repo's own files.

## `logout` does not touch it

`redential logout` deletes only the session token
(`credentials.json`) — see
[docs/login-submit.md](login-submit.md#where-the-token-lives). It does not
delete `identity-selections.json`, because a remembered identity selection
is not a credential: it doesn't grant access to anything, and losing your
session shouldn't also make you re-pick your own email on every repo you've
already confirmed once.

To clear remembered selections, delete the file directly:

| Platform | Command |
|---|---|
| macOS / Linux | `rm ~/.config/redential/identity-selections.json` |
| Windows (PowerShell) | `Remove-Item "$env:USERPROFILE\AppData\Roaming\redential\identity-selections.json"` |

Deleting it is always safe: the next `scan`/`submit` on any affected repo
simply falls back to the ordinary interactive selection flow, exactly as
if this feature didn't exist.
