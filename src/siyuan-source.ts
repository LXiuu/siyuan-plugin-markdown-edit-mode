import {
  areSiyuanMarkdownBlocksEquivalent,
  hasSingleMarkdownTopLevelBlock,
  haveSameSafeContainerStructure,
  parseGfmTable,
  parseSiyuanMarkdownBlock,
} from "./siyuan-markdown-structure";

export interface SiyuanChildBlockData {
  id: string;
  type: string;
  subType?: string | null;
  content?: string | null;
  markdown?: string | null;
}

export interface SiyuanBlockTreeNode extends SiyuanChildBlockData {
  children: SiyuanBlockTreeNode[];
}

export type SiyuanBlockPresentation = "editable-source" | "locked-source" | "card";

export interface SiyuanSourceBlock {
  id: string;
  type: string;
  subType: string | null;
  content: string;
  markdown: string;
  serverMarkdown: string;
  from: number;
  to: number;
  editable: boolean;
  presentation: SiyuanBlockPresentation;
}

export interface MappedSiyuanSourceBlock {
  id: string;
  from: number;
  to: number;
}

export interface SiyuanSourceDocument {
  markdown: string;
  blocks: SiyuanSourceBlock[];
  rootKramdown: string;
}

export interface SiyuanBlockEdit {
  id: string;
  type: string;
  subType: string | null;
  markdown: string;
  from: number;
  to: number;
}

export type SiyuanBlockValidationIssue =
  | "protected"
  | "changed-type"
  | "multiple-blocks"
  | "invalid-fence"
  | "changed-structure"
  | "invalid-table";

export interface SiyuanBlockValidationResult {
  valid: boolean;
  nextType?: string;
  issue?: SiyuanBlockValidationIssue;
}

const EDITABLE_BLOCK_TYPES = new Set(["p", "h", "c", "m", "tb", "l", "b", "t", "html"]);
const EMPTY_PARAGRAPH_MARKER = "\u200D";
const CONVERTIBLE_LEAF_TYPES = new Set(["p", "h", "c", "m", "tb", "html"]);
const SAFE_EDIT_TARGET_TYPES = new Set(["p", "h", "c", "m", "tb", "html", "l", "b"]);
const CARD_BLOCK_TYPES = new Set([
  "s",
  "query_embed",
  "av",
  "iframe",
  "video",
  "audio",
  "widget",
]);

export function createSiyuanSourceDocument(
  children: readonly SiyuanChildBlockData[],
  rootKramdown: string,
): SiyuanSourceDocument {
  const blocks: SiyuanSourceBlock[] = [];
  let markdown = "";

  children.forEach((child, index) => {
    if (index > 0) {
      markdown += "\n\n";
    }

    const source = getSiyuanChildBlockSource(child);
    const from = markdown.length;
    markdown += source;
    const editable =
      EDITABLE_BLOCK_TYPES.has(child.type) &&
      !hasKnownLossySiyuanSource(child.type, source);

    blocks.push({
      id: child.id,
      type: child.type,
      subType: child.subType ?? null,
      content: child.content ?? "",
      markdown: source,
      serverMarkdown: source,
      from,
      to: markdown.length,
      editable,
      presentation: editable
        ? "editable-source"
        : CARD_BLOCK_TYPES.has(child.type)
          ? "card"
          : "locked-source",
    });
  });

  return {
    markdown,
    blocks,
    rootKramdown,
  };
}

export function collectSiyuanBlockEdits(
  sourceDocument: SiyuanSourceDocument,
  mappedBlocks: readonly MappedSiyuanSourceBlock[],
  currentMarkdown: string,
): SiyuanBlockEdit[] {
  assertSiyuanSourceStructure(sourceDocument, mappedBlocks, currentMarkdown);

  const mappedById = new Map(mappedBlocks.map((block) => [block.id, block]));

  return sourceDocument.blocks.flatMap((block) => {
    const mapped = mappedById.get(block.id);

    if (!mapped) {
      throw new Error("Missing source range for SiYuan block " + block.id);
    }

    const markdown = currentMarkdown.slice(mapped.from, mapped.to);

    if (markdown === block.markdown) {
      return [];
    }

    return [{
      id: block.id,
      type: block.type,
      subType: block.subType,
      markdown,
      from: mapped.from,
      to: mapped.to,
    }];
  });
}

