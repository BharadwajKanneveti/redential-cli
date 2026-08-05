// Kept as a standalone module with zero imports of its own — cli.ts's
// startup version gate must be checkable before any other module (which
// may use Node 20+ globals like `fetch`) is even loaded, so this file
// can't depend on anything that itself assumes a modern runtime.

/** The oldest Node.js major version redential supports (matches package.json's `engines.node`). */
export const MIN_SUPPORTED_NODE_MAJOR = 20;

/**
 * Extracts the major version number from a Node.js version string.
 * Accepts both `process.version`'s own shape ("v18.19.0") and a bare
 * "18.19.0", so it's directly unit-testable with either form. Returns NaN
 * for anything unrecognizable, which safely fails `isNodeVersionSupported`'s
 * `>=` comparison rather than throwing.
 */
export function parseNodeMajorVersion(versionString: string): number {
  const match = /^v?(\d+)\./.exec(versionString);
  return match ? parseInt(match[1], 10) : NaN;
}

/** True when `versionString`'s major version meets MIN_SUPPORTED_NODE_MAJOR. */
export function isNodeVersionSupported(versionString: string): boolean {
  return parseNodeMajorVersion(versionString) >= MIN_SUPPORTED_NODE_MAJOR;
}
