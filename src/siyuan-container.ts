import {
  getSiyuanMarkdownNodeSource,
  parseSiyuanMarkdownBlock,
  type ParsedSiyuanMarkdownBlock,
  type SiyuanMarkdownStructureNode,
} from "./siyuan-markdown-structure";
import {
  getSiyuanChildBlockSource,
  validateSiyuanBlockEdit,
  type SiyuanBlockTreeNode,
  type SiyuanListItemControlEdit,
  type SiyuanSourceBlock,
} from "./siyuan-source";

export interface SiyuanContainerSourceUpdate {
  ownerId: string;
  id: string;
  type: string;
  subType: string | null;
  kind: "source" | "list-item-control";
  markdown: string | null;
  originalMarkdown: string | null;
  control: SiyuanListItemControlEdit | null;
}

export interface SiyuanContainerEditPlan {
  ownerId: string;
  beforeTree: SiyuanBlockTreeNode;
  updates: SiyuanContainerSourceUpdate[];
}

export function createSiyuanContainerEditPlan(
  sourceBlock: SiyuanSourceBlock,
  editedMarkdown: string,
  currentTree: SiyuanBlockTreeNode,
): SiyuanContainerEditPlan {
  if (sourceBlock.type !== "l" && sourceBlock.type !== "b") {
    throw new Error("Unsupported SiYuan container type " + sourceBlock.type);
  }

  if (currentTree.id !== sourceBlock.id || currentTree.type !== sourceBlock.type) {
    throw new Error("SiYuan container identity changed");
  }

  const before = parseSiyuanMarkdownBlock(sourceBlock.serverMarkdown);
  const after = parseSiyuanMarkdownBlock(editedMarkdown);

  if (
    !before ||
    !after ||
    before.root.type !== sourceBlock.type ||
    after.root.type !== sourceBlock.type
  ) {
    throw new Error("SiYuan container no longer contains one compatible Markdown block");
  }

  const updates: SiyuanContainerSourceUpdate[] = [];
  collectContainerUpdates(
    sourceBlock.id,
    before,
    before.root,
    after,
    after.root,
    currentTree,
    updates,
  );

  return {
    ownerId: sourceBlock.id,
    beforeTree: currentTree,
    updates,
  };
}

export function haveSameSiyuanBlockTree(
  before: SiyuanBlockTreeNode,
  after: SiyuanBlockTreeNode,
): boolean {
  return (
    before.id === after.id &&
    before.type === after.type &&
    (before.subType ?? null) === (after.subType ?? null) &&
    before.children.length === after.children.length &&
    before.children.every((child, index) => {
      const other = after.children[index];
      return Boolean(other && haveSameSiyuanBlockTree(child, other));
    })
  );
}

function collectContainerUpdates(
  ownerId: string,
  beforeDocument: ParsedSiyuanMarkdownBlock,
  beforeNode: SiyuanMarkdownStructureNode,
  afterDocument: ParsedSiyuanMarkdownBlock,
  afterNode: SiyuanMarkdownStructureNode,
  treeNode: SiyuanBlockTreeNode,
  updates: SiyuanContainerSourceUpdate[],
) {
  if (
    beforeNode.type !== afterNode.type ||
    beforeNode.subType !== afterNode.subType ||
    beforeNode.type !== treeNode.type ||
    (treeNode.subType ?? null) !== beforeNode.subType ||
    beforeNode.children.length !== afterNode.children.length ||
    treeNode.children.length !== beforeNode.children.length
  ) {
    throw new Error("SiYuan container block tree changed");
  }

  if (beforeNode.type === "i") {
    const originalMarker = beforeNode.listMarker;
    const nextMarker = afterNode.listMarker;

    if (!originalMarker || !nextMarker || originalMarker.length !== nextMarker.length) {
      throw new Error("SiYuan list item marker is missing");
    }

    const originalTaskMarker = beforeNode.taskMarker;
    const nextTaskMarker = afterNode.taskMarker;

    if (Boolean(originalTaskMarker) !== Boolean(nextTaskMarker)) {
      throw new Error("Task list structure changed");
    }

    if (originalMarker !== nextMarker || originalTaskMarker !== nextTaskMarker) {
      updates.push({
        ownerId,
        id: treeNode.id,
        type: treeNode.type,
        subType: treeNode.subType ?? null,
        kind: "list-item-control",
        markdown: null,
        originalMarkdown: null,
        control: {
          originalMarker,
          nextMarker,
          originalTaskMarker,
          nextTaskMarker,
        },
      });
    }
  }

  if (beforeNode.children.length > 0) {
    beforeNode.children.forEach((child, index) => {
      const afterChild = afterNode.children[index];
      const treeChild = treeNode.children[index];

      if (!afterChild || !treeChild) {
        throw new Error("SiYuan container block tree changed");
      }

      collectContainerUpdates(
        ownerId,
        beforeDocument,
        child,
        afterDocument,
        afterChild,
        treeChild,
        updates,
      );
    });
    return;
  }

  const beforeMarkdown = getSiyuanMarkdownNodeSource(beforeDocument, beforeNode);
  const nextMarkdown = getSiyuanMarkdownNodeSource(afterDocument, afterNode);

  if (beforeMarkdown === null || nextMarkdown === null) {
    throw new Error("SiYuan nested Markdown indentation changed unsafely");
  }

  const currentMarkdown = getSiyuanChildBlockSource(treeNode);

  if (normalizeLineEndings(beforeMarkdown) !== normalizeLineEndings(currentMarkdown)) {
    throw new Error("SiYuan nested block source no longer matches its block tree");
  }

  if (normalizeLineEndings(nextMarkdown) === normalizeLineEndings(currentMarkdown)) {
    return;
  }

  const validation = validateSiyuanBlockEdit(
    createNestedSourceBlock(treeNode, currentMarkdown),
    nextMarkdown,
  );

  if (!validation.valid) {
    throw new Error("Nested " + treeNode.type + " block edit is not lossless");
  }

  updates.push({
    ownerId,
    id: treeNode.id,
    type: treeNode.type,
    subType: treeNode.subType ?? null,
    kind: "source",
    markdown: nextMarkdown,
    originalMarkdown: currentMarkdown,
    control: null,
  });
}

function createNestedSourceBlock(
  node: SiyuanBlockTreeNode,
  markdown: string,
): SiyuanSourceBlock {
  return {
    id: node.id,
    type: node.type,
    subType: node.subType ?? null,
    content: node.content ?? "",
    markdown,
    serverMarkdown: markdown,
    from: 0,
    to: markdown.length,
    editable: true,
    presentation: "editable-source",
  };
}

function normalizeLineEndings(markdown: string): string {
  return markdown.replace(/\r\n?/g, "\n");
}
