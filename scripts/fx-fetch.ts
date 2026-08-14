// FX rate fetcher. Runs in GitHub Actions every 30 minutes.
//
// Two sources, written to two tables:
//   sp-today  → fx.rates (currencies) + fx.gold (gold) — parallel market
//   cbs       → fx.rates (currencies)                  — official rate
//
// sp-today: GET https://sse.sp-today.com/snapshot returns a single JSON
// payload with all currencies (30+) and all gold karats (5) for every
// city sp-today tracks. We dropped the prior HTML regex scrape — same
// data, more of it, and stable across their Next.js chunk shuffles.
//
// CBS: still scraped from cb.gov.sy — they have no JSON endpoint. We
// pull mid rates from the home page calculator + the USD bulletin (which
// has real buy/sell). All CBS rows get city='damascus' (CBS publishes a
// single national rate; the column exists for sp-today's multi-city data).
//
// Required env vars (set in repo's GitHub Actions secrets):
//   NEXT_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// Local test:
//   SUPABASE_SERVICE_ROLE_KEY=... bun run scripts/fx-fetch.ts

import { createClient } from '@supabase/supabase-js';

type FxRow = {
  source: 'sp-today' | 'cbs';
  currency_code: string;
  city: string;
  name_ar: string;
  flag: string;
  syp_buy: number;
  syp_sell: number;
};

type GoldRow = {
  karat: string;
  city: string;
  syp_buy: number;
  syp_sell: number;
};

const UA =
  'Mozilla/5.0 (compatible; DaloonaFxFetcher/1.0; +https://daloona.app)';

// ─── sp-today ───────────────────────────────────────────────────────────────
//
// The snapshot endpoint returns only buy/sell/change — no human-readable
// metadata. We maintain the Arabic name + flag here. To add a currency
// sp-today starts publishing (e.g. INR, CNY), add a row to this table.
//
// IRR (Iranian Rial) currently comes back as 0/0 — sp-today doesn't track
// active prices for it. The 0-guard in the parser silently skips it.

const SP_TODAY_LABELS: Record<string, { name_ar: string; flag: string }> = {
  USD: { name_ar: 'دولار أمريكي',    flag: '🇺🇸' },
  EUR: { name_ar: 'يورو',             flag: '🇪🇺' },
  TRY: { name_ar: 'ليرة تركية',       flag: '🇹🇷' },
  SAR: { name_ar: 'ريال سعودي',       flag: '🇸🇦' },
  AED: { name_ar: 'درهم إماراتي',     flag: '🇦🇪' },
  EGP: { name_ar: 'جنيه مصري',        flag: '🇪🇬' },
  LYD: { name_ar: 'دينار ليبي',       flag: '🇱🇾' },
  JOD: { name_ar: 'دينار أردني',      flag: '🇯🇴' },
  KWD: { name_ar: 'دينار كويتي',      flag: '🇰🇼' },
  GBP: { name_ar: 'جنيه إسترليني',    flag: '🇬🇧' },
  QAR: { name_ar: 'ريال قطري',        flag: '🇶🇦' },
  BHD: { name_ar: 'دينار بحريني',     flag: '🇧🇭' },
  SEK: { name_ar: 'كرونة سويدية',     flag: '🇸🇪' },
  CAD: { name_ar: 'دولار كندي',       flag: '🇨🇦' },
  OMR: { name_ar: 'ريال عماني',       flag: '🇴🇲' },
  NOK: { name_ar: 'كرونة نرويجية',    flag: '🇳🇴' },
  DKK: { name_ar: 'كرونة دنماركية',   flag: '🇩🇰' },
  DZD: { name_ar: 'دينار جزائري',     flag: '🇩🇿' },
  MAD: { name_ar: 'درهم مغربي',       flag: '🇲🇦' },
  TND: { name_ar: 'دينار تونسي',      flag: '🇹🇳' },
  RUB: { name_ar: 'روبل روسي',        flag: '🇷🇺' },
  MYR: { name_ar: 'رينغيت ماليزي',     flag: '🇲🇾' },
  BRL: { name_ar: 'ريال برازيلي',     flag: '🇧🇷' },
  NZD: { name_ar: 'دولار نيوزيلندي',  flag: '🇳🇿' },
  CHF: { name_ar: 'فرنك سويسري',      flag: '🇨🇭' },
  AUD: { name_ar: 'دولار أسترالي',    flag: '🇦🇺' },
  ZAR: { name_ar: 'راند جنوب أفريقي', flag: '🇿🇦' },
  IQD: { name_ar: 'دينار عراقي',      flag: '🇮🇶' },
  IRR: { name_ar: 'ريال إيراني',      flag: '🇮🇷' },
  SGD: { name_ar: 'دولار سنغافوري',   flag: '🇸🇬' },
};

