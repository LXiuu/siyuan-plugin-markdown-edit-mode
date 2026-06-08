export interface NormalizeMarkdownResult {
  markdown: string;
  removedFrontMatterCount: number;
  removedDocTitleHeadingCount: number;
}

export interface NormalizeSiyuanExportMarkdownOptions {
  docTitle?: string | null;
}

const SIYUAN_FRONT_MATTER_KEYS = new Set(["title", "date", "lastmod"]);
const SIYUAN_EMPTY_PARAGRAPH_MARKER = "\u200D";

export function normalizeSiyuanExportMarkdown(
  markdown: string,
  options: NormalizeSiyuanExportMarkdownOptions = {},
): NormalizeMarkdownResult {
  let normalized = normalizeMarkdownForSave(markdown);
  let removedFrontMatterCount = 0;

  while (true) {
    const next = removeOneSiyuanFrontMatter(normalized);

    if (!next.removed) {
      break;
    }

    normalized = next.markdown;
    removedFrontMatterCount += 1;
  }

  const titleResult = removeLeadingDocTitleHeadings(normalized, options.docTitle);

  return {
    markdown: titleResult.markdown,
    removedFrontMatterCount,
    removedDocTitleHeadingCount: titleResult.removedCount,
  };
}

export function normalizeMarkdownForSave(markdown: string): string {
  return markdown
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "");
}

export function preserveBlankParagraphsForSiyuanSave(markdown: string): string {
  const normalized = normalizeMarkdownForSave(markdown);

  if (!normalized.trim()) {
    return normalized.length > 0 ? SIYUAN_EMPTY_PARAGRAPH_MARKER : normalized;
  }

  const lines = normalized.split("\n");
  const result: string[] = [];
  let activeFence: string | null = null;

  for (let index = 0; index < lines.length; ) {
    if (activeFence && isBlankMarkdownLine(lines[index] ?? "")) {
      result.push(lines[index] ?? "");
      index += 1;
      continue;
    }

    if (!isBlankMarkdownLine(lines[index] ?? "")) {
      const line = lines[index] ?? "";

      result.push(line);
      activeFence = getNextFenceState(line, activeFence);
      index += 1;
      continue;
    }

    const runStart = index;

    while (index < lines.length && isBlankMarkdownLine(lines[index] ?? "")) {
      index += 1;
    }

    result.push(...createBlankRunSaveLines(lines, runStart, index, normalized.endsWith("\n")));
  }

  return result.join("\n");
}

export function normalizePastedMarkdown(markdown: string): string {
  const normalized = normalizeMarkdownForSave(markdown);
  return dedentLikelyMarkdown(stripOuterMarkdownFence(normalized));
}

