import { markdownLanguage } from "@codemirror/lang-markdown";

export type SiyuanMarkdownStructureType =
  | "l"
  | "i"
  | "b"
  | "p"
  | "h"
  | "c"
  | "tb"
  | "t"
  | "html";

export interface SiyuanMarkdownStructureNode {
  type: SiyuanMarkdownStructureType;
  subType: string | null;
  from: number;
  to: number;
  sourceFrom: number;
  sourceTo: number;
  children: SiyuanMarkdownStructureNode[];
  listMarker: string | null;
  taskMarker: string | null;
  headingLevel: number | null;
}

export interface ParsedSiyuanMarkdownBlock {
  markdown: string;
  root: SiyuanMarkdownStructureNode;
}

export type GfmTableAlignment = "none" | "left" | "center" | "right";

export interface ParsedGfmTable {
  header: string[];
  rows: string[][];
  alignments: GfmTableAlignment[];
}

interface SyntaxNodeLike {
  name: string;
  from: number;
  to: number;
  firstChild: SyntaxNodeLike | null;
  nextSibling: SyntaxNodeLike | null;
}

export function parseSiyuanMarkdownBlock(markdown: string): ParsedSiyuanMarkdownBlock | null {
  const normalized = normalizeLineEndings(markdown);
  const tree = markdownLanguage.parser.parse(normalized);
  const blocks = getDirectChildren(tree.topNode as SyntaxNodeLike);

  if (blocks.length !== 1) {
    return null;
  }

  const syntax = blocks[0]!;

  if (
    normalized.slice(0, syntax.from).trim() !== "" ||
    normalized.slice(syntax.to).trim() !== ""
  ) {
    return null;
  }

  const root = parseStructureNode(syntax, normalized, null);
  return root ? { markdown: normalized, root } : null;
}

export function hasSingleMarkdownTopLevelBlock(markdown: string): boolean {
  const normalized = normalizeLineEndings(markdown);
  const tree = markdownLanguage.parser.parse(normalized);
  const blocks = getDirectChildren(tree.topNode as SyntaxNodeLike);

  if (blocks.length !== 1) {
    return false;
  }

  const block = blocks[0]!;
  return (
    normalized.slice(0, block.from).trim() === "" &&
    normalized.slice(block.to).trim() === ""
  );
}

export function haveSameSafeContainerStructure(
  beforeMarkdown: string,
  afterMarkdown: string,
  expectedType: "l" | "b",
): boolean {
  const before = parseSiyuanMarkdownBlock(beforeMarkdown);
  const after = parseSiyuanMarkdownBlock(afterMarkdown);

  return Boolean(
    before &&
    after &&
    before.root.type === expectedType &&
    after.root.type === expectedType &&
    haveSameStructureNode(before.root, after.root),
  );
}

export function parseGfmTable(markdown: string): ParsedGfmTable | null {
  const parsed = parseSiyuanMarkdownBlock(markdown);

  if (!parsed || parsed.root.type !== "t") {
    return null;
  }

  const tree = markdownLanguage.parser.parse(parsed.markdown);
  const tableNode = getDirectChildren(tree.topNode as SyntaxNodeLike)[0];

  if (!tableNode || tableNode.name !== "Table") {
    return null;
  }

  const tableChildren = getDirectChildren(tableNode);
  const headerNode = tableChildren.find((child) => child.name === "TableHeader");
  const delimiterNode = tableChildren.find((child) => child.name === "TableDelimiter");

  if (!headerNode || !delimiterNode) {
    return null;
  }

  const header = getTableCells(headerNode, parsed.markdown);

  if (header.length === 0) {
    return null;
  }

  const delimiterCells = splitTableDelimiterRow(
    parsed.markdown.slice(delimiterNode.from, delimiterNode.to),
  );

  if (!delimiterCells || delimiterCells.length !== header.length) {
    return null;
  }

  const alignments: GfmTableAlignment[] = [];

  for (const cell of delimiterCells) {
    const trimmed = cell.trim();

    if (!/^:?-{3,}:?$/.test(trimmed)) {
      return null;
    }

    alignments.push(
      trimmed.startsWith(":") && trimmed.endsWith(":")
        ? "center"
        : trimmed.startsWith(":")
          ? "left"
          : trimmed.endsWith(":")
            ? "right"
            : "none",
    );
  }

  const rows: string[][] = [];

  for (const rowNode of tableChildren.filter((child) => child.name === "TableRow")) {
    const row = getTableCells(rowNode, parsed.markdown);

    if (row.length > header.length) {
      return null;
    }

    while (row.length < header.length) {
      row.push("");
    }

    rows.push(row);
  }

  return { header, rows, alignments };
}

