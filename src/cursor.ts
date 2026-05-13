import { normalizeMarkdownForSave } from "./markdown";

export interface ProtyleCursorHint {
  blockMarkdown: string | null;
  blockText: string;
  blockType?: string | null;
  documentEdge?: "start" | "end";
  tableRowIndex?: number;
  tableCellIndex?: number;
  tableCellTextOffset?: number;
  sourceBlockEdge?: "start" | "end";
  textBeforeCursor: string;
  textAfterCursor: string;
  contextBefore: string;
  contextAfter: string;
  textOffset: number;
  occurrenceIndex: number;
  occurrenceMode?: "markdown" | "text";
  textOccurrenceIndex?: number;
  blockIndex: number;
  blockCount?: number;
  documentRatio: number;
  viewportY: number | null;
}

interface LuteLike {
  BlockDOM2Md(html: string): string;
  BlockDOM2StdMd(html: string): string;
}

interface TextRange {
  start: number;
  end: number;
}

interface CaretPosition {
  node: Node;
  offset: number;
}

interface MarkdownBlock extends TextRange {
  source: string;
}

interface IndexedMarkdownBlock extends MarkdownBlock {
  index: number;
}

interface RenderedBlockCandidate {
  element: HTMLElement;
  confidence: "exact" | "text" | "approximate";
}

interface MarkdownLine extends TextRange {
  text: string;
}

interface MarkdownTableCell extends TextRange {
  source: string;
}

interface MarkdownTableRow extends TextRange {
  cells: MarkdownTableCell[];
}

interface MarkdownVisibleProjection {
  text: string;
  chars: Array<{
    char: string;
    start: number;
    end: number;
  }>;
  hiddenRanges: TextRange[];
}

const CURSOR_CONTEXT_LENGTH = 48;
const MAX_MARKDOWN_BLOCK_COMPARISONS = 80;
const NEARBY_EXACT_BLOCK_WINDOW = 48;
const CARET_DEFENSE_WINDOW_MS = 160;

export function captureProtyleCursorHint(protyle: HTMLElement): ProtyleCursorHint | null {
  const selection = window.getSelection();

  if (!selection || selection.rangeCount === 0 || !selection.focusNode) {
    return null;
  }

  const focusNode = selection.focusNode;

  if (!protyle.contains(focusNode)) {
    return null;
  }

  const block = getClosestBlockElement(focusNode, protyle);

  if (!block) {
    return null;
  }

  const blockTextOffset = getVisibleTextOffsetBeforePosition(
    block,
    focusNode,
    selection.focusOffset,
  );
  const blockChars = getRenderedTextChars(block);
  const textBeforeCursor = getRenderedTextFromChars(blockChars.slice(0, blockTextOffset));
  const textAfterCursor = getRenderedTextFromChars(blockChars.slice(blockTextOffset));
  const blockText = normalizeTextForMatching(getRenderedTextFromChars(blockChars));
  const blockMarkdown = getBlockMarkdown(block);
  const blockType = block.getAttribute("data-type");
  const textOffset = isCodeBlockType(blockType)
    ? Array.from(textBeforeCursor).length
    : getVisibleTextLength(textBeforeCursor);
  const renderedBlocks = getRenderedBlocks(protyle);
  const occurrenceCounts = getPreviousSimilarRenderedBlockCounts(
    block,
    blockMarkdown,
    blockText,
    renderedBlocks,
  );
  const blockIndex = renderedBlocks.indexOf(block);
  const renderedBlockCount = renderedBlocks.length;
  const viewportY = getSelectionViewportY(selection, block);
  const documentEdge = getRenderedCursorDocumentEdge(
    blockIndex,
    renderedBlockCount,
    blockTextOffset,
    blockChars.length,
  );
  const tablePosition =
    blockType === "NodeTable"
      ? getRenderedTableCursorPosition(block, focusNode, selection.focusOffset)
      : null;

  return {
    blockMarkdown,
    blockText,
    blockType,
    documentEdge,
    tableRowIndex: tablePosition?.rowIndex,
    tableCellIndex: tablePosition?.cellIndex,
    tableCellTextOffset: tablePosition?.cellTextOffset,
    sourceBlockEdge: undefined,
    textBeforeCursor: normalizeTextForMatching(textBeforeCursor),
    textAfterCursor: normalizeTextForMatching(textAfterCursor),
    contextBefore: getTrailingContext(textBeforeCursor),
    contextAfter: getLeadingContext(textAfterCursor),
    textOffset,
    occurrenceIndex: occurrenceCounts.markdownCount,
    occurrenceMode: occurrenceCounts.exactConfident ? "markdown" : "text",
    textOccurrenceIndex: occurrenceCounts.textCount,
    blockIndex,
    blockCount: renderedBlockCount,
    documentRatio: getDocumentRatio(blockIndex, renderedBlockCount),
    viewportY,
  };
}

export function resolveMarkdownCursorPosition(
  markdown: string,
  cursorHint: ProtyleCursorHint | null,
): number {
  if (!cursorHint) {
    return 0;
  }

  const normalizedMarkdown = normalizeMarkdownForSave(markdown);
  const edgePosition = resolveMarkdownDocumentEdgePosition(normalizedMarkdown, cursorHint);

  if (edgePosition !== null) {
    return edgePosition;
  }

  const exactCandidate = findExactBlockCandidate(normalizedMarkdown, cursorHint);

  if (exactCandidate) {
    return clampPosition(
      resolveMarkdownBlockCursorPosition(normalizedMarkdown, exactCandidate, cursorHint),
      normalizedMarkdown.length,
    );
  }

  return clampPosition(
    resolveByVisibleText(normalizedMarkdown, cursorHint) ??
      resolveByApproximateMarkdownBlock(normalizedMarkdown, cursorHint),
    normalizedMarkdown.length,
  );
}

export function captureMarkdownCursorHint(
  markdown: string,
  cursorPosition: number,
  viewportY: number | null = null,
): ProtyleCursorHint | null {
  const normalizedMarkdown = normalizeMarkdownForSave(markdown);
  const position = clampPosition(cursorPosition, normalizedMarkdown.length);
  const documentEdge = getMarkdownCursorDocumentEdge(normalizedMarkdown, position);
  const markdownBlocks = getMarkdownBlocks(normalizedMarkdown);
  const block = getMarkdownBlockAtPositionFromBlocks(markdownBlocks, normalizedMarkdown, position);

  if (!block) {
    return documentEdge
      ? createDocumentEdgeCursorHint(normalizedMarkdown, position, documentEdge, viewportY)
      : null;
  }

  const blockType = getMarkdownBlockType(block.source);
  const blockPosition = Math.max(0, position - block.start);
  const blockProjection = buildMarkdownVisibleProjection(block.source);
  const blockText = blockProjection.text;
  const textBeforeCursor = getMarkdownVisibleTextBeforeProjectionPosition(
    blockProjection,
    blockPosition,
  );
  const textAfterCursor = getMarkdownVisibleTextAfterProjectionPosition(
    blockProjection,
    blockPosition,
  );
  const blockIndex = markdownBlocks.findIndex(
    (candidate) => candidate.start === block.start && candidate.end === block.end,
  );
  const occurrenceCounts = getPreviousSimilarMarkdownBlockCounts(
    normalizedMarkdown,
    block.start,
    block.source,
    blockType,
    blockText,
    markdownBlocks,
  );
  const textOffset = isCodeBlockType(blockType)
    ? Array.from(textBeforeCursor).length
    : getVisibleTextLength(textBeforeCursor);
  const tablePosition =
    blockType === "NodeTable"
      ? getMarkdownTableCursorPosition(block.source, Math.max(0, position - block.start))
      : null;

  return {
    blockMarkdown: block.source.trimEnd(),
    blockText: normalizeTextForMatching(blockText),
    blockType,
    documentEdge,
    tableRowIndex: tablePosition?.rowIndex,
    tableCellIndex: tablePosition?.cellIndex,
    tableCellTextOffset: tablePosition?.cellTextOffset,
    sourceBlockEdge: getMarkdownCursorSeparatorEdge(block.source, blockPosition),
    textBeforeCursor: normalizeTextForMatching(textBeforeCursor),
    textAfterCursor: normalizeTextForMatching(textAfterCursor),
    contextBefore: getTrailingContext(textBeforeCursor),
    contextAfter: getLeadingContext(textAfterCursor),
    textOffset,
    occurrenceIndex: occurrenceCounts.markdownCount,
    occurrenceMode: block.source.trim() ? "markdown" : "text",
    textOccurrenceIndex: occurrenceCounts.textCount,
    blockIndex,
    blockCount: markdownBlocks.length,
    documentRatio: normalizedMarkdown.length > 0 ? position / normalizedMarkdown.length : 0,
    viewportY: sanitizeViewportY(viewportY),
  };
}

export function restoreProtyleCursorFromHint(
  protyle: HTMLElement,
  cursorHint: ProtyleCursorHint | null,
): boolean {
  if (!cursorHint) {
    return false;
  }

  if (cursorHint.documentEdge && restoreRenderedDocumentEdge(protyle, cursorHint)) {
    return true;
  }

  const blockCandidate = findRenderedBlockCandidate(protyle, cursorHint);

  if (!blockCandidate) {
    return false;
  }

  if (!setCaretByVisiblePrefix(blockCandidate.element, cursorHint)) {
    return false;
  }

  alignRenderedCursorToViewportY(blockCandidate.element, cursorHint.viewportY);

  return true;
}

function getRenderedCursorDocumentEdge(
  blockIndex: number,
  blockCount: number,
  blockTextOffset: number,
  blockTextLength: number,
): ProtyleCursorHint["documentEdge"] {
  if (blockCount <= 0 || blockIndex < 0) {
    return undefined;
  }

  if (blockIndex === blockCount - 1 && blockTextOffset >= blockTextLength) {
    return "end";
  }

  if (blockIndex === 0 && blockTextOffset <= 0) {
    return "start";
  }

  return undefined;
}

function getMarkdownCursorSeparatorEdge(
  source: string,
  position: number,
): ProtyleCursorHint["sourceBlockEdge"] {
  return position > source.trimEnd().length ? "end" : undefined;
}

function resolveMarkdownDocumentEdgePosition(
  markdown: string,
  cursorHint: ProtyleCursorHint,
): number | null {
  if (cursorHint.documentEdge === "start") {
    return getMarkdownSignificantContentStart(markdown);
  }

  if (cursorHint.documentEdge === "end") {
    return getMarkdownSignificantContentEnd(markdown);
  }

  return null;
}

function getMarkdownSignificantContentStart(markdown: string): number {
  const match = markdown.match(/^\s*/);
  return match ? match[0].length : 0;
}

function getMarkdownCursorDocumentEdge(
  markdown: string,
  position: number,
): ProtyleCursorHint["documentEdge"] {
  if (position <= 0) {
    return "start";
  }

  if (position >= getMarkdownSignificantContentEnd(markdown)) {
    return "end";
  }

  return undefined;
}

function getMarkdownSignificantContentEnd(markdown: string): number {
  const match = markdown.match(/\s*$/);
  return match ? markdown.length - match[0].length : markdown.length;
}

