import type { Root } from 'mdast';
import { toString as mdToString } from 'mdast-util-to-string';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

export interface HeadingInfo {
  depth: number;
  /** Heading text without the leading hashes or inline markers. */
  text: string;
  /** 1-based line of the heading. */
  line: number;
}

/** A run of lines: `start` is the heading line, `end` is the first line after the region (both 1-based). */
export interface Region {
  start: number;
  end: number;
}

const parser = unified().use(remarkParse);

/** Top-level headings only; headings inside lists, quotes or code blocks are ignored. */
export function topLevelHeadings(src: string): HeadingInfo[] {
  const tree = parser.parse(src) as Root;
  const out: HeadingInfo[] = [];
  for (const node of tree.children) {
    if (node.type === 'heading' && node.position) {
      out.push({ depth: node.depth, text: mdToString(node).trim(), line: node.position.start.line });
    }
  }
  return out;
}

export function splitLines(src: string): string[] {
  return src.replace(/\r\n?/g, '\n').split('\n');
}

/** Lines from `fromLine` (inclusive) to `toLine` (exclusive), 1-based. */
export function sliceLines(lines: readonly string[], fromLine: number, toLine: number): string {
  return lines.slice(fromLine - 1, toLine - 1).join('\n');
}

/** The region a heading owns: until the next heading of the same or a higher level. */
export function regionOf(heading: HeadingInfo, headings: readonly HeadingInfo[], lineCount: number): Region {
  const next = headings.find((h) => h.line > heading.line && h.depth <= heading.depth);
  return { start: heading.line, end: next ? next.line : lineCount + 1 };
}