function assertSiyuanSourceStructure(
  sourceDocument: SiyuanSourceDocument,
  mappedBlocks: readonly MappedSiyuanSourceBlock[],
  currentMarkdown: string,
) {
  const mappedById = new Map(mappedBlocks.map((block) => [block.id, block]));
  let previousTo = 0;

  sourceDocument.blocks.forEach((block, index) => {
    const mapped = mappedById.get(block.id);

    if (!mapped) {
      throw new Error("Missing source range for SiYuan block " + block.id);
    }

    if (
      !Number.isInteger(mapped.from) ||
      !Number.isInteger(mapped.to) ||
      mapped.from < previousTo ||
      mapped.to < mapped.from ||
      mapped.to > currentMarkdown.length
    ) {
      throw new Error("SiYuan source block boundaries changed");
    }

    const expectedSeparator = index === 0 ? "" : "\n\n";

    if (currentMarkdown.slice(previousTo, mapped.from) !== expectedSeparator) {
      throw new Error("SiYuan source block boundaries changed");
    }

    previousTo = mapped.to;
  });

  if (
    mappedBlocks.length !== sourceDocument.blocks.length ||
    mappedById.size !== sourceDocument.blocks.length ||
    currentMarkdown.slice(previousTo) !== ""
  ) {
    throw new Error("SiYuan source block boundaries changed");
  }
}

export function matchesSiyuanSourceSnapshot(
  sourceDocument: SiyuanSourceDocument,
  children: readonly SiyuanChildBlockData[],
): boolean {
  if (sourceDocument.blocks.length !== children.length) {
    return false;
  }

  return sourceDocument.blocks.every((block, index) => {
    const child = children[index];
    return Boolean(
      child &&
      child.id === block.id &&
      child.type === block.type &&
      getSiyuanChildBlockSource(child) === block.serverMarkdown,
    );
  });
}

export function matchesSiyuanKramdownSnapshot(before: string, after: string): boolean {
  return canonicalizeSiyuanKramdownSnapshot(before) === canonicalizeSiyuanKramdownSnapshot(after);
}

export function validateSiyuanBlockEdit(
  block: SiyuanSourceBlock,
  markdown: string,
): SiyuanBlockValidationResult {
  if (!block.editable) {
    return { valid: false, issue: "protected" };
  }

  // SiYuan exposes the payload of some native HTML blocks without the outer
  // <div> wrapper that is present in getBlockKramdown. Such payloads (for
  // example <ruby>) are valid HTML-block contents even though a Markdown
  // parser classifies them as an ordinary paragraph. Never infer a type
  // conversion from that stripped payload: the writer restores the original
  // Kramdown envelope and keeps the block an HTML block.
  if (block.type === "html") {
    return { valid: true };
  }

  const nextType = detectSiyuanMarkdownBlockType(markdown);
  const targetIssue = validateSiyuanEditTarget(markdown, nextType);

  if (targetIssue) {
    return { valid: false, issue: targetIssue };
  }

  if ((block.type === "l" || block.type === "b") && nextType !== block.type) {
    return isSafeContainerUnwrap(block.markdown, block.type, nextType)
      ? { valid: true, nextType }
      : { valid: false, issue: "changed-structure" };
  }

  if (block.type === "l" || block.type === "b") {
    return nextType === block.type &&
      haveSameSafeContainerStructure(block.markdown, markdown, block.type)
      ? { valid: true }
      : { valid: false, issue: "changed-structure" };
  }

  if (block.type === "t") {
    return nextType === "t"
      ? { valid: true }
      : { valid: false, issue: "changed-type" };
  }

  if (!CONVERTIBLE_LEAF_TYPES.has(block.type)) {
    return { valid: false, issue: "protected" };
  }

  if (!SAFE_EDIT_TARGET_TYPES.has(nextType)) {
    return { valid: false, issue: "changed-type" };
  }

  if (isSetextHeadingSyntax(markdown) && !isSetextHeadingSyntax(block.markdown)) {
    return { valid: false, issue: "changed-type" };
  }

  return nextType === block.type
    ? { valid: true }
    : { valid: true, nextType };
}