function createDocumentEdgeCursorHint(
  markdown: string,
  position: number,
  documentEdge: "start" | "end",
  viewportY: number | null,
): ProtyleCursorHint {
  const blocks = getMarkdownBlocks(markdown);
  const block = documentEdge === "end" ? blocks[blocks.length - 1] : blocks[0];
  const blockIndex = block ? blocks.indexOf(block) : 0;
  const blockType = block ? getMarkdownBlockType(block.source) : "NodeParagraph";
  const blockText = block ? markdownToVisibleText(block.source) : "";
  const blockPosition = block
    ? documentEdge === "end"
      ? block.end - block.start
      : 0
    : 0;
  const textBeforeCursor = block
    ? getMarkdownVisibleTextBeforeSourcePosition(block.source, blockPosition)
    : "";
  const textAfterCursor = block
    ? getMarkdownVisibleTextAfterSourcePosition(block.source, blockPosition)
    : "";
  const occurrenceCounts = block
    ? getPreviousSimilarMarkdownBlockCounts(markdown, block.start, block.source, blockType, blockText, blocks)
    : { markdownCount: 0, textCount: 0 };

  return {
    blockMarkdown: block?.source.trimEnd() ?? null,
    blockText: normalizeTextForMatching(blockText),
    blockType,
    documentEdge,
    tableRowIndex: undefined,
    tableCellIndex: undefined,
    tableCellTextOffset: undefined,
    sourceBlockEdge: documentEdge,
    textBeforeCursor: normalizeTextForMatching(textBeforeCursor),
    textAfterCursor: normalizeTextForMatching(textAfterCursor),
    contextBefore: getTrailingContext(textBeforeCursor),
    contextAfter: getLeadingContext(textAfterCursor),
    textOffset: isCodeBlockType(blockType)
      ? Array.from(textBeforeCursor).length
      : getVisibleTextLength(textBeforeCursor),
    occurrenceIndex: occurrenceCounts.markdownCount,
    occurrenceMode: block?.source.trim() ? "markdown" : "text",
    textOccurrenceIndex: occurrenceCounts.textCount,
    blockIndex,
    blockCount: Math.max(blocks.length, 1),
    documentRatio: markdown.length > 0 ? position / markdown.length : 0,
    viewportY: sanitizeViewportY(viewportY),
  };
}

function restoreRenderedDocumentEdge(
  protyle: HTMLElement,
  cursorHint: ProtyleCursorHint,
): boolean {
  const edge = cursorHint.documentEdge;

  if (!edge) {
    return false;
  }

  const blocks = getRenderedBlocks(protyle);
  const block = edge === "end" ? blocks[blocks.length - 1] : blocks[0];

  if (!block) {
    return false;
  }

  const position = getRenderedDocumentEdgePosition(block, edge);

  if (!position || !setCaretAtPosition(block, position)) {
    return false;
  }

  alignRenderedCursorToViewportY(block, cursorHint.viewportY);
  return true;
}

function getRenderedDocumentEdgePosition(
  block: HTMLElement,
  edge: "start" | "end",
): CaretPosition | null {
  const chars = getRenderedTextChars(block);

  if (chars.length > 0) {
    return edge === "end"
      ? getTextPositionAfterRenderedChar(chars, chars.length - 1)
      : { node: chars[0].node, offset: chars[0].start };
  }

  const editable = getDocumentEdgeEditableElement(block);

  if (!editable) {
    return null;
  }

  return {
    node: editable,
    offset: edge === "end" ? editable.childNodes.length : 0,
  };
}

function getDocumentEdgeEditableElement(root: HTMLElement): HTMLElement | null {
  if (root.matches('[contenteditable="true"]')) {
    return root;
  }

  return root.querySelector<HTMLElement>('[contenteditable="true"]') ?? root;
}

export function alignElementToViewportY(element: HTMLElement, viewportY: number | null): boolean {
  const desiredY = sanitizeViewportY(viewportY);

  if (desiredY === null) {
    element.scrollIntoView({ block: "center", inline: "nearest" });
    return true;
  }

  const currentY = getElementViewportY(element);

  if (currentY === null) {
    element.scrollIntoView({ block: "center", inline: "nearest" });
    return false;
  }

  scrollByViewportDelta(element, currentY - clampViewportY(desiredY));
  return true;
}

function getClosestBlockElement(node: Node, protyle: HTMLElement): HTMLElement | null {
  const element = node instanceof HTMLElement ? node : node.parentElement;
  const block = element?.closest<HTMLElement>(
    ".protyle-wysiwyg > [data-node-id][data-type^='Node']",
  );

  if (!block || !protyle.contains(block) || block.classList.contains("protyle-title")) {
    return null;
  }

  const type = block.getAttribute("data-type");
  return type === "NodeDocument" ? null : block;
}

function getSelectionViewportY(selection: Selection, fallbackElement: HTMLElement): number | null {
  if (selection.rangeCount === 0) {
    return getElementViewportY(fallbackElement);
  }

  const range = selection.getRangeAt(0).cloneRange();
  const rect = getRangeViewportRect(range);

  if (rect) {
    range.detach();
    return rect.top;
  }

  const collapsedRect = getCollapsedRangeViewportRect(range, selection);

  if (collapsedRect) {
    range.detach();
    return collapsedRect.top;
  }

  range.detach();

  const focusY = getFocusNodeViewportY(selection, fallbackElement);
  return focusY ?? getElementViewportY(fallbackElement);
}

function getCollapsedRangeViewportRect(range: Range, selection: Selection): DOMRect | null {
  try {
    const probe = range.cloneRange();
    probe.collapse(selection.focusOffset !== undefined ? false : true);
    const rect = getRangeViewportRect(probe);
    probe.detach();
    return rect;
  } catch {
    return null;
  }
}

function getFocusNodeViewportY(selection: Selection, fallbackElement: HTMLElement): number | null {
  const focusNode = selection.focusNode;

  if (!focusNode) {
    return null;
  }

  const element = focusNode instanceof HTMLElement ? focusNode : focusNode.parentElement;

  if (!element || !fallbackElement.contains(element)) {
    return null;
  }

  const rect = element.getBoundingClientRect();
  return hasUsableRect(rect) ? rect.top : null;
}

function getRangeViewportRect(range: Range): DOMRect | null {
  const rects = Array.from(range.getClientRects()).filter(hasUsableRect);

  if (rects.length > 0) {
    return rects[0];
  }

  const rect = range.getBoundingClientRect();
  return hasUsableRect(rect) ? rect : null;
}

function hasUsableRect(rect: DOMRect): boolean {
  return rect.top !== 0 || rect.left !== 0 || rect.width !== 0 || rect.height !== 0;
}

function createLute(): LuteLike | null {
  const luteFactory = (window as Window & { Lute?: { New(): LuteLike } }).Lute;

  try {
    return luteFactory?.New() ?? null;
  } catch {
    return null;
  }
}

function getBlockMarkdown(block: HTMLElement, lute: LuteLike | null = createLute()): string | null {
  if (!lute) {
    return null;
  }

  try {
    const markdown = lute?.BlockDOM2StdMd(block.outerHTML) || lute?.BlockDOM2Md(block.outerHTML);
    return markdown ? normalizeMarkdownForSave(markdown).trimEnd() : null;
  } catch {
    return null;
  }
}

function getPreviousSimilarRenderedBlockCounts(
  block: HTMLElement,
  blockMarkdown: string | null,
  blockText: string,
  renderedBlocks?: HTMLElement[],
): { markdownCount: number; textCount: number; exactConfident: boolean } {
  const wysiwyg = block.closest<HTMLElement>(".protyle-wysiwyg");

  if (!wysiwyg) {
    return { markdownCount: 0, textCount: 0, exactConfident: Boolean(blockMarkdown) };
  }

  const blockType = block.getAttribute("data-type");
  const blocks = renderedBlocks ?? getRenderedBlocks(wysiwyg);
  const lute = blockMarkdown ? createLute() : null;
  let markdownCount = 0;
  let textCount = 0;
  let exactComparisons = 0;
  let skippedExactComparison = false;

  const buildResult = (reachedSelf: boolean) => {
    const exactConfident = Boolean(blockMarkdown) && !skippedExactComparison && reachedSelf;
    return {
      markdownCount: exactConfident ? markdownCount : textCount,
      textCount,
      exactConfident,
    };
  };

  for (const candidate of blocks) {
    if (candidate === block) {
      return buildResult(true);
    }

    if (candidate.getAttribute("data-type") !== blockType) {
      continue;
    }

    const candidateText =
      blockText || !blockMarkdown ? getRenderedElementTextForMatching(candidate) : "";

    if (blockText && candidateText !== blockText) {
      continue;
    }

    if (blockText && candidateText === blockText) {
      textCount += 1;
    }

    if (blockMarkdown) {
      if (!lute || exactComparisons >= MAX_MARKDOWN_BLOCK_COMPARISONS) {
        skippedExactComparison = true;
        continue;
      }

      exactComparisons += 1;

      if (getBlockMarkdown(candidate, lute) === blockMarkdown) {
        markdownCount += 1;
      }

      continue;
    }

    if (blockText && candidateText === blockText) {
      markdownCount += 1;
    }
  }

  return buildResult(false);
}

function findExactBlockCandidate(
  markdown: string,
  cursorHint: ProtyleCursorHint,
): IndexedMarkdownBlock | null {
  const blockMarkdown = cursorHint.blockMarkdown;

  if (!blockMarkdown) {
    return null;
  }

  const variants = Array.from(new Set([blockMarkdown, blockMarkdown.trim()])).filter(Boolean);
  const blocks = getIndexedMarkdownBlocks(markdown);
  const candidates = blocks.filter((block) => {
    const blockSource = block.source.trimEnd();
    return variants.some((variant) => blockSource === variant.trimEnd());
  });

  return chooseBlockCandidate(candidates, blocks.length, cursorHint, getExactOccurrenceIndex(cursorHint));
}

function getExactOccurrenceIndex(cursorHint: ProtyleCursorHint): number {
  return cursorHint.occurrenceMode === "text"
    ? getTextOccurrenceIndex(cursorHint)
    : cursorHint.occurrenceIndex;
}

function resolveMarkdownBlockCursorPosition(
  markdown: string,
  block: MarkdownBlock,
  cursorHint: ProtyleCursorHint,
): number {
  if (isCodeBlockType(cursorHint.blockType)) {
    return block.start + resolveCodeBlockSourcePosition(block.source, cursorHint.textOffset);
  }

  if (cursorHint.blockType === "NodeTable") {
    const tablePosition = resolveMarkdownTableCursorPosition(block.source, cursorHint);

    if (tablePosition !== null) {
      return block.start + tablePosition;
    }
  }

  const edgePosition = resolveMarkdownBlockEdgePosition(block.source, cursorHint);

  if (edgePosition !== null) {
    return block.start + edgePosition;
  }

  const contextPosition = findMarkdownContextPosition(markdown, cursorHint, block);

  if (contextPosition !== null) {
    return contextPosition;
  }

  return block.start + resolveVisiblePrefixPosition(
    block.source,
    cursorHint.textBeforeCursor,
    cursorHint.blockText,
  );
}

function resolveMarkdownBlockEdgePosition(
  source: string,
  cursorHint: ProtyleCursorHint,
): number | null {
  const edge = cursorHint.sourceBlockEdge;

  if (!edge) {
    return null;
  }

  const projection = buildMarkdownVisibleProjection(source);

  if (edge === "start") {
    return projection.chars[0]?.start ?? 0;
  }

  return source.trimEnd().length;
}

