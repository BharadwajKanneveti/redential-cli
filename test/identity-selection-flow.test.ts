import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBundleInteractively } from "../src/build-bundle.js";
import { ScanError } from "../src/errors.js";
import type { Bundle } from "../src/types.js";
import { cleanup, commit, createRepo } from "./support/fixtures.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) cleanup(dirs.pop()!);
});

function tempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "redential-config-"));
  dirs.push(dir);
  return dir;
}

function repoWithTwoAuthors(): string {
  const dir = createRepo();
  dirs.push(dir);
  commit(dir, { message: "a1", authorName: "Alice", authorEmail: "alice@example.com", files: { "a.ts": "1\n" } });
  commit(dir, { message: "a2", authorName: "Alice", authorEmail: "alice@example.com", files: { "a.ts": "2\n" } });
  commit(dir, { message: "b1", authorName: "Bob", authorEmail: "bob@example.com", files: { "b.ts": "1\n" } });
  return dir;
}

function selectionStorePath(configDir: string): string {
  return join(configDir, "identity-selections.json");
}

/** Strips the two fields runScan always fills from `new Date()` (created_at,
 * attestation.confirmed_at), so two bundles produced by different code paths
 * for the exact same repo/authors can be compared for byte-identical
 * equality without depending on both runs landing in the same millisecond. */
function normalizeForComparison(bundle: Bundle): unknown {
  return {
    ...bundle,
    created_at: "STRIPPED",
    attestation: { ...bundle.attestation, confirmed_at: "STRIPPED" },
  };
}

