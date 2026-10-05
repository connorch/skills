import { describe, expect, it } from "vite-plus/test";
import { renderCandidatesPage } from "./candidates.ts";

describe("renderCandidatesPage", () => {
  it("numbers every candidate, escapes text, and flags NC licences", () => {
    const html = renderCandidatesPage('cable "clip"', [
      {
        site: "makerworld",
        title: "A <b>clamp</b>",
        url: "https://makerworld.com/en/models/1",
        author: "Cat",
        license: "Standard Digital File License",
        downloads: 58943,
        likes: 21585,
        thumbnail: "https://x/1.jpg",
      },
      {
        site: "printables",
        title: "Klamma",
        url: "https://www.printables.com/model/2",
        author: "FH",
        license: "CC-BY-NC-SA",
        downloads: 950,
        likes: 12,
        thumbnail: null,
      },
    ]);
    expect(html).toContain("cable &quot;clip&quot; · Candidates");
    expect(html).toContain('<span class="n">1</span>');
    expect(html).toContain('<span class="n">2</span>');
    expect(html).toContain("A &lt;b&gt;clamp&lt;/b&gt;");
    expect(html).toContain("↓ 59k");
    expect(html).toContain("↓ 950");
    expect(html).toContain('<span class="nc">CC-BY-NC-SA</span>');
    expect(html).toContain("<span>Std</span>");
    expect(html).toContain('class="noimg"');
    expect(html).toContain("2 candidates · MakerWorld + Printables");
  });
});