export function areGfmTablesEquivalent(left: string, right: string): boolean {
  const leftTable = parseGfmTable(left);
  const rightTable = parseGfmTable(right);
  return Boolean(leftTable && rightTable && JSON.stringify(leftTable) === JSON.stringify(rightTable));
}

export function areSiyuanMarkdownBlocksEquivalent(
  type: string,
  left: string,
  right: string,
): boolean {
  if (type === "p") {
    return normalizeParagraphSemantics(left) === normalizeParagraphSemantics(right);
  }

  if (type === "html") {
    return normalizeHtmlBlockSemantics(left) === normalizeHtmlBlockSemantics(right);
  }

  if (type === "h") {
    const leftHeading = parseAtxHeadingSemantics(left);
    const rightHeading = parseAtxHeadingSemantics(right);
    return Boolean(
      leftHeading &&
      rightHeading &&
      leftHeading.level === rightHeading.level &&
      leftHeading.content === rightHeading.content
    );
  }

  if (type === "c") {
    const leftCode = parseFencedCodeSemantics(left);
    const rightCode = parseFencedCodeSemantics(right);
    return Boolean(
      leftCode &&
      rightCode &&
      leftCode.info === rightCode.info &&
      leftCode.content === rightCode.content
    );
  }

  if (type === "m") {
    const leftMath = parseMathBlockSemantics(left);
    const rightMath = parseMathBlockSemantics(right);
    return leftMath !== null && rightMath !== null && leftMath === rightMath;
  }

  if (type === "tb") {
    return isThematicBreakSource(left) && isThematicBreakSource(right);
  }

  if (type === "t") {
    return areGfmTablesEquivalent(left, right);
  }

  if (type === "l" || type === "b") {
    const before = parseSiyuanMarkdownBlock(left);
    const after = parseSiyuanMarkdownBlock(right);

    return Boolean(
      before &&
      after &&
      before.root.type === type &&
      after.root.type === type &&
      haveSameStructureNode(before.root, after.root) &&
      haveSameContainerSemantics(before, after),
    );
  }

  return normalizeLineEndings(left) === normalizeLineEndings(right);
}

export function getSiyuanMarkdownNodeSource(
  parsed: ParsedSiyuanMarkdownBlock,
  node: SiyuanMarkdownStructureNode,
): string | null {
  const raw = parsed.markdown.slice(node.sourceFrom, node.sourceTo);
  const lines = raw.split("\n");

  if (lines.length <= 1) {
    return raw;
  }

  const continuationPrefix = deriveContinuationPrefix(parsed.markdown, node.sourceFrom);

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (!continuationPrefix) {
      continue;
    }

    if (line.startsWith(continuationPrefix)) {
      lines[index] = line.slice(continuationPrefix.length);
      continue;
    }

    if (line.trim() === "") {
      lines[index] = "";
      continue;
    }

    return null;
  }

  return lines.join("\n");
}