function stripOuterMarkdownFence(markdown: string): string {
  const match = markdown.match(
    /^\s*(`{3,}|~{3,})[ \t]*(?:markdown|md|mdx)?[^\n]*\n([\s\S]*?)\n\1[ \t]*\s*$/i,
  );

  return match ? match[2] ?? "" : markdown;
}

function dedentLikelyMarkdown(markdown: string): string {
  const lines = markdown.split("\n");
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0);

  if (nonEmptyLines.length < 2) {
    return markdown;
  }

  const minLeadingSpaces = Math.min(
    ...nonEmptyLines.map((line) => line.match(/^ */)?.[0].length ?? 0),
  );
  const stripSpaces = Math.floor(minLeadingSpaces / 4) * 4;

  if (stripSpaces <= 0) {
    return markdown;
  }

  const prefix = " ".repeat(stripSpaces);
  const dedented = lines
    .map((line) => (line.startsWith(prefix) ? line.slice(stripSpaces) : line))
    .join("\n");

  return looksLikeMarkdown(dedented) ? dedented : markdown;
}

function looksLikeMarkdown(markdown: string): boolean {
  return /(^|\n)\s{0,3}(#{1,6}\s|[-+*]\s|\d+\.\s|>\s|```|~~~|\|.+\|)/.test(markdown);
}

function createBlankRunSaveLines(
  lines: string[],
  runStart: number,
  runEnd: number,
  endsWithNewline: boolean,
): string[] {
  const runLength = runEnd - runStart;
  const hasPreviousContent = runStart > 0;
  const hasNextContent = runEnd < lines.length;
  const hasExplicitWhitespaceLine = lines
    .slice(runStart, runEnd)
    .some((line) => line.length > 0);

  if (hasPreviousContent && hasNextContent) {
    const markerCount = Math.max(
      hasExplicitWhitespaceLine ? 1 : 0,
      Math.ceil((runLength - 1) / 2),
    );

    return createSeparatedEmptyParagraphLines(markerCount, {
      leadingSeparator: true,
      trailingSeparator: true,
    });
  }

  if (hasNextContent) {
    return createSeparatedEmptyParagraphLines(Math.ceil(runLength / 2), {
      leadingSeparator: false,
      trailingSeparator: true,
    });
  }

  if (hasPreviousContent) {
    const trailingLineBreakOnly = endsWithNewline ? 1 : 0;
    const markerCount = Math.ceil(Math.max(0, runLength - trailingLineBreakOnly) / 2);

    return createSeparatedEmptyParagraphLines(markerCount, {
      leadingSeparator: true,
      trailingSeparator: false,
    });
  }

  return createSeparatedEmptyParagraphLines(Math.ceil(runLength / 2), {
    leadingSeparator: false,
    trailingSeparator: false,
  });
}

function createSeparatedEmptyParagraphLines(
  markerCount: number,
  options: { leadingSeparator: boolean; trailingSeparator: boolean },
): string[] {
  if (markerCount <= 0) {
    return options.leadingSeparator || options.trailingSeparator ? [""] : [];
  }

  const lines: string[] = [];

  if (options.leadingSeparator) {
    lines.push("");
  }

  for (let index = 0; index < markerCount; index += 1) {
    if (index > 0) {
      lines.push("");
    }

    lines.push(SIYUAN_EMPTY_PARAGRAPH_MARKER);
  }

  if (options.trailingSeparator) {
    lines.push("");
  }

  return lines;
}

function isBlankMarkdownLine(line: string): boolean {
  return line.trim().length === 0;
}

function getNextFenceState(line: string, activeFence: string | null): string | null {
  const match = line.match(/^[ \t]*(`{3,}|~{3,})/);

  if (!match) {
    return activeFence;
  }

  const fence = match[1] ?? "";

  if (!activeFence) {
    return fence;
  }

  return fence[0] === activeFence[0] && fence.length >= activeFence.length
    ? null
    : activeFence;
}

function removeOneSiyuanFrontMatter(markdown: string): {
  markdown: string;
  removed: boolean;
} {
  const match = markdown.match(/^(\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);

  if (!match || !isSiyuanExportFrontMatter(match[2] ?? "")) {
    return { markdown, removed: false };
  }

  return {
    markdown: markdown.slice(match[0].length).replace(/^\r?\n/, ""),
    removed: true,
  };
}

function isSiyuanExportFrontMatter(frontMatter: string): boolean {
  const keys = new Set(
    frontMatter
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*([A-Za-z][\w-]*)\s*:/)?.[1]?.toLowerCase())
      .filter((key): key is string => Boolean(key)),
  );

  return Array.from(SIYUAN_FRONT_MATTER_KEYS).every((key) => keys.has(key));
}

function removeLeadingDocTitleHeadings(
  markdown: string,
  docTitle: string | null | undefined,
): {
  markdown: string;
  removedCount: number;
} {
  const normalizedDocTitle = normalizeHeadingText(docTitle ?? "");

  if (!normalizedDocTitle) {
    return { markdown, removedCount: 0 };
  }

  let nextMarkdown = markdown;
  let removedCount = 0;

  while (true) {
    const next = removeOneLeadingDocTitleHeading(nextMarkdown, normalizedDocTitle);

    if (!next.removed) {
      return { markdown: nextMarkdown, removedCount };
    }

    nextMarkdown = next.markdown;
    removedCount += 1;
  }
}

function removeOneLeadingDocTitleHeading(
  markdown: string,
  normalizedDocTitle: string,
): {
  markdown: string;
  removed: boolean;
} {
  const match = markdown.match(/^((?:[ \t]*\n)*)(#[ \t]+[^\n]*)(?:\n|$)/);

  if (!match) {
    return { markdown, removed: false };
  }

  const headingText = parseAtxH1Text(match[2] ?? "");

  if (normalizeHeadingText(headingText) !== normalizedDocTitle) {
    return { markdown, removed: false };
  }

  return {
    markdown: markdown.slice(match[0].length).replace(/^(?:[ \t]*\n)+/, ""),
    removed: true,
  };
}

function parseAtxH1Text(line: string): string {
  return line
    .replace(/^#[ \t]+/, "")
    .replace(/[ \t]+#+[ \t]*$/, "")
    .trim();
}

function normalizeHeadingText(text: string): string {
  return text
    .replace(/\\([\\`*_[\]{}()#+\-.!>])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
