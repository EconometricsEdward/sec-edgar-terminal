/** Decode numeric HTML references after removing markup. Preserve full Unicode
 * and replace invalid scalar values instead of truncating them to UTF-16. */
export function decodeNumericHtmlEntities(text) {
  return text.replace(/&#(?:x([\da-f]+)|(\d+));/gi, (_, hex, decimal) => {
    const point = Number.parseInt(hex || decimal, hex ? 16 : 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
      ? String.fromCodePoint(point) : '\uFFFD';
  });
}