function isSafeContainerUnwrap(
  markdown: string,
  containerType: "l" | "b",
  nextType: string,
): boolean {
  if (!SAFE_EDIT_TARGET_TYPES.has(nextType) || nextType === "l" || nextType === "b") {
    return false;
  }

  const parsed = parseSiyuanMarkdownBlock(markdown);

  if (
    !parsed ||
    parsed.root.type !== containerType ||
    parsed.root.children.length !== 1
  ) {
    return false;
  }

  const containerChild = parsed.root.children[0];
  const leaf = containerType === "l"
    ? containerChild?.type === "i" && containerChild.children.length === 1
      ? containerChild.children[0]
      : null
    : containerChild;

  return Boolean(
    leaf &&
    leaf.type === nextType &&
    leaf.children.length === 0,
  );
}

function validateSiyuanEditTarget(
  markdown: string,
  nextType: string,
): SiyuanBlockValidationIssue | null {
  const normalized = markdown.replace(/\r\n?/g, "\n");

  if (/^[ ]{0,3}(?:`{3,}|~{3,})/.test(normalized)) {
    return isSingleFencedCodeBlock(normalized) ? null : "invalid-fence";
  }

  if (normalized.split("\n")[0]?.trim() === "$$") {
    return isSingleMathBlock(normalized) ? null : "invalid-fence";
  }

  if (nextType === "p") {
    if (normalized.trim() === "") {
      return null;
    }

    if (isStandaloneIndentedCodeSyntax(normalized)) {
      return "changed-type";
    }

    return hasSingleMarkdownTopLevelBlock(normalized) ? null : "multiple-blocks";
  }

  if (nextType === "h") {
    return isAtxHeadingSyntax(normalized) ? null : "changed-type";
  }

  if (nextType === "c") {
    return isSingleFencedCodeBlock(normalized) ? null : "invalid-fence";
  }

  if (nextType === "m") {
    return isSingleMathBlock(normalized) ? null : "invalid-fence";
  }

  if (nextType === "tb") {
    return isThematicBreak(normalized) ? null : "changed-type";
  }

  if (nextType === "l" || nextType === "b") {
    return parseSiyuanMarkdownBlock(normalized)?.root.type === nextType
      ? null
      : "changed-structure";
  }

  if (nextType === "t") {
    return parseGfmTable(normalized) ? null : "invalid-table";
  }

  if (nextType === "html") {
    return parseSiyuanMarkdownBlock(normalized)?.root.type === "html"
      ? null
      : "changed-type";
  }

  return "changed-type";
}

export function detectSiyuanMarkdownBlockType(markdown: string): string {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const trimmed = normalized.trim();

  if (!trimmed) {
    return "p";
  }

  if (isSingleFencedCodeBlock(normalized)) {
    return "c";
  }

  if (isSingleMathBlock(normalized)) {
    return "m";
  }

  if (isAtxHeadingSyntax(normalized)) {
    return "h";
  }

  if (isThematicBreak(normalized)) {
    return "tb";
  }

  if (/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+/.test(normalized)) {
    return "l";
  }

  if (/^[ \t]*>/.test(normalized)) {
    return "b";
  }

  if (/^[ \t]*\{\{\{(?:col|row)\b/.test(normalized)) {
    return "s";
  }

  if (/^[ \t]*\{\{[\s\S]*}}[ \t]*$/.test(normalized)) {
    return "query_embed";
  }

  if (/^[ \t]*<(?:div|iframe)\b[^>]*\bdata-type=["\']NodeWidget["\']/i.test(normalized)) {
    return "widget";
  }

  if (/^[ \t]*<div\b[^>]*\bdata-type=["']NodeAttributeView["']/i.test(normalized)) {
    return "av";
  }

  if (/^[ \t]*<iframe\b/i.test(normalized)) {
    return "iframe";
  }

  if (/^[ \t]*<video\b/i.test(normalized)) {
    return "video";
  }

  if (/^[ \t]*<audio\b/i.test(normalized)) {
    return "audio";
  }

  if (looksLikeMarkdownTable(normalized)) {
    return "t";
  }

  if (/^[ \t]*<(?:address|article|aside|base|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)\b/i.test(normalized)) {
    return "html";
  }

  return "p";
}

function isAtxHeadingSyntax(markdown: string): boolean {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const line = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  return (
    !line.includes("\n") &&
    /^[ ]{0,3}#{1,6}(?:[ \t]+[^\n]*)?[ \t]*$/.test(line)
  );
}

function isSetextHeadingSyntax(markdown: string): boolean {
  const parsed = parseSiyuanMarkdownBlock(markdown);
  return Boolean(parsed?.root.type === "h" && !isAtxHeadingSyntax(markdown));
}

function isStandaloneIndentedCodeSyntax(markdown: string): boolean {
  const parsed = parseSiyuanMarkdownBlock(markdown);
  return Boolean(
    parsed?.root.type === "c" &&
    !isSingleFencedCodeBlock(markdown) &&
    /^(?: {4}|\t)/.test(markdown.replace(/\r\n?/g, "\n"))
  );
}

export function movePositionOutsideProtectedBlock(
  sourceDocument: SiyuanSourceDocument,
  position: number,
): number {
  const block = sourceDocument.blocks.find(
    (candidate) => !candidate.editable && position > candidate.from && position < candidate.to,
  );

  if (!block) {
    return position;
  }

  return position - block.from <= block.to - position ? block.from : block.to;
}

export function summarizeSiyuanBlock(block: SiyuanSourceBlock, maxLength = 120): string {
  const source = (block.content || block.markdown)
    .replace(/\s+/g, " ")
    .trim();

  if (source.length <= maxLength) {
    return source;
  }

  return source.slice(0, Math.max(0, maxLength - 1)).trimEnd() + "…";
}

function hasKnownLossySiyuanSource(type: string, markdown: string): boolean {
  return type === "p" && /<br\s*\/?>/i.test(markdown);
}

export function getSiyuanChildBlockSource(child: SiyuanChildBlockData): string {
  if (typeof child.markdown === "string") {
    if (
      child.type === "p" &&
      child.markdown === EMPTY_PARAGRAPH_MARKER &&
      (child.content === null ||
        child.content === undefined ||
        child.content === "" ||
        child.content === EMPTY_PARAGRAPH_MARKER)
    ) {
      return "";
    }

    return child.markdown;
  }

  if (
    child.type === "p" &&
    (child.content === null ||
      child.content === undefined ||
      child.content === "" ||
      child.content === EMPTY_PARAGRAPH_MARKER)
  ) {
    return "";
  }

  if (EDITABLE_BLOCK_TYPES.has(child.type)) {
    throw new Error("Missing Markdown source for editable SiYuan block " + child.id);
  }

  return child.content ?? "";
}

export function getSiyuanBlockIal(blockId: string, blockKramdown: string): string {
  const match = findSiyuanBlockIal(blockId, blockKramdown);

  if (!match) {
    throw new Error("Missing block IAL for SiYuan block " + blockId);
  }

  return match.ial;
}

export function matchesSiyuanKramdownIals(before: string, after: string): boolean {
  const beforeIals = collectSiyuanKramdownIals(before);
  const afterIals = collectSiyuanKramdownIals(after);

  return (
    beforeIals.size === afterIals.size &&
    Array.from(beforeIals).every(([id, attributes]) => {
      const other = afterIals.get(id);
      return Boolean(
        other &&
        attributes.size === other.size &&
        Array.from(attributes).every(([key, value]) => other.get(key) === value),
      );
    })
  );
}

export function matchesSiyuanBlockIal(
  blockId: string,
  beforeKramdown: string,
  afterKramdown: string,
): boolean {
  try {
    const before = parseSiyuanBlockIal(getSiyuanBlockIal(blockId, beforeKramdown));
    const after = parseSiyuanBlockIal(getSiyuanBlockIal(blockId, afterKramdown));

    return (
      before.size === after.size &&
      Array.from(before).every(([key, value]) => after.get(key) === value)
    );
  } catch {
    return false;
  }
}

export function prepareSiyuanBlockSourceForUpdate(
  blockId: string,
  type: string,
  markdown: string,
  blockKramdown: string,
  originalMarkdown = markdown,
): string {
  const source = type === "p" && markdown.length === 0 ? EMPTY_PARAGRAPH_MARKER : markdown;
  const ialMatch = findSiyuanBlockIal(blockId, blockKramdown);

  if (!ialMatch) {
    throw new Error("Missing block IAL for SiYuan block " + blockId);
  }

  if (type === "html") {
    return prepareSiyuanHtmlBlockSourceForUpdate(
      blockId,
      source,
      originalMarkdown,
      blockKramdown,
      ialMatch,
    );
  }

  return source + (source.endsWith("\n") ? "" : "\n") + ialMatch.ial;
}

function prepareSiyuanHtmlBlockSourceForUpdate(
  blockId: string,
  markdown: string,
  originalMarkdown: string,
  blockKramdown: string,
  ialMatch: SiyuanIalMatch,
): string {
  const beforeIal = blockKramdown.slice(0, ialMatch.from);
  const lineBreakMatch = beforeIal.match(/(\r?\n)$/);

  if (!lineBreakMatch) {
    throw new Error("HTML block Kramdown envelope changed for " + blockId);
  }

  const ialSeparator = lineBreakMatch[1] ?? "\n";
  const body = beforeIal.slice(0, -ialSeparator.length);

  if (body === originalMarkdown) {
    if (detectSiyuanMarkdownBlockType(markdown) === "html") {
      return markdown + (markdown.endsWith("\n") ? "" : ialSeparator) + ialMatch.ial;
    }

    return (
      "<div>" +
      ialSeparator +
      markdown +
      (markdown.endsWith(ialSeparator) ? "" : ialSeparator) +
      "</div>" +
      ialSeparator +
      ialMatch.ial
    );
  }

  const opening = body.match(/^<div\b[^>]*>(\r?\n)/i);
  const closing = body.match(/(\r?\n)<\/div>$/i);

  if (!opening || !closing) {
    throw new Error("HTML block Kramdown envelope changed for " + blockId);
  }

  const payloadFrom = opening[0].length;
  const payloadTo = body.length - closing[0].length;

  if (body.slice(payloadFrom, payloadTo) !== originalMarkdown) {
    throw new Error("HTML block Kramdown source changed for " + blockId);
  }

  return (
    body.slice(0, payloadFrom) +
    markdown +
    body.slice(payloadTo) +
    ialSeparator +
    ialMatch.ial
  );
}

export interface SiyuanListItemControlEdit {
  originalMarker: string;
  nextMarker: string;
  originalTaskMarker: string | null;
  nextTaskMarker: string | null;
}

export function prepareSiyuanListItemSourceForUpdate(
  blockId: string,
  blockKramdown: string,
  edit: SiyuanListItemControlEdit,
): string {
  const normalized = blockKramdown.replace(/\r\n?/g, "\n");
  const markerMatch = normalized.match(/^([ \t]*)([-+*]|\d+[.)])/);

  if (!markerMatch || markerMatch[2] !== edit.originalMarker) {
    throw new Error("List item marker changed outside source mode for " + blockId);
  }

  let prepared =
    (markerMatch[1] ?? "") +
    edit.nextMarker +
    normalized.slice(markerMatch[0].length);

  if (edit.originalTaskMarker === null && edit.nextTaskMarker === null) {
    return prepared;
  }

  if (edit.originalTaskMarker === null || edit.nextTaskMarker === null) {
    throw new Error("Task list structure changed for " + blockId);
  }

  const itemIal = findSiyuanBlockIal(blockId, prepared);

  if (!itemIal) {
    throw new Error("Missing block IAL for SiYuan block " + blockId);
  }

  const afterIal = prepared.slice(itemIal.to);
  const taskMatch = afterIal.match(/^[ \t]*(\[[ xX]\])/);

  if (!taskMatch || taskMatch[1] !== edit.originalTaskMarker) {
    throw new Error("Task marker changed outside source mode for " + blockId);
  }

  const taskFrom = itemIal.to + taskMatch[0].lastIndexOf(taskMatch[1]);
  return prepared.slice(0, taskFrom) + edit.nextTaskMarker +
    prepared.slice(taskFrom + taskMatch[1].length);
}

export { areSiyuanMarkdownBlocksEquivalent };

function parseSiyuanBlockIal(ial: string): ReadonlyMap<string, string> {
  const body = ial.slice(2, -1);
  const attributes = new Map<string, string>();
  const attributePattern = /\s*([^\s=]+)=("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gy;
  let index = 0;

  while (index < body.length) {
    if (body.slice(index).trim() === "") {
      break;
    }

    attributePattern.lastIndex = index;
    const match = attributePattern.exec(body);

    if (!match || !match[1] || !match[2] || attributes.has(match[1])) {
      throw new Error("Invalid SiYuan block IAL");
    }

    attributes.set(match[1], match[2]);
    index = attributePattern.lastIndex;
  }

  return attributes;
}

interface SiyuanIalMatch {
  ial: string;
  from: number;
  to: number;
}

function findSiyuanBlockIal(blockId: string, source: string): SiyuanIalMatch | null {
  let cursor = 0;

  while (cursor < source.length) {
    const from = source.indexOf("{:", cursor);

    if (from < 0) {
      return null;
    }

    const end = findSiyuanIalEnd(source, from);

    if (end < 0) {
      return null;
    }

    const ial = source.slice(from, end + 1);

    try {
      const attributes = parseSiyuanBlockIal(ial);
      const id = attributes.get("id");

      if (id && unquoteSiyuanIalValue(id) === blockId) {
        return { ial, from, to: end + 1 };
      }
    } catch {
      // Literal or malformed Kramdown text is not a block IAL.
    }

    cursor = end + 1;
  }

  return null;
}

function collectSiyuanKramdownIals(
  source: string,
): ReadonlyMap<string, ReadonlyMap<string, string>> {
  const result = new Map<string, ReadonlyMap<string, string>>();
  let cursor = 0;

  while (cursor < source.length) {
    const from = source.indexOf("{:", cursor);

    if (from < 0) {
      break;
    }

    const end = findSiyuanIalEnd(source, from);

    if (end < 0) {
      break;
    }

    const ial = source.slice(from, end + 1);

    try {
      const attributes = parseSiyuanBlockIal(ial);
      const id = attributes.get("id");

      if (id) {
        result.set(unquoteSiyuanIalValue(id), attributes);
      }
    } catch {
      // Literal or malformed Kramdown text is not a block IAL.
    }

    cursor = end + 1;
  }

  return result;
}

function unquoteSiyuanIalValue(value: string): string {
  return value.length >= 2 ? value.slice(1, -1) : value;
}

function canonicalizeSiyuanKramdownSnapshot(kramdown: string): string {
  const lines = kramdown.replace(/\r\n?/g, "\n").split("\n");
  let fenceCharacter: "`" | "~" | null = null;
  let fenceLength = 0;

  return lines.map((line) => {
    if (fenceCharacter) {
      const closingFence = getKramdownFenceMarker(line, true);

      if (
        closingFence &&
        closingFence.character === fenceCharacter &&
        closingFence.length >= fenceLength
      ) {
        fenceCharacter = null;
        fenceLength = 0;
      }

      return line;
    }

    const openingFence = getKramdownFenceMarker(line, false);

    if (openingFence) {
      fenceCharacter = openingFence.character;
      fenceLength = openingFence.length;
      return line;
    }

    return canonicalizeSiyuanIalsInLine(line);
  }).join("\n");
}

function canonicalizeSiyuanIalsInLine(line: string): string {
  let canonical = "";
  let index = 0;
  let inlineCodeDelimiterLength = 0;

  while (index < line.length) {
    if (line.charAt(index) === "`") {
      let runLength = 1;

      while (line.charAt(index + runLength) === "`") {
        runLength += 1;
      }

      if (inlineCodeDelimiterLength === 0) {
        inlineCodeDelimiterLength = runLength;
      } else if (runLength === inlineCodeDelimiterLength) {
        inlineCodeDelimiterLength = 0;
      }

      canonical += line.slice(index, index + runLength);
      index += runLength;
      continue;
    }

    if (
      inlineCodeDelimiterLength === 0 &&
      line.startsWith("{:", index) &&
      !isEscapedMarkdownCharacter(line, index)
    ) {
      const ialEnd = findSiyuanIalEnd(line, index);

      if (ialEnd >= 0) {
        const ial = line.slice(index, ialEnd + 1);

        try {
          canonical += canonicalizeSiyuanIal(ial);
          index = ialEnd + 1;
          continue;
        } catch {
          // Keep malformed or literal text byte-for-byte comparable.
        }
      }
    }

    canonical += line.charAt(index);
    index += 1;
  }

  return canonical;
}

function canonicalizeSiyuanIal(ial: string): string {
  const attributes = Array.from(parseSiyuanBlockIal(ial)).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const canonicalAttributes = attributes.map(([key, value]) => `${key}=${value}`).join(" ");
  return `{:${canonicalAttributes ? " " + canonicalAttributes : ""}}`;
}

function findSiyuanIalEnd(line: string, start: number): number {
  let quote: "\"" | "'" | null = null;
  let escaped = false;

  for (let index = start + 2; index < line.length; index += 1) {
    const character = line.charAt(index);

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
    } else if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === "}") {
      return index;
    }
  }

  return -1;
}

