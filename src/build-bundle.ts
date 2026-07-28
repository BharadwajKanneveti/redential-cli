import { runScan, listAuthors, computeRepoFingerprint, type AuthorCandidate } from "./scan.js";
import { ScanError } from "./errors.js";
import {
  promptAuthors,
  promptConfirmAttestation,
  promptContinueLocally,
  promptUseGitIdentity,
  promptUseSavedSelection,
} from "./prompt.js";
import { getConfiguredUserEmail, getRemoteUrl, isShallowRepository } from "./git.js";
import { publicHostWarning } from "./public-remote.js";
import { shallowRepoWarning } from "./shallow-repo.js";
import {
  computeAuthorListHash,
  readIdentitySelection,
  saveIdentitySelection,
} from "./identity-selection-store.js";
import type { Bundle } from "./types.js";

export interface BuildBundleOptions {
  repoPath: string;
  author: string[];
  yes: boolean;
  toolVersion: string;
  configDir?: string;
  // Injectable for tests; defaults to the real interactive prompts. The
  // optional second argument (identity-selection-memory milestone, see
  // docs/identity-selection-memory.md) pre-marks a "still-present" saved
  // selection as the Enter-default inside the full numbered list — only
  // ever passed when a stored selection exists but its author-list hash no
  // longer matches (see the "stale store" branch below).
  promptAuthorsFn?: (candidates: AuthorCandidate[], preselectedEmails?: string[]) => Promise<string[]>;
  promptConfirmFn?: () => Promise<boolean>;
  // Injectable for tests; defaults to the real interactive prompt. Only
  // ever called when `git config user.email` matches one of 2+ candidates
  // — see the "author pre-selection" comment below.
  promptUseGitIdentityFn?: (candidate: AuthorCandidate) => Promise<boolean>;
  // Injectable for tests; defaults to the real interactive prompt. Only
  // ever called on a real TTY with 2+ candidates, when a stored selection
  // (identity-selection-store.ts) still matches the repo's current author
  // list exactly — see docs/identity-selection-memory.md.
  promptUseSavedSelectionFn?: (authors: string[]) => Promise<boolean>;
  warn?: (message: string) => void;
  // True when stdout is an interactive terminal (cli.ts passes
  // `process.stdout.isTTY`; scan-command.ts/submit-command.ts forward their
  // own `isTTY` option straight through). Only used to decide whether the
  // connectable-repo notice gets an actual interactive "Continue locally?"
  // follow-up question — see promptContinueLocallyFn below. Undefined
  // behaves like `false` (no prompt), matching a piped stdout.
  isTTY?: boolean;
  // Injectable for tests; defaults to the real interactive prompt. Only
  // ever called when `isTTY` is true AND the remote looks connectable (see
  // public-remote.ts's publicHostWarning) — never in piped/non-TTY mode,
  // which keeps today's non-blocking "warn and continue" behavior exactly.
  promptContinueLocallyFn?: () => Promise<boolean>;
  // Raw --since spec, forwarded to runScan (src/since.ts parses it). See
  // scan-command.ts / docs/scan.md for the CLI-facing behavior.
  since?: string;
  // Forwarded to runScan — see ScanOptions.onProgress.
  onProgress?: (scanned: number, total: number) => void;
}

/**
 * Shared by `scan` and `submit`: author selection, authorization
 * confirmation, and the actual scan. `submit` calls this directly instead
 * of re-deriving the bundle another way, so the bundle it uploads is
 * produced by the exact same code path `scan` prints (principle 4,
 * "User-reviewed").
 *
 * Returns `null` — instead of a `Bundle` — only when a real TTY user
 * answered "n" to the connectable-repo "Continue locally?" follow-up (see
 * below): nothing was scanned, and the caller must exit cleanly (exit code
 * 0) without printing anything further. Every other path (including the
 * non-TTY/piped one, which never asks that question at all) still always
 * returns a `Bundle`.
 */