function resolveCodeBlockSourcePosition(source: string, textOffset: number): number {
  const chars = buildMarkdownVisibleProjection(source).chars;
  const targetOffset = clampPosition(textOffset, chars.length);

  if (targetOffset <= 0) {
    return chars[0]?.start ?? 0;
  }

  return chars[targetOffset - 1]?.end ?? source.length;
}

function resolveByVisibleText(
  markdown: string,
  cursorHint: ProtyleCursorHint,
): number | null {
  const blockText = cursorHint.blockText;

  if (!blockText) {
    return null;
  }

  const normalizedBlockText = normalizeTextForMatching(blockText);
  const blocks = getIndexedMarkdownBlocks(markdown);
  const candidates = blocks.filter((block) => {
    const candidateText = normalizeTextForMatching(markdownToVisibleText(block.source));

    return candidateText === normalizedBlockText && markdownBlockMatchesHintType(block, cursorHint);
  });
  const block = chooseBlockCandidate(
    candidates,
    blocks.length,
    cursorHint,
    getTextOccurrenceIndex(cursorHint),
  );

  return block ? resolveMarkdownBlockCursorPosition(markdown, block, cursorHint) : null;
}

function chooseBlockCandidate(
  candidates: IndexedMarkdownBlock[],
  blockCount: number,
  cursorHint: ProtyleCursorHint,
  occurrenceIndex: number,
): IndexedMarkdownBlock | null {
  if (candidates.length === 0) {
    return null;
  }

  const approximateIndex = getApproximateBlockIndex(blockCount, cursorHint);
  const indexedCandidate = candidates[occurrenceIndex];

  if (indexedCandidate) {
    return indexedCandidate;
  }

  return chooseNearestMarkdownBlockCandidate(candidates, approximateIndex);
}

function chooseNearestMarkdownBlockCandidate(
  candidates: IndexedMarkdownBlock[],
  approximateIndex: number,
): IndexedMarkdownBlock {
  return candidates.reduce((bestCandidate, candidate) =>
    Math.abs(candidate.index - approximateIndex) <
    Math.abs(bestCandidate.index - approximateIndex)
      ? candidate
      : bestCandidate,
  );
}

function getApproximateIndexedBlockCandidate(
  blocks: IndexedMarkdownBlock[],
  cursorHint: ProtyleCursorHint,
): IndexedMarkdownBlock | null {
  if (blocks.length === 0) {
    return null;
  }

  const approximateIndex = getApproximateBlockIndex(blocks.length, cursorHint);

  if (cursorHint.blockType) {
    const typed = blocks.filter((block) => markdownBlockMatchesHintType(block, cursorHint));

    if (typed.length > 0) {
      return typed.reduce((best, block) =>
        Math.abs(block.index - approximateIndex) < Math.abs(best.index - approximateIndex)
          ? block
          : best,
      );
    }
  }

  return blocks[approximateIndex] ?? null;
}

function getApproximateBlockIndex(blockCount: number, cursorHint: ProtyleCursorHint): number {
  if (blockCount <= 0) {
    return 0;
  }

  const sourceBlockCount = cursorHint.blockCount ?? 0;

  if (cursorHint.blockIndex >= 0 && sourceBlockCount > 1) {
    return clampPosition(
      Math.round((cursorHint.blockIndex / (sourceBlockCount - 1)) * (blockCount - 1)),
      blockCount - 1,
    );
  }

  if (cursorHint.blockIndex >= 0 && sourceBlockCount <= 0) {
    return clampPosition(cursorHint.blockIndex, blockCount - 1);
  }

  if (cursorHint.blockIndex >= 0 && blockCount === 1) {
    return 0;
  }

  if (cursorHint.blockIndex >= 0 && sourceBlockCount === blockCount) {
    return clampPosition(cursorHint.blockIndex, blockCount - 1);
  }

  return Math.round(clampRatio(cursorHint.documentRatio) * (blockCount - 1));
}

function getTextOccurrenceIndex(cursorHint: ProtyleCursorHint): number {
  return cursorHint.textOccurrenceIndex ?? cursorHint.occurrenceIndex;
}

function markdownBlockMatchesHintType(
  block: MarkdownBlock,
  cursorHint: ProtyleCursorHint,
): boolean {
  return !cursorHint.blockType || getMarkdownBlockType(block.source) === cursorHint.blockType;
}

function resolveByApproximateMarkdownBlock(
  markdown: string,
  cursorHint: ProtyleCursorHint,
): number {
  const blocks = getIndexedMarkdownBlocks(markdown);

  if (blocks.length === 0) {
    return Math.round(clampRatio(cursorHint.documentRatio) * markdown.length);
  }

  const block = getApproximateIndexedBlockCandidate(blocks, cursorHint);

  if (!block) {
    return Math.round(clampRatio(cursorHint.documentRatio) * markdown.length);
  }

  return resolveMarkdownBlockCursorPosition(markdown, block, cursorHint);
}

function findRenderedBlockCandidate(
  protyle: HTMLElement,
  cursorHint: ProtyleCursorHint,
): RenderedBlockCandidate | null {
  const blocks = getRenderedBlocks(protyle);
  const textCandidates = getRenderedTextCandidates(blocks, cursorHint);
  const exactCandidates = cursorHint.blockMarkdown
    ? textCandidates.length > 0
      ? getRenderedExactCandidates(textCandidates, cursorHint.blockMarkdown, true)
      : getRenderedExactCandidates(
          getNearbyRenderedBlockCandidates(blocks, cursorHint),
          cursorHint.blockMarkdown,
          false,
        )
    : [];

  if (exactCandidates.length > 0) {
    const element = chooseRenderedBlockCandidate(
      exactCandidates,
      blocks,
      cursorHint,
      getExactOccurrenceIndex(cursorHint),
    );

    return element ? { element, confidence: "exact" } : null;
  }

  if (textCandidates.length > 0) {
    const element = chooseRenderedBlockCandidate(
      textCandidates,
      blocks,
      cursorHint,
      getTextOccurrenceIndex(cursorHint),
    );

    return element ? { element, confidence: "text" } : null;
  }

  const element = getApproximateRenderedBlockCandidate(blocks, cursorHint);

  return element ? { element, confidence: "approximate" } : null;
}

function getRenderedTextCandidates(
  blocks: HTMLElement[],
  cursorHint: ProtyleCursorHint,
): HTMLElement[] {
  if (!cursorHint.blockText) {
    return [];
  }

  return blocks.filter((block) => {
    if (!renderedBlockMatchesHintType(block, cursorHint)) {
      return false;
    }

    return getRenderedElementTextForMatching(block) === cursorHint.blockText;
  });
}

function getRenderedExactCandidates(
  candidates: HTMLElement[],
  blockMarkdown: string,
  allowTextFallback: boolean,
): HTMLElement[] {
  const lute = createLute();

  if (!lute) {
    return allowTextFallback ? candidates : [];
  }

  return candidates.filter((block) => getBlockMarkdown(block, lute) === blockMarkdown);
}

function getNearbyRenderedBlockCandidates(
  blocks: HTMLElement[],
  cursorHint: ProtyleCursorHint,
): HTMLElement[] {
  if (blocks.length === 0) {
    return [];
  }

  const approximateIndex = getApproximateBlockIndex(blocks.length, cursorHint);
  const start = clampPosition(approximateIndex - NEARBY_EXACT_BLOCK_WINDOW, blocks.length - 1);
  const end = clampPosition(approximateIndex + NEARBY_EXACT_BLOCK_WINDOW + 1, blocks.length);

  return blocks.slice(start, end).filter((block) => renderedBlockMatchesHintType(block, cursorHint));
}

function chooseRenderedBlockCandidate(
  candidates: HTMLElement[],
  blocks: HTMLElement[],
  cursorHint: ProtyleCursorHint,
  occurrenceIndex: number,
): HTMLElement | null {
  if (candidates.length === 0) {
    return null;
  }

  const approximateIndex = getApproximateBlockIndex(blocks.length, cursorHint);
  const indexedCandidate = candidates[occurrenceIndex];

  if (indexedCandidate) {
    return indexedCandidate;
  }

  return candidates.reduce((bestCandidate, candidate) => {
    const candidateIndex = blocks.indexOf(candidate);
    const bestIndex = blocks.indexOf(bestCandidate);

    return Math.abs(candidateIndex - approximateIndex) < Math.abs(bestIndex - approximateIndex)
      ? candidate
      : bestCandidate;
  });
}

function renderedBlockMatchesHintType(
  block: HTMLElement,
  cursorHint: ProtyleCursorHint,
): boolean {
  return !cursorHint.blockType || block.getAttribute("data-type") === cursorHint.blockType;
}

function getApproximateRenderedBlockCandidate(
  blocks: HTMLElement[],
  cursorHint: ProtyleCursorHint,
): HTMLElement | null {
  if (blocks.length === 0) {
    return null;
  }

  const approximateIndex = getApproximateBlockIndex(blocks.length, cursorHint);

  if (cursorHint.blockType) {
    const typed = blocks
      .map((block, index) => ({ block, index }))
      .filter((entry) => renderedBlockMatchesHintType(entry.block, cursorHint));

    if (typed.length > 0) {
      return typed.reduce((best, entry) =>
        Math.abs(entry.index - approximateIndex) < Math.abs(best.index - approximateIndex)
          ? entry
          : best,
      ).block;
    }
  }

  return blocks[approximateIndex] ?? null;
}

function getRenderedBlocks(protyle: HTMLElement): HTMLElement[] {
  return Array.from(
    protyle.querySelectorAll<HTMLElement>(".protyle-wysiwyg > [data-node-id][data-type^='Node']"),
  ).filter((block) => {
    const type = block.getAttribute("data-type");

    if (type === "NodeDocument" || block.classList.contains("protyle-title")) {
      return false;
    }

    return !isEffectivelyEmptyRenderedBlock(block);
  });
}

function isEffectivelyEmptyRenderedBlock(block: HTMLElement): boolean {
  if (block.getAttribute("data-type") !== "NodeParagraph") {
    return false;
  }

  if (block.querySelector("[data-node-id]")) {
    return false;
  }

  const editable =
    block.querySelector<HTMLElement>('[contenteditable="true"]') ?? block;
  const text = editable.textContent ?? "";

  return text.replace(/[ ​-‍﻿\s]/g, "") === "";
}

function getRenderedElementTextForMatching(element: HTMLElement): string {
  return normalizeTextForMatching(getRenderedTextFromChars(getRenderedTextChars(element)));
}

function setCaretByVisiblePrefix(
  root: HTMLElement,
  cursorHint: ProtyleCursorHint,
): boolean {
  const selection = window.getSelection();

  if (!selection) {
    return false;
  }

  const tableTarget =
    cursorHint.blockType === "NodeTable" ? findRenderedTableCellPosition(root, cursorHint) : null;
  if (tableTarget) {
    return setCaretAtPosition(root, tableTarget);
  }

  const contextTarget = findTextPositionByContext(root, cursorHint);
  const visiblePrefix = cursorHint.textBeforeCursor;
  const offsetTarget = isCodeBlockType(cursorHint.blockType)
    ? findTextPosition(root, cursorHint.textOffset)
    : findTextPosition(root, cursorHint.textOffset) ??
      findTextPositionByVisiblePrefix(root, visiblePrefix);
  const position =
    tableTarget ?? contextTarget ?? offsetTarget ?? getOffsetFallbackPosition(root, cursorHint);

  return Boolean(position && setCaretAtPosition(root, position));
}

