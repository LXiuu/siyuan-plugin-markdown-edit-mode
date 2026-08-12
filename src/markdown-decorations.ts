import { syntaxTree } from "@codemirror/language";
import type { Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

const BLOCK_NODE_CLASSES = {
  FencedCode: "markdown-edit-mode-code-line",
  Table: "markdown-edit-mode-table-line",
} as const;

const MARK_NODE_CLASSES = {
  CodeInfo: "markdown-edit-mode-code-info",
  CodeMark: "markdown-edit-mode-code-mark",
  CodeText: "markdown-edit-mode-code-text",
  TableHeader: "markdown-edit-mode-table-header",
  TableDelimiter: "markdown-edit-mode-table-delimiter",
} as const;

type BlockNodeName = keyof typeof BLOCK_NODE_CLASSES;
type MarkNodeName = keyof typeof MARK_NODE_CLASSES;

function isBlockNodeName(name: string): name is BlockNodeName {
  return name in BLOCK_NODE_CLASSES;
}

function isMarkNodeName(name: string): name is MarkNodeName {
  return name in MARK_NODE_CLASSES;
}

function buildMarkdownStructureDecorations(view: EditorView): DecorationSet {
  const lineClasses = new Map<number, Set<string>>();
  const markRanges: Range<Decoration>[] = [];
  const seenMarks = new Set<string>();
  const tree = syntaxTree(view.state);

  const addBlockLines = (
    name: BlockNodeName,
    nodeFrom: number,
    nodeTo: number,
    visibleFrom: number,
    visibleTo: number,
  ) => {
    if (nodeTo <= nodeFrom) {
      return;
    }

    const document = view.state.doc;
    const firstVisibleLine = document.lineAt(Math.max(nodeFrom, visibleFrom)).number;
    const lastVisibleLine = document.lineAt(
      Math.max(nodeFrom, Math.min(nodeTo - 1, visibleTo)),
    ).number;
    const baseClass = BLOCK_NODE_CLASSES[name];

    for (let lineNumber = firstVisibleLine; lineNumber <= lastVisibleLine; lineNumber += 1) {
      const classes = lineClasses.get(lineNumber) ?? new Set<string>();
      classes.add(baseClass);
      lineClasses.set(lineNumber, classes);
    }
  };

  for (const visibleRange of view.visibleRanges) {
    tree.iterate({
      from: visibleRange.from,
      to: visibleRange.to,
      enter(node) {
        if (isBlockNodeName(node.name)) {
          addBlockLines(
            node.name,
            node.from,
            node.to,
            visibleRange.from,
            visibleRange.to,
          );
          return;
        }

        if (!isMarkNodeName(node.name)) {
          return;
        }

        const from = Math.max(node.from, visibleRange.from);
        const to = Math.min(node.to, visibleRange.to);
        if (to <= from) {
          return;
        }

        const markKey = `${node.name}:${from}:${to}`;
        if (seenMarks.has(markKey)) {
          return;
        }

        seenMarks.add(markKey);
        markRanges.push(
          Decoration.mark({ class: MARK_NODE_CLASSES[node.name] }).range(from, to),
        );
      },
    });
  }

  const lineRanges = [...lineClasses.entries()]
    .sort(([firstLine], [secondLine]) => firstLine - secondLine)
    .map(([lineNumber, classes]) =>
      Decoration.line({ class: [...classes].join(" ") }).range(
        view.state.doc.line(lineNumber).from,
      ),
    );

  return Decoration.set([...lineRanges, ...markRanges], true);
}

export const markdownStructureDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildMarkdownStructureDecorations(view);
    }

    update(update: ViewUpdate) {
      const syntaxTreeChanged = syntaxTree(update.startState) !== syntaxTree(update.state);
      if (update.docChanged || update.viewportChanged || syntaxTreeChanged) {
        this.decorations = buildMarkdownStructureDecorations(update.view);
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
  },
);
