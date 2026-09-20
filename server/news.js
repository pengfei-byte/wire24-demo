const FETCH_MS = 9000;
const CACHE_MS = 90_000;
const UA = "Wire24/1.0 (newsroom demo; +https://popvid.ai)";

const SOURCES = [
  {
    id: "bbc-world",
    category: "politics",
    source: "BBC",
    url: "https://feeds.bbci.co.uk/news/world/rss.xml",
  },
  {
    id: "bbc-politics",
    category: "politics",
    source: "BBC",
    url: "https://feeds.bbci.co.uk/news/politics/rss.xml",
  },
  {
    id: "npr-politics",
    category: "politics",
    source: "NPR",
    url: "https://feeds.npr.org/1014/rss.xml",
  },
  {
    id: "npr-world",
    category: "politics",
    source: "NPR",
    url: "https://feeds.npr.org/1004/rss.xml",
  },
  {
    id: "guardian-world",
    category: "politics",
    source: "The Guardian",
    url: "https://www.theguardian.com/world/rss",
  },
  {
    id: "bbc-business",
    category: "business",
    source: "BBC",
    url: "https://feeds.bbci.co.uk/news/business/rss.xml",
  },
  {
    id: "npr-business",
    category: "business",
    source: "NPR",
    url: "https://feeds.npr.org/1006/rss.xml",
  },
  {
    id: "guardian-business",
    category: "business",
    source: "The Guardian",
    url: "https://www.theguardian.com/uk/business/rss",
  },
  {
    id: "marketwatch",
    category: "finance",
    source: "MarketWatch",
    url: "https://feeds.content.dowjones.io/public/rss/mw_topstories",
  },
  {
    id: "npr-economy",
    category: "finance",
    source: "NPR",
    url: "https://feeds.npr.org/1017/rss.xml",
  },
  {
    id: "guardian-business-finance",
    category: "finance",
    source: "The Guardian",
    url: "https://www.theguardian.com/business/economics/rss",
  },
  {
    id: "bbc-ent",
    category: "entertainment",
    source: "BBC",
    url: "https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml",
  },
  {
    id: "npr-arts",
    category: "entertainment",
    source: "NPR",
    url: "https://feeds.npr.org/1008/rss.xml",
  },
  {
    id: "guardian-culture",
    category: "entertainment",
    source: "The Guardian",
    url: "https://www.theguardian.com/uk/culture/rss",
  },
  {
    id: "gnews-world",
    category: "politics",
    source: "Google News",
    url: "https://news.google.com/rss/headlines/section/topic/WORLD?hl=en-US&gl=US&ceid=US:en",
  },
  {
    id: "gnews-business",
    category: "business",
    source: "Google News",
    url: "https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-US&gl=US&ceid=US:en",
  },
  {
    id: "gnews-ent",
    category: "entertainment",
    source: "Google News",
    url: "https://news.google.com/rss/headlines/section/topic/ENTERTAINMENT?hl=en-US&gl=US&ceid=US:en",
  },
];

const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

const CATEGORY_LABEL = {
  politics: "Politics",
  business: "Business",
  finance: "Finance",
  entertainment: "Entertainment",
};

let cache = { at: 0, briefing: null };

export function decodeEntities(input) {
  let text = String(input || "");
  for (let i = 0; i < 3; i += 1) {
    const next = text
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/g, (_, token) => {
        if (token[0] === "#") {
          const hex = token[1] === "x" || token[1] === "X";
          const code = hex ? parseInt(token.slice(2), 16) : parseInt(token.slice(1), 10);
          return Number.isFinite(code) ? String.fromCodePoint(code) : "";
        }
        return ENTITIES[token] || "";
      });
    if (next === text) break;
    text = next;
  }
  return text;
}