function getOffsetFallbackPosition(
  root: HTMLElement,
  cursorHint: ProtyleCursorHint,
): { node: Text; offset: number } | null {
  const visibleLength = getElementVisibleTextLength(root);

  if (visibleLength === 0) {
    return findTextPosition(root, 0);
  }

  return findTextPosition(root, clampPosition(cursorHint.textOffset, visibleLength));
}

function setCaretAtPosition(root: HTMLElement, position: CaretPosition): boolean {
  if (!applyCaretAtPosition(root, position)) {
    return false;
  }

  scheduleCaretReinforcement(root, position);
  return true;
}

function applyCaretAtPosition(root: HTMLElement, position: CaretPosition): boolean {
  const selection = window.getSelection();

  if (!selection || !root.contains(position.node)) {
    return false;
  }

  const scrollSnapshot = captureScrollSnapshot(root);
  const editable = getClosestEditableElement(position.node);

  if (editable) {
    editable.focus({ preventScroll: true });
  }

  try {
    const range = document.createRange();
    range.setStart(position.node, position.offset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    restoreScrollSnapshot(scrollSnapshot);
    return true;
  } catch {
    restoreScrollSnapshot(scrollSnapshot);
    return false;
  }
}

function scheduleCaretReinforcement(root: HTMLElement, position: CaretPosition) {
  if (typeof window === "undefined" || typeof requestAnimationFrame === "undefined") {
    return;
  }

  requestAnimationFrame(() => {
    if (!document.contains(position.node) || !root.contains(position.node)) {
      return;
    }

    if (!isSelectionAtPosition(position)) {
      applyCaretAtPosition(root, position);
    }
  });

  const deadline = Date.now() + CARET_DEFENSE_WINDOW_MS;
  let detached = false;
  const detach = () => {
    if (detached) {
      return;
    }
    detached = true;
    document.removeEventListener("selectionchange", listener, true);
  };

  const listener = () => {
    if (Date.now() > deadline || !document.contains(position.node)) {
      detach();
      return;
    }

    const selection = window.getSelection();

    if (!selection || selection.rangeCount === 0) {
      return;
    }

    const focus = selection.focusNode;

    if (focus && root.contains(focus)) {
      return;
    }

    applyCaretAtPosition(root, position);
  };

  document.addEventListener("selectionchange", listener, true);
  window.setTimeout(detach, CARET_DEFENSE_WINDOW_MS);
}

function isSelectionAtPosition(position: CaretPosition): boolean {
  const selection = window.getSelection();

  if (!selection || selection.rangeCount === 0) {
    return false;
  }

  return selection.focusNode === position.node && selection.focusOffset === position.offset;
}

function findTextPositionByVisiblePrefix(
  root: HTMLElement,
  visiblePrefix: string,
): { node: Text; offset: number } | null {
  const targetChars = Array.from(normalizeTextForMatching(visiblePrefix));

  return targetChars.length === 0
    ? findTextPosition(root, 0)
    : findTextPositionBySubsequence(root, targetChars);
}

function getRenderedTableCursorPosition(
  table: HTMLElement,
  focusNode: Node,
  focusOffset: number,
): { rowIndex: number; cellIndex: number; cellTextOffset: number } | null {
  const cell = getClosestRenderedTableCell(focusNode, table);
  const row = cell?.closest("tr");

  if (!cell || !(row instanceof HTMLElement)) {
    return null;
  }

  const rows = getRenderedTableRows(table);
  const rowIndex = rows.indexOf(row);
  const cells = getRenderedTableCells(row);
  const cellIndex = cells.indexOf(cell);

  if (rowIndex < 0 || cellIndex < 0) {
    return null;
  }

  return {
    rowIndex,
    cellIndex,
    cellTextOffset: getVisibleTextOffsetBeforePosition(cell, focusNode, focusOffset),
  };
}

function findRenderedTableCellPosition(
  table: HTMLElement,
  cursorHint: ProtyleCursorHint,
): CaretPosition | null {
  if (
    cursorHint.tableRowIndex === undefined ||
    cursorHint.tableCellIndex === undefined ||
    cursorHint.tableCellTextOffset === undefined
  ) {
    return null;
  }

  const rows = getRenderedTableRows(table);
  const row = rows[cursorHint.tableRowIndex];

  if (!row) {
    return null;
  }

  const cell = getRenderedTableCells(row)[cursorHint.tableCellIndex];

  if (!cell) {
    return null;
  }

  return findTextPosition(cell, cursorHint.tableCellTextOffset) ?? getRenderedEmptyCellPosition(cell);
}

function getClosestRenderedTableCell(node: Node, table: HTMLElement): HTMLElement | null {
  const element = node instanceof HTMLElement ? node : node.parentElement;
  const cell = element?.closest<HTMLElement>("th, td");

  return cell && table.contains(cell) ? cell : null;
}

function getRenderedTableRows(table: HTMLElement): HTMLElement[] {
  return Array.from(table.querySelectorAll<HTMLElement>("tr"));
}

function getRenderedTableCells(row: HTMLElement): HTMLElement[] {
  return Array.from(row.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && (child.matches("th") || child.matches("td")),
  );
}

function getRenderedEmptyCellPosition(cell: HTMLElement): CaretPosition | null {
  const editable = getDocumentEdgeEditableElement(cell);

  if (!editable) {
    return null;
  }

  return { node: editable, offset: editable.childNodes.length };
}

function getClosestEditableElement(node: Node): HTMLElement | null {
  const element = node instanceof HTMLElement ? node : node.parentElement;
  return element?.closest<HTMLElement>('[contenteditable="true"]') ?? null;
}

function findTextPositionByContext(
  root: HTMLElement,
  cursorHint: ProtyleCursorHint,
): { node: Text; offset: number } | null {
  const textChars = getRenderedTextChars(root);
  const beforeChars = Array.from(getCursorContextBefore(cursorHint));
  const afterChars = Array.from(getCursorContextAfter(cursorHint));

  if (textChars.length === 0 || (beforeChars.length === 0 && afterChars.length === 0)) {
    return null;
  }

  const candidates: Array<{ node: Text; offset: number; visibleOffset: number }> = [];

  for (let boundary = 0; boundary <= textChars.length; boundary += 1) {
    if (
      matchesContextBefore(textChars, boundary, beforeChars) &&
      matchesContextAfter(textChars, boundary, afterChars)
    ) {
      candidates.push(renderedBoundaryToTextPosition(textChars, boundary));
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  const targetOffset = clampPosition(cursorHint.textOffset, textChars.length);
  const best = candidates.reduce((bestCandidate, candidate) =>
    Math.abs(candidate.visibleOffset - targetOffset) <
    Math.abs(bestCandidate.visibleOffset - targetOffset)
      ? candidate
      : bestCandidate,
  );

  return { node: best.node, offset: best.offset };
}

function getCursorContextBefore(cursorHint: ProtyleCursorHint): string {
  return cursorHint.contextBefore || getTrailingContext(cursorHint.textBeforeCursor);
}

function getCursorContextAfter(cursorHint: ProtyleCursorHint): string {
  return cursorHint.contextAfter || getLeadingContext(cursorHint.textAfterCursor ?? "");
}

function getTrailingContext(text: string): string {
  const normalizedText = normalizeTextForMatching(text);
  const chars = Array.from(normalizedText);
  return chars.slice(Math.max(0, chars.length - CURSOR_CONTEXT_LENGTH)).join("");
}

function getLeadingContext(text: string): string {
  return Array.from(normalizeTextForMatching(text)).slice(0, CURSOR_CONTEXT_LENGTH).join("");
}

function matchesContextBefore<T extends { char: string }>(
  chars: T[],
  boundary: number,
  beforeChars: string[],
): boolean {
  if (beforeChars.length === 0) {
    return true;
  }

  let contextIndex = beforeChars.length - 1;

  for (let charIndex = boundary - 1; charIndex >= 0 && contextIndex >= 0; charIndex -= 1) {
    contextIndex = skipContextSpacesBackward(beforeChars, contextIndex, chars[charIndex].char);

    if (chars[charIndex].char === beforeChars[contextIndex]) {
      contextIndex -= 1;
    }
  }

  return hasMatchedLeadingContext(beforeChars, contextIndex);
}

function matchesContextAfter<T extends { char: string }>(
  chars: T[],
  boundary: number,
  afterChars: string[],
): boolean {
  if (afterChars.length === 0) {
    return true;
  }

  let contextIndex = 0;

  for (let charIndex = boundary; charIndex < chars.length && contextIndex < afterChars.length; charIndex += 1) {
    contextIndex = skipTargetSpacesBeforeNonSpace(afterChars, contextIndex, chars[charIndex].char);

    if (chars[charIndex].char === afterChars[contextIndex]) {
      contextIndex += 1;
    }
  }

  return hasMatchedRemainingTarget(afterChars, contextIndex);
}

function skipContextSpacesBackward(
  contextChars: string[],
  contextIndex: number,
  sourceChar: string,
): number {
  if (sourceChar === " ") {
    return contextIndex;
  }

  let nextIndex = contextIndex;

  while (contextChars[nextIndex] === " ") {
    nextIndex -= 1;
  }

  return nextIndex;
}

function hasMatchedLeadingContext(contextChars: string[], contextIndex: number): boolean {
  for (let index = contextIndex; index >= 0; index -= 1) {
    if (contextChars[index] !== " ") {
      return false;
    }
  }

  return true;
}

function alignRenderedCursorToViewportY(block: HTMLElement, viewportY: number | null) {
  const desiredY = sanitizeViewportY(viewportY);
  const selection = window.getSelection();
  const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
  const rect = range ? getRangeViewportRect(range) : null;

  range?.detach();

  if (rect && desiredY !== null) {
    scrollByViewportDelta(block, rect.top - clampViewportY(desiredY));
    return;
  }

  alignElementToViewportY(block, viewportY);
}

function findTextPositionBySubsequence(
  root: HTMLElement,
  targetChars: string[],
): { node: Text; offset: number } | null {
  let targetIndex = 0;

  for (const textNode of iterateTextNodes(root)) {
    const text = textNode.data;

    for (let offset = 0; offset < text.length; ) {
      const codePoint = text.codePointAt(offset);
      const char = String.fromCodePoint(codePoint ?? text.charCodeAt(offset));
      const end = offset + char.length;
      const normalizedChar = normalizeTextCharacter(char, {
        preserveLineBreaks: isInsideCodeBlock(textNode),
        preserveSpaces: isInsideCodeBlock(textNode),
      });

      if (normalizedChar) {
        targetIndex = skipTargetSpacesBeforeNonSpace(targetChars, targetIndex, normalizedChar);

        if (normalizedChar === targetChars[targetIndex]) {
          targetIndex += 1;

          if (hasMatchedRemainingTarget(targetChars, targetIndex)) {
            return { node: textNode, offset: end };
          }
        }
      }

      offset = end;
    }
  }

  return null;
}

function skipTargetSpacesBeforeNonSpace(
  targetChars: string[],
  targetIndex: number,
  sourceChar: string,
): number {
  if (sourceChar === " ") {
    return targetIndex;
  }

  let nextIndex = targetIndex;

  while (targetChars[nextIndex] === " ") {
    nextIndex += 1;
  }

  return nextIndex;
}

function hasMatchedRemainingTarget(targetChars: string[], targetIndex: number): boolean {
  for (let index = targetIndex; index < targetChars.length; index += 1) {
    if (targetChars[index] !== " ") {
      return false;
    }
  }

  return true;
}

function findTextPosition(
  root: HTMLElement,
  targetVisibleOffset: number,
): { node: Text; offset: number } | null {
  const chars = getRenderedTextChars(root);

  if (chars.length === 0) {
    return null;
  }

  if (targetVisibleOffset <= 0) {
    return { node: chars[0].node, offset: chars[0].start };
  }

  return getTextPositionAfterRenderedChar(chars, clampPosition(targetVisibleOffset, chars.length) - 1);
}

function getVisibleTextOffsetBeforePosition(
  root: HTMLElement,
  focusNode: Node,
  focusOffset: number,
): number {
  if (!root.contains(focusNode)) {
    return 0;
  }

  try {
    const range = document.createRange();
    range.selectNodeContents(root);
    range.setEnd(focusNode, focusOffset);

    let visibleOffset = 0;

    for (const char of getRenderedTextChars(root)) {
      if (range.comparePoint(char.node, char.end) > 0) {
        break;
      }

      visibleOffset += 1;
    }

    range.detach();
    return visibleOffset;
  } catch {
    return 0;
  }
}

function getElementVisibleTextLength(root: HTMLElement): number {
  return getRenderedTextChars(root).length;
}

function getRenderedTextChars(root: HTMLElement): Array<{
  char: string;
  node: Text;
  start: number;
  end: number;
}> {
  return Array.from(iterateRenderedTextChars(root));
}

function getRenderedTextFromChars(chars: Array<{ char: string }>): string {
  return chars.map((char) => char.char).join("");
}

function* iterateRenderedTextChars(root: HTMLElement): Generator<{
  char: string;
  node: Text;
  start: number;
  end: number;
}> {
  let previousVisibleWasSpace = false;
  let previousTextPosition: { node: Text; offset: number } | null = null;

  for (const textNode of iterateTextNodes(root)) {
    const text = textNode.data;
    const separator = previousTextPosition
      ? getTextSeparatorBetween(previousTextPosition, { node: textNode, offset: 0 })
      : "";

    if (separator && !previousVisibleWasSpace) {
      yield {
        char: " ",
        node: previousTextPosition?.node ?? textNode,
        start: previousTextPosition?.offset ?? 0,
        end: previousTextPosition?.offset ?? 0,
      };
      previousVisibleWasSpace = true;
    }

    for (let offset = 0; offset < text.length; ) {
      const codePoint = text.codePointAt(offset);
      const originalChar = String.fromCodePoint(codePoint ?? text.charCodeAt(offset));
      const end = offset + originalChar.length;
      const normalizedChar = normalizeTextCharacter(originalChar, {
        preserveLineBreaks: isInsideCodeBlock(textNode),
        preserveSpaces: isInsideCodeBlock(textNode),
      });

      if (normalizedChar) {
        if (normalizedChar === " " && previousVisibleWasSpace) {
          offset = end;
          continue;
        }

        previousVisibleWasSpace = normalizedChar === " ";

        yield {
          char: normalizedChar,
          node: textNode,
          start: offset,
          end,
        };
      }

      previousTextPosition = { node: textNode, offset: end };
      offset = end;
    }
  }
}

function getTextSeparatorBetween(
  previous: { node: Text; offset: number },
  next: { node: Text; offset: number },
): string {
  try {
    const range = document.createRange();
    range.setStart(previous.node, previous.offset);
    range.setEnd(next.node, next.offset);
    const separator = normalizeTextForOffset(range.toString()).trim() ? "" : normalizeTextForOffset(range.toString());
    range.detach();
    return separator.includes(" ") ? " " : "";
  } catch {
    return "";
  }
}

function renderedBoundaryToTextPosition(
  chars: ReturnType<typeof getRenderedTextChars>,
  boundary: number,
): { node: Text; offset: number; visibleOffset: number } {
  if (boundary <= 0) {
    const firstChar = chars[0];
    return {
      node: firstChar.node,
      offset: firstChar.start,
      visibleOffset: 0,
    };
  }

  const position = getTextPositionAfterRenderedChar(chars, boundary - 1);

  return { ...position, visibleOffset: boundary };
}

function getTextPositionAfterRenderedChar(
  chars: ReturnType<typeof getRenderedTextChars>,
  charIndex: number,
): { node: Text; offset: number } {
  const char = chars[charIndex] ?? chars[chars.length - 1];

  if (char.start === char.end) {
    const nextChar = chars[charIndex + 1];

    if (nextChar) {
      return { node: nextChar.node, offset: nextChar.start };
    }
  }

  return { node: char.node, offset: char.end };
}

function* iterateTextNodes(root: HTMLElement): Generator<Text> {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement;

      if (!parent) {
        return NodeFilter.FILTER_REJECT;
      }

      if (
        parent.closest(
          ".protyle-attr, .protyle-action, .protyle-linenumber, .protyle-cursor, .protyle-icons, .hljs-ln-numbers, .protyle-breadcrumb, script, style",
        )
      ) {
        return NodeFilter.FILTER_REJECT;
      }

      if (isInsideNonEditableSubtree(parent, root)) {
        return NodeFilter.FILTER_REJECT;
      }

      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let node = walker.nextNode();

  while (node) {
    if (node instanceof Text) {
      yield node;
    }

    node = walker.nextNode();
  }
}

function isInsideNonEditableSubtree(start: HTMLElement, root: HTMLElement): boolean {
  let element: HTMLElement | null = start;

  while (element && element !== root) {
    const editable = element.getAttribute("contenteditable");

    if (editable === "false") {
      return true;
    }

    if (editable === "true") {
      return false;
    }

    element = element.parentElement;
  }

  return false;
}

function isInsideCodeBlock(node: Node): boolean {
  const element = node instanceof HTMLElement ? node : node.parentElement;
  return Boolean(element?.closest('[data-type="NodeCodeBlock"], .hljs, code, pre'));
}

function getMarkdownBlockAtPosition(
  markdown: string,
  cursorPosition: number,
): MarkdownBlock | null {
  return getMarkdownBlockAtPositionFromBlocks(getMarkdownBlocks(markdown), markdown, cursorPosition);
}

function getMarkdownBlockAtPositionFromBlocks(
  blocks: MarkdownBlock[],
  markdown: string,
  cursorPosition: number,
): MarkdownBlock | null {
  if (markdown.length === 0) {
    return { start: 0, end: 0, source: "" };
  }

  const position = normalizeMarkdownBlockLookupPosition(markdown, cursorPosition);
  const block = blocks.find(
    (candidate) => position >= candidate.start && position <= candidate.end,
  );

  if (block) {
    return block;
  }

  const previousBlock = [...blocks]
    .reverse()
    .find((candidate) => candidate.end <= position);

  return previousBlock ?? null;
}

function normalizeMarkdownBlockLookupPosition(markdown: string, cursorPosition: number): number {
  const position = clampPosition(cursorPosition, markdown.length);

  if (isInsideBlankMarkdownSeparator(markdown, position)) {
    return getPreviousMarkdownContentPosition(markdown, position);
  }

  if (position > 0 && position >= markdown.length && markdown[position - 1] === "\n") {
    return getPreviousMarkdownContentPosition(markdown, position);
  }

  return position;
}

function isInsideBlankMarkdownSeparator(markdown: string, position: number): boolean {
  const lineStart = markdown.lastIndexOf("\n", Math.max(0, position - 1)) + 1;
  const nextLineBreak = markdown.indexOf("\n", position);
  const lineEnd = nextLineBreak >= 0 ? nextLineBreak : markdown.length;

  return markdown.slice(lineStart, lineEnd).trim() === "";
}

function getPreviousMarkdownContentPosition(markdown: string, position: number): number {
  let previous = clampPosition(position, markdown.length) - 1;

  while (previous > 0 && /[ \t\n]/.test(markdown[previous])) {
    previous -= 1;
  }

  return Math.max(0, previous + 1);
}

function getMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = getMarkdownLines(markdown);
  const blocks: MarkdownBlock[] = [];

  for (let lineIndex = 0; lineIndex < lines.length; ) {
    const line = lines[lineIndex];

    if (!line || line.text.trim() === "") {
      lineIndex += 1;
      continue;
    }

    const blockRange = getMarkdownBlockLineRange(lines, lineIndex);

    if (!blockRange) {
      lineIndex += 1;
      continue;
    }

    const start = lines[blockRange.startLine].start;
    const end = lines[blockRange.endLine].end;
    const source = markdown.slice(start, end);

    if (source.trim().length > 0) {
      blocks.push({ start, end, source });
    }

    lineIndex = blockRange.endLine + 1;
  }

  return blocks;
}

function getIndexedMarkdownBlocks(markdown: string): IndexedMarkdownBlock[] {
  return getMarkdownBlocks(markdown).map((block, index) => ({ ...block, index }));
}

function getMarkdownBlockLineRange(
  lines: MarkdownLine[],
  lineIndex: number,
): { startLine: number; endLine: number } | null {
  const line = lines[lineIndex];

  if (!line || line.text.trim() === "") {
    return null;
  }

  const fencedBlock = getFencedBlockLineRange(lines, lineIndex);

  if (fencedBlock) {
    return fencedBlock;
  }

  const tableBlock = getTableBlockLineRange(lines, lineIndex);

  if (tableBlock) {
    return tableBlock;
  }

  const topLevelListBlock = getTopLevelListBlockLineRange(lines, lineIndex);

  if (topLevelListBlock) {
    return topLevelListBlock;
  }

  return { startLine: lineIndex, endLine: lineIndex };
}

function getMarkdownLines(markdown: string): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  let start = 0;

  for (let index = 0; index <= markdown.length; index += 1) {
    if (index === markdown.length || markdown[index] === "\n") {
      const end = index < markdown.length ? index + 1 : index;
      lines.push({ start, end, text: markdown.slice(start, index) });
      start = index + 1;
    }
  }

  return lines;
}

function getFencedBlockLineRange(
  lines: MarkdownLine[],
  lineIndex: number,
): { startLine: number; endLine: number } | null {
  let fenceStart = -1;
  let fenceMarker: string | null = null;

  for (let index = 0; index <= lineIndex; index += 1) {
    const match = lines[index].text.match(/^[ \t]*(`{3,}|~{3,})/);

    if (!match) {
      continue;
    }

    const marker = match[1][0];

    if (fenceMarker === null) {
      fenceStart = index;
      fenceMarker = marker;
      continue;
    }

    if (marker === fenceMarker) {
      fenceStart = -1;
      fenceMarker = null;
    }
  }

  if (fenceStart === -1) {
    return null;
  }

  let fenceEnd = lines.length - 1;

  for (let index = lineIndex + 1; index < lines.length; index += 1) {
    if (lines[index].text.match(new RegExp(`^[ \\t]*\\${fenceMarker}{3,}`))) {
      fenceEnd = index;
      break;
    }
  }

  return { startLine: fenceStart, endLine: fenceEnd };
}

function getTableBlockLineRange(
  lines: MarkdownLine[],
  lineIndex: number,
): { startLine: number; endLine: number } | null {
  if (!isPotentialMarkdownTableLine(lines[lineIndex]?.text ?? "")) {
    return null;
  }

  let startLine = lineIndex;
  let endLine = lineIndex;

  while (startLine > 0 && isPotentialMarkdownTableLine(lines[startLine - 1].text)) {
    startLine -= 1;
  }

  while (endLine < lines.length - 1 && isPotentialMarkdownTableLine(lines[endLine + 1].text)) {
    endLine += 1;
  }

  for (let index = startLine + 1; index <= endLine; index += 1) {
    if (isMarkdownTableSeparatorLine(lines[index].text)) {
      return { startLine, endLine };
    }
  }

  return null;
}

function isPotentialMarkdownTableLine(line: string): boolean {
  return line.trim() !== "" && hasUnescapedTablePipe(line);
}

function getTopLevelListBlockLineRange(
  lines: MarkdownLine[],
  lineIndex: number,
): { startLine: number; endLine: number } | null {
  const line = lines[lineIndex];
  const marker = line ? getListMarkerInfo(line.text) : null;

  if (!marker || marker.indent > 3) {
    return null;
  }

  let endLine = lineIndex;

  for (let index = lineIndex + 1; index < lines.length; index += 1) {
    const currentLine = lines[index];
    const currentMarker = getListMarkerInfo(currentLine.text);

    if (currentLine.text.trim() === "") {
      const nextContentLine = findNextNonEmptyMarkdownLine(lines, index + 1);

      if (nextContentLine && isListBlockContinuationLine(nextContentLine.text, marker)) {
        endLine = index;
        continue;
      }

      break;
    }

    if (currentMarker && currentMarker.indent < marker.indent) {
      break;
    }

    if (!isListBlockContinuationLine(currentLine.text, marker)) {
      break;
    }

    endLine = index;
  }

  return { startLine: lineIndex, endLine };
}

function findNextNonEmptyMarkdownLine(
  lines: MarkdownLine[],
  startIndex: number,
): MarkdownLine | null {
  for (let index = startIndex; index < lines.length; index += 1) {
    if (lines[index].text.trim() !== "") {
      return lines[index];
    }
  }

  return null;
}

function isListBlockContinuationLine(line: string, marker: ListMarkerInfo): boolean {
  const lineMarker = getListMarkerInfo(line);

  if (lineMarker) {
    return lineMarker.indent >= marker.indent;
  }

  const indent = getMarkdownIndentWidth(line.match(/^[ \t]*/)?.[0] ?? "");
  return indent >= marker.contentIndent;
}

interface ListMarkerInfo {
  indent: number;
  contentIndent: number;
}

function getListMarkerInfo(line: string): ListMarkerInfo | null {
  const match = line.match(/^([ \t]*)(?:[-+*]|\d+[.)])([ \t]+)/);

  if (!match) {
    return null;
  }

  const indent = getMarkdownIndentWidth(match[1] ?? "");
  const markerAndPadding = getMarkdownIndentWidth(match[0] ?? "");

  return {
    indent,
    contentIndent: Math.max(indent + 1, markerAndPadding),
  };
}

function getMarkdownIndentWidth(indent: string): number {
  return Array.from(indent).reduce((width, char) => width + (char === "\t" ? 4 : 1), 0);
}

function getMarkdownBlockType(source: string): string | null {
  const firstLine = source.split("\n", 1)[0] ?? "";

  if (/^[ \t]{0,3}#{1,6}[ \t]+/.test(firstLine)) {
    return "NodeHeading";
  }

  if (/^[ \t]{0,3}>[ \t]?/.test(firstLine)) {
    return "NodeBlockquote";
  }

  if (/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+/.test(firstLine)) {
    return "NodeList";
  }

  if (/^[ \t]*(`{3,}|~{3,})/.test(firstLine)) {
    return "NodeCodeBlock";
  }

  if (looksLikeMarkdownTable(source)) {
    return "NodeTable";
  }

  if (/^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(firstLine)) {
    return "NodeThematicBreak";
  }

  return "NodeParagraph";
}

function isCodeBlockType(blockType: string | null | undefined): boolean {
  return blockType === "NodeCodeBlock";
}

function looksLikeMarkdownTable(source: string): boolean {
  const lines = getMarkdownLines(source);

  return lines.some((line, index) => {
    if (!isMarkdownTableSeparatorLine(line.text)) {
      return false;
    }

    const previousLine = lines[index - 1]?.text ?? "";
    return hasUnescapedTablePipe(previousLine);
  });
}

function getPreviousSimilarMarkdownBlockCount(
  markdown: string,
  currentBlockStart: number,
  blockMarkdown: string,
  blockText: string,
  blocks: MarkdownBlock[] = getMarkdownBlocks(markdown),
): number {
  return getPreviousSimilarMarkdownBlockCounts(
    markdown,
    currentBlockStart,
    blockMarkdown,
    null,
    blockText,
    blocks,
  ).markdownCount;
}

function getPreviousSimilarMarkdownTextBlockCount(
  markdown: string,
  currentBlockStart: number,
  blockText: string,
  blockType: string | null,
  blocks: MarkdownBlock[] = getMarkdownBlocks(markdown),
): number {
  return getPreviousSimilarMarkdownBlockCounts(
    markdown,
    currentBlockStart,
    "",
    blockType,
    blockText,
    blocks,
  ).textCount;
}

function getPreviousSimilarMarkdownBlockCounts(
  _markdown: string,
  currentBlockStart: number,
  blockMarkdown: string,
  blockType: string | null,
  blockText: string,
  blocks: MarkdownBlock[],
): { markdownCount: number; textCount: number } {
  const normalizedBlockMarkdown = blockMarkdown.trimEnd();
  const normalizedBlockText = normalizeTextForMatching(blockText);
  let markdownCount = 0;
  let textCount = 0;

  for (const block of blocks) {
    if (block.start >= currentBlockStart) {
      break;
    }

    if (normalizedBlockMarkdown && block.source.trimEnd() === normalizedBlockMarkdown) {
      markdownCount += 1;
    }

    if (!normalizedBlockText) {
      continue;
    }

    const candidateType = getMarkdownBlockType(block.source);
    const needsTextForMarkdown = !normalizedBlockMarkdown;
    const needsTextForTextCount = candidateType === blockType;

    if (!needsTextForMarkdown && !needsTextForTextCount) {
      continue;
    }

    const candidateText = normalizeTextForMatching(markdownToVisibleText(block.source));

    if (needsTextForMarkdown && candidateText === normalizedBlockText) {
      markdownCount += 1;
    }

    if (needsTextForTextCount && candidateText === normalizedBlockText) {
      textCount += 1;
    }
  }

  return { markdownCount, textCount };
}

function markdownToVisibleText(markdown: string): string {
  return buildMarkdownVisibleProjection(markdown).text;
}

function getMarkdownVisibleTextBeforeSourcePosition(
  markdown: string,
  sourcePosition: number,
): string {
  return getMarkdownVisibleTextBeforeProjectionPosition(
    buildMarkdownVisibleProjection(markdown),
    sourcePosition,
  );
}

function getMarkdownVisibleTextBeforeProjectionPosition(
  projection: MarkdownVisibleProjection,
  sourcePosition: number,
): string {
  const position = clampPosition(sourcePosition, getMarkdownProjectionSourceEnd(projection));

  return projection.chars
    .filter((char) => char.end <= position)
    .map((char) => char.char)
    .join("");
}

function getMarkdownVisibleTextAfterSourcePosition(
  markdown: string,
  sourcePosition: number,
): string {
  return getMarkdownVisibleTextAfterProjectionPosition(
    buildMarkdownVisibleProjection(markdown),
    sourcePosition,
  );
}

function getMarkdownVisibleTextAfterProjectionPosition(
  projection: MarkdownVisibleProjection,
  sourcePosition: number,
): string {
  const position = clampPosition(sourcePosition, getMarkdownProjectionSourceEnd(projection));

  return projection.chars
    .filter((char) => char.start >= position)
    .map((char) => char.char)
    .join("");
}

function getMarkdownProjectionSourceEnd(projection: MarkdownVisibleProjection): number {
  return projection.chars[projection.chars.length - 1]?.end ?? 0;
}

function buildMarkdownVisibleProjection(markdown: string): MarkdownVisibleProjection {
  const source = normalizeMarkdownForSave(markdown);
  const lines = getMarkdownLines(source);
  const hiddenRanges: TextRange[] = [];
  const spacePositions = new Set<number>();
  const tableRowIndices = getMarkdownTableRowIndices(lines);
  const codeBlockRanges: TextRange[] = [];
  let fenceMarker: string | null = null;
  let fenceStart: number | null = null;

  lines.forEach((line, lineIndex) => {
    const fenceMatch = line.text.match(/^[ \t]*(`{3,}|~{3,})/);

    if (fenceMatch) {
      addHiddenRange(hiddenRanges, line.start, line.end);

      const marker = fenceMatch[1][0];
      if (fenceMarker === marker) {
        if (fenceStart !== null) {
          addTextRange(codeBlockRanges, fenceStart, line.start);
        }

        fenceMarker = null;
        fenceStart = null;
        return;
      }

      fenceMarker = marker;
      fenceStart = line.end;
      return;
    }

    if (fenceMarker) {
      return;
    }

    if (isMarkdownTableSeparatorLine(line.text)) {
      addHiddenRange(hiddenRanges, line.start, line.end);
      return;
    }

    addBlockSyntaxHiddenRanges(line.text, line.start, hiddenRanges);
    addInlineSyntaxHiddenRanges(line.text, line.start, hiddenRanges);

    if (tableRowIndices.has(lineIndex)) {
      addTableRowProjectionRanges(line.text, line.start, hiddenRanges, spacePositions);
    }
  });

  const mergedHiddenRanges = mergeTextRanges(hiddenRanges);
  const chars = Array.from(
    iterateProjectedMarkdownChars(
      source,
      mergedHiddenRanges,
      spacePositions,
      mergeTextRanges(codeBlockRanges),
    ),
  );

  return {
    text: chars.map((char) => char.char).join(""),
    chars,
    hiddenRanges: mergedHiddenRanges,
  };
}

function addBlockSyntaxHiddenRanges(
  line: string,
  lineStart: number,
  hiddenRanges: TextRange[],
) {
  const headingStart = line.match(/^[ \t]{0,3}#{1,6}[ \t]+/);

  if (headingStart) {
    addHiddenRange(hiddenRanges, lineStart, lineStart + headingStart[0].length);

    const closingHeadingMarker = line.match(/[ \t]+#{1,}[ \t]*$/);

    if (closingHeadingMarker?.index !== undefined) {
      addHiddenRange(
        hiddenRanges,
        lineStart + closingHeadingMarker.index,
        lineStart + closingHeadingMarker.index + closingHeadingMarker[0].length,
      );
    }
  }

  const blockquote = line.match(/^[ \t]{0,3}(?:>[ \t]?)+/);

  if (blockquote) {
    addHiddenRange(hiddenRanges, lineStart, lineStart + blockquote[0].length);
  }

  const listMarker = line.match(/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+/);

  if (listMarker) {
    const contentStart = listMarker[0].length;
    addHiddenRange(hiddenRanges, lineStart, lineStart + contentStart);

    const taskMarker = line.slice(contentStart).match(/^\[[ xX]\][ \t]+/);

    if (taskMarker) {
      addHiddenRange(
        hiddenRanges,
        lineStart + contentStart,
        lineStart + contentStart + taskMarker[0].length,
      );
    }
  }
}

function addInlineSyntaxHiddenRanges(
  line: string,
  lineStart: number,
  hiddenRanges: TextRange[],
) {
  addLinkSyntaxHiddenRanges(line, lineStart, hiddenRanges);
  addDelimitedSyntaxHiddenRanges(line, lineStart, hiddenRanges);
  addRegexHiddenRanges(line, lineStart, hiddenRanges, /<\/?[A-Za-z][^>\n]*>/g);
  addEscapedMarkdownHiddenRanges(line, lineStart, hiddenRanges);
}

function addLinkSyntaxHiddenRanges(
  line: string,
  lineStart: number,
  hiddenRanges: TextRange[],
) {
  const linkPattern = /!?\[([^\]\n]*)\]\(([^)\n]*)\)/g;
  let match: RegExpExecArray | null;

  while ((match = linkPattern.exec(line))) {
    const markerLength = match[0].startsWith("!") ? 2 : 1;
    const labelStart = match.index + markerLength;
    const labelEnd = labelStart + (match[1]?.length ?? 0);

    addHiddenRange(hiddenRanges, lineStart + match.index, lineStart + labelStart);
    addHiddenRange(
      hiddenRanges,
      lineStart + labelEnd,
      lineStart + match.index + match[0].length,
    );
  }
}

function addDelimitedSyntaxHiddenRanges(
  line: string,
  lineStart: number,
  hiddenRanges: TextRange[],
) {
  addPairedDelimiterHiddenRanges(line, lineStart, hiddenRanges, /(`+)([^`]*?)\1/g);
  addPairedDelimiterHiddenRanges(line, lineStart, hiddenRanges, /(~~)([\s\S]*?)\1/g);
  addPairedDelimiterHiddenRanges(line, lineStart, hiddenRanges, /(\*\*|__)([\s\S]*?)\1/g);
  addPairedDelimiterHiddenRanges(line, lineStart, hiddenRanges, /(\*|_)([^\s*_][\s\S]*?)\1/g);
}

function addPairedDelimiterHiddenRanges(
  line: string,
  lineStart: number,
  hiddenRanges: TextRange[],
  pattern: RegExp,
) {
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(line))) {
    const delimiter = match[1] ?? "";

    if (!delimiter) {
      continue;
    }

    addHiddenRange(
      hiddenRanges,
      lineStart + match.index,
      lineStart + match.index + delimiter.length,
    );
    addHiddenRange(
      hiddenRanges,
      lineStart + match.index + match[0].length - delimiter.length,
      lineStart + match.index + match[0].length,
    );
  }
}

function addRegexHiddenRanges(
  line: string,
  lineStart: number,
  hiddenRanges: TextRange[],
  pattern: RegExp,
) {
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(line))) {
    addHiddenRange(hiddenRanges, lineStart + match.index, lineStart + match.index + match[0].length);
  }
}

function addEscapedMarkdownHiddenRanges(
  line: string,
  lineStart: number,
  hiddenRanges: TextRange[],
) {
  const escapedMarkdown = /\\[\\`*_[\]{}()#+\-.!>|]/g;
  let match: RegExpExecArray | null;

  while ((match = escapedMarkdown.exec(line))) {
    addHiddenRange(hiddenRanges, lineStart + match.index, lineStart + match.index + 1);
  }
}

function addTableRowProjectionRanges(
  line: string,
  lineStart: number,
  hiddenRanges: TextRange[],
  spacePositions: Set<number>,
) {
  const pipeIndices = getUnescapedTablePipeIndices(line);

  if (pipeIndices.length === 0) {
    return;
  }

  const firstPipe = pipeIndices[0];
  const lastPipe = pipeIndices[pipeIndices.length - 1];
  const hasLeadingBoundary = line.slice(0, firstPipe).trim() === "";
  const hasTrailingBoundary = line.slice(lastPipe + 1).trim() === "";
  const firstInternalPipeIndex = hasLeadingBoundary ? 1 : 0;
  const lastInternalPipeIndex = hasTrailingBoundary ? pipeIndices.length - 2 : pipeIndices.length - 1;

  if (hasLeadingBoundary) {
    addHiddenRange(hiddenRanges, lineStart, lineStart + firstPipe + 1);
  }

  if (hasTrailingBoundary) {
    addHiddenRange(hiddenRanges, lineStart + lastPipe, lineStart + line.length);
  }

  pipeIndices.forEach((pipeIndex, index) => {
    if (index >= firstInternalPipeIndex && index <= lastInternalPipeIndex) {
      spacePositions.add(lineStart + pipeIndex);
      return;
    }

    addHiddenRange(hiddenRanges, lineStart + pipeIndex, lineStart + pipeIndex + 1);
  });
}

function getMarkdownTableCursorPosition(
  tableSource: string,
  sourcePosition: number,
): { rowIndex: number; cellIndex: number; cellTextOffset: number } | null {
  const rows = getMarkdownTableRows(tableSource);
  const position = clampPosition(sourcePosition, tableSource.length);

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];

    if (position < row.start || position > row.end) {
      continue;
    }

    const cellIndex = getMarkdownTableCellIndexAtPosition(row, position);
    const cell = row.cells[cellIndex];

    if (!cell) {
      return null;
    }

    const cellPosition = clampPosition(position - cell.start, cell.source.length);

    return {
      rowIndex,
      cellIndex,
      cellTextOffset: getVisibleTextLength(
        getMarkdownVisibleTextBeforeSourcePosition(cell.source, cellPosition),
      ),
    };
  }

  const previousRowIndex = findPreviousMarkdownTableRowIndex(rows, position);
  const previousRow = previousRowIndex >= 0 ? rows[previousRowIndex] : null;

  if (!previousRow || previousRow.cells.length === 0) {
    return null;
  }

  const cellIndex = previousRow.cells.length - 1;
  const cell = previousRow.cells[cellIndex];

  return {
    rowIndex: previousRowIndex,
    cellIndex,
    cellTextOffset: getVisibleTextLength(markdownToVisibleText(cell.source)),
  };
}

function resolveMarkdownTableCursorPosition(
  tableSource: string,
  cursorHint: ProtyleCursorHint,
): number | null {
  if (
    cursorHint.tableRowIndex === undefined ||
    cursorHint.tableCellIndex === undefined ||
    cursorHint.tableCellTextOffset === undefined
  ) {
    return null;
  }

  const row = getMarkdownTableRows(tableSource)[cursorHint.tableRowIndex];
  const cell = row?.cells[cursorHint.tableCellIndex];

  if (!cell) {
    return null;
  }

  const cellPosition =
    findMarkdownPositionByVisibleOffset(cell.source, cursorHint.tableCellTextOffset) ??
    cell.source.length;

  return cell.start + clampPosition(cellPosition, cell.source.length);
}

function getMarkdownTableRows(tableSource: string): MarkdownTableRow[] {
  const rows: MarkdownTableRow[] = [];

  for (const line of getMarkdownLines(tableSource)) {
    if (isMarkdownTableSeparatorLine(line.text) || !hasUnescapedTablePipe(line.text)) {
      continue;
    }

    rows.push({
      start: line.start,
      end: line.end,
      cells: getMarkdownTableCells(line.text, line.start),
    });
  }

  return rows;
}

function getMarkdownTableCells(line: string, lineStart: number): MarkdownTableCell[] {
  const pipeIndices = getUnescapedTablePipeIndices(line);

  if (pipeIndices.length === 0) {
    return [{ start: lineStart, end: lineStart + line.length, source: line }];
  }

  const firstPipe = pipeIndices[0];
  const lastPipe = pipeIndices[pipeIndices.length - 1];
  const hasLeadingBoundary = line.slice(0, firstPipe).trim() === "";
  const hasTrailingBoundary = line.slice(lastPipe + 1).trim() === "";
  const contentStart = hasLeadingBoundary ? firstPipe + 1 : 0;
  const contentEnd = hasTrailingBoundary ? lastPipe : line.length;
  const separators = pipeIndices.filter(
    (pipeIndex) => pipeIndex >= contentStart && pipeIndex < contentEnd,
  );
  const boundaries = [contentStart, ...separators, contentEnd];
  const cells: MarkdownTableCell[] = [];

  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index] + (index === 0 ? 0 : 1);
    const end = boundaries[index + 1];
    const trimmed = trimMarkdownTableCellRange(line, start, end);

    cells.push({
      start: lineStart + trimmed.start,
      end: lineStart + trimmed.end,
      source: line.slice(trimmed.start, trimmed.end),
    });
  }

  return cells;
}

function trimMarkdownTableCellRange(
  line: string,
  start: number,
  end: number,
): { start: number; end: number } {
  let nextStart = start;
  let nextEnd = end;

  while (nextStart < nextEnd && /[ \t]/.test(line[nextStart])) {
    nextStart += 1;
  }

  while (nextEnd > nextStart && /[ \t]/.test(line[nextEnd - 1])) {
    nextEnd -= 1;
  }

  return { start: nextStart, end: nextEnd };
}

function getMarkdownTableCellIndexAtPosition(
  row: MarkdownTableRow,
  position: number,
): number {
  const containingIndex = row.cells.findIndex(
    (cell) => position >= cell.start && position <= cell.end,
  );

  if (containingIndex >= 0) {
    return containingIndex;
  }

  const nextIndex = row.cells.findIndex((cell) => position < cell.start);
  return nextIndex >= 0 ? nextIndex : Math.max(0, row.cells.length - 1);
}

function findPreviousMarkdownTableRowIndex(rows: MarkdownTableRow[], position: number): number {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index].end <= position) {
      return index;
    }
  }

  return -1;
}

