// Shared helpers.
import { config } from './config.js';

// Treat text as English-readable if it contains at most a couple of characters
// from non-Latin scripts (CJK, Hangul, kana, Cyrillic, Arabic, Thai, fullwidth forms).
const FOREIGN_SCRIPT = /[　-鿿가-힯Ѐ-ӿ؀-ۿ฀-๿＀-￯]/g;

export function isMostlyEnglish(text) {
  if (!text) return true;
  const matches = text.match(FOREIGN_SCRIPT);
  return !matches || matches.length <= 2;
}

// ---------------------------------------------------------------------------
// Region classification from a free-text GitHub location string.
// Returns 'north_america' | 'other' | null (unknown / empty).

const NA_SIGNALS = [
  // countries
  /\b(usa|u\.s\.a\.?|u\.s\.|united states|america|canada|mexico|méxico)\b/i,
  // regions
  /\b(bay area|silicon valley|new england|pacific northwest|midwest|east coast|west coast|socal|norcal)\b/i,
  // US states (full names)
  /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)\b/i,
  // ", XX" state/province abbreviations at a boundary (avoids matching CA in "Africa")
  /,\s*(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|MA|MD|ME|MI|MN|MO|MS|MT|NC|ND|NE|NH|NJ|NM|NV|NY|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VA|VT|WA|WI|WV|WY|ON|QC|BC|AB|MB|SK|NS|NB|NL|PE)\b/,
  // Canadian provinces (full names)
  /\b(ontario|quebec|british columbia|alberta|manitoba|saskatchewan|nova scotia|new brunswick|newfoundland)\b/i,
  // major cities
  /\b(san francisco|sf|nyc|new york|seattle|austin|boston|toronto|vancouver|waterloo|montreal|montréal|ottawa|calgary|edmonton|los angeles|san diego|san jose|palo alto|mountain view|menlo park|sunnyvale|cupertino|berkeley|oakland|chicago|denver|boulder|miami|atlanta|dallas|houston|philadelphia|pittsburgh|portland|phoenix|salt lake city|minneapolis|ann arbor|raleigh|durham|nashville|washington dc|d\.c\.|brooklyn|manhattan|cambridge,\s*ma|kitchener|mississauga)\b/i,
];

const NON_NA_SIGNALS = [
  /\b(uk|u\.k\.|united kingdom|england|scotland|wales|ireland|london|manchester|edinburgh|dublin)\b/i,
  /\b(germany|deutschland|berlin|munich|münchen|hamburg|france|paris|lyon|netherlands|amsterdam|belgium|brussels|spain|madrid|barcelona|portugal|lisbon|italy|rome|milan|switzerland|zurich|zürich|geneva|austria|vienna|sweden|stockholm|norway|oslo|denmark|copenhagen|finland|helsinki|poland|warsaw|krakow|czech|prague|europe|eu\b)/i,
  /\b(india|bangalore|bengaluru|mumbai|delhi|hyderabad|chennai|pune|china|beijing|shanghai|shenzhen|hangzhou|hong kong|taiwan|taipei|japan|tokyo|osaka|korea|seoul|singapore|vietnam|hanoi|indonesia|jakarta|thailand|bangkok|philippines|manila|malaysia)\b/i,
  /\b(australia|sydney|melbourne|new zealand|auckland|brazil|brasil|são paulo|sao paulo|rio de janeiro|argentina|buenos aires|chile|santiago|colombia|bogotá|bogota|peru|lima)\b/i,
  /\b(israel|tel aviv|turkey|istanbul|uae|dubai|saudi|egypt|cairo|nigeria|lagos|kenya|nairobi|south africa|cape town|johannesburg|russia|moscow|ukraine|kyiv|kiev)\b/i,
];

export function classifyRegion(location) {
  if (!location || !location.trim()) return null;
  if (NA_SIGNALS.some((re) => re.test(location))) return 'north_america';
  if (NON_NA_SIGNALS.some((re) => re.test(location))) return 'other';
  return null;
}

// ---------------------------------------------------------------------------
// Top-university detection in bio/company text (top ~50, NA-weighted).
// Returns { university, isStudent } or null.

