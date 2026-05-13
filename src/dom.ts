import { getActiveEditor } from "siyuan";

export interface ActiveEditorContext {
  docId: string;
  protyle: HTMLElement;
  editor?: ReloadableEditor;
}

export interface ReloadableEditor {
  reload(focus: boolean): void;
}

export function getActiveEditorContext(): ActiveEditorContext | null {
  return getActiveEditorContextByApi() ?? getActiveEditorContextByDom();
}

export function getEditorContextByDocId(docId: string): ActiveEditorContext | null {
  const activeContext = getActiveEditorContext();

  if (activeContext?.docId === docId) {
    return activeContext;
  }

  for (const protyle of document.querySelectorAll<HTMLElement>(".protyle:not(.fn__none)")) {
    const contextDocId = getDocIdFromProtyleElement(protyle);

    if (contextDocId === docId && isVisibleElement(protyle)) {
      return { docId, protyle };
    }
  }

  return null;
}

function getActiveEditorContextByApi(): ActiveEditorContext | null {
  let editor: unknown;

  try {
    editor = getActiveEditor();
  } catch {
    return null;
  }

  const protyleInstance = getPossibleProtyleInstance(editor);
  const docId = getDocIdFromProtyleInstance(protyleInstance);
  const protyle = getProtyleElementFromInstance(protyleInstance);

  if (docId && protyle) {
    return { docId, protyle, editor: getReloadableEditor(editor) };
  }

  return null;
}

function getPossibleProtyleInstance(editor: unknown): Record<string, any> | null {
  if (!editor || typeof editor !== "object") {
    return null;
  }

  const editorRecord = editor as Record<string, any>;
  return editorRecord.protyle ?? editorRecord;
}

function getReloadableEditor(editor: unknown): ReloadableEditor | undefined {
  if (
    editor &&
    typeof editor === "object" &&
    typeof (editor as Record<string, unknown>).reload === "function"
  ) {
    return editor as ReloadableEditor;
  }

  return undefined;
}

function getDocIdFromProtyleInstance(
  protyleInstance: Record<string, any> | null,
): string | null {
  const docId = protyleInstance?.block?.rootID;
  return typeof docId === "string" && docId.length > 0 ? docId : null;
}

function getProtyleElementFromInstance(
  protyleInstance: Record<string, any> | null,
): HTMLElement | null {
  const candidates = [
    protyleInstance?.element,
    protyleInstance?.protyle?.element,
    protyleInstance?.wysiwyg?.element?.closest?.(".protyle"),
  ];

  for (const candidate of candidates) {
    if (candidate instanceof HTMLElement) {
      if (candidate.matches(".protyle")) {
        return candidate;
      }

      const closestProtyle = candidate.closest(".protyle");
      return closestProtyle instanceof HTMLElement ? closestProtyle : null;
    }
  }

  return null;
}

function getActiveEditorContextByDom(): ActiveEditorContext | null {
  const protyle = getActiveProtyleByDom();

  if (!protyle) {
    return null;
  }

  const docId = getDocIdFromProtyleElement(protyle);

  return docId ? { docId, protyle } : null;
}

function getDocIdFromProtyleElement(protyle: HTMLElement): string | null {
  return (
    protyle
      .querySelector<HTMLElement>(".protyle-title[data-node-id]")
      ?.getAttribute("data-node-id") ||
    protyle
      .querySelector<HTMLElement>('[data-type="NodeDocument"][data-node-id]')
      ?.getAttribute("data-node-id") ||
    protyle.getAttribute("data-id")
  );
}

function getActiveProtyleByDom(): HTMLElement | null {
  const candidates = [
    ".layout__wnd--active .protyle:not(.fn__none)",
    ".layout-tab-container .protyle:not(.fn__none)",
    ".protyle:not(.fn__none)",
  ];

  for (const selector of candidates) {
    const protyles = Array.from(document.querySelectorAll<HTMLElement>(selector));
    const visibleProtyle = protyles.find(isVisibleElement);

    if (visibleProtyle) {
      return visibleProtyle;
    }
  }

  return null;
}

function isVisibleElement(element: HTMLElement): boolean {
  return element.offsetParent !== null || element.getClientRects().length > 0;
}