function isMarkdownTableSeparatorLine(line: string): boolean {
  const trimmedLine = line.trim();

  if (!trimmedLine.includes("-")) {
    return false;
  }

  const cells = trimmedLine
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

function getMarkdownTableRowIndices(lines: Array<{ text: string }>): Set<number> {
  const rowIndices = new Set<number>();

  lines.forEach((line, lineIndex) => {
    if (!isMarkdownTableSeparatorLine(line.text)) {
      return;
    }

    for (let index = lineIndex - 1; index >= 0; index -= 1) {
      if (!hasUnescapedTablePipe(lines[index].text)) {
        break;
      }

      rowIndices.add(index);
    }

    for (let index = lineIndex + 1; index < lines.length; index += 1) {
      if (!hasUnescapedTablePipe(lines[index].text)) {
        break;
      }

      rowIndices.add(index);
    }
  });

  return rowIndices;
}

function hasUnescapedTablePipe(line: string): boolean {
  return getUnescapedTablePipeIndices(line).length > 0;
}

function getUnescapedTablePipeIndices(line: string): number[] {
  const indices: number[] = [];

  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === "|" && !isEscapedMarkdownCharacter(line, index)) {
      indices.push(index);
    }
  }

  return indices;
}

function isEscapedMarkdownCharacter(text: string, index: number): boolean {
  let slashCount = 0;

  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }

  return slashCount % 2 === 1;
}

