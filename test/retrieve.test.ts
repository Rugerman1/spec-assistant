import { describe, expect, it } from "vitest";
import { embedText, ftsQuery, rrf, sectionRefs } from "../src/retrieve";
import { isChunk } from "../src/load";

describe("sectionRefs", () => {
  it("finds dotted section numbers", () => {
    expect(sectionRefs("What does 701.2.4 require?")).toEqual(["701.2.4"]);
  });
  it("finds bare sections only after the word Section", () => {
    expect(sectionRefs("What does Section 105 cover?")).toEqual(["105"]);
    expect(sectionRefs("Can I pour at 100 degrees with a 3/4 inch sieve?")).toEqual([]);
  });
});

describe("ftsQuery", () => {
  it("keeps meaningful words and quotes them", () => {
    expect(ftsQuery("What is the maximum slump for Class 4000 concrete?")).toBe(
      '"maximum" OR "slump" OR "class" OR "4000" OR "concrete"',
    );
  });
  it("can't be broken by FTS syntax in the question", () => {
    expect(ftsQuery('slump" OR NEAR(* -')).toBe('"slump" OR "near"');
  });
  it("returns null when nothing is searchable", () => {
    expect(ftsQuery("what is the?")).toBeNull();
  });
});

describe("rrf", () => {
  it("rewards ids that both searches agree on", () => {
    const scores = rrf([["a", "b", "c"], ["c", "d"]]);
    const ranked = [...scores.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id);
    expect(ranked[0]).toBe("c");
    expect(ranked).toHaveLength(4);
  });
});

describe("embedText", () => {
  it("puts the breadcrumb first and stays under the embedding limit", () => {
    const t = embedText({ path: "Section 901 > 901.2 Water", text: "x".repeat(5000) });
    expect(t.startsWith("Section 901 > 901.2 Water\n")).toBe(true);
    expect(t.length).toBeLessThanOrEqual(1800);
  });
});

describe("isChunk", () => {
  const good = {
    id: "901.2.1", section: "901.2.1", title: "Water", section_no: "901", section_title: "Sample",
    division: "900", division_title: "Sample", path: "p", page_start: 2, page_end: 2,
    page_label: "900-1", edition: "2025", text: "t",
  };
  it("accepts what extract.py writes", () => expect(isChunk(good)).toBe(true));
  it("rejects missing fields", () => expect(isChunk({ ...good, edition: undefined })).toBe(false));
});
