import { describe, expect, it } from "vitest";
import {
  adfToPlainText,
  daysBetween,
  daysSince,
  daysUntil,
  extractIssueKey,
  isPastDue,
} from "../src/dateUtils.js";

const NOW = new Date("2026-08-03T00:00:00.000Z");

describe("daysBetween", () => {
  it("floors partial days", () => {
    expect(daysBetween(new Date("2026-08-01T00:00:00Z"), new Date("2026-08-03T23:00:00Z"))).toBe(2);
  });

  it("returns a negative number when `to` precedes `from`", () => {
    expect(daysBetween(new Date("2026-08-03T00:00:00Z"), new Date("2026-08-01T00:00:00Z"))).toBe(-2);
  });
});

describe("daysSince", () => {
  it("computes days from a past date to `now`", () => {
    expect(daysSince("2026-07-30T00:00:00Z", NOW)).toBe(4);
  });

  it("returns 0 for the same day", () => {
    expect(daysSince("2026-08-03T00:00:00Z", NOW)).toBe(0);
  });
});

describe("daysUntil", () => {
  it("is positive for a future date", () => {
    expect(daysUntil("2026-08-10T00:00:00Z", NOW)).toBe(7);
  });

  it("is negative once the date has passed", () => {
    expect(daysUntil("2026-07-30T00:00:00Z", NOW)).toBe(-4);
  });
});

describe("isPastDue", () => {
  it("is false when dueDateStr is null", () => {
    expect(isPastDue(null, NOW)).toBe(false);
  });

  it("is false when dueDateStr is an empty string", () => {
    expect(isPastDue("", NOW)).toBe(false);
  });

  it("is true once the due date is in the past", () => {
    expect(isPastDue("2026-08-01T00:00:00Z", NOW)).toBe(true);
  });

  it("is false when the due date is today or later", () => {
    expect(isPastDue("2026-08-03T00:00:00Z", NOW)).toBe(false);
  });
});

describe("extractIssueKey", () => {
  it("extracts a key matching the project prefix", () => {
    expect(extractIssueKey("Fixes SMA-42 for the login flow", "SMA")).toBe("SMA-42");
  });

  it("returns null when there's no match", () => {
    expect(extractIssueKey("Fixes the login flow", "SMA")).toBeNull();
  });

  it("returns null for null/undefined text without throwing", () => {
    expect(extractIssueKey(null, "SMA")).toBeNull();
    expect(extractIssueKey(undefined, "SMA")).toBeNull();
  });

  it("does not match a different project's key", () => {
    expect(extractIssueKey("Fixes OTHER-42", "SMA")).toBeNull();
  });

  it("does not match when the trailing digits run into another word character", () => {
    // \b requires a transition between a word char and a non-word char; digit-to-letter
    // (1 -> X) is word-to-word, so no boundary exists and the whole match fails.
    expect(extractIssueKey("See SMA-421X for context", "SMA")).toBeNull();
  });
});

describe("adfToPlainText", () => {
  it("returns an empty string for null/non-object input", () => {
    expect(adfToPlainText(null)).toBe("");
    expect(adfToPlainText(undefined)).toBe("");
    expect(adfToPlainText("plain string")).toBe("");
  });

  it("flattens a paragraph of text nodes", () => {
    const adf = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Hello " },
            { type: "text", text: "world" },
          ],
        },
      ],
    };
    expect(adfToPlainText(adf)).toBe("Hello world");
  });

  it("joins multiple paragraphs with newlines and trims trailing whitespace", () => {
    const adf = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "line one" }] },
        { type: "paragraph", content: [{ type: "text", text: "line two" }] },
      ],
    };
    expect(adfToPlainText(adf)).toBe("line one\nline two");
  });
});