function isEscapedMarkdownCharacter(line: string, index: number): boolean {
  let backslashCount = 0;

  for (let cursor = index - 1; cursor >= 0 && line.charAt(cursor) === "\\"; cursor -= 1) {
    backslashCount += 1;
  }

  return backslashCount % 2 === 1;
}

function getKramdownFenceMarker(
  line: string,
  closingOnly: boolean,
): { character: "`" | "~"; length: number } | null {
  const match = line.match(
    closingOnly
      ? /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/
      : /^[ \t]{0,3}(`{3,}|~{3,})/,
  );
  const marker = match?.[1];

  if (!marker) {
    return null;
  }

  return {
    character: marker[0] as "`" | "~",
    length: marker.length,
  };
}

function containsParagraphBreakingSyntax(markdown: string): boolean {
  const normalized = markdown.replace(/\r\n?/g, "\n");

  if (/\n[ \t]*\n/.test(normalized)) {
    return true;
  }

  const lines = normalized.split("\n");
  return lines.slice(1).some((line) => isMarkdownBlockStarter(line));
}

function isMarkdownBlockStarter(line: string): boolean {
  return (
    /^[ \t]*(?:#{1,6}[ \t]+|>|(?:[-+*]|\d+[.)])[ \t]+|\x60{3,}|~{3,}|\$\$[ \t]*$)/.test(line) ||
    isThematicBreak(line) ||
    /^[ \t]*\{\{/.test(line) ||
    /^[ \t]*<(?:div|table|iframe|video|audio|script|style)\b/i.test(line)
  );
}

function hasSameFencedCodeMarkers(original: string, next: string): boolean {
  const originalMarkers = getFencedCodeMarkers(original);
  const nextMarkers = getFencedCodeMarkers(next);

  return Boolean(
    originalMarkers &&
    nextMarkers &&
    originalMarkers[0] === nextMarkers[0] &&
    originalMarkers[1] === nextMarkers[1],
  );
}

function isSingleFencedCodeBlock(markdown: string): boolean {
  return (
    getFencedCodeMarkers(markdown) !== null &&
    parseSiyuanMarkdownBlock(markdown)?.root.type === "c"
  );
}

function getFencedCodeMarkers(markdown: string): readonly [string, string] | null {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const opening = lines[0]?.match(/^([ ]{0,3})(\x60{3,}|~{3,})[^\n]*$/);

  if (!opening) {
    return null;
  }

  let lastContentIndex = lines.length - 1;

  while (lastContentIndex > 0 && lines[lastContentIndex]?.trim() === "") {
    lastContentIndex -= 1;
  }

  if (lastContentIndex <= 0) {
    return null;
  }

  const openingFence = opening[2] ?? "";
  const closing = (lines[lastContentIndex] ?? "").match(
    /^([ ]{0,3})(\x60{3,}|~{3,})[ \t]*$/,
  );

  if (
    !closing ||
    closing[2]?.[0] !== openingFence[0] ||
    (closing[2]?.length ?? 0) < openingFence.length
  ) {
    return null;
  }

  return [(opening[1] ?? "") + openingFence, (closing[1] ?? "") + (closing[2] ?? "")];
}

function isSingleMathBlock(markdown: string): boolean {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");

  if (lines[0]?.trim() !== "$$") {
    return false;
  }

  let lastContentIndex = lines.length - 1;

  while (lastContentIndex > 0 && lines[lastContentIndex]?.trim() === "") {
    lastContentIndex -= 1;
  }

  return lastContentIndex > 0 && lines[lastContentIndex]?.trim() === "$$";
}

function isThematicBreak(markdown: string): boolean {
  const trimmed = markdown.trim();
  return !trimmed.includes("\n") && /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(trimmed);
}

function looksLikeMarkdownTable(markdown: string): boolean {
  const lines = markdown.split("\n");

  if (lines.length < 2 || !lines[0]?.includes("|")) {
    return false;
  }

  const separator = (lines[1] ?? "").trim();
  const cells = separator
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|");

  return cells.length > 0 && cells.every((cell) => /^[ \t]*:?-{3,}:?[ \t]*$/.test(cell));
}