type SpTodayQuote = { buy: number; sell: number; change: number };
type SpTodaySnapshot = {
  ok: boolean;
  data?: {
    currencies?: Record<string, SpTodayQuote>;
    gold?: Record<string, SpTodayQuote>;
    version?: number;
  };
};

async function fetchSpToday(): Promise<{
  currencies: FxRow[];
  gold: GoldRow[];
}> {
  const res = await fetch('https://sse.sp-today.com/snapshot', {
    headers: { 'User-Agent': UA },
  });
  if (!res.ok) throw new Error(`sp-today snapshot: HTTP ${res.status}`);
  const json = (await res.json()) as SpTodaySnapshot;
  if (!json.ok || !json.data) {
    throw new Error('sp-today snapshot: malformed payload');
  }

  const currencies: FxRow[] = [];
  for (const [key, val] of Object.entries(json.data.currencies ?? {})) {
    const sep = key.indexOf(':');
    if (sep < 0) continue;
    const code = key.slice(0, sep);
    const city = key.slice(sep + 1);
    const meta = SP_TODAY_LABELS[code];
    if (!meta) {
      console.warn(`[sp-today] unknown currency code, skipping: ${code}`);
      continue;
    }
    const buy = Number(val.buy);
    const sell = Number(val.sell);
    if (!isFinite(buy) || !isFinite(sell) || buy <= 0 || sell <= 0) continue;
    currencies.push({
      source: 'sp-today',
      currency_code: code,
      city,
      name_ar: meta.name_ar,
      flag: meta.flag,
      syp_buy: buy,
      syp_sell: sell,
    });
  }

  const gold: GoldRow[] = [];
  for (const [key, val] of Object.entries(json.data.gold ?? {})) {
    const sep = key.indexOf(':');
    if (sep < 0) continue;
    const karat = key.slice(0, sep);
    const city = key.slice(sep + 1);
    const buy = Number(val.buy);
    const sell = Number(val.sell);
    if (!isFinite(buy) || !isFinite(sell) || buy <= 0 || sell <= 0) continue;
    gold.push({ karat, city, syp_buy: buy, syp_sell: sell });
  }

  return { currencies, gold };
}

// ─── CBS ────────────────────────────────────────────────────────────────────
//
// CBS publishes data in two places:
//
//   1. Home page calculator (cb.gov.sy/) — multi-currency, but only the
//      MID rate as a single number per currency.
//   2. Bulletin "النشرة الرسمية لأسعار الصرف بالليرة الجديدة والليرة القديمة"
//      (service=4) — USD-only, with separate buy (الشراء) and sell
//      (المبيع) columns. This is the authoritative source for the spread.
//
// We scrape BOTH: USD comes from the bulletin (real buy/sell); other
// currencies come from the home page calculator with buy=sell=mid.

