import test from "node:test";
import assert from "node:assert/strict";
import {
  parseRss,
  cleanTitle,
  pickStories,
  assembleBriefing,
  MAX_CUE_CHARS,
} from "./news.js";

const BBC = `<?xml version="1.0"?><rss version="2.0"><channel>
<item>
  <title><![CDATA[Largest attack on Moscow sees Ukraine fire hundreds of drones, mayor says]]></title>
  <description><![CDATA[Moscow's mayor says 450 drones were downed during the overnight barrage, in which two people died.]]></description>
  <link>https://www.bbc.co.uk/news/articles/c34gdjk1ne8yo</link>
  <pubDate>Sun, 20 Sep 2026 10:45:39 GMT</pubDate>
</item>
<item>
  <title>Second world headline - BBC News</title>
  <description>&lt;p&gt;Short diplomatic update after weekend talks.&lt;/p&gt;</description>
  <pubDate>Sun, 20 Sep 2026 09:00:00 GMT</pubDate>
</item>
</channel></rss>`;

test("parseRss reads cdata, html, and pubDate", () => {
  const items = parseRss(BBC, { id: "bbc-world", category: "politics", source: "BBC" });
  assert.equal(items.length, 2);
  assert.match(items[0].title, /Moscow/);
  assert.match(items[0].summary, /450 drones/);
  assert.equal(items[0].category, "politics");
  assert.ok(items[0].published_at > 0);
  assert.equal(items[1].title, "Second world headline");
});

test("cleanTitle strips outlet suffixes", () => {
  assert.equal(cleanTitle("Market jumps - BBC News", "BBC"), "Market jumps");
  assert.equal(cleanTitle("Film premiere | The Guardian", "The Guardian"), "Film premiere");
});

test("pickStories rotates categories and dedupes", () => {
  const now = Date.parse("2026-09-20T16:00:00Z");
  const items = [
    { title: "A1", summary: "a", source: "BBC", category: "politics", published_at: now },
    { title: "A1", summary: "dup", source: "NPR", category: "politics", published_at: now - 1 },
    { title: "B1", summary: "b", source: "BBC", category: "business", published_at: now - 2 },
    { title: "F1", summary: "f", source: "MW", category: "finance", published_at: now - 3 },
    { title: "E1", summary: "e", source: "BBC", category: "entertainment", published_at: now - 4 },
    { title: "A2", summary: "a2", source: "NPR", category: "politics", published_at: now - 5 },
  ];
  const picked = pickStories(items, now);
  assert.equal(picked[0].category, "politics");
  assert.equal(picked[1].category, "business");
  assert.equal(picked.map((s) => s.title).filter((t) => t === "A1").length, 1);
  assert.ok(picked.some((s) => s.category_label === "Finance"));
});

test("cues pack stories and stay inside turn.submit length", () => {
  const now = Date.now();
  const items = [];
  const cats = ["politics", "business", "finance", "entertainment"];
  for (let i = 0; i < 12; i += 1) {
    items.push({
      title: `Headline ${i + 1} from the wire desk`,
      summary: "Officials kept the policy rate unchanged and pointed to sticky inflation in the latest note.",
      source: "NPR",
      category: cats[i % 4],
      published_at: now - i * 1000,
    });
  }
  const briefing = assembleBriefing(items, now);
  assert.ok(briefing.cues.length >= 1);
  assert.ok(briefing.cues.length < briefing.items.length);
  assert.notEqual(briefing.cues.at(-1).kind, "close");
  for (const cue of briefing.cues) {
    assert.ok(cue.cue.length <= 2000, cue.cue.length);
    assert.ok(cue.cue.length <= MAX_CUE_CHARS || cue.story_ids.length === 1);
  }
  assert.ok(briefing.cues[0].story_ids.length >= 2);
  assert.match(briefing.cues[0].cue, /Headline 1/);
  assert.match(briefing.cues[0].cue, /Dead air forbidden|back-to-back/i);
});
