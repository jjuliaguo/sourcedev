// Shared helpers.

// Treat text as English-readable if it contains at most a couple of characters
// from non-Latin scripts (CJK, Hangul, kana, Cyrillic, Arabic, Thai, fullwidth forms).
const FOREIGN_SCRIPT = /[　-鿿가-힯Ѐ-ӿ؀-ۿ฀-๿＀-￯]/g;

export function isMostlyEnglish(text) {
  if (!text) return true;
  const matches = text.match(FOREIGN_SCRIPT);
  return !matches || matches.length <= 2;
}
