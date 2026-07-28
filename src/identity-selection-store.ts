import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG_DIR } from "./config.js";

/**
 * Per-repo memory of "which author identities did you pick last time?" —
 * purely a local UX cache so `scan` can offer a fast default instead of
 * re-asking the same question on every run. Never uploaded: nothing in this
 * file crosses the network, and this module doesn't compute the repo
 * fingerprint it's keyed by (the caller — build-bundle.ts — passes it in,
 * already salted per the bundle's own rules).
 */
export interface StoredIdentitySelection {
  authors: string[];
  author_list_hash: string;
  updated_at: string;
}

interface IdentitySelectionFile {
  version: 1;
  selections: Record<string, StoredIdentitySelection>;
}

function identitySelectionsPath(configDir: string = DEFAULT_CONFIG_DIR): string {
  return join(configDir, "identity-selections.json");
}

/**
 * Deliberately plain (unsalted) sha256 — unlike the bundle's own author
 * hashing, this hash never leaves the machine: it only detects whether the
 * repo's author list changed since the last saved selection, so there is no
 * privacy reason to salt it. Sorted + deduped so the hash is stable
 * regardless of git log ordering.
 */
export function computeAuthorListHash(emails: string[]): string {
  const normalized = [...new Set(emails)].sort();
  return createHash("sha256").update(normalized.join("\n")).digest("hex");
}

/** Minimal shape validation — a corrupt or hand-edited entry must never
 * crash `scan`, so anything that doesn't look right is treated as absent. */
function isValidEntry(value: unknown): value is StoredIdentitySelection {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    Array.isArray(entry.authors) &&
    entry.authors.every((a) => typeof a === "string") &&
    typeof entry.author_list_hash === "string" &&
    typeof entry.updated_at === "string"
  );
}

/** Reads the whole store, tolerating a missing, corrupt, or wrongly-shaped
 * file by returning an empty store instead of throwing. */
function readStore(configDir: string): IdentitySelectionFile {
  const path = identitySelectionsPath(configDir);
  if (!existsSync(path)) return { version: 1, selections: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { selections?: unknown }).selections !== "object" ||
      (parsed as { selections?: unknown }).selections === null
    ) {
      return { version: 1, selections: {} };
    }
    return { version: 1, selections: (parsed as IdentitySelectionFile).selections };
  } catch {
    return { version: 1, selections: {} };
  }
}

/** null when the file, the entry for this fingerprint, or the entry's shape
 * is missing/invalid — a corrupt cache must never break `scan`. */
export function readIdentitySelection(
  fingerprint: string,
  configDir: string = DEFAULT_CONFIG_DIR
): StoredIdentitySelection | null {
  const store = readStore(configDir);
  const entry = store.selections[fingerprint];
  return isValidEntry(entry) ? entry : null;
}

/**
 * 0600 — same permission pattern as credentials.ts's session token. `mode`
 * is a no-op on Windows for the same reason documented there (NTFS ACL
 * inheritance is what actually protects this file on that platform); see
 * credentials.ts's saveCredentials for the full explanation.
 */
export function saveIdentitySelection(
  fingerprint: string,
  authors: string[],
  authorListHash: string,
  configDir: string = DEFAULT_CONFIG_DIR
): void {
  const store = readStore(configDir);
  store.selections[fingerprint] = {
    authors,
    author_list_hash: authorListHash,
    updated_at: new Date().toISOString(),
  };
  mkdirSync(configDir, { recursive: true });
  writeFileSync(identitySelectionsPath(configDir), JSON.stringify(store), { mode: 0o600 });
}