export async function buildBundleInteractively(opts: BuildBundleOptions): Promise<Bundle | null> {
  const warn = opts.warn ?? console.error;

  const publicHostNote = publicHostWarning(getRemoteUrl(opts.repoPath));
  if (publicHostNote) {
    warn(publicHostNote);
    // TTY-interactive only — see BuildBundleOptions.isTTY's comment and
    // public-remote.ts's own comment on why this question lives outside
    // publicHostWarning's returned string. Piped/non-TTY stdout keeps
    // today's exact behavior: warn and continue, never blocking.
    if (opts.isTTY) {
      const proceed = await (opts.promptContinueLocallyFn ?? promptContinueLocally)();
      if (!proceed) {
        warn("Nothing scanned. Connect the GitHub App instead for a stronger tier.");
        return null;
      }
    }
  }
  if (isShallowRepository(opts.repoPath)) warn(shallowRepoWarning());

  let authors = opts.author;
  if (authors.length === 0) {
    const candidates = await listAuthors(opts.repoPath);
    if (candidates.length === 0) {
      throw new ScanError("This repository has no commits yet — nothing to scan.");
    }

    // Identity-selection memory (see docs/identity-selection-memory.md):
    // `--author` flags (the `authors.length === 0` guard above) always
    // bypass this store entirely — no read, no write. Only reached when
    // the user is about to be asked interactively (or, non-TTY, would hit
    // the existing EOF error) which author identity is theirs.
    const fingerprint = computeRepoFingerprint(opts.repoPath, opts.configDir);
    const stored = readIdentitySelection(fingerprint, opts.configDir);
    const currentHash = computeAuthorListHash(candidates.map((c) => c.email));
    const candidateEmails = new Set(candidates.map((c) => c.email));
    // "Matches" means the stored selection's author-list hash is identical
    // to the repo's current one AND every stored author is still among the
    // current candidates — see docs/identity-selection-memory.md's
    // "Staleness" section.
    const storedMatches =
      stored !== null &&
      stored.author_list_hash === currentHash &&
      stored.authors.every((email) => candidateEmails.has(email));

    if (!opts.isTTY) {
      // Non-interactive: a matching stored selection is used silently (a
      // single stderr notice, never stdout — the piped bundle JSON must
      // stay byte-identical). Anything else — no stored entry, or a stale
      // one — falls through to today's exact flow (including its EOF
      // error naming --author/--yes); nothing is ever inferred here, and
      // nothing is ever saved on this path.
      if (storedMatches) {
        authors = stored!.authors;
        warn(`Using saved identity selection: ${authors.join(", ")} (docs/identity-selection-memory.md).`);
      } else {
        authors = await selectAuthorsTodaysFlow(opts, candidates);
      }
    } else if (candidates.length > 1 && storedMatches) {
      // 2+ candidates, a matching stored selection: offer it back FIRST,
      // before the git-identity fast path. Declining falls through to
      // today's flow exactly, with no pre-marking — the user just
      // declined that selection, so it shouldn't linger as a default.
      const useSaved = await (opts.promptUseSavedSelectionFn ?? promptUseSavedSelection)(stored!.authors);
      authors = useSaved ? stored!.authors : await selectAuthorsTodaysFlow(opts, candidates);
    } else if (candidates.length > 1 && stored !== null && !storedMatches) {
      // 2+ candidates, a stale stored selection (author list changed since
      // it was saved): skip both the saved-selection offer and the
      // git-identity fast path, and go straight to the full list — with
      // the still-present stored authors pre-marked as its Enter-default,
      // so "still just those" costs one keystroke without ever silently
      // reusing an answer that no longer matches the history it was
      // chosen against.
      const storedStillPresent = stored.authors.filter((email) => candidateEmails.has(email));
      authors =
        storedStillPresent.length > 0
          ? await callPromptAuthors(opts, candidates, storedStillPresent)
          : await selectAuthorsTodaysFlow(opts, candidates);
    } else {
      // Single candidate, or no stored entry at all: today's flow,
      // unchanged.
      authors = await selectAuthorsTodaysFlow(opts, candidates);
    }

    // Save whatever the user just picked, interactively, for next time —
    // never on the non-interactive path (see above) and never an empty
    // selection. A store write failure must never break the scan itself.
    if (opts.isTTY && authors.length > 0) {
      try {
        saveIdentitySelection(fingerprint, authors, currentHash, opts.configDir);
      } catch {
        // Best-effort local UX cache only — see identity-selection-store.ts.
      }
    }
  }

  let confirmed = opts.yes;
  if (!confirmed) {
    confirmed = await (opts.promptConfirmFn ?? promptConfirmAttestation)();
  }

  return runScan({
    repoPath: opts.repoPath,
    authors,
    confirmed,
    toolVersion: opts.toolVersion,
    configDir: opts.configDir,
    since: opts.since,
    onProgress: opts.onProgress,
  });
}

/**
 * The author-selection flow exactly as it existed before the identity-
 * selection-memory milestone (docs/identity-selection-memory.md) — extracted
 * unchanged so every "fall through to today's flow" branch above (declined
 * saved selection, stale store with nothing still present, no store at all)
 * calls the exact same code, never a near-duplicate that could drift.
 *
 * With 2+ candidates, offers the repo's own git identity as a fast default
 * BEFORE the full list — most repos have one obvious "you". A single
 * candidate already gets its own Y/n confirmation inside promptAuthors;
 * asking the same question twice in a row would be redundant, so this only
 * fires for 2+. Declining, or no match at all, falls through to the FULL,
 * unmodified list — never silently dropping the matched entry, since "no"
 * often means "that one plus others" for a multi-identity repo.
 */
async function selectAuthorsTodaysFlow(opts: BuildBundleOptions, candidates: AuthorCandidate[]): Promise<string[]> {
  if (candidates.length > 1) {
    const gitEmail = getConfiguredUserEmail(opts.repoPath);
    const matched = gitEmail ? candidates.find((c) => c.email === gitEmail) : undefined;
    if (matched) {
      const useIt = await (opts.promptUseGitIdentityFn ?? promptUseGitIdentity)(matched);
      if (useIt) return [matched.email];
    }
  }

  return callPromptAuthors(opts, candidates);
}

/**
 * Small adapter over `opts.promptAuthorsFn` (or the real `promptAuthors`) —
 * needed only because the real function's parameter order is
 * `(candidates, streams?, preselectedEmails?)` while the injectable
 * `BuildBundleOptions.promptAuthorsFn` (matching every test fake already in
 * this codebase, none of which take a `streams` argument) is
 * `(candidates, preselectedEmails?)`. Keeps both call sites above from
 * having to know which of the two shapes they're calling.
 */
function callPromptAuthors(
  opts: BuildBundleOptions,
  candidates: AuthorCandidate[],
  preselectedEmails?: string[]
): Promise<string[]> {
  if (opts.promptAuthorsFn) return opts.promptAuthorsFn(candidates, preselectedEmails);
  return promptAuthors(candidates, undefined, preselectedEmails);
}
