import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { NOT_FOUND, parseResponse, toSearchResults } from "../src/answer";
import type { Retrieved } from "../src/types";

// Made-up chunks shaped like the real ones. Not real SCDOT text.
const chunk = (id: string, text: string): Retrieved => ({
  id, section: id, title: "Sample", section_no: id.slice(0, 3), section_title: "Sample Materials",
  division: "900", division_title: "Sample", path: `Section 901 Sample Materials > ${id} Sample`,
  page_start: 3, page_end: 3, page_label: "900-2", edition: "2025", text, score: 1, via: ["vector"],
});
const chunks = [chunk("901.2.1", "Use clean water.\nTest it when asked."), chunk("901.3", "Measure by the cubic yard.")];

const cite = (source: string, cited_text: string) => ({
  type: "search_result_location" as const, source, cited_text, title: null,
  search_result_index: 0, start_block_index: 0, end_block_index: 1,
});

describe("toSearchResults", () => {
  it("makes one search result per chunk, one text block per paragraph", () => {
    const [first] = toSearchResults(chunks);
    expect(first!.source).toBe("901.2.1");
    expect(first!.title).toContain("page 900-2");
    expect(first!.content).toHaveLength(2);
    expect(first!.citations).toEqual({ enabled: true });
  });
});

describe("parseResponse", () => {
  it("numbers sources in the order they are first cited", () => {
    const content = [
      { type: "text", text: "Measure it by the cubic yard", citations: [cite("901.3", "Measure by the cubic yard.")] },
      { type: "text", text: " and use clean water", citations: [cite("901.2.1", "Use clean water."), cite("901.3", "Measure by the cubic yard.")] },
      { type: "text", text: ".", citations: null },
    ] as unknown as Anthropic.Beta.BetaContentBlock[];
    const a = parseResponse(content, chunks, [], "m");
    expect(a.found).toBe(true);
    expect(a.sources.map((s) => s.id)).toEqual(["901.3", "901.2.1"]);
    expect(a.parts[1]!.cites).toEqual([2, 1]);
    expect(a.sources[0]!.quotes).toEqual(["Measure by the cubic yard."]);
  });

  it("treats the not-found phrase as not found", () => {
    const content = [{ type: "text", text: `${NOT_FOUND} The closest section is 901.3.`, citations: null }] as unknown as Anthropic.Beta.BetaContentBlock[];
    expect(parseResponse(content, chunks, [], "m").found).toBe(false);
  });

  it("treats an answer with no citations as not found", () => {
    const content = [{ type: "text", text: "Probably 4 inches.", citations: null }] as unknown as Anthropic.Beta.BetaContentBlock[];
    expect(parseResponse(content, chunks, [], "m").found).toBe(false);
  });

  it("ignores citations to chunks it never sent", () => {
    const content = [{ type: "text", text: "x", citations: [cite("999.9", "?")] }] as unknown as Anthropic.Beta.BetaContentBlock[];
    expect(parseResponse(content, chunks, [], "m").sources).toEqual([]);
  });
});