export function stripTags(input) {
  return decodeEntities(input)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tagText(block, tag) {
  const cdata = block.match(
    new RegExp(`<${tag}(?:\\s[^>]*)?>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, "i")
  );
  if (cdata) return decodeEntities(cdata[1]).trim();
  const plain = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  if (plain) return stripTags(plain[1]);
  return "";
}

const SKIP_TITLE = /\|\s*letters$/i;

export function recategorize(item) {
  const text = `${item.title} ${item.summary}`;
  if (/fashion week|film|movie|music|album|concert|actor|actress|singer|celebrity|oscar|grammy|netflix|harry and meghan|starmer models|spongebob|starbucks/i.test(text)) {
    return { ...item, category: "entertainment" };
  }
  if (/\b(fed|ecb|interest rate|inflation|stock market|nasdaq|s&p|bond yield|wall street|oil price|rental property|mortgage)\b/i.test(text)) {
    return { ...item, category: "finance" };
  }
  if (/\b(merger|antitrust|ceo|regulator|workers|supply chain|shareholders|four-day workweek|jobs)\b/i.test(text) && item.category === "politics") {
    return { ...item, category: "business" };
  }
  return item;
}

export function parseRss(xml, meta) {
  const items = [];
  const blocks = String(xml || "").match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) || [];
  for (const raw of blocks) {
    const title = tagText(raw, "title");
    if (!title || SKIP_TITLE.test(title)) continue;
    const description = tagText(raw, "description");
    const link = tagText(raw, "link") || tagText(raw, "guid");
    const pubDate = tagText(raw, "pubDate") || tagText(raw, "dc:date");
    const origin = tagText(raw, "source") || meta.source;
    const publishedAt = Date.parse(pubDate) || 0;
    items.push(
      recategorize({
        title: cleanTitle(title, origin),
        summary: cleanSummary(description, title),
        link,
        source: origin || meta.source,
        category: meta.category,
        published_at: publishedAt,
        feed: meta.id,
      })
    );
  }
  return items;
}

export function cleanTitle(title, source) {
  let text = stripTags(title);
  const suffixes = [
    " - BBC News",
    " | The Guardian",
    " | Guardian",
    " - NPR",
    " - MarketWatch",
    " - Google News",
  ];
  for (const suffix of suffixes) {
    if (text.endsWith(suffix)) text = text.slice(0, -suffix.length);
  }
  if (source && text.endsWith(` - ${source}`)) {
    text = text.slice(0, -(source.length + 3));
  }
  return text.trim();
}

export function cleanSummary(description, title) {
  let text = stripTags(description);
  if (!text || text.length < 24) return stripTags(title);
  if (/google news/i.test(text) && text.length > 180) {
    const first = text.split(/(?<=\.)\s/)[0];
    if (first && first.length > 20 && first.length < 220) return first;
  }
  if (text.length > 280) text = `${text.slice(0, 277).replace(/\s+\S*$/, "")}…`;
  return text;
}

export function formatAgo(ms, now = Date.now()) {
  if (!ms) return "just now";
  const delta = Math.max(0, now - ms);
  const mins = Math.round(delta / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function normalizeKey(title) {
  return stripTags(title)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .trim();
}

export function pickStories(all, now = Date.now()) {
  const seen = new Set();
  const buckets = {
    politics: [],
    business: [],
    finance: [],
    entertainment: [],
  };
  const ranked = [...all].sort((a, b) => (b.published_at || 0) - (a.published_at || 0));
  for (const item of ranked) {
    const key = normalizeKey(item.title);
    if (!key || seen.has(key)) continue;
    if (!buckets[item.category]) continue;
    seen.add(key);
    buckets[item.category].push(item);
  }

  const quotas = { politics: 4, business: 4, finance: 4, entertainment: 4 };
  const picked = [];
  for (const category of Object.keys(quotas)) {
    picked.push(...buckets[category].slice(0, quotas[category]));
  }
  picked.sort((a, b) => (b.published_at || 0) - (a.published_at || 0));

  const order = ["politics", "business", "finance", "entertainment"];
  const sequenced = [];
  const leftover = [...picked];
  while (leftover.length) {
    for (const category of order) {
      const idx = leftover.findIndex((item) => item.category === category);
      if (idx >= 0) sequenced.push(leftover.splice(idx, 1)[0]);
    }
  }

  return sequenced.slice(0, 12).map((item, index) => ({
    id: `story_${index + 1}`,
    category: item.category,
    category_label: CATEGORY_LABEL[item.category],
    title: item.title,
    summary: item.summary,
    source: item.source,
    link: item.link,
    published_at: item.published_at,
    ago: formatAgo(item.published_at, now),
  }));
}

export const MAX_CUE_CHARS = 1850;

function directorWrap(body) {
  return `[DIRECTOR — silent]
Live. Dead air forbidden. First word now. No questions. No wait. No re-greeting.
${body}`.trim();
}

function storyLine(story, n) {
  return `${n}. [${story.category_label}] ${story.title}. ${story.summary} (${story.source}, ${story.ago})`;
}

function renderCue(group, first) {
  const lines = group.map((story, n) => storyLine(story, n + 1)).join("\n");
  const lead = first
    ? 'Hot camera. One short open: "You\'re watching WIRE 24. I\'m Elena Voss." Then story 1 with no pause.'
    : "Already on air. Do not greet. Next story in the same breath.";
  return directorWrap(`
${lead}
Read every story below back-to-back. Only a breath between them. Do not stop until the last line.
${lines}
Natural English. Facts only from the lines above. Keep talking.
`);
}

function cueRecord(group, index, cue) {
  return {
    id: `block_${index}`,
    kind: "story",
    category: group[0].category,
    category_label: group[0].category_label,
    title: group[0].title,
    summary: group[0].summary,
    source: group[0].source,
    ago: group[0].ago,
    story_ids: group.map((story) => story.id),
    cue,
  };
}

export function buildCues(stories) {
  if (!stories.length) return [];
  const cues = [];
  let i = 0;
  while (i < stories.length) {
    const first = cues.length === 0;
    const group = [stories[i]];
    i += 1;
    while (i < stories.length) {
      const trial = [...group, stories[i]];
      if (renderCue(trial, first).length > MAX_CUE_CHARS) break;
      group.push(stories[i]);
      i += 1;
    }
    let cue = renderCue(group, first);
    if (cue.length > 2000 && group.length === 1) {
      const trimmed = {
        ...group[0],
        summary: group[0].summary.slice(0, 180).replace(/\s+\S*$/, ""),
      };
      cue = renderCue([trimmed], first).slice(0, 2000);
    }
    cues.push(cueRecord(group, cues.length + 1, cue));
  }
  return cues;
}

export function closingCue() {
  return {
    id: "close",
    kind: "close",
    category: "politics",
    category_label: "Close",
    title: "That's the hour",
    summary: "Thanks for watching WIRE 24.",
    source: "WIRE 24",
    ago: "now",
    story_ids: [],
    cue: directorWrap(`
Keep talking. Two short lines: thank the viewer for watching WIRE 24, then say the wires are still moving. No question. No pause.
`),
  };
}

export function keepRollingCue() {
  return {
    id: "fill",
    kind: "story",
    category: "politics",
    category_label: "Politics",
    title: "WIRE 24 still rolling",
    summary: "The hour continues with politics, markets, and culture.",
    source: "WIRE 24",
    ago: "now",
    story_ids: [],
    cue: directorWrap(`
Do not go silent. Immediately keep the hour moving: you are still with WIRE 24 rolling news. Recap that politics, business, markets, and entertainment are all live this hour, name that the wires are still updating, and stay on camera talking until this copy is done. No questions. No pause. No holding look.
`),
  };
}

const FALLBACK = [
  {
    category: "politics",
    title: "Governments keep watching regional conflicts and diplomatic talks",
    summary: "Weekend contacts continued as parties urged de-escalation and waited for the next public statement.",
    source: "WIRE 24 desk",
  },
  {
    category: "business",
    title: "Companies keep adjusting supply chains and regulatory strategy",
    summary: "Technology and retail groups answered cost and compliance pressure this week as markets waited for fresh guidance.",
    source: "WIRE 24 desk",
  },
  {
    category: "finance",
    title: "Investors wait on rates and risk assets",
    summary: "Major indexes traded cautiously into the weekend, with attention on inflation data and central-bank language.",
    source: "WIRE 24 desk",
  },
  {
    category: "entertainment",
    title: "New releases and tour dates keep landing",
    summary: "Music, film, and publishing desks circulated fresh schedules and titles over the weekend.",
    source: "WIRE 24 desk",
  },
];

export function assembleBriefing(items, now = Date.now()) {
  const stories = items.length
    ? pickStories(items, now)
    : FALLBACK.map((item, index) => ({
        id: `story_${index + 1}`,
        category: item.category,
        category_label: CATEGORY_LABEL[item.category],
        title: item.title,
        summary: item.summary,
        source: item.source,
        link: "",
        published_at: now,
        ago: "just now",
      }));
  const cues = buildCues(stories);
  return {
    generated_at: now,
    edition: editionName(now),
    stale: items.length === 0,
    sources: [...new Set(stories.map((s) => s.source))],
    items: stories,
    cues,
    filler: keepRollingCue(),
    closing: closingCue(),
  };
}

export function editionName(now = Date.now()) {
  const hour = new Date(now).getHours();
  if (hour < 6) return "Overnight edition";
  if (hour < 12) return "Morning edition";
  if (hour < 18) return "Afternoon edition";
  return "Evening edition";
}

async function fetchFeed(source) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_MS);
  try {
    const res = await fetch(source.url, {
      signal: ctrl.signal,
      headers: {
        Accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
        "User-Agent": UA,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    return parseRss(xml, source);
  } finally {
    clearTimeout(timer);
  }
}

export async function loadBriefing({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.briefing && now - cache.at < CACHE_MS) return cache.briefing;

  const results = await Promise.allSettled(SOURCES.map((source) => fetchFeed(source)));
  const items = [];
  const errors = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") items.push(...result.value);
    else errors.push({ id: SOURCES[index].id, error: String(result.reason?.message || result.reason) });
  });

  const briefing = assembleBriefing(items, now);
  briefing.feed_errors = errors;
  briefing.feed_ok = results.filter((r) => r.status === "fulfilled").length;
  cache = { at: now, briefing };
  return briefing;
}

export function categoryLabel(id) {
  return CATEGORY_LABEL[id] || id;
}
