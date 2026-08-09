import { describe, expect, it } from "vitest";

import {
  DEFAULT_ARCHIVE_TTL_SECONDS,
  DEFAULT_CACHE_CONTROL,
  isArchiveAllowed,
  loadConfig,
} from "./config";
import type { Config, Env } from "./types";

const env = (overrides: Partial<Env> = {}): Env =>
  ({ BUCKET: {} as R2Bucket, ...overrides }) as Env;

const config = (overrides: Partial<Config> = {}): Config => ({
  ...loadConfig(env()),
  ...overrides,
});

describe("loadConfig", () => {
  it("applies defaults when nothing is set", () => {
    const c = loadConfig(env());
    expect(c.cacheControl).toBe(DEFAULT_CACHE_CONTROL);
    expect(c.allowedArchives).toEqual([]);
    expect(c.archiveTtlMs).toBe(DEFAULT_ARCHIVE_TTL_SECONDS * 1000);
    expect(c.corsOrigin).toBe("*");
  });

  it("parses the archive allowlist, trimming blanks", () => {
    const c = loadConfig(env({ ALLOWED_ARCHIVES: " a , b ,, c " }));
    expect(c.allowedArchives).toEqual(["a", "b", "c"]);
  });

  it("converts the TTL to milliseconds", () => {
    expect(loadConfig(env({ ARCHIVE_TTL_SECONDS: "30" })).archiveTtlMs).toBe(30_000);
  });

  it("falls back to the default TTL when unparseable", () => {
    expect(loadConfig(env({ ARCHIVE_TTL_SECONDS: "nonsense" })).archiveTtlMs).toBe(
      DEFAULT_ARCHIVE_TTL_SECONDS * 1000,
    );
  });
});

describe("isArchiveAllowed", () => {
  it("allows anything in the bucket when the allowlist is empty", () => {
    expect(isArchiveAllowed(config({ allowedArchives: [] }), "anything.v1")).toBe(true);
  });

  it("enforces a non-empty allowlist", () => {
    const c = config({ allowedArchives: ["squiggly.v1.base"] });
    expect(isArchiveAllowed(c, "squiggly.v1.base")).toBe(true);
    expect(isArchiveAllowed(c, "squiggly.v1.contours")).toBe(false);
  });

  // The character check is the security-relevant half — it must hold even when
  // the allowlist is empty and would otherwise wave everything through.
  it("rejects traversal and path separators regardless of allowlist", () => {
    const c = config({ allowedArchives: [] });
    for (const bad of ["..", "../secrets", "a/../b", "a/b", ".hidden", "-leading", ""]) {
      expect(isArchiveAllowed(c, bad), bad).toBe(false);
    }
  });

  it("accepts the naming scheme actually in use", () => {
    const c = config({ allowedArchives: [] });
    for (const good of ["squiggly.v1.base", "squiggly.v1.base-test", "a", "A0._-"]) {
      expect(isArchiveAllowed(c, good), good).toBe(true);
    }
  });
});