describe("identity-selection memory in buildBundleInteractively", () => {
  it("first run: no stored selection, git-identity fast path used, then saves it", async () => {
    const dir = repoWithTwoAuthors();
    execFileSync("git", ["config", "user.email", "alice@example.com"], { cwd: dir });
    const configDir = tempConfigDir();

    expect(existsSync(selectionStorePath(configDir))).toBe(false);

    await buildBundleInteractively({
      repoPath: dir,
      author: [],
      yes: true,
      toolVersion: "0.1.0",
      configDir,
      isTTY: true,
      warn: () => {},
      promptUseGitIdentityFn: async () => true,
    });

    expect(existsSync(selectionStorePath(configDir))).toBe(true);
    const stored = JSON.parse(readFileSync(selectionStorePath(configDir), "utf8"));
    const entry = Object.values(stored.selections)[0] as { authors: string[] };
    expect(entry.authors).toEqual(["alice@example.com"]);
  });

  it("second run: offers the saved selection first (promptUseSavedSelectionFn called, promptAuthorsFn/git-identity NOT called); accepting reuses it", async () => {
    const dir = repoWithTwoAuthors();
    const configDir = tempConfigDir();

    // First run establishes the stored selection via the full list (no git
    // identity configured in this fixture repo).
    await buildBundleInteractively({
      repoPath: dir,
      author: [],
      yes: true,
      toolVersion: "0.1.0",
      configDir,
      isTTY: true,
      warn: () => {},
      promptAuthorsFn: async () => ["alice@example.com"],
    });

    let savedPromptedWith: string[] = [];
    let gitIdentityPromptCalled = false;
    let listPromptCalled = false;
    const bundle = await buildBundleInteractively({
      repoPath: dir,
      author: [],
      yes: true,
      toolVersion: "0.1.0",
      configDir,
      isTTY: true,
      warn: () => {},
      promptUseSavedSelectionFn: async (authors) => {
        savedPromptedWith = authors;
        return true;
      },
      promptUseGitIdentityFn: async () => {
        gitIdentityPromptCalled = true;
        return true;
      },
      promptAuthorsFn: async () => {
        listPromptCalled = true;
        return [];
      },
    });

    expect(savedPromptedWith).toEqual(["alice@example.com"]);
    expect(gitIdentityPromptCalled).toBe(false);
    expect(listPromptCalled).toBe(false);
    expect(bundle!.commits.user_total).toBe(2);
  });

  it("second run, decline: falls through to today's flow exactly, and the new pick overwrites the store", async () => {
    const dir = repoWithTwoAuthors();
    const configDir = tempConfigDir();

    await buildBundleInteractively({
      repoPath: dir,
      author: [],
      yes: true,
      toolVersion: "0.1.0",
      configDir,
      isTTY: true,
      warn: () => {},
      promptAuthorsFn: async () => ["alice@example.com"],
    });

    let listPromptedWith: string[] = [];
    const bundle = await buildBundleInteractively({
      repoPath: dir,
      author: [],
      yes: true,
      toolVersion: "0.1.0",
      configDir,
      isTTY: true,
      warn: () => {},
      promptUseSavedSelectionFn: async () => false,
      promptAuthorsFn: async (candidates) => {
        listPromptedWith = candidates.map((c) => c.email);
        return ["alice@example.com", "bob@example.com"];
      },
    });

    expect(listPromptedWith.sort()).toEqual(["alice@example.com", "bob@example.com"]);
    expect(bundle!.commits.user_total).toBe(3);

    const stored = JSON.parse(readFileSync(selectionStorePath(configDir), "utf8"));
    const entry = Object.values(stored.selections)[0] as { authors: string[] };
    expect(entry.authors.sort()).toEqual(["alice@example.com", "bob@example.com"]);
  });

  it("stale store (new author appeared since it was saved): skips promptUseSavedSelectionFn, calls promptAuthorsFn with the stored emails as preselected", async () => {
    const dir = repoWithTwoAuthors();
    const configDir = tempConfigDir();

    await buildBundleInteractively({
      repoPath: dir,
      author: [],
      yes: true,
      toolVersion: "0.1.0",
      configDir,
      isTTY: true,
      warn: () => {},
      promptAuthorsFn: async () => ["alice@example.com"],
    });

    // A new author joins the history — the stored author-list hash no
    // longer matches.
    commit(dir, { message: "c1", authorName: "Carol", authorEmail: "carol@example.com", files: { "c.ts": "1\n" } });

    let savedPromptCalled = false;
    let gitIdentityPromptCalled = false;
    let promptAuthorsPreselected: string[] | undefined;
    await buildBundleInteractively({
      repoPath: dir,
      author: [],
      yes: true,
      toolVersion: "0.1.0",
      configDir,
      isTTY: true,
      warn: () => {},
      promptUseSavedSelectionFn: async () => {
        savedPromptCalled = true;
        return true;
      },
      promptUseGitIdentityFn: async () => {
        gitIdentityPromptCalled = true;
        return true;
      },
      promptAuthorsFn: async (_candidates, preselected) => {
        promptAuthorsPreselected = preselected;
        return ["alice@example.com"];
      },
    });

    expect(savedPromptCalled).toBe(false);
    expect(gitIdentityPromptCalled).toBe(false);
    expect(promptAuthorsPreselected).toEqual(["alice@example.com"]);
  });

  it("non-TTY, matching store: no prompt calls, single stderr notice, and stdout JSON deep-equal (modulo timestamps) to the same run via --author", async () => {
    const dir = repoWithTwoAuthors();
    const configDir = tempConfigDir();

    await buildBundleInteractively({
      repoPath: dir,
      author: [],
      yes: true,
      toolVersion: "0.1.0",
      configDir,
      isTTY: true,
      warn: () => {},
      promptAuthorsFn: async () => ["alice@example.com"],
    });

    const warnings: string[] = [];
    const bundleFromStore = await buildBundleInteractively({
      repoPath: dir,
      author: [],
      yes: true,
      toolVersion: "0.1.0",
      configDir,
      // isTTY omitted -> non-interactive
      warn: (m) => warnings.push(m),
      promptUseSavedSelectionFn: async () => {
        throw new Error("must not be called in non-interactive mode");
      },
      promptAuthorsFn: async () => {
        throw new Error("must not be called when the stored selection matches");
      },
      promptUseGitIdentityFn: async () => {
        throw new Error("must not be called when the stored selection matches");
      },
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toBe(
      "Using saved identity selection: alice@example.com (docs/identity-selection-memory.md)."
    );

    // Same configDir (and therefore the same on-disk salt) as the
    // stored-selection run above — the salt is what makes
    // author_identity_hashes/repo_fingerprint comparable at all.
    const bundleFromAuthorFlag = await buildBundleInteractively({
      repoPath: dir,
      author: ["alice@example.com"],
      yes: true,
      toolVersion: "0.1.0",
      configDir,
      warn: () => {},
    });

    expect(normalizeForComparison(bundleFromStore!)).toEqual(normalizeForComparison(bundleFromAuthorFlag!));
  });

  it("non-TTY, stale store: throws the existing named-flags error, exactly as if no store existed", async () => {
    const dir = repoWithTwoAuthors();
    const configDir = tempConfigDir();

    await buildBundleInteractively({
      repoPath: dir,
      author: [],
      yes: true,
      toolVersion: "0.1.0",
      configDir,
      isTTY: true,
      warn: () => {},
      promptAuthorsFn: async () => ["alice@example.com"],
    });

    commit(dir, { message: "c1", authorName: "Carol", authorEmail: "carol@example.com", files: { "c.ts": "1\n" } });

    // Simulates the real promptAuthors' EOF-throw (test/prompt.test.ts pins
    // that behavior directly against a closed stream) — the point here is
    // that a stale store falls through to the exact same call the pre-
    // existing non-interactive flow always made, not a re-implementation of
    // readline's own EOF handling.
    await expect(
      buildBundleInteractively({
        repoPath: dir,
        author: [],
        yes: true,
        toolVersion: "0.1.0",
        configDir,
        warn: () => {},
        promptAuthorsFn: async () => {
          throw new ScanError(
            "Input closed before an author identity was selected. Use --author <email> and --yes for non-interactive runs."
          );
        },
      })
    ).rejects.toThrow(ScanError);
  });

  it("--author flag: never reads or writes the store", async () => {
    const dir = repoWithTwoAuthors();
    const configDir = tempConfigDir();

    await buildBundleInteractively({
      repoPath: dir,
      author: ["alice@example.com"],
      yes: true,
      toolVersion: "0.1.0",
      configDir,
      isTTY: true,
      warn: () => {},
    });

    expect(existsSync(selectionStorePath(configDir))).toBe(false);
  });
});