function parseStructureNode(
  node: SyntaxNodeLike,
  markdown: string,
  inheritedListType: string | null,
): SiyuanMarkdownStructureNode | null {
  if (node.name === "BulletList" || node.name === "OrderedList") {
    const itemNodes = getDirectChildren(node).filter((child) => child.name === "ListItem");

    if (itemNodes.length === 0) {
      return null;
    }

    const taskStates = itemNodes.map((item) =>
      getDirectChildren(item).some((child) => child.name === "Task"),
    );
    const hasTasks = taskStates.some(Boolean);

    if (hasTasks && !taskStates.every(Boolean)) {
      return null;
    }

    const subType = node.name === "OrderedList" ? "o" : hasTasks ? "t" : "u";
    const children = itemNodes.map((item) => parseStructureNode(item, markdown, subType));

    if (children.some((child) => !child)) {
      return null;
    }

    return createStructureNode("l", subType, node, children as SiyuanMarkdownStructureNode[]);
  }

  if (node.name === "ListItem") {
    const directChildren = getDirectChildren(node);
    const markerNode = directChildren.find((child) => child.name === "ListMark");
    const taskNode = directChildren.find((child) => child.name === "Task");
    const contentNodes = directChildren.filter(
      (child) => child.name !== "ListMark" && child.name !== "Task",
    );
    const children: SiyuanMarkdownStructureNode[] = [];
    let taskMarker: string | null = null;

    if (!markerNode || !inheritedListType) {
      return null;
    }

    if (taskNode) {
      const taskMarkerNode = getDirectChildren(taskNode).find(
        (child) => child.name === "TaskMarker",
      );

      if (!taskMarkerNode) {
        return null;
      }

      taskMarker = markdown.slice(taskMarkerNode.from, taskMarkerNode.to);
      let sourceFrom = taskMarkerNode.to;

      while (sourceFrom < taskNode.to && /[ \t]/.test(markdown.charAt(sourceFrom))) {
        sourceFrom += 1;
      }

      children.push({
        ...createStructureNode("p", null, taskNode, []),
        sourceFrom,
        sourceTo: taskNode.to,
      });
    }

    for (const child of contentNodes) {
      const parsed = parseStructureNode(child, markdown, inheritedListType);

      if (!parsed) {
        return null;
      }

      children.push(parsed);
    }

    return {
      ...createStructureNode("i", inheritedListType, node, children),
      listMarker: markdown.slice(markerNode.from, markerNode.to),
      taskMarker,
    };
  }

  if (node.name === "Blockquote") {
    const children: SiyuanMarkdownStructureNode[] = [];

    for (const child of getDirectChildren(node)) {
      if (child.name === "QuoteMark") {
        continue;
      }

      const parsed = parseStructureNode(child, markdown, null);

      if (!parsed) {
        return null;
      }

      children.push(parsed);
    }

    return children.length > 0 ? createStructureNode("b", null, node, children) : null;
  }

  if (node.name === "Paragraph") {
    return createStructureNode("p", null, node, []);
  }

  const headingMatch = node.name.match(/^(?:ATX|Setext)Heading([1-6])$/);

  if (headingMatch) {
    return {
      ...createStructureNode("h", null, node, []),
      headingLevel: Number(headingMatch[1]),
    };
  }

  if (node.name === "FencedCode" || node.name === "CodeBlock") {
    return createStructureNode("c", null, node, []);
  }

  if (node.name === "HorizontalRule") {
    return createStructureNode("tb", null, node, []);
  }

  if (node.name === "Table") {
    return createStructureNode("t", null, node, []);
  }

  if (node.name === "HTMLBlock") {
    return createStructureNode("html", null, node, []);
  }

  return null;
}

function createStructureNode(
  type: SiyuanMarkdownStructureType,
  subType: string | null,
  syntax: Pick<SyntaxNodeLike, "from" | "to">,
  children: SiyuanMarkdownStructureNode[],
): SiyuanMarkdownStructureNode {
  return {
    type,
    subType,
    from: syntax.from,
    to: syntax.to,
    sourceFrom: syntax.from,
    sourceTo: syntax.to,
    children,
    listMarker: null,
    taskMarker: null,
    headingLevel: null,
  };
}

function haveSameStructureNode(
  left: SiyuanMarkdownStructureNode,
  right: SiyuanMarkdownStructureNode,
): boolean {
  return (
    left.type === right.type &&
    left.subType === right.subType &&
    Boolean(left.taskMarker) === Boolean(right.taskMarker) &&
    (left.type !== "i" ||
      (left.listMarker !== null &&
        right.listMarker !== null &&
        left.listMarker.length === right.listMarker.length)) &&
    left.children.length === right.children.length &&
    left.children.every((child, index) => {
      const other = right.children[index];
      return Boolean(other && haveSameStructureNode(child, other));
    })
  );
}

function haveSameContainerSemantics(
  left: ParsedSiyuanMarkdownBlock,
  right: ParsedSiyuanMarkdownBlock,
): boolean {
  const compare = (
    leftNode: SiyuanMarkdownStructureNode,
    rightNode: SiyuanMarkdownStructureNode,
  ): boolean => {
    if (leftNode.type === "i") {
      if (
        normalizeTaskMarker(leftNode.taskMarker) !== normalizeTaskMarker(rightNode.taskMarker)
      ) {
        return false;
      }

      if (leftNode.subType === "o" && leftNode.listMarker && rightNode.listMarker) {
        const leftNumber = Number.parseInt(leftNode.listMarker, 10);
        const rightNumber = Number.parseInt(rightNode.listMarker, 10);

        if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
          return false;
        }
      }
    }

    if (leftNode.children.length === 0) {
      return getSiyuanMarkdownNodeSource(left, leftNode) ===
        getSiyuanMarkdownNodeSource(right, rightNode);
    }

    return leftNode.children.every((child, index) => {
      const other = rightNode.children[index];
      return Boolean(other && compare(child, other));
    });
  };

  return compare(left.root, right.root);
}

