// News aggregator. Runs in GitHub Actions every 15 minutes.
//
// For each row in news.sources (where enabled = true), fetch the
// rss_url, parse with fast-xml-parser, normalize fields, then
// upsert into news.items on (source_id, external_id). The
// dedup conflict-target is unique-indexed, so re-fetching the same
// items is a no-op — only genuinely new items appear in the mobile
// feed.
//
// Behaviors worth knowing:
//   - Per-source items capped at 30 per fetch (most feeds publish
//     5-20, this is just a safety belt against a misbehaving feed).
//   - Items older than 30 days at fetch time are skipped — keeps the
//     table from growing forever and matches our "daily-habit" UX
//     (old news is dead news).
//   - Image URL extracted from (in order): media:content, media:thumbnail,
//     enclosure, image, first <img> in <description>. Hot-linked, not
//     proxied — if the source's CDN dies, the card renders without art.
//   - Summary: <description> with HTML stripped, capped at 400 chars.
//   - Source failures are isolated — one broken feed doesn't kill the
//     batch. Failure rows logged to stderr but exit code stays 0
//     unless ALL sources fail.
//
// Required env vars (GitHub Actions secrets):
//   NEXT_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// Local test:
//   SUPABASE_SERVICE_ROLE_KEY=eyJ... bun run scripts/news-fetch.ts

import { encode as encodeBlurhash } from 'blurhash';
import sharp from 'sharp';

import { createClient } from '@supabase/supabase-js';
import { XMLParser } from 'fast-xml-parser';

type NewsSource = {
  id: string;
  name_ar: string;
  rss_url: string;
};

// Tier 2 source IDs — global/regional Arabic outlets where we keep only
// items mentioning Syria. The cron applies `passesSyriaFilter` to items
// from these sources before upsert. Tier 1 sources (Syrian-focused
// feeds) aren't in this set and pass through unfiltered.
//
// Daraj is NOT here even though it's a regional outlet — it exposes a
// Syria-tagged topic feed, already pre-filtered server-side, so the
// cron just consumes everything it returns.
const SYRIA_FILTERED_SOURCES = new Set([
  'bbc-arabic',
  'aljazeera-ar',
  'sky-news-ar',
  'france24-ar',
  'dw-arabic',
  'anadolu-ar',
  'rt-arabic',
  'asharq-alawsat',
]);

// Substring tokens that mark an item as Syria-relevant. Substring match
// is intentionally loose — Arabic grammar makes word-boundary matching
// unreliable, and 'سوريا' inside 'السورية' or 'سوريون' should still
// count. Trade-off: rare false positives on 'حمص' (Homs the city vs
// chickpeas the food), 'حلب' (Aleppo vs milking). Acceptable noise
// level for news context.
const SYRIA_KEYWORDS = [
  // Country name + adjective forms
  'سوريا',
  'سوري',
  'سورية',
  'السوري',
  'السورية',
  // Major Syrian cities (caught only when named explicitly)
  'دمشق',
  'حلب',
  'حمص',
  'اللاذقية',
  'إدلب',
  'درعا',
  'الرقة',
  'دير الزور',
  'طرطوس',
  'الحسكة',
  'السويداء',
  'القنيطرة',
  'الجولان',
];

function passesSyriaFilter(title: string, summary: string | null): boolean {
  const hay = `${title} ${summary ?? ''}`;
  return SYRIA_KEYWORDS.some((kw) => hay.includes(kw));
}

type NewsItemRow = {
  source_id: string;
  external_id: string;
  title: string;
  summary: string | null;
  url: string;
  image_url: string | null;
  // BlurHash string (~28 bytes) decoded client-side into a blurred
  // placeholder while the real image_url loads. Computed at ingest
  // from a 32px-wide downscale of the source image. Null when the
  // item has no image_url or when the fetch/decode failed.
  // Column added in main repo migration 0080.
  image_blurhash: string | null;
  published_at: string; // ISO
};

const UA =
  'Mozilla/5.0 (compatible; BawabaNewsFetcher/1.0; +https://bawaba.syrially.com)';

