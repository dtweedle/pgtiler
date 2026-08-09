import { describe, expect, it } from "vitest";

import { VERSION_LENGTH } from "../config";
import { versionCode } from "./version";

describe("versionCode", () => {
  it("truncates a single-part MD5 ETag", () => {
    expect(versionCode("d41d8cd98f00b204e9800998ecf8427e")).toBe("d41d8cd98f");
  });

  // Production archives are all multipart, so this is the form that matters.
  it("handles a multipart ETag's part-count suffix", () => {
    expect(versionCode("a3f1c9e40b7d2856f0918ab3cd4e7f21-72")).toBe("a3f1c9e40b");
  });

  it("ignores surrounding quotes", () => {
    expect(versionCode('"d41d8cd98f00b204e9800998ecf8427e"')).toBe("d41d8cd98f");
  });

  it("is stable and URL-safe", () => {
    const code = versionCode("a3f1c9e40b7d2856f0918ab3cd4e7f21-72");
    expect(code).toHaveLength(VERSION_LENGTH);
    expect(code).toMatch(/^[a-z0-9]+$/);
    expect(encodeURIComponent(code)).toBe(code);
  });

  it("changes when the ETag does", () => {
    expect(versionCode("aaaaaaaaaa11")).not.toBe(versionCode("bbbbbbbbbb11"));
  });

  it("is case-insensitive, since ETag hex casing is not guaranteed", () => {
    expect(versionCode("D41D8CD98F00B204")).toBe(versionCode("d41d8cd98f00b204"));
  });
});