const UNIVERSITIES = [
  ['Waterloo', /\b(uwaterloo|university of waterloo|waterloo)\b/i],
  ['MIT', /\bmit\b|massachusetts institute of technology/i],
  ['Stanford', /\bstanford\b/i],
  ['Harvard', /\bharvard\b/i],
  ['UC Berkeley', /\bberkeley\b|\bucb\b|\bcal\b(?!\w)/i],
  ['CMU', /\bcmu\b|carnegie mellon/i],
  ['Princeton', /\bprinceton\b/i],
  ['Yale', /\byale\b/i],
  ['Columbia', /\bcolumbia\b/i],
  ['Cornell', /\bcornell\b/i],
  ['UPenn', /\bupenn\b|\bpenn\b|wharton|university of pennsylvania/i],
  ['Brown', /\bbrown university\b|\bbrown\b(?=.*(univ|cs|student|'\d{2}))/i],
  ['Dartmouth', /\bdartmouth\b/i],
  ['Caltech', /\bcaltech\b|california institute of technology/i],
  ['Georgia Tech', /georgia tech|\bgatech\b/i],
  ['UIUC', /\buiuc\b|university of illinois/i],
  ['Michigan', /\bumich\b|university of michigan|ann arbor/i],
  ['UW (Seattle)', /university of washington|\budub\b/i],
  ['UT Austin', /ut austin|university of texas/i],
  ['UCLA', /\bucla\b/i],
  ['UCSD', /\bucsd\b|uc san diego/i],
  ['USC', /\busc\b/i],
  ['NYU', /\bnyu\b|new york university/i],
  ['Duke', /\bduke\b/i],
  ['Northwestern', /\bnorthwestern\b/i],
  ['Johns Hopkins', /johns hopkins|\bjhu\b/i],
  ['Rice', /\brice university\b/i],
  ['Purdue', /\bpurdue\b/i],
  ['UMD', /\bumd\b|university of maryland/i],
  ['UW-Madison', /uw-madison|university of wisconsin/i],
  ['Toronto', /\buoft\b|university of toronto/i],
  ['UBC', /\bubc\b|university of british columbia/i],
  ['McGill', /\bmcgill\b/i],
  ['Oxford', /\boxford\b/i],
  ['Cambridge', /\bcambridge university\b|university of cambridge/i],
  ['ETH Zurich', /\beth\b|eth zurich|eth zürich/i],
  ['EPFL', /\bepfl\b/i],
  ['Imperial College', /imperial college/i],
  ['Tsinghua', /\btsinghua\b/i],
  ['Peking', /\bpeking university\b|\bpku\b/i],
  ['NUS', /\bnus\b|national university of singapore/i],
  ['IIT', /\biit\b(?!\w)|indian institute of technology/i],
];

const STUDENT_SIGNAL =
  /\b(student|undergrad(uate)?|grad(uate)? student|phd|ph\.d|masters?|m\.s\.|b\.s\.|bs\/ms|sophomore|junior|senior|freshman|studying|intern)\b|'\d{2}\b|class of 20\d{2}|c\/o 20\d{2}|cs @/i;

// ---------------------------------------------------------------------------
// Safety-net filter: even a well-targeted query occasionally pulls in a
// consumer/hobby app (e.g. a nutrition tracker tagged "rag" for its food
// database lookup). Reject obvious non-devtool consumer-app signals.

const CONSUMER_APP_SIGNALS = /\b(diet|nutrition|recipe|meal plan|calorie|fitness tracker|workout|horoscope|astrology|tarot|dating app|matchmaking|meditation|mood tracker|travel itinerary|flight booking|hotel booking|shopping list|grocery)\b/i;

export function isConsumerApp(text) {
  if (!text) return false;
  return CONSUMER_APP_SIGNALS.test(text);
}

// Phrase-search false positive: a repo whose description mentions "code
// review" as part of its own contribution process (e.g. a read-only mirror),
// not because the repo IS a code-review tool. Mirrors are also never
// genuinely emerging original work.
const MIRROR_OR_BOILERPLATE = /\b(read-only mirror|this is a mirror|mirror of|should be submitted to|please see contributing|see contributing\.md)\b/i;

export function isMirrorOrBoilerplate(text) {
  if (!text) return false;
  return MIRROR_OR_BOILERPLATE.test(text);
}

export function detectUniversity(text) {
  if (!text || !text.trim()) return null;
  for (const [name, re] of UNIVERSITIES) {
    if (re.test(text)) {
      return { university: name, isStudent: STUDENT_SIGNAL.test(text) };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Founder-dense employer detection in bio/company text.
// Returns { company } or null. The company list lives in config.js (not here)
// because it's a targeting knob — add/remove companies without touching
// classifier logic — unlike the static UNIVERSITIES reference table above.

export function detectFounderDenseEmployer(text) {
  if (!text || !text.trim()) return null;
  for (const { name, textMatch } of config.founderDenseEmployers.companies) {
    if (textMatch.some((re) => re.test(text))) return { company: name };
  }
  return null;
}