const MAX_ITEMS_PER_SOURCE = 30;
const MAX_AGE_DAYS = 30;
const SUMMARY_MAX_LEN = 400;
const REQUEST_TIMEOUT_MS = 15_000;
const OG_FETCH_TIMEOUT_MS = 8_000;
const BLURHASH_FETCH_TIMEOUT_MS = 8_000;
// Max raster bytes we'll pull into memory for BlurHash compute. Most
// news heroes are <1 MB but some sources serve 5+ MB originals. Cap
// guards GitHub Actions memory + run time without changing card UX
// (we only need the rough color blob, full pixels are overkill).
const BLURHASH_MAX_FETCH_BYTES = 2_500_000;
// Downscale size before encoding. BlurHash perceptual quality plateaus
// past ~32px wide — going bigger just costs decode time on mobile.
const BLURHASH_SAMPLE_WIDTH = 32;
const BLURHASH_SAMPLE_HEIGHT = 32;
// 4x3 components is the standard for landscape thumbnails (1024 entries
// in the colorspace, ≈28 chars). Bumping above ~5x4 wastes payload
// bytes without visible quality gain at card sizes.
const BLURHASH_COMPONENTS_X = 4;
const BLURHASH_COMPONENTS_Y = 3;

// Substrings that, when found in a URL pulled from the RSS feed,
// indicate the source served us an advertising/placeholder image
// instead of the article's actual hero. Al Watan's `<content:encoded>`
// contains only `<img src="…/ad_section-1.webp">` — the real article
// image lives on the article page itself. Treat these as "no image"
// and try the og:image fallback.
const AD_PLACEHOLDER_PATTERNS = [
  '/ad_section',
  '/ad-section',
  '/placeholder',
  'masaha-i3laniya',
];

function isAdPlaceholderUrl(url: string | null): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  return AD_PLACEHOLDER_PATTERNS.some((p) => lower.includes(p));
}

// fast-xml-parser config: keep attribute names accessible, but flatten
// to a predictable shape. Some RSS feeds wrap text in CDATA, some don't —
// the parser handles both transparently.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  processEntities: true,
  trimValues: true,
  // Some feeds put commas in numbers; we don't want type coercion on
  // anything ever, since titles and IDs can look numeric.
  parseTagValue: false,
  parseAttributeValue: false,
});

async function main() {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.EXPO_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error(
      'Missing required env: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY',
    );
    process.exit(1);
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false },
  });

  // News data moved out of public into its own schema in migration
  // 0069 of the main repo. Table names dropped the redundant `news_`
  // prefix (news_sources → news.sources, news_items → news.items).
  // Route every read/write through .schema('news') with the short
  // names.
  const news = supabase.schema('news');

  const { data: sources, error: srcErr } = await news
    .from('sources')
    .select('id, name_ar, rss_url')
    .eq('enabled', true)
    .order('sort_order');

  if (srcErr) {
    console.error('Failed to load news.sources:', srcErr.message);
    process.exit(1);
  }
  if (!sources || sources.length === 0) {
    console.log('No enabled news.sources — exiting cleanly.');
    return;
  }

  console.log(`Fetching ${sources.length} source(s)...`);

  const results = await Promise.all(
    sources.map((s) => fetchSource(s).catch((e: Error) => ({ error: e, source: s }))),
  );

  let totalUpserted = 0;
  let failedSources = 0;

  for (const result of results) {
    if ('error' in result) {
      failedSources += 1;
      console.error(
        `[${result.source.id}] FAILED: ${result.error.message ?? result.error}`,
      );
      continue;
    }
    if (result.items.length === 0) {
      console.log(`[${result.source.id}] 0 fresh items`);
      continue;
    }

    const { error: upsertErr, count } = await news
      .from('items')
      .upsert(result.items, {
        onConflict: 'source_id,external_id',
        ignoreDuplicates: false, // we want updates if title/image changes
        count: 'estimated',
      });

    if (upsertErr) {
      failedSources += 1;
      console.error(`[${result.source.id}] upsert error: ${upsertErr.message}`);
      continue;
    }

    totalUpserted += result.items.length;
    console.log(
      `[${result.source.id}] upserted ${result.items.length} items (count hint: ${count ?? '?'})`,
    );
  }

  console.log(`Done. Total upserted: ${totalUpserted}. Failed sources: ${failedSources}/${sources.length}.`);

  // Only fail the workflow if EVERY source broke — one bad feed shouldn't
  // page us. The admin dashboard can show last-success per source later.
  if (failedSources === sources.length) {
    process.exit(2);
  }
}