function* iterateProjectedMarkdownChars(
  source: string,
  hiddenRanges: TextRange[],
  spacePositions: Set<number>,
  codeBlockRanges: TextRange[],
): Generator<{
  char: string;
  start: number;
  end: number;
}> {
  let hiddenRangeIndex = 0;
  let codeBlockRangeIndex = 0;

  for (let index = 0; index < source.length; ) {
    const codePoint = source.codePointAt(index);
    const originalChar = String.fromCodePoint(codePoint ?? source.charCodeAt(index));
    const end = index + originalChar.length;

    while (
      hiddenRangeIndex < hiddenRanges.length &&
      hiddenRanges[hiddenRangeIndex].end <= index
    ) {
      hiddenRangeIndex += 1;
    }

    if (
      hiddenRangeIndex < hiddenRanges.length &&
      hiddenRanges[hiddenRangeIndex].start < end &&
      hiddenRanges[hiddenRangeIndex].end > index
    ) {
      index = end;
      continue;
    }

    while (
      codeBlockRangeIndex < codeBlockRanges.length &&
      codeBlockRanges[codeBlockRangeIndex].end <= index
    ) {
      codeBlockRangeIndex += 1;
    }

    const isCodeBlockChar =
      codeBlockRangeIndex < codeBlockRanges.length &&
      codeBlockRanges[codeBlockRangeIndex].start <= index &&
      codeBlockRanges[codeBlockRangeIndex].end >= end;
    const normalizedChar = spacePositions.has(index)
      ? " "
      : normalizeTextCharacter(originalChar, {
          preserveLineBreaks: isCodeBlockChar,
          preserveSpaces: isCodeBlockChar,
        });

    if (normalizedChar) {
      yield { char: normalizedChar, start: index, end };
    }

    index = end;
  }
}

