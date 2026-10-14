/**
 * Regression tests for findContextForPath segment-boundary matching.
 *
 * Context key "/202" must not apply to "/2024/a.md" (bare startsWith
 * matched across the segment boundary). A candidate prefix matches only
 * when it equals the path or the path continues with "/".
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  setConfigSource,
  findContextForPath,
} from "../src/collections.ts";

beforeEach(() => {
  setConfigSource({
    config: {
      collections: {
        c: {
          path: "/tmp/qmd-ctx-test",
          pattern: "**/*.md",
          context: {
            "/": "CTX-ROOT",
            "/202": "CTX-202",
            "/2024": "CTX-2024",
          },
        },
      },
    },
  });
});

afterEach(() => {
  setConfigSource();
});

describe("findContextForPath segment boundary", () => {
  test("prefix does not match across a segment boundary", () => {
    // "/202" must not win for "/2024/a.md"; longest in-segment match is "/2024"
    expect(findContextForPath("c", "/2024/a.md")).toBe("CTX-2024");
  });

  test("prefix without any in-segment rival falls back, not cross-segment", () => {
    setConfigSource({
      config: {
        collections: {
          solo: {
            path: "/tmp/qmd-ctx-test",
            pattern: "**/*.md",
            context: { "/202": "CTX-202" },
          },
        },
      },
    });
    // "/202" must not apply to "/2024/a.md" at all
    expect(findContextForPath("solo", "/2024/a.md")).toBeUndefined();
  });

  test("exact path and child path still match", () => {
    expect(findContextForPath("c", "/202")).toBe("CTX-202");
    expect(findContextForPath("c", "/202/a.md")).toBe("CTX-202");
  });

  test("root prefix matches everything", () => {
    expect(findContextForPath("c", "/other/a.md")).toBe("CTX-ROOT");
  });

  test("trailing-slash prefix behaves as its segment", () => {
    setConfigSource({
      config: {
        collections: {
          slash: {
            path: "/tmp/qmd-ctx-test",
            pattern: "**/*.md",
            context: { "/202/": "CTX-202" },
          },
        },
      },
    });
    expect(findContextForPath("slash", "/202/a.md")).toBe("CTX-202");
    expect(findContextForPath("slash", "/202")).toBe("CTX-202");
    expect(findContextForPath("slash", "/2024/a.md")).toBeUndefined();
  });
});