// ─── per-source fetch + parse ───────────────────────────────────────────────

async function fetchSource(source: NewsSource): Promise<{
  source: NewsSource;
  items: NewsItemRow[];
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let xml: string;
  try {
    const res = await fetch(source.rss_url, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/rss+xml, application/xml, text/xml, */*',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    xml = await res.text();
  } finally {
    clearTimeout(timeout);
  }

  const parsed = parser.parse(xml);

  // Standard RSS 2.0 shape: rss > channel > item[]
  // Atom shape:           feed > entry[]
  let rawItems: unknown[];
  if (parsed?.rss?.channel?.item) {
    rawItems = Array.isArray(parsed.rss.channel.item)
      ? parsed.rss.channel.item
      : [parsed.rss.channel.item];
  } else if (parsed?.feed?.entry) {
    rawItems = Array.isArray(parsed.feed.entry)
      ? parsed.feed.entry
      : [parsed.feed.entry];
  } else {
    throw new Error('No recognizable feed structure (rss.channel.item or feed.entry)');
  }

  const cutoffMs = Date.now() - MAX_AGE_DAYS * 86_400_000;
  const items: NewsItemRow[] = [];

  for (const raw of rawItems.slice(0, MAX_ITEMS_PER_SOURCE)) {
    const item = raw as Record<string, unknown>;
    const url = extractUrl(item);
    if (!url) continue;
    const title = stripHtml(extractText(item.title)).trim();
    if (!title) continue;
    const publishedAtMs = parseDate(
      extractText(item.pubDate) ||
        extractText(item.published) ||
        extractText(item.updated) ||
        extractText(item['dc:date']),
    );
    if (publishedAtMs == null || publishedAtMs < cutoffMs) continue;

    const externalId = extractGuid(item) || hashString(url);
    const descriptionHtml =
      extractText(item.description) ||
      extractText(item['content:encoded']) ||
      extractText(item.summary) ||
      extractText(item.content) ||
      '';
    // Image extraction has its own combined HTML pool: both
    // description AND content:encoded. WordPress feeds (Levant 24,
    // Syria Direct, Enab Baladi) put a short text excerpt in
    // <description> but the article's <img> hero in <content:encoded>.
    // Searching only description silently drops images on those feeds.
    const imageSearchHtml =
      extractText(item['content:encoded']) +
      '\n' +
      extractText(item.description) +
      '\n' +
      extractText(item.content);
    const summary = summarize(descriptionHtml);
    const imageUrl = extractImage(item, imageSearchHtml);

    items.push({
      source_id: source.id,
      external_id: externalId,
      title: decodeEntities(title),
      summary: summary ? decodeEntities(summary) : null,
      url,
      image_url: sanitizeImageUrl(imageUrl) || null,
      // Computed in a separate pass below — after image_url has been
      // resolved (which itself may run the og:image fallback first).
      image_blurhash: null,
      published_at: new Date(publishedAtMs).toISOString(),
    });
  }

  // Tier 2 sources (global/regional Arabic outlets) get filtered down
  // to items that match at least one Syria keyword in title + summary.
  // Tier 1 (Syrian-focused) feeds bypass this — every item passes.
  let finalItems = items;
  if (SYRIA_FILTERED_SOURCES.has(source.id)) {
    const before = items.length;
    finalItems = items.filter((it) => passesSyriaFilter(it.title, it.summary));
    if (before > 0) {
      console.log(
        `[${source.id}] syria-filter: kept ${finalItems.length}/${before}`,
      );
    }
  }

  // Backfill missing or ad-placeholder image URLs from the article
  // page's <meta property="og:image">. Some feeds (Daraj, Al Jazeera
  // Arabic) ship without any image marker at all; others (Al Watan)
  // embed an ad-space placeholder where the article hero would go.
  // We hit the article URL only when needed, in parallel across the
  // source's items, so the extra cost is bounded by one ~8s timeout
  // per source.
  await Promise.all(
    finalItems.map(async (it) => {
      if (it.image_url && !isAdPlaceholderUrl(it.image_url)) return;
      const og = await fetchOgImage(it.url);
      if (og) {
        it.image_url = og;
      } else if (isAdPlaceholderUrl(it.image_url)) {
        // Drop the placeholder rather than leaving "ad space" art
        // on the card.
        it.image_url = null;
      }
    }),
  );

  // Compute BlurHash placeholders for every item with a resolved
  // image_url. Runs in parallel across the source's items; each
  // compute has its own 8s timeout so a slow source can't sink the
  // whole batch. Items with no image_url leave image_blurhash null
  // and the mobile card falls back to its surface-elevated rectangle.
  await Promise.all(
    finalItems.map(async (it) => {
      if (!it.image_url) return;
      const hash = await computeBlurhash(it.image_url);
      it.image_blurhash = hash;
    }),
  );

  return { source, items: finalItems };
}

// Compute a BlurHash from an image URL. Used so mobile cards can
// render a blurred placeholder INSTANTLY (decoded client-side via
// expo-image) before the real image_url lands over the network —
// critical UX on the weak Syrian connections most of our users hit
// the app on.
//
// Pipeline: fetch source bytes (cap at BLURHASH_MAX_FETCH_BYTES) →
// sharp resizes to 32×32 RGBA → blurhash.encode → 4x3-component
// string. Returns null on any failure (network, decode, image too
// weird for sharp) — caller stores null and the mobile card falls
// back to its surface-elevated placeholder.
//
// We fetch the ORIGINAL source URL (not via our cdn.bawaba.dev
// transform). Two reasons: 1) GitHub Actions has fast US/EU
// connectivity so source latency isn't the bottleneck for the cron
// (vs the Syrian mobile case); 2) hitting our own transform from
// the cron would burn through CF Image Transformations quota on
// requests no real user will ever look at.
async function computeBlurhash(imageUrl: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    BLURHASH_FETCH_TIMEOUT_MS,
  );
  try {
    const res = await fetch(imageUrl, {
      headers: { 'User-Agent': UA, Accept: 'image/*' },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) return null;
    // Optional content-length pre-check so we don't even start
    // streaming a 50 MB original.
    const cl = res.headers.get('content-length');
    if (cl && Number(cl) > BLURHASH_MAX_FETCH_BYTES) return null;

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > BLURHASH_MAX_FETCH_BYTES) {
      return null;
    }

    // sharp handles JPEG/PNG/WebP/AVIF/GIF (first frame). resize +
    // ensureAlpha + raw() gives us a plain RGBA pixel buffer of the
    // requested size — exactly what blurhash.encode wants.
    const { data } = await sharp(buf)
      .resize(BLURHASH_SAMPLE_WIDTH, BLURHASH_SAMPLE_HEIGHT, {
        fit: 'cover',
      })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    return encodeBlurhash(
      new Uint8ClampedArray(data),
      BLURHASH_SAMPLE_WIDTH,
      BLURHASH_SAMPLE_HEIGHT,
      BLURHASH_COMPONENTS_X,
      BLURHASH_COMPONENTS_Y,
    );
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Fetch the article HTML and pull out <meta property="og:image" content="…">
// (also accepts the swapped attribute order: content first, property
// second). Returns null on any failure — caller treats it as "no image"
// and the card renders without art. Network errors, non-OK responses,
// bot-walled pages, and pages without an og:image all silently return
// null; one slow page doesn't sink the whole cron run.
async function fetchOgImage(articleUrl: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OG_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(articleUrl, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,*/*',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const html = await res.text();
    // Most pages put property= first, but some swap the order.
    const m =
      html.match(
        /<meta[^>]+property=["']og:image(?::secure_url|:url)?["'][^>]+content=["']([^"']+)["']/i,
      ) ||
      html.match(
        /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url|:url)?["']/i,
      );
    if (!m) return null;
    let url = m[1].trim();
    if (!url) return null;
    // Resolve protocol-relative + path-relative URLs against the
    // article URL. <meta og:image content="//cdn.x/a.jpg"> is common.
    if (url.startsWith('//')) url = 'https:' + url;
    else if (url.startsWith('/')) {
      try {
        url = new URL(url, articleUrl).href;
      } catch {
        return null;
      }
    }
    if (!url.startsWith('http')) return null;
    return url;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── field extractors ───────────────────────────────────────────────────────

// fast-xml-parser flattens text nodes to either a plain string or
// { '#text': '...' } depending on attributes. This normalizes both.
function extractText(field: unknown): string {
  if (field == null) return '';
  if (typeof field === 'string') return field;
  if (typeof field === 'number') return String(field);
  if (typeof field === 'object') {
    const o = field as Record<string, unknown>;
    if (typeof o['#text'] === 'string') return o['#text'];
    if (Array.isArray(field) && field.length > 0) {
      return extractText(field[0]);
    }
  }
  return '';
}

function extractUrl(item: Record<string, unknown>): string {
  // RSS 2.0
  const link = item.link;
  if (typeof link === 'string') return link;
  if (Array.isArray(link)) {
    // Atom often has multiple <link> elements; prefer rel="alternate"
    for (const l of link) {
      if (typeof l === 'object' && l !== null) {
        const o = l as Record<string, unknown>;
        if ((o['@_rel'] ?? 'alternate') === 'alternate' && typeof o['@_href'] === 'string') {
          return o['@_href'] as string;
        }
      } else if (typeof l === 'string') {
        return l;
      }
    }
  }
  if (typeof link === 'object' && link !== null) {
    const o = link as Record<string, unknown>;
    if (typeof o['@_href'] === 'string') return o['@_href'];
    if (typeof o['#text'] === 'string') return o['#text'];
  }
  return '';
}

function extractGuid(item: Record<string, unknown>): string {
  const guid = item.guid ?? item.id;
  if (typeof guid === 'string') return guid;
  if (typeof guid === 'object' && guid !== null) {
    const o = guid as Record<string, unknown>;
    if (typeof o['#text'] === 'string') return o['#text'];
  }
  return '';
}

function extractImage(item: Record<string, unknown>, descriptionHtml: string): string {
  // media:content url="..." medium="image"
  const mediaContent = item['media:content'];
  if (Array.isArray(mediaContent)) {
    for (const m of mediaContent) {
      const o = m as Record<string, unknown>;
      const medium = o['@_medium'] ?? o['@_type'];
      if ((medium == null || String(medium).startsWith('image')) && typeof o['@_url'] === 'string') {
        return o['@_url'] as string;
      }
    }
  } else if (mediaContent && typeof mediaContent === 'object') {
    const o = mediaContent as Record<string, unknown>;
    if (typeof o['@_url'] === 'string') return o['@_url'] as string;
  }

  // media:thumbnail
  const thumb = item['media:thumbnail'];
  if (thumb && typeof thumb === 'object') {
    const o = thumb as Record<string, unknown>;
    if (typeof o['@_url'] === 'string') return o['@_url'] as string;
  }

  // enclosure type="image/..."
  const enclosure = item.enclosure;
  if (Array.isArray(enclosure)) {
    for (const e of enclosure) {
      const o = e as Record<string, unknown>;
      if (
        typeof o['@_type'] === 'string' &&
        (o['@_type'] as string).startsWith('image') &&
        typeof o['@_url'] === 'string'
      ) {
        return o['@_url'] as string;
      }
    }
  } else if (enclosure && typeof enclosure === 'object') {
    const o = enclosure as Record<string, unknown>;
    const t = o['@_type'];
    if ((!t || (typeof t === 'string' && t.startsWith('image'))) && typeof o['@_url'] === 'string') {
      return o['@_url'] as string;
    }
  }

  // <image> element. Two shapes in the wild:
  //   <image>https://.../hero.jpg</image>                — Enab Baladi
  //   <image><url>...</url></image>                       — RSS channel
  const image = item.image;
  if (typeof image === 'string') return image;
  if (image && typeof image === 'object') {
    const o = image as Record<string, unknown>;
    if (typeof o.url === 'string') return o.url as string;
    if (typeof o['#text'] === 'string') return o['#text'] as string;
  }

  // Fallback: first <img src> in the description HTML.
  const m = descriptionHtml.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (m) return m[1];

  return '';
}

// ─── parsing helpers ────────────────────────────────────────────────────────

function parseDate(input: string): number | null {
  if (!input) return null;
  const t = Date.parse(input);
  return Number.isFinite(t) ? t : null;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

// Decode HTML entities that aren't decoded by fast-xml-parser's
// processEntities (which handles XML entities only — &amp; &lt; etc).
// RSS feeds often include numeric/named HTML entities in titles and
// descriptions (e.g. &#8220; for curly quotes) — those render as
// literal text in React Native if not decoded.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  laquo: '«',
  raquo: '»',
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) =>
      String.fromCodePoint(parseInt(dec, 10)),
    )
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

// Source feeds occasionally publish malformed image URLs (missing
// path separators, raw HTML, etc.). We first try to repair known
// patterns; what doesn't get repaired and still looks broken gets
// dropped — better no image than a broken one.
function sanitizeImageUrl(raw: string): string {
  if (!raw) return '';
  const candidate = repairKnownMalformedUrl(raw);
  try {
    const u = new URL(candidate);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    // TLD-shape check: last label between 2-6 letters (covers .sy,
    // .com, .net, .info, .travel, etc. — rejects malformed hosts
    // like 'domain.netuploads' that come from feeds missing a slash).
    if (!/\.[a-z]{2,6}(:\d+)?$/i.test(u.hostname)) return '';
    // Doubled slashes in the path are another smell of malformed
    // URLs (the feed concatenated host+path without a separator,
    // then added one too many later).
    if (u.pathname.includes('//')) return '';
    return candidate;
  } catch {
    return '';
  }
}

// Targeted repairs for source feeds that ship broken URLs in their
// enclosure/media:content elements. Keep this short and explicit —
// each entry references the actual source and the actual bad pattern
// so future debugging is easy.
function repairKnownMalformedUrl(s: string): string {
  // Zaman al-Wsl: hostname mashed with the path. Their feed emits
  //   https://www.zamanalwsl.netuploads//abcd1234.png
  // and the real URL is
  //   https://www.zamanalwsl.net/uploads/abcd1234.png
  // (verified 200 + image/png in a HEAD probe). Rewrite the seam.
  if (s.includes('zamanalwsl.netuploads//')) {
    return s.replace('zamanalwsl.netuploads//', 'zamanalwsl.net/uploads/');
  }
  return s;
}

function summarize(html: string): string {
  const stripped = stripHtml(html);
  if (!stripped) return '';
  if (stripped.length <= SUMMARY_MAX_LEN) return stripped;
  // Cut at the last sentence/word boundary near the limit so we don't
  // chop a word in half.
  const truncated = stripped.slice(0, SUMMARY_MAX_LEN);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > SUMMARY_MAX_LEN * 0.7 ? truncated.slice(0, lastSpace) : truncated) + '…';
}

// Deterministic ID for items whose feeds don't expose a stable <guid>.
// We hash the canonical URL — same URL = same item, no duplicates on
// re-fetch. Web Crypto SHA-256 → base64url, truncated.
function hashString(input: string): string {
  // Bun/Node 18+ has a synchronous Bun.hash; but we want this to run
  // unchanged in any Node ≥18, so use Web Crypto async via a sync wrapper
  // would be wrong here. Fall back to a fast non-crypto hash since this
  // is just for de-dup, not for security.
  let h1 = 0xdeadbeef ^ 0x55555555;
  let h2 = 0x41c6ce57 ^ 0x55555555;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (
    (4294967296 * (2097151 & h2) + (h1 >>> 0))
      .toString(36)
      .padStart(10, '0')
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