const CBS_LABELS: Record<string, { name_ar: string; flag: string }> = {
  USD: { name_ar: 'دولار أمريكي',  flag: '🇺🇸' },
  EUR: { name_ar: 'يورو',           flag: '🇪🇺' },
  GBP: { name_ar: 'جنيه إسترليني',   flag: '🇬🇧' },
  SAR: { name_ar: 'ريال سعودي',     flag: '🇸🇦' },
  AED: { name_ar: 'درهم إماراتي',   flag: '🇦🇪' },
  KWD: { name_ar: 'دينار كويتي',    flag: '🇰🇼' },
  JOD: { name_ar: 'دينار أردني',    flag: '🇯🇴' },
  SEK: { name_ar: 'كرونة سويدية',   flag: '🇸🇪' },
};

const CBS_BULLETIN_URL =
  'https://cb.gov.sy/index.php?page=list&ex=2&dir=exchangerate&lang=1&service=4&act=1207';

async function fetchCbsUsdBuySell(): Promise<{
  buy: number;
  sell: number;
} | null> {
  const res = await fetch(CBS_BULLETIN_URL, {
    headers: { 'User-Agent': UA },
    redirect: 'follow',
  });
  if (!res.ok) return null;
  const html = await res.text();

  // The bulletin lists rows in newest-first order. Each row has the
  // shape:
  //   <div class='bd2'>
  //     <div class='w2 floatRight '> YYYY-MM-DD </div>
  //     <div class='w2 floatRight '> SELL </div>
  //     <div class='w2 floatRight '> BUY </div>
  //     ...
  // We pick the first match.
  const m = html.match(
    /<div class='bd[12]'>\s*<div[^>]*>\s*\d{4}-\d{2}-\d{2}\s*<\/div>\s*<div[^>]*>\s*([\d.]+)\s*<\/div>\s*<div[^>]*>\s*([\d.]+)\s*<\/div>/,
  );
  if (!m) return null;
  const sell = parseFloat(m[1]);
  const buy = parseFloat(m[2]);
  if (!isFinite(buy) || !isFinite(sell)) return null;
  return { buy, sell };
}

async function fetchCbsHomeMid(): Promise<Map<string, number>> {
  const res = await fetch('https://cb.gov.sy/', {
    headers: { 'User-Agent': UA },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`cbs home: HTTP ${res.status}`);
  const html = await res.text();
  // <option value='113.00'>USD </option>
  const pattern = /<option value='([\d.]+)'[^>]*>\s*([A-Z]{3})\b/g;
  const out = new Map<string, number>();
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(html)) !== null) {
    const [, valueStr, code] = m;
    if (out.has(code)) continue;
    const rate = parseFloat(valueStr);
    if (!isFinite(rate) || rate <= 0) continue;
    out.set(code, rate);
  }
  return out;
}

async function fetchCbs(): Promise<FxRow[]> {
  const [midByCode, usdBuySell] = await Promise.all([
    fetchCbsHomeMid(),
    fetchCbsUsdBuySell().catch(() => null),
  ]);

  const out: FxRow[] = [];
  for (const [code, meta] of Object.entries(CBS_LABELS)) {
    const mid = midByCode.get(code);
    if (mid === undefined) continue;
    const { buy, sell } =
      code === 'USD' && usdBuySell
        ? usdBuySell
        : { buy: mid, sell: mid };
    out.push({
      source: 'cbs',
      currency_code: code,
      city: 'damascus',
      name_ar: meta.name_ar,
      flag: meta.flag,
      syp_buy: buy,
      syp_sell: sell,
    });
  }
  return out;
}

// ─── Silver / Fuel / Electricity ────────────────────────────────────────────
//
// Three more sp-today pages, each server-rendered HTML (no JSON snapshot).
// Patterns are pinned to specific markup; if sp-today restyles the page,
// the regex breaks and the scraper returns null/empty (best-effort — the
// main currency + gold flow still succeeds).

type SilverRow = {
  kind: string;
  city: string;
  syp_buy: number;
  syp_sell: number;
};

type FuelRow = {
  kind: 'benzin' | 'diesel' | 'gas';
  name_ar: string;
  city: string;
  usd_per_liter: number;
};

type ElectricityRow = {
  tier: 'houses-under-300kwh' | 'houses-above-300kwh' | 'industrial';
  name_ar: string;
  syp_per_kwh: number;
};

