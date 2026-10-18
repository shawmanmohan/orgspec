const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  mdash: '—',
  ndash: '–',
  hellip: '…',
};

const decode = (s: string): string =>
  s
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m);

/**
 * Confluence storage format (XHTML with `ac:` macros) → plain Markdown-ish text.
 * Macros, comments and hidden markup are dropped; the result is untrusted data, never instructions.
 */
export function storageToText(storage: string): string {
  return decode(
    storage
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(
        /<ac:(?:structured-macro|parameter|plain-text-body)[\s\S]*?<\/ac:(?:structured-macro|parameter|plain-text-body)>/g,
        '',
      )
      .replace(/<ac:[^>]*\/>/g, '')
      .replace(/<\/?ac:[^>]*>/g, '')
      .replace(/<\/?ri:[^>]*>/g, '')
      .replace(/<h([1-6])[^>]*>/gi, (_m, n: string) => `\n\n${'#'.repeat(Number(n))} `)
      .replace(/<\/h[1-6]>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|ul|ol|table|blockquote)>/gi, '\n')
      .replace(/<(td|th)[^>]*>/gi, ' | ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[​-‍﻿⁠]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Comparison form for grounding: unified quotes and dashes, collapsed whitespace, lower case. */
export function quoteForm(text: string): string {
  return text
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[​-‍﻿⁠]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export const MIN_QUOTE = 12;

/** A rule is grounded when its quote appears verbatim (up to whitespace and quote style) in the source. */
export const isGrounded = (quote: string, sourceText: string): boolean =>
  quoteForm(quote).length >= MIN_QUOTE && quoteForm(sourceText).includes(quoteForm(quote));
