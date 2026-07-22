import { EditorState, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";

import {
  type MappedSiyuanSourceBlock,
  type SiyuanSourceBlock,
  type SiyuanSourceDocument,
  summarizeSiyuanBlock,
  validateSiyuanBlockEdit,
} from "./siyuan-source";

export interface SiyuanSourceEditorSupport {
  extension: Extension;
  getMappedBlocks(state: EditorState): readonly MappedSiyuanSourceBlock[];
}

interface SiyuanSourceEditorSupportOptions {
  getBlockLabel(block: SiyuanSourceBlock): string;
  onBlockedEdit(block: SiyuanSourceBlock | null): void;
}

export function createSiyuanSourceEditorSupport(
  sourceDocument: SiyuanSourceDocument,
  options: SiyuanSourceEditorSupportOptions,
): SiyuanSourceEditorSupport {
  const sourceById = new Map(sourceDocument.blocks.map((block) => [block.id, block]));
  const blockField = StateField.define<readonly MappedSiyuanSourceBlock[]>({
    create: () => sourceDocument.blocks.map(({ id, from, to }) => ({ id, from, to })),
    update: (blocks, transaction) => {
      if (!transaction.docChanged) {
        return blocks;
      }

      return blocks.map((block) => ({
        id: block.id,
        from: transaction.changes.mapPos(block.from, -1),
        to: transaction.changes.mapPos(block.to, 1),
      }));
    },
    provide: (field) => EditorView.decorations.from(
      field,
      (blocks) => buildSourceBlockDecorations(blocks, sourceById, options),
    ),
  });

  const changeFilter = EditorState.changeFilter.of((transaction) => {
    if (!transaction.docChanged) {
      return true;
    }

    const blocks = transaction.startState.field(blockField);
    const touchedBlockIds = new Set<string>();
    let blockedBy: SiyuanSourceBlock | null = null;
    let allowed = true;

    transaction.changes.iterChanges((fromA, toA) => {
      if (!allowed) {
        return;
      }

      const editableBlock = findEditableBlockForChange(blocks, sourceById, fromA, toA);

      if (editableBlock) {
        touchedBlockIds.add(editableBlock.id);
        return;
      }

      allowed = false;
      blockedBy = findProtectedBlockForChange(blocks, sourceById, fromA, toA);
    });

    if (allowed) {
      for (const id of touchedBlockIds) {
        const source = sourceById.get(id);
        const mapped = blocks.find((block) => block.id === id);

        if (!source || !mapped || (source.type !== "l" && source.type !== "b")) {
          continue;
        }

        const from = transaction.changes.mapPos(mapped.from, -1);
        const to = transaction.changes.mapPos(mapped.to, 1);
        const candidate = transaction.newDoc.sliceString(from, to);

        if (!validateSiyuanBlockEdit(source, candidate).valid) {
          allowed = false;
          blockedBy = source;
          break;
        }
      }
    }

    if (!allowed) {
      const blockedBlock = blockedBy;
      queueMicrotask(() => options.onBlockedEdit(blockedBlock));
    }

    return allowed;
  });

  const atomicRanges = EditorView.atomicRanges.of((view) =>
    buildAtomicRanges(view.state.field(blockField), sourceById),
  );

  return {
    extension: [blockField, changeFilter, atomicRanges],
    getMappedBlocks: (state) => state.field(blockField),
  };
}

function buildSourceBlockDecorations(
  mappedBlocks: readonly MappedSiyuanSourceBlock[],
  sourceById: ReadonlyMap<string, SiyuanSourceBlock>,
  options: SiyuanSourceEditorSupportOptions,
): DecorationSet {
  const ranges = [];

  for (const mapped of mappedBlocks) {
    const source = sourceById.get(mapped.id);

    if (!source || source.editable) {
      continue;
    }

    const label = options.getBlockLabel(source);

    if (source.presentation === "card" && mapped.from < mapped.to) {
      ranges.push(
        Decoration.replace({
          widget: new ProtectedBlockCardWidget(
            source.id,
            label,
            source.subType,
            summarizeSiyuanBlock(source),
            source.markdown,
          ),
          inclusive: false,
        }).range(mapped.from, mapped.to),
      );
      continue;
    }

    if (mapped.from < mapped.to) {
      ranges.push(
        Decoration.mark({
          class: "markdown-edit-mode-protected-source",
          attributes: {
            "data-siyuan-block-type": source.type,
          },
        }).range(mapped.from, mapped.to),
      );
    }

    ranges.push(
      Decoration.widget({
        widget: new ProtectedBlockBadgeWidget(source.id, label),
        side: -1,
      }).range(mapped.from),
    );
  }

  return Decoration.set(ranges, true);
}

function buildAtomicRanges(
  mappedBlocks: readonly MappedSiyuanSourceBlock[],
  sourceById: ReadonlyMap<string, SiyuanSourceBlock>,
): DecorationSet {
  const ranges = mappedBlocks.flatMap((mapped) => {
    const source = sourceById.get(mapped.id);

    if (!source || source.editable || mapped.from >= mapped.to) {
      return [];
    }

    return [Decoration.mark({}).range(mapped.from, mapped.to)];
  });

  return Decoration.set(ranges, true);
}

function findEditableBlockForChange(
  mappedBlocks: readonly MappedSiyuanSourceBlock[],
  sourceById: ReadonlyMap<string, SiyuanSourceBlock>,
  from: number,
  to: number,
): SiyuanSourceBlock | null {
  for (const mapped of mappedBlocks) {
    const source = sourceById.get(mapped.id);

    if (!source?.editable) {
      continue;
    }

    if (from === to) {
      if (from >= mapped.from && from <= mapped.to) {
        return source;
      }
      continue;
    }

    if (from >= mapped.from && to <= mapped.to) {
      return source;
    }
  }

  return null;
}

function findProtectedBlockForChange(
  mappedBlocks: readonly MappedSiyuanSourceBlock[],
  sourceById: ReadonlyMap<string, SiyuanSourceBlock>,
  from: number,
  to: number,
): SiyuanSourceBlock | null {
  for (const mapped of mappedBlocks) {
    const source = sourceById.get(mapped.id);

    if (!source || source.editable) {
      continue;
    }

    if (from === to) {
      if (from >= mapped.from && from <= mapped.to) {
        return source;
      }
      continue;
    }

    if (from < mapped.to && to > mapped.from) {
      return source;
    }
  }

  return null;
}

class ProtectedBlockCardWidget extends WidgetType {
  constructor(
    private readonly blockId: string,
    private readonly label: string,
    private readonly subType: string | null,
    private readonly summary: string,
    private readonly rawSource: string,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof ProtectedBlockCardWidget &&
      other.blockId === this.blockId &&
      other.label === this.label &&
      other.subType === this.subType &&
      other.summary === this.summary &&
      other.rawSource === this.rawSource
    );
  }

  toDOM(): HTMLElement {
    const root = document.createElement("span");
    root.className = "markdown-edit-mode-block-card";
    root.setAttribute("contenteditable", "false");
    root.setAttribute("data-siyuan-block-id", this.blockId);
    root.title = this.rawSource;

    const heading = document.createElement("span");
    heading.className = "markdown-edit-mode-block-card__heading";

    const lock = document.createElement("span");
    lock.className = "markdown-edit-mode-block-card__lock";
    lock.setAttribute("aria-hidden", "true");
    lock.textContent = "◇";

    const type = document.createElement("span");
    type.className = "markdown-edit-mode-block-card__type";
    type.textContent = this.subType ? this.label + " · " + this.subType : this.label;

    const id = document.createElement("span");
    id.className = "markdown-edit-mode-block-card__id";
    id.textContent = this.blockId;

    heading.append(lock, type, id);
    root.appendChild(heading);

    if (this.summary) {
      const summary = document.createElement("span");
      summary.className = "markdown-edit-mode-block-card__summary";
      summary.textContent = this.summary;
      root.appendChild(summary);
    }

    return root;
  }
}

class ProtectedBlockBadgeWidget extends WidgetType {
  constructor(
    private readonly blockId: string,
    private readonly label: string,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof ProtectedBlockBadgeWidget &&
      other.blockId === this.blockId &&
      other.label === this.label
    );
  }

  toDOM(): HTMLElement {
    const badge = document.createElement("span");
    badge.className = "markdown-edit-mode-protected-badge";
    badge.setAttribute("contenteditable", "false");
    badge.setAttribute("aria-label", this.label);
    badge.textContent = "◇ " + this.label;
    return badge;
  }
}