function addHiddenRange(ranges: TextRange[], start: number, end: number) {
  addTextRange(ranges, start, end);
}

function addTextRange(ranges: TextRange[], start: number, end: number) {
  if (end > start) {
    ranges.push({ start, end });
  }
}

function mergeTextRanges(ranges: TextRange[]): TextRange[] {
  const sortedRanges = [...ranges].sort((first, second) => first.start - second.start);
  const mergedRanges: TextRange[] = [];

  for (const range of sortedRanges) {
    const previous = mergedRanges[mergedRanges.length - 1];

    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
      continue;
    }

    mergedRanges.push({ ...range });
  }

  return mergedRanges;
}

function findMarkdownContextPosition(
  markdown: string,
  cursorHint: ProtyleCursorHint,
  range: TextRange | null,
): number | null {
  const source = range ? markdown.slice(range.start, range.end) : markdown;
  const chars = buildMarkdownVisibleProjection(source).chars;
  const beforeChars = Array.from(getCursorContextBefore(cursorHint));
  const afterChars = Array.from(getCursorContextAfter(cursorHint));

  if (chars.length === 0 || (beforeChars.length === 0 && afterChars.length === 0)) {
    return null;
  }

  const candidates = getMarkdownContextCandidates(chars, beforeChars, afterChars)
    .map((position) => (range ? range.start + position : position));

  if (candidates.length === 0) {
    return null;
  }

  const preferredPosition = range
    ? range.start + resolveVisiblePrefixPosition(
        source,
        cursorHint.textBeforeCursor,
        cursorHint.blockText,
      )
    : Math.round(clampRatio(cursorHint.documentRatio) * markdown.length);

  return chooseNearestPosition(candidates, preferredPosition);
}

