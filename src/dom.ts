import { getActiveEditor } from "siyuan";

export interface ActiveEditorContext {
  docId: string;
  protyle: HTMLElement;
  editor?: ReloadableEditor;
  disabled?: boolean;
}

export interface ReloadableEditor {
  reload(focus: boolean): void;
}

type ApiLookupResult =
  | { status: "ok"; context: ActiveEditorContext }
  | { status: "pending" }
  | { status: "absent" };

export function getActiveEditorContext(): ActiveEditorContext | null {
  const focusedContext = getActiveEditorContextByFocusedDom();

  if (focusedContext) {
    return focusedContext;
  }

  const apiResult = lookupActiveEditorContextByApi();

  if (apiResult.status === "ok") {
    return apiResult.context;
  }

  // SiYuan's API knows about a target document, but its protyle isn't
  // attached/visible yet (e.g., mid doc-switch). Returning a stale DOM
  // match here would point the UI at the previous document; instead let
  // the eventBus/focus listeners retry once the new protyle is mounted.
  if (apiResult.status === "pending") {
    return null;
  }

  return getActiveEditorContextByDom();
}

export function getEditorContextByDocId(docId: string): ActiveEditorContext | null {
  const activeContext = getActiveEditorContext();

  if (activeContext?.docId === docId) {
    return activeContext;
  }

  for (const protyle of document.querySelectorAll<HTMLElement>(".protyle:not(.fn__none)")) {
    const contextDocId = getDocIdFromProtyleElement(protyle);

    if (contextDocId === docId && isVisibleProtyle(protyle)) {
      return { docId, protyle };
    }
  }

  return null;
}

function lookupActiveEditorContextByApi(): ApiLookupResult {
  let editor: unknown;

  try {
    editor = getActiveEditor();
  } catch {
    return { status: "absent" };
  }

  if (editor === null || editor === undefined) {
    return { status: "absent" };
  }

  const protyleInstance = getPossibleProtyleInstance(editor);
  const docId = getDocIdFromProtyleInstance(protyleInstance);
  const protyle = getProtyleElementFromInstance(protyleInstance);

  if (!docId) {
    return { status: "absent" };
  }

  if (!protyle || !isVisibleProtyle(protyle)) {
    // API points at a doc whose protyle is not laid out yet.
    return { status: "pending" };
  }

  return {
    status: "ok",
    context: {
      docId,
      protyle,
      editor: getReloadableEditor(editor),
      disabled: getProtyleDisabledFromInstance(protyleInstance),
    },
  };
}

function getProtyleDisabledFromInstance(
  protyleInstance: Record<string, any> | null,
): boolean | undefined {
  if (!protyleInstance) {
    return undefined;
  }

  if (typeof protyleInstance.disabled === "boolean") {
    return protyleInstance.disabled;
  }

  if (typeof protyleInstance.protyle?.disabled === "boolean") {
    return protyleInstance.protyle.disabled;
  }

  return undefined;
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

function getActiveEditorContextByFocusedDom(): ActiveEditorContext | null {
  const protyle = getFocusedProtyleByDom();

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
  const focusedProtyle = getFocusedProtyleByDom();

  if (focusedProtyle) {
    return focusedProtyle;
  }

  const candidates = [
    ".layout__wnd--active .protyle:not(.fn__none)",
    ".layout-tab-container .protyle:not(.fn__none)",
    ".protyle:not(.fn__none)",
  ];

  for (const selector of candidates) {
    const protyles = Array.from(document.querySelectorAll<HTMLElement>(selector));
    const visibleProtyle = protyles.find(isVisibleProtyle);

    if (visibleProtyle) {
      return visibleProtyle;
    }
  }

  return null;
}

function getFocusedProtyleByDom(): HTMLElement | null {
  const activeElement = document.activeElement;
  const focusedProtyle =
    activeElement instanceof Element
      ? activeElement.closest<HTMLElement>(".protyle:not(.fn__none)")
      : null;

  if (focusedProtyle && isVisibleProtyle(focusedProtyle)) {
    return focusedProtyle;
  }

  const selection = document.getSelection();
  const selectionElement =
    selection?.anchorNode instanceof Element
      ? selection.anchorNode
      : selection?.anchorNode?.parentElement ?? null;
  const selectedProtyle = selectionElement?.closest<HTMLElement>(".protyle:not(.fn__none)");

  return selectedProtyle && isVisibleProtyle(selectedProtyle) ? selectedProtyle : null;
}

function isVisibleProtyle(protyle: HTMLElement): boolean {
  if (!isAttachedAndShown(protyle)) {
    return false;
  }

  if (!isDocumentEditorProtyle(protyle)) {
    return false;
  }

  const rect = protyle.getBoundingClientRect();
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.right > 0 &&
    rect.bottom > 0 &&
    rect.left < window.innerWidth &&
    rect.top < window.innerHeight
  );
}

function isAttachedAndShown(protyle: HTMLElement): boolean {
  if (!document.body.contains(protyle) || protyle.classList.contains("fn__none")) {
    return false;
  }

  return isVisibleElement(protyle);
}

function isDocumentEditorProtyle(protyle: HTMLElement): boolean {
  return !!(
    protyle.querySelector(".protyle-wysiwyg") &&
    (protyle.querySelector(".protyle-title[data-node-id]") ||
      protyle.querySelector('[data-type="NodeDocument"][data-node-id]') ||
      protyle.getAttribute("data-id"))
  );
}

function isVisibleElement(element: HTMLElement): boolean {
  return element.offsetParent !== null || element.getClientRects().length > 0;
}
