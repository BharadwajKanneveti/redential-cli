import { describe, expect, it } from "vitest";
import { isNodeVersionSupported, parseNodeMajorVersion, MIN_SUPPORTED_NODE_MAJOR } from "../src/node-version.js";

describe("parseNodeMajorVersion", () => {
  it("parses process.version's own 'v'-prefixed shape", () => {
    expect(parseNodeMajorVersion("v20.11.0")).toBe(20);
  });

  it("parses a bare version string with no 'v' prefix", () => {
    expect(parseNodeMajorVersion("18.19.0")).toBe(18);
  });

  it("returns NaN for an unrecognizable string", () => {
    expect(parseNodeMajorVersion("not-a-version")).toBeNaN();
  });
});

describe("isNodeVersionSupported", () => {
  it("rejects v16.20.0", () => {
    expect(isNodeVersionSupported("v16.20.0")).toBe(false);
  });

  it("rejects v18.19.0", () => {
    expect(isNodeVersionSupported("v18.19.0")).toBe(false);
  });

  it("accepts v20.0.0", () => {
    expect(isNodeVersionSupported("v20.0.0")).toBe(true);
  });

  it("accepts v22.1.0", () => {
    expect(isNodeVersionSupported("v22.1.0")).toBe(true);
  });

  it("matches MIN_SUPPORTED_NODE_MAJOR exactly", () => {
    expect(isNodeVersionSupported(`v${MIN_SUPPORTED_NODE_MAJOR}.0.0`)).toBe(true);
    expect(isNodeVersionSupported(`v${MIN_SUPPORTED_NODE_MAJOR - 1}.99.99`)).toBe(false);
  });
});