function getMarkdownContextCandidates(
  chars: MarkdownVisibleProjection["chars"],
  beforeChars: string[],
  afterChars: string[],
): number[] {
  const candidates: number[] = [];

  for (let boundary = 0; boundary <= chars.length; boundary += 1) {
    if (
      matchesContextBefore(chars, boundary, beforeChars) &&
      matchesContextAfter(chars, boundary, afterChars)
    ) {
      candidates.push(markdownBoundaryToSourcePosition(chars, boundary));
    }
  }

  return candidates;
}

function markdownBoundaryToSourcePosition(
  chars: MarkdownVisibleProjection["chars"],
  boundary: number,
): number {
  if (boundary <= 0) {
    return chars[0]?.start ?? 0;
  }

  return chars[boundary - 1]?.end ?? chars[chars.length - 1]?.end ?? 0;
}

function chooseNearestPosition(positions: number[], preferredPosition: number): number {
  return positions.reduce((best, position) =>
    Math.abs(position - preferredPosition) < Math.abs(best - preferredPosition)
      ? position
      : best,
  );
}

function resolveVisiblePrefixPosition(
  source: string,
  visiblePrefix: string,
  blockText: string,
): number {
  const prefix = normalizeTextForMatching(visiblePrefix);

  if (!prefix) {
    return findFirstVisibleTextPosition(source, blockText) ?? 0;
  }

  return (
    findSubsequenceEnd(source, prefix) ??
    findMarkdownPositionByVisibleOffset(source, getVisibleTextLength(prefix)) ??
    Math.min(prefix.length, source.length)
  );
}

function findFirstVisibleTextPosition(source: string, blockText: string): number | null {
  const normalizedBlockText = normalizeTextForMatching(blockText);
  const firstVisibleCharacter = Array.from(normalizedBlockText)[0];

  if (!firstVisibleCharacter) {
    return 0;
  }

  return findSubsequenceStartCandidates(source, firstVisibleCharacter, 1)[0] ?? null;
}

function findSubsequenceEnd(source: string, target: string): number | null {
  const targetChars = Array.from(target);
  let targetIndex = 0;

  for (const { char, end } of buildMarkdownVisibleProjection(source).chars) {
    targetIndex = skipTargetSpacesBeforeNonSpace(targetChars, targetIndex, char);

    if (char === targetChars[targetIndex]) {
      targetIndex += 1;

      if (hasMatchedRemainingTarget(targetChars, targetIndex)) {
        return end;
      }
    }
  }

  return null;
}

function findSubsequenceStartCandidates(
  source: string,
  target: string,
  limit: number,
): number[] {
  const targetChars = Array.from(normalizeTextForMatching(target));
  const sourceChars = buildMarkdownVisibleProjection(source).chars;
  const candidates: number[] = [];

  if (targetChars.length === 0) {
    return candidates;
  }

  for (let sourceIndex = 0; sourceIndex < sourceChars.length; sourceIndex += 1) {
    if (sourceChars[sourceIndex].char !== targetChars[0]) {
      continue;
    }

    let targetIndex = 1;

    for (
      let scanIndex = sourceIndex + 1;
      scanIndex < sourceChars.length && targetIndex < targetChars.length;
      scanIndex += 1
    ) {
      targetIndex = skipTargetSpacesBeforeNonSpace(
        targetChars,
        targetIndex,
        sourceChars[scanIndex].char,
      );

      if (sourceChars[scanIndex].char === targetChars[targetIndex]) {
        targetIndex += 1;
      }
    }

    if (hasMatchedRemainingTarget(targetChars, targetIndex)) {
      candidates.push(sourceChars[sourceIndex].start);

      if (candidates.length >= limit) {
        return candidates;
      }
    }
  }

  return candidates;
}

function findMarkdownPositionByVisibleOffset(
  source: string,
  targetVisibleOffset: number,
): number | null {
  const chars = buildMarkdownVisibleProjection(source).chars;

  if (targetVisibleOffset <= 0) {
    return chars[0]?.start ?? 0;
  }

  let visibleOffset = 0;
  let previousVisibleWasSpace = false;
  let lastPosition: number | null = chars[0]?.start ?? null;

  for (const char of chars) {
    const shouldCount = char.char !== " " || !previousVisibleWasSpace;
    previousVisibleWasSpace = char.char === " ";

    if (shouldCount) {
      visibleOffset += 1;

      if (visibleOffset >= targetVisibleOffset) {
        return char.end;
      }
    }

    lastPosition = char.end;
  }

  return lastPosition;
}

function normalizeTextForMatching(text: string): string {
  return normalizeTextForOffset(text).trim();
}

function normalizeTextForOffset(text: string): string {
  return Array.from(normalizeMarkdownForSave(text))
    .map((char) => normalizeTextCharacter(char))
    .join("")
    .replace(/ +/g, " ");
}

function getVisibleTextLength(text: string): number {
  return Array.from(normalizeTextForOffset(text)).length;
}

function normalizeTextCharacter(
  char: string,
  options: { preserveLineBreaks?: boolean; preserveSpaces?: boolean } = {},
): string {
  if (/[\u200B-\u200D\uFEFF\r]/.test(char)) {
    return "";
  }

  if (options.preserveLineBreaks && char === "\n") {
    return "\n";
  }

  if (options.preserveSpaces && (char === " " || char === "\t")) {
    return char;
  }

  if (/\s/.test(char)) {
    return " ";
  }

  return char === "\u00A0" ? " " : char;
}

function clampPosition(position: number, max: number): number {
  return Math.max(0, Math.min(position, max));
}

function getDocumentRatio(index: number, total: number): number {
  if (index < 0 || total <= 1) {
    return 0;
  }

  return index / (total - 1);
}

function clampRatio(ratio: number): number {
  return Number.isFinite(ratio) ? Math.max(0, Math.min(ratio, 1)) : 0;
}

function getElementViewportY(element: HTMLElement): number | null {
  const rect = element.getBoundingClientRect();

  if (!hasUsableRect(rect)) {
    return null;
  }

  return rect.top;
}

function scrollByViewportDelta(element: HTMLElement, delta: number) {
  if (Math.abs(delta) < 1) {
    return;
  }

  const scroller = getScrollContainer(element);

  if (scroller) {
    scroller.scrollTop += delta;
    return;
  }

  window.scrollBy(0, delta);
}

interface ScrollSnapshot {
  windowX: number;
  windowY: number;
  elements: Array<{
    element: HTMLElement;
    left: number;
    top: number;
  }>;
}

function captureScrollSnapshot(element: HTMLElement): ScrollSnapshot {
  const scrollElements: HTMLElement[] = [];
  const preferred = element.closest<HTMLElement>(".protyle-content");

  if (preferred && isScrollableElement(preferred)) {
    scrollElements.push(preferred);
  }

  let parent = element.parentElement;

  while (parent && parent !== document.body && parent !== document.documentElement) {
    if (isScrollableElement(parent) && !scrollElements.includes(parent)) {
      scrollElements.push(parent);
    }

    parent = parent.parentElement;
  }

  return {
    windowX: window.scrollX,
    windowY: window.scrollY,
    elements: scrollElements.map((scrollElement) => ({
      element: scrollElement,
      left: scrollElement.scrollLeft,
      top: scrollElement.scrollTop,
    })),
  };
}

function restoreScrollSnapshot(snapshot: ScrollSnapshot) {
  for (const item of snapshot.elements) {
    item.element.scrollLeft = item.left;
    item.element.scrollTop = item.top;
  }

  if (window.scrollX !== snapshot.windowX || window.scrollY !== snapshot.windowY) {
    window.scrollTo(snapshot.windowX, snapshot.windowY);
  }
}

function getScrollContainer(element: HTMLElement): HTMLElement | null {
  const preferred = element.closest<HTMLElement>(".protyle-content");

  if (preferred && isScrollableElement(preferred)) {
    return preferred;
  }

  let parent = element.parentElement;

  while (parent && parent !== document.body && parent !== document.documentElement) {
    if (isScrollableElement(parent)) {
      return parent;
    }

    parent = parent.parentElement;
  }

  return null;
}

function isScrollableElement(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);
  return (
    /(auto|scroll|overlay)/.test(style.overflowY) &&
    element.scrollHeight > element.clientHeight + 1
  );
}

function sanitizeViewportY(viewportY: number | null | undefined): number | null {
  return typeof viewportY === "number" && Number.isFinite(viewportY) ? viewportY : null;
}

function clampViewportY(viewportY: number): number {
  const topPadding = 48;
  const bottomPadding = 64;

  if (window.innerHeight <= topPadding + bottomPadding) {
    return viewportY;
  }

  return Math.max(topPadding, Math.min(viewportY, window.innerHeight - bottomPadding));
}
