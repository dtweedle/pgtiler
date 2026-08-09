import { describe, expect, it } from "vitest";

import { FakeClock, FakeObjectStore } from "../test-support/fake-object-store";
import { ArchiveStore } from "./archive-store";

const KEY = "base.pmtiles";
const bytes = (s: string) => new TextEncoder().encode(s);

function setup(ttlMs = 60_000) {
  const clock = new FakeClock();
  const objects = new FakeObjectStore().put(KEY, bytes("v1 contents"), "etag-1");
  return { clock, objects, store: new ArchiveStore(objects, ttlMs, clock) };
}

describe("ArchiveStore.getEtag", () => {
  it("returns the object's ETag", async () => {
    const { store } = setup();
    expect(await store.getEtag("base")).toBe("etag-1");
  });

  it("returns null for an archive that isn't in the bucket", async () => {
    const { store } = setup();
    expect(await store.getEtag("missing")).toBeNull();
  });

  it("memoises within the TTL, so a re-upload is not seen immediately", async () => {
    const { store, objects, clock } = setup(60_000);
    expect(await store.getEtag("base")).toBe("etag-1");

    objects.replace(KEY, bytes("v2 contents"), "etag-2");
    clock.advance(59_000);

    expect(await store.getEtag("base")).toBe("etag-1");
  });

  it("re-reads once the TTL expires", async () => {
    const { store, objects, clock } = setup(60_000);
    await store.getEtag("base");

    objects.replace(KEY, bytes("v2 contents"), "etag-2");
    clock.advance(60_001);

    expect(await store.getEtag("base")).toBe("etag-2");
  });

  it("forgets an archive that has been deleted", async () => {
    const { store, objects, clock } = setup(1_000);
    await store.getEtag("base");

    objects.delete(KEY);
    clock.advance(1_001);

    expect(await store.getEtag("base")).toBeNull();
  });

  // Two stores must not share memoised state — this is what module-level
  // globals used to prevent.
  it("keeps memoisation per instance", async () => {
    const { objects, clock } = setup();
    const a = new ArchiveStore(objects, 60_000, clock);
    const b = new ArchiveStore(objects, 60_000, clock);

    expect(await a.getEtag("base")).toBe("etag-1");
    objects.replace(KEY, bytes("v2"), "etag-2");

    expect(await a.getEtag("base")).toBe("etag-1");
    expect(await b.getEtag("base")).toBe("etag-2");
  });
});

describe("ArchiveStore.list", () => {
  it("strips the suffix and ignores non-archives", async () => {
    const objects = new FakeObjectStore()
      .put("b.pmtiles", bytes("x"), "e1")
      .put("a.pmtiles", bytes("x"), "e2")
      .put("notes.txt", bytes("x"), "e3");

    expect(await new ArchiveStore(objects, 1000).list()).toEqual(["a", "b"]);
  });
});

describe("ArchiveStore.open", () => {
  it("returns null when the archive is absent", async () => {
    const { store } = setup();
    expect(await store.open("missing")).toBeNull();
  });
});