function normalizeTaskMarker(marker: string | null): string | null {
  if (!marker) {
    return null;
  }

  return /^\[[xX]\]$/.test(marker) ? "checked" : "unchecked";
}

function getTableCells(node: SyntaxNodeLike, markdown: string): string[] {
  return getDirectChildren(node)
    .filter((child) => child.name === "TableCell")
    .map((cell) => markdown.slice(cell.from, cell.to).trim());
}

function splitTableDelimiterRow(line: string): string[] | null {
  let trimmed = line.trim();

  if (trimmed.startsWith("|")) {
    trimmed = trimmed.slice(1);
  }

  if (trimmed.endsWith("|")) {
    trimmed = trimmed.slice(0, -1);
  }

  const cells = trimmed.split("|");
  return cells.length > 0 ? cells : null;
}

function deriveContinuationPrefix(markdown: string, sourceFrom: number): string {
  const lineStart = markdown.lastIndexOf("\n", Math.max(0, sourceFrom - 1)) + 1;
  let prefix = markdown.slice(lineStart, sourceFrom);

  prefix = prefix.replace(
    /(^|[ \t>])(?:[-+*]|\d+[.)])([ \t]+)/g,
    (match, leading: string, spacing: string) =>
      leading + " ".repeat(match.length - leading.length),
  );
  prefix = prefix.replace(/\[[ xX]\][ \t]+$/, "");
  return prefix;
}

function getDirectChildren(node: SyntaxNodeLike): SyntaxNodeLike[] {
  const children: SyntaxNodeLike[] = [];

  for (let child = node.firstChild; child; child = child.nextSibling) {
    children.push(child);
  }

  return children;
}

function normalizeParagraphSemantics(markdown: string): string {
  const normalized = normalizeLineEndings(markdown);
  return normalized.trim() === "" ? "" : normalized;
}

function normalizeHtmlBlockSemantics(markdown: string): string {
  const normalized = normalizeLineEndings(markdown);
  const envelope = normalized.match(/^<div>\n([\s\S]*)\n<\/div>$/i);
  return envelope?.[1] ?? normalized;
}

function parseAtxHeadingSemantics(
  markdown: string,
): { level: number; content: string } | null {
  const normalized = normalizeLineEndings(markdown).trimEnd();

  if (normalized.includes("\n")) {
    return null;
  }

  const match = normalized.match(/^[ ]{0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/);

  if (!match?.[1]) {
    return null;
  }

  return {
    level: match[1].length,
    content: (match[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trimEnd(),
  };
}

function parseFencedCodeSemantics(
  markdown: string,
): { info: string; content: string } | null {
  const normalized = normalizeLineEndings(markdown);
  const parsed = parseSiyuanMarkdownBlock(normalized);

  if (!parsed || parsed.root.type !== "c") {
    return null;
  }

  const lines = normalized.split("\n");
  const opening = lines[0]?.match(/^[ ]{0,3}(`{3,}|~{3,})(.*)$/);

  if (!opening?.[1]) {
    return null;
  }

  const openingFence = opening[1];
  const info = opening[2] ?? "";

  if (openingFence.startsWith("`") && info.includes("`")) {
    return null;
  }

  let closingIndex = lines.length - 1;

  while (closingIndex > 0 && lines[closingIndex]?.trim() === "") {
    closingIndex -= 1;
  }

  const closing = lines[closingIndex]?.match(/^[ ]{0,3}(`{3,}|~{3,})[ \t]*$/);

  if (
    closingIndex <= 0 ||
    !closing?.[1] ||
    closing[1][0] !== openingFence[0] ||
    closing[1].length < openingFence.length
  ) {
    return null;
  }

  return {
    info: info.trim(),
    content: lines
      .slice(1, closingIndex)
      .map((line) => line.replace(/^([ \t]{0,3})\u200D(?=`{3,}|~{3,})/, "$1"))
      .join("\n"),
  };
}

function parseMathBlockSemantics(markdown: string): string | null {
  const lines = normalizeLineEndings(markdown).split("\n");

  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") {
    lines.pop();
  }

  if (lines.length < 2 || lines[0]?.trim() !== "$$" || lines[lines.length - 1]?.trim() !== "$$") {
    return null;
  }

  return lines.slice(1, -1).join("\n");
}

function isThematicBreakSource(markdown: string): boolean {
  const trimmed = normalizeLineEndings(markdown).trim();
  return (
    !trimmed.includes("\n") &&
    /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(trimmed)
  );
}

function normalizeLineEndings(markdown: string): string {
  return markdown.replace(/\r\n?/g, "\n");
}
