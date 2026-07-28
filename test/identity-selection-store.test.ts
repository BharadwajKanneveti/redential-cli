import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup } from "./support/fixtures.js";
import {
  computeAuthorListHash,
  readIdentitySelection,
  saveIdentitySelection,
} from "../src/identity-selection-store.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) cleanup(dirs.pop()!);
});

function tempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "redential-config-"));
  dirs.push(dir);
  return dir;
}

describe("computeAuthorListHash", () => {
  it("is stable regardless of input order and duplicates", () => {
    const a = computeAuthorListHash(["b@example.com", "a@example.com"]);
    const b = computeAuthorListHash(["a@example.com", "b@example.com", "a@example.com"]);
    expect(a).toBe(b);
  });

  it("returns a 64-char hex sha256 digest", () => {
    const hash = computeAuthorListHash(["a@example.com"]);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("readIdentitySelection", () => {
  it("returns null when the file doesn't exist", () => {
    const configDir = tempConfigDir();
    expect(readIdentitySelection("fp-1", configDir)).toBeNull();
  });

  it("returns null when the file exists but has no entry for this fingerprint", () => {
    const configDir = tempConfigDir();
    saveIdentitySelection("fp-other", ["a@example.com"], computeAuthorListHash(["a@example.com"]), configDir);
    expect(readIdentitySelection("fp-1", configDir)).toBeNull();
  });

  it("returns null (never throws) on a corrupt JSON file", () => {
    const configDir = tempConfigDir();
    writeFileSync(join(configDir, "identity-selections.json"), "{ not valid json", { mode: 0o600 });
    expect(() => readIdentitySelection("fp-1", configDir)).not.toThrow();
    expect(readIdentitySelection("fp-1", configDir)).toBeNull();
  });

  it("returns null on a wrongly-shaped entry (e.g. authors not an array)", () => {
    const configDir = tempConfigDir();
    const badFile = {
      version: 1,
      selections: {
        "fp-1": { authors: "not-an-array", author_list_hash: "abc", updated_at: "2026-01-01T00:00:00.000Z" },
      },
    };
    writeFileSync(join(configDir, "identity-selections.json"), JSON.stringify(badFile), { mode: 0o600 });
    expect(readIdentitySelection("fp-1", configDir)).toBeNull();
  });
});

describe("saveIdentitySelection / readIdentitySelection roundtrip", () => {
  it("saves and reads back the same selection", () => {
    const configDir = tempConfigDir();
    const hash = computeAuthorListHash(["a@example.com", "b@example.com"]);
    saveIdentitySelection("fp-1", ["a@example.com", "b@example.com"], hash, configDir);

    const stored = readIdentitySelection("fp-1", configDir);
    expect(stored).not.toBeNull();
    expect(stored!.authors).toEqual(["a@example.com", "b@example.com"]);
    expect(stored!.author_list_hash).toBe(hash);
    expect(typeof stored!.updated_at).toBe("string");
    expect(() => new Date(stored!.updated_at).toISOString()).not.toThrow();
  });

  it("merges into the store, preserving other fingerprints' entries", () => {
    const configDir = tempConfigDir();
    const hashA = computeAuthorListHash(["a@example.com"]);
    const hashB = computeAuthorListHash(["b@example.com"]);
    saveIdentitySelection("fp-a", ["a@example.com"], hashA, configDir);
    saveIdentitySelection("fp-b", ["b@example.com"], hashB, configDir);

    expect(readIdentitySelection("fp-a", configDir)!.authors).toEqual(["a@example.com"]);
    expect(readIdentitySelection("fp-b", configDir)!.authors).toEqual(["b@example.com"]);
  });

  it("tolerates a corrupt existing file by starting fresh instead of throwing", () => {
    const configDir = tempConfigDir();
    writeFileSync(join(configDir, "identity-selections.json"), "{ not valid json", { mode: 0o600 });

    const hash = computeAuthorListHash(["a@example.com"]);
    expect(() => saveIdentitySelection("fp-1", ["a@example.com"], hash, configDir)).not.toThrow();

    const stored = readIdentitySelection("fp-1", configDir);
    expect(stored!.authors).toEqual(["a@example.com"]);
  });

  it("writes the file with 0600 permissions", () => {
    if (process.platform === "win32") return;
    const configDir = tempConfigDir();
    saveIdentitySelection("fp-1", ["a@example.com"], computeAuthorListHash(["a@example.com"]), configDir);

    const path = join(configDir, "identity-selections.json");
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("lands only in the injected configDir, nowhere else", () => {
    const configDir = tempConfigDir();
    saveIdentitySelection("fp-1", ["a@example.com"], computeAuthorListHash(["a@example.com"]), configDir);

    const entries = readdirSync(configDir);
    expect(entries).toEqual(["identity-selections.json"]);
    const contents = readFileSync(join(configDir, "identity-selections.json"), "utf8");
    const parsed = JSON.parse(contents);
    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed.selections)).toEqual(["fp-1"]);
  });
});