async function fetchSilver(): Promise<SilverRow[]> {
  const res = await fetch('https://sp-today.com/silver', { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`silver: HTTP ${res.status}`);
  const html = await res.text();

  // The page embeds buy/sell inside Next.js RSC streaming chunks (escaped JSON).
  // Pattern: "children":"شراء"...later..."children":["VALUE"," ","ل.س"]
  // The 0-400 character gap allows for some markup variation between the
  // label and its paired value without matching across unrelated sections.
  const buyM = html.match(
    /\\"children\\":\\"شراء\\".{0,400}?\\"children\\":\[\\"([0-9,]+)\\"/,
  );
  const sellM = html.match(
    /\\"children\\":\\"مبيع\\".{0,400}?\\"children\\":\[\\"([0-9,]+)\\"/,
  );
  if (!buyM || !sellM) return [];
  const buy = Number(buyM[1].replace(/,/g, ''));
  const sell = Number(sellM[1].replace(/,/g, ''));
  if (!isFinite(buy) || !isFinite(sell) || buy <= 0 || sell <= 0) return [];
  return [{ kind: '999', city: 'damascus', syp_buy: buy, syp_sell: sell }];
}

const FUEL_PAGES: Array<{
  kind: FuelRow['kind'];
  name_ar: string;
  path: string;
}> = [
  { kind: 'benzin', name_ar: 'بنزين', path: '/energy/benzin' },
  { kind: 'diesel', name_ar: 'مازوت', path: '/energy/diesel' },
  { kind: 'gas',    name_ar: 'غاز',   path: '/energy/gas' },
];

async function fetchFuel(): Promise<FuelRow[]> {
  const rows = await Promise.all(
    FUEL_PAGES.map(async ({ kind, name_ar, path }) => {
      try {
        const res = await fetch(`https://sp-today.com${path}`, {
          headers: { 'User-Agent': UA },
        });
        if (!res.ok) return null;
        const html = await res.text();
        // <p class="text-4xl font-bold font-mono mb-2">$<!-- -->1.10</p>
        const m = html.match(
          /<p class="text-4xl font-bold font-mono mb-2">\$<!-- -->([\d.]+)<\/p>/,
        );
        if (!m) return null;
        const v = Number(m[1]);
        if (!isFinite(v) || v <= 0) return null;
        return { kind, name_ar, city: 'damascus', usd_per_liter: v };
      } catch {
        return null;
      }
    }),
  );
  return rows.filter((r): r is FuelRow => r !== null);
}

const ELECTRICITY_PAGES: Array<{
  tier: ElectricityRow['tier'];
  name_ar: string;
  path: string;
}> = [
  { tier: 'houses-under-300kwh', name_ar: 'منازل (أقل من 300 ك.و.س)',  path: '/energy/houses-under-300kwh' },
  { tier: 'houses-above-300kwh', name_ar: 'منازل (أكثر من 300 ك.و.س)', path: '/energy/houses-above-300kwh' },
  { tier: 'industrial',          name_ar: 'صناعي',                      path: '/energy/industrial' },
];

async function fetchElectricity(): Promise<ElectricityRow[]> {
  const rows = await Promise.all(
    ELECTRICITY_PAGES.map(async ({ tier, name_ar, path }) => {
      try {
        const res = await fetch(`https://sp-today.com${path}`, {
          headers: { 'User-Agent': UA },
        });
        if (!res.ok) return null;
        const html = await res.text();
        // <p class="text-4xl font-bold font-mono mb-2">1,400</p>
        // (no $ prefix on these — SYP price)
        const m = html.match(
          /<p class="text-4xl font-bold font-mono mb-2">([\d,]+)<\/p>/,
        );
        if (!m) return null;
        const v = Number(m[1].replace(/,/g, ''));
        if (!isFinite(v) || v <= 0) return null;
        return { tier, name_ar, syp_per_kwh: v };
      } catch {
        return null;
      }
    }),
  );
  return rows.filter((r): r is ElectricityRow => r !== null);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error('Missing SUPABASE_URL env var');
  if (!serviceKey) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY env var');

  const supabase = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Run all five fetchers in parallel; each is independent.
  const [spResult, cbsResult, silverResult, fuelResult, elecResult] =
    await Promise.allSettled([
      fetchSpToday(),
      fetchCbs(),
      fetchSilver(),
      fetchFuel(),
      fetchElectricity(),
    ]);

  const currencyRows: FxRow[] = [];
  let goldRows: GoldRow[] = [];
  let silverRows: SilverRow[] = [];
  let fuelRows: FuelRow[] = [];
  let elecRows: ElectricityRow[] = [];

  if (spResult.status === 'fulfilled') {
    currencyRows.push(...spResult.value.currencies);
    goldRows = spResult.value.gold;
    const cities = new Set(spResult.value.currencies.map((r) => r.city));
    console.log(
      `✓ sp-today: ${spResult.value.currencies.length} currency rows ` +
        `(${cities.size} cities), ${spResult.value.gold.length} gold rows`,
    );
  } else {
    console.error('✖ sp-today failed:', spResult.reason);
  }
  if (cbsResult.status === 'fulfilled') {
    currencyRows.push(...cbsResult.value);
    console.log(`✓ cbs:       ${cbsResult.value.length} currencies`);
  } else {
    console.error('✖ cbs failed:', cbsResult.reason);
  }
  if (silverResult.status === 'fulfilled') {
    silverRows = silverResult.value;
    console.log(`✓ silver:    ${silverRows.length} rows`);
  } else {
    console.error('✖ silver failed:', silverResult.reason);
  }
  if (fuelResult.status === 'fulfilled') {
    fuelRows = fuelResult.value;
    console.log(`✓ fuel:      ${fuelRows.length} rows`);
  } else {
    console.error('✖ fuel failed:', fuelResult.reason);
  }
  if (elecResult.status === 'fulfilled') {
    elecRows = elecResult.value;
    console.log(`✓ electricity: ${elecRows.length} rows`);
  } else {
    console.error('✖ electricity failed:', elecResult.reason);
  }

  if (currencyRows.length === 0) {
    throw new Error(
      'No currencies fetched from any source — refusing to write empty payload',
    );
  }

  const fetchedAt = new Date().toISOString();

  // FX data moved out of public into its own schema in migration 0068
  // of the main repo. Table names dropped the redundant `fx_` prefix
  // along the way (fx_rates → fx.rates, etc). Route every write
  // through .schema('fx') and use the short names.
  const fx = supabase.schema('fx');

  const { error: fxError } = await fx
    .from('rates')
    .insert(currencyRows.map((r) => ({ ...r, fetched_at: fetchedAt })));
  if (fxError) throw fxError;
  console.log(`✓ wrote ${currencyRows.length} currency rows at ${fetchedAt}`);

  // Auxiliary inserts (gold/silver/fuel/electricity) are best-effort: a
  // failure on one shouldn't sink the whole run — currencies are already
  // written and the others can recover on the next cron tick.
  await Promise.allSettled([
    bestEffortInsert(fx, 'gold', goldRows, fetchedAt),
    bestEffortInsert(fx, 'silver', silverRows, fetchedAt),
    bestEffortInsert(fx, 'fuel', fuelRows, fetchedAt),
    bestEffortInsert(fx, 'electricity', elecRows, fetchedAt),
  ]);
}

async function bestEffortInsert<T extends object>(
  fx: ReturnType<ReturnType<typeof createClient>['schema']>,
  table: string,
  rows: T[],
  fetchedAt: string,
): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await fx
    .from(table)
    .insert(rows.map((r) => ({ ...r, fetched_at: fetchedAt })));
  if (error) {
    console.error(`✖ fx.${table} insert failed (continuing):`, error.message);
  } else {
    console.log(`✓ wrote ${rows.length} fx.${table} rows`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
