export type SourceDraftMode = "block" | "legacy";

export interface SourceDraftBlockRange {
  id: string;
  from: number;
  to: number;
}

export interface SourceDraft {
  version: 2;
  docId: string;
  mode: SourceDraftMode;
  baseMarkdown: string;
  currentMarkdown: string;
  updatedAt: number;
  cursorPosition: number;
  cursorViewportY: number | null;
  blockRanges: SourceDraftBlockRange[] | null;
}

export type SourceDraftRecoveryState =
  | "already-saved"
  | "conflict"
  | "recoverable"
  | "unchanged";

export const SOURCE_DRAFT_STORAGE_PREFIX =
  "siyuan-plugin-markdown-edit-mode:source-draft:v2:";

export function getSourceDraftStorageKey(docId: string): string {
  return `${SOURCE_DRAFT_STORAGE_PREFIX}${docId}`;
}

export function parseSourceDraft(value: string | null): SourceDraft | null {
  if (!value) {
    return null;
  }

  try {
    const candidate = JSON.parse(value) as unknown;

    if (!isRecord(candidate) || candidate.version !== 2) {
      return null;
    }

    const blockRanges = parseBlockRanges(candidate.blockRanges);

    if (
      typeof candidate.docId !== "string" ||
      (candidate.mode !== "block" && candidate.mode !== "legacy") ||
      typeof candidate.baseMarkdown !== "string" ||
      typeof candidate.currentMarkdown !== "string" ||
      typeof candidate.updatedAt !== "number" ||
      !Number.isFinite(candidate.updatedAt) ||
      typeof candidate.cursorPosition !== "number" ||
      !Number.isInteger(candidate.cursorPosition) ||
      candidate.cursorPosition < 0 ||
      (candidate.cursorViewportY !== null &&
        (typeof candidate.cursorViewportY !== "number" ||
          !Number.isFinite(candidate.cursorViewportY))) ||
      blockRanges === undefined
    ) {
      return null;
    }

    return {
      version: 2,
      docId: candidate.docId,
      mode: candidate.mode,
      baseMarkdown: candidate.baseMarkdown,
      currentMarkdown: candidate.currentMarkdown,
      updatedAt: candidate.updatedAt,
      cursorPosition: candidate.cursorPosition,
      cursorViewportY: candidate.cursorViewportY,
      blockRanges,
    };
  } catch {
    return null;
  }
}

export function classifySourceDraft(
  draft: SourceDraft,
  context: {
    docId: string;
    mode: SourceDraftMode;
    currentMarkdown: string;
    blockIds?: readonly string[];
  },
): SourceDraftRecoveryState {
  if (draft.docId !== context.docId || draft.mode !== context.mode) {
    return "conflict";
  }

  if (draft.currentMarkdown === draft.baseMarkdown) {
    return "unchanged";
  }

  if (draft.currentMarkdown === context.currentMarkdown) {
    return "already-saved";
  }

  if (draft.baseMarkdown !== context.currentMarkdown) {
    return "conflict";
  }

  if (
    context.mode === "block" &&
    !hasValidBlockDraftRanges(
      draft.currentMarkdown,
      draft.blockRanges,
      context.blockIds ?? [],
    )
  ) {
    return "conflict";
  }

  return "recoverable";
}

export function hasValidBlockDraftRanges(
  markdown: string,
  ranges: readonly SourceDraftBlockRange[] | null,
  blockIds: readonly string[],
): ranges is readonly SourceDraftBlockRange[] {
  if (!ranges || ranges.length !== blockIds.length) {
    return false;
  }

  let previousTo = 0;

  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index];
    const expectedSeparator = index === 0 ? "" : "\n\n";

    if (
      !range ||
      range.id !== blockIds[index] ||
      !Number.isInteger(range.from) ||
      !Number.isInteger(range.to) ||
      range.from < previousTo ||
      range.to < range.from ||
      range.to > markdown.length ||
      markdown.slice(previousTo, range.from) !== expectedSeparator
    ) {
      return false;
    }

    previousTo = range.to;
  }

  return previousTo === markdown.length;
}

function parseBlockRanges(value: unknown): SourceDraftBlockRange[] | null | undefined {
  if (value === null) {
    return null;
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const ranges: SourceDraftBlockRange[] = [];

  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.from !== "number" ||
      typeof item.to !== "number" ||
      !Number.isInteger(item.from) ||
      !Number.isInteger(item.to)
    ) {
      return undefined;
    }

    ranges.push({ id: item.id, from: item.from, to: item.to });
  }

  return ranges;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
