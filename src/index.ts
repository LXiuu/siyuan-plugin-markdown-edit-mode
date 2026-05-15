import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import {
  HighlightStyle,
  bracketMatching,
  forceParsing,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { Plugin, confirm, getFrontend, showMessage } from "siyuan";

import { exportMdContent, updateBlockByMarkdown } from "./api";
import {
  captureMarkdownCursorHint,
  captureProtyleCursorHint,
  resolveMarkdownCursorPosition,
  restoreProtyleCursorFromHint,
  type ProtyleCursorHint,
} from "./cursor";
import {
  getActiveEditorContext,
  getEditorContextByDocId,
  type ReloadableEditor,
} from "./dom";
import { getErrorMessage } from "./error";
import { normalizeMarkdownForSave, normalizePastedMarkdown } from "./markdown";
import "./style.css";

const STATUS_BUTTON_CLASS = "markdown-edit-mode-status-btn";
const FULLSCREEN_CLASS = "markdown-edit-mode-fullscreen";
const EDITOR_CLASS = "markdown-edit-mode-editor";
const EXIT_BUTTON_CLASS = "markdown-edit-mode-exit-btn";
const SAVE_STATUS_CLASS = "markdown-edit-mode-save-status";
const BUTTON_ICON_CLASS = "markdown-edit-mode-btn-icon";
const BUTTON_LABEL_CLASS = "markdown-edit-mode-btn-label";
const PREPARING_CLASS = "is-preparing";
const RENDERED_TEXT_WIDTH_PROPERTY = "--markdown-edit-mode-rendered-text-width";
const REALTIME_SAVE_DELAY = 1000;
const LEGACY_DRAFT_STORAGE_PREFIX = "siyuan-plugin-markdown-edit-mode:source-draft:v1:";
const PENDING_CURSOR_HINT_MAX_AGE = 1500;
const RENDERED_CURSOR_HINT_CACHE_MAX_AGE = 10000;
const RELOAD_RESTORE_TIMEOUT_MS = 6000;
const RELOAD_RESTORE_DEBOUNCE_MS = 80;
const RELOAD_RESTORE_GRACE_MS = 240;
const DOUBLE_CTRL_TAP_INTERVAL_MS = 450;
const SUPPORTED_FRONTENDS = new Set(["desktop", "browser-desktop", "desktop-window"]);

const DEFAULT_I18N = {
  name: "Markdown Source Mode",
  description: "Switch the current document into a lightweight Markdown source editor.",
  buttonEnterSourceMode: "Source",
  buttonExitSourceMode: "Exit",
  titleToggleSourceMode: "Toggle Markdown source mode",
  titleSaveAndExitSourceMode: "Save and exit Markdown source mode",
  messageDocumentNotFound: "No active document found",
  messageEnterFailed: "Failed to enter source mode: {{message}}",
  messageMarkdownSaved: "Markdown saved",
  messageSaveFailed: "Failed to save Markdown: {{message}}",
  dialogSaveRiskTitle: "Save source mode content",
  dialogSaveRiskContent:
    "Saving standard Markdown reparses the document. Complex blocks, block attributes, and child block IDs may not be preserved losslessly. Continue?",
  statusRealtimeEnabled: "Real-time updates enabled",
  statusRealtimeReadonly: "The current context is read-only; real-time updates are disabled",
  statusRealtimeSaving: "Updating...",
  statusRealtimeSuccess: "Updated {{time}}",
  statusRealtimeFailed: "Update failed {{time}}",
  errorExportFailed: "Failed to export Markdown",
  errorSaveFailed: "Failed to save Markdown",
  errorRefreshEditorFailed: "Failed to refresh the SiYuan editor",
} as const;

type I18nKey = keyof typeof DEFAULT_I18N;
type I18nParams = Record<string, string | number>;

interface DocumentCursorHint {
  docId: string;
  hint: ProtyleCursorHint;
  updatedAt: number;
}

interface SourceCursorSnapshot {
  docId: string;
  position: number;
  viewportY: number | null;
  updatedAt: number;
}

const typoraHighlightStyle = HighlightStyle.define([
  { tag: t.heading, color: "#dc4f87", fontWeight: "700" },
  { tag: t.heading1, fontSize: "1.85em", lineHeight: "1.5" },
  { tag: t.heading2, fontSize: "1.35em" },
  { tag: t.strong, color: "#111827", fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: [t.link, t.url], color: "#2456a6" },
  { tag: [t.monospace, t.special(t.string)], color: "#2449a6" },
  { tag: t.quote, color: "#65717c" },
  { tag: [t.meta, t.processingInstruction], color: "#dc4f87" },
  { tag: t.atom, color: "#8a5b12" },
]);

export default class MarkdownEditModePlugin extends Plugin {
  private isSourceMode = false;
  private isEntering = false;
  private isSaving = false;
  private activeDocId: string | null = null;
  private activeEditor: ReloadableEditor | null = null;
  private activeProtyle: HTMLElement | null = null;
  private sourceEditor: EditorView | null = null;
  private originalMarkdown = "";
  private removedFrontMatterCount = 0;
  private removedDocTitleHeadingCount = 0;
  private activeDocTitle: string | null = null;
  private statusButton: HTMLButtonElement | null = null;
  private fullscreenElement: HTMLElement | null = null;
  private saveStatusElement: HTMLElement | null = null;
  private hasConfirmedWriteRisk = false;
  private pendingCursorHint: DocumentCursorHint | null = null;
  private lastRenderedCursorHint: DocumentCursorHint | null = null;
  private lastSourceCursor: SourceCursorSnapshot | null = null;
  private realtimeSaveTimerId: number | null = null;
  private realtimeSavePromise: Promise<boolean> | null = null;
  private realtimeSaveRequested = false;
  private sourceDirty = false;
  private lastSavedMarkdown = "";
  private hasRealtimeSaved = false;
  private lastRealtimeSaveErrorAt = 0;
  private operationGeneration = 0;
  private isRestoringRenderedCursor = false;
  private statusButtonFrameId: number | null = null;
  private sourceWidthFrameId: number | null = null;
  private sourceEditorTextWidth: number | null = null;
  private ctrlTapArmed = false;
  private ctrlTapHadOtherKey = false;
  private lastCtrlTapAt = 0;

  private t(key: I18nKey, params: I18nParams = {}): string {
    const value = this.i18n?.[key];
    const template = typeof value === "string" && value.length > 0 ? value : DEFAULT_I18N[key];

    return template.replace(/\{\{(\w+)}}/g, (_, token: string) =>
      String(params[token] ?? ""),
    );
  }

  onload() {
    if (!isSupportedFrontend()) {
      return;
    }

    window.addEventListener("keydown", this.keydownHandler, true);
    window.addEventListener("keyup", this.keyupHandler, true);
    window.addEventListener("resize", this.windowResizeHandler, true);
    window.addEventListener("scroll", this.positionStatusButton, true);
    window.addEventListener("pointerdown", this.positionStatusButton, true);
    window.addEventListener("beforeunload", this.beforeUnloadHandler, true);
    window.addEventListener("pagehide", this.beforeUnloadHandler, true);
  }

  onLayoutReady() {
    if (!isSupportedFrontend()) {
      return;
    }

    this.createStatusButton();
  }

  onunload() {
    window.removeEventListener("keydown", this.keydownHandler, true);
    window.removeEventListener("keyup", this.keyupHandler, true);
    window.removeEventListener("resize", this.windowResizeHandler, true);
    window.removeEventListener("scroll", this.positionStatusButton, true);
    window.removeEventListener("pointerdown", this.positionStatusButton, true);
    window.removeEventListener("beforeunload", this.beforeUnloadHandler, true);
    window.removeEventListener("pagehide", this.beforeUnloadHandler, true);
    void this.flushRealtimeSave();
    this.cleanupSourceMode();
    this.statusButton?.remove();
    this.statusButton = null;
  }

  private createStatusButton() {
    if (this.statusButton) {
      return;
    }

    const button = document.createElement("button");
    button.className = STATUS_BUTTON_CLASS;
    button.type = "button";
    button.tabIndex = -1;
    setModeButtonContent(button, this.t("buttonEnterSourceMode"));
    button.title = this.t("titleToggleSourceMode");
    button.setAttribute("aria-label", this.t("titleToggleSourceMode"));
    button.setAttribute("aria-pressed", "false");

    const captureCursor = () => {
      if (this.isEntering || this.isSaving || this.isRestoringRenderedCursor) {
        return;
      }

      const context = getActiveEditorContext();
      this.pendingCursorHint = context ? this.captureRenderedCursor(context) : null;
    };

    button.addEventListener("pointerdown", (event) => {
      preventModeButtonFocus(event);
      captureCursor();
    });
    button.addEventListener("mousedown", preventModeButtonFocus);
    button.addEventListener(
      "touchstart",
      (event) => {
        preventModeButtonFocus(event);
        captureCursor();
      },
      { passive: false },
    );
    button.addEventListener(
      "touchend",
      (event) => {
        preventModeButtonFocus(event);
        void this.toggleSourceMode();
      },
      { passive: false },
    );
    button.addEventListener("click", (event) => {
      preventModeButtonFocus(event);
      void this.toggleSourceMode();
    });

    this.statusButton = button;
    document.body.appendChild(button);
    this.positionStatusButton();
  }

  private async toggleSourceMode() {
    if (this.isEntering || this.isSaving || this.isRestoringRenderedCursor) {
      return;
    }

    if (this.isSourceMode) {
      await this.exitSourceMode(true);
      return;
    }

    await this.enterSourceMode();
  }

  private async enterSourceMode() {
    if (this.isSourceMode || this.isEntering || this.isSaving || this.isRestoringRenderedCursor) {
      return;
    }

    const context = getActiveEditorContext();

    if (!context) {
      showMessage(this.t("messageDocumentNotFound"), 3000, "error");
      return;
    }

    this.isEntering = true;
    this.updateButtonsBusy(true);
    const generation = this.beginOperation();

    try {
      if (generation !== this.operationGeneration) {
        return;
      }

      const cursorHint = this.getCursorHintForEnter(context);
      const {
        markdown,
        removedFrontMatterCount,
        removedDocTitleHeadingCount,
        docTitle,
      } = await exportMdContent(context.docId, {
        exportFailed: this.t("errorExportFailed"),
      });
      this.clearLegacyDraft(context.docId);
      const initialCursor = resolveMarkdownCursorPosition(markdown, cursorHint);
      this.activeProtyle = context.protyle;
      this.activeDocId = context.docId;
      this.activeEditor = context.editor ?? null;
      const editor = this.createFullscreenEditor(
        markdown,
        initialCursor,
        cursorHint?.viewportY ?? null,
        getRenderedTextWidth(context.protyle),
      );

      this.sourceEditor = editor;
      this.originalMarkdown = markdown;
      this.lastSavedMarkdown = markdown;
      this.sourceDirty = false;
      this.rememberSourceCursor(editor, initialCursor, cursorHint?.viewportY ?? null);
      this.hasRealtimeSaved = false;
      this.removedFrontMatterCount = removedFrontMatterCount;
      this.removedDocTitleHeadingCount = removedDocTitleHeadingCount;
      this.activeDocTitle = docTitle;
      this.isSourceMode = true;

      this.updateButtonState(true);
    } catch (error) {
      console.error(error);
      showMessage(
        this.t("messageEnterFailed", { message: getErrorMessage(error) }),
        5000,
        "error",
      );
      this.cleanupSourceMode();
    } finally {
      this.isEntering = false;
      this.pendingCursorHint = null;
      this.updateButtonsBusy(false);
    }
  }

  private createFullscreenEditor(
    markdown: string,
    initialCursor: number,
    viewportY: number | null,
    renderedTextWidth: number | null,
  ): EditorView {
    this.fullscreenElement?.remove();
    const initialSelection = clampEditorPosition(initialCursor, markdown.length);

    const fullscreen = document.createElement("div");
    fullscreen.className = `${FULLSCREEN_CLASS} ${PREPARING_CLASS}`;

    const editorHost = document.createElement("div");
    editorHost.className = EDITOR_CLASS;
    this.sourceEditorTextWidth = normalizeRenderedTextWidth(renderedTextWidth);
    setSourceEditorTextWidth(editorHost, this.sourceEditorTextWidth);

    const exitButton = document.createElement("button");
    exitButton.className = EXIT_BUTTON_CLASS;
    exitButton.type = "button";
    exitButton.tabIndex = -1;
    setModeButtonContent(exitButton, this.t("buttonExitSourceMode"));
    exitButton.title = this.t("titleSaveAndExitSourceMode");
    exitButton.setAttribute("aria-label", this.t("titleSaveAndExitSourceMode"));
    exitButton.style.left = this.statusButton?.style.left || "12px";
    const rememberCursor = () => this.rememberSourceCursor(editor);
    const exit = () => {
      void this.exitSourceMode(true);
    };

    exitButton.addEventListener("pointerdown", (event) => {
      preventModeButtonFocus(event);
      rememberCursor();
    });
    exitButton.addEventListener("mousedown", preventModeButtonFocus);
    exitButton.addEventListener(
      "touchstart",
      (event) => {
        preventModeButtonFocus(event);
        rememberCursor();
      },
      { passive: false },
    );
    exitButton.addEventListener(
      "touchend",
      (event) => {
        preventModeButtonFocus(event);
        exit();
      },
      { passive: false },
    );
    exitButton.addEventListener("click", (event) => {
      preventModeButtonFocus(event);
      exit();
    });

    const saveStatus = document.createElement("div");
    saveStatus.className = SAVE_STATUS_CLASS;
    saveStatus.textContent = this.t("statusRealtimeEnabled");

    fullscreen.appendChild(editorHost);
    fullscreen.appendChild(exitButton);
    fullscreen.appendChild(saveStatus);
    document.body.appendChild(fullscreen);

    const editor = new EditorView({
      parent: editorHost,
      state: EditorState.create({
        doc: markdown,
        selection: { anchor: initialSelection },
        extensions: this.createEditorExtensions(),
      }),
    });

    this.fullscreenElement = fullscreen;
    this.saveStatusElement = saveStatus;

    window.setTimeout(() => {
      if (this.sourceEditor !== editor || !this.isSourceMode) {
        return;
      }

      this.syncSourceEditorWidth();
      focusSourceEditorWithoutScroll(editor);
      editor.dispatch({
        selection: { anchor: clampEditorPosition(initialSelection, editor.state.doc.length) },
        scrollIntoView: true,
      });
      parseSourceEditorBeforeReveal(editor, initialSelection);
      alignSourceCursorToViewportY(editor, initialSelection, viewportY);
      fullscreen.classList.remove(PREPARING_CLASS);
      this.scheduleSourceParsing(editor);
      this.scheduleSourceCursorViewportAlignment(editor, initialSelection, viewportY);
    });

    return editor;
  }

  private scheduleSourceParsing(editor: EditorView) {
    const parseVisibleRange = () => {
      if (this.sourceEditor !== editor) {
        return;
      }

      forceParsing(editor, editor.viewport.to, 20);
    };

    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(parseVisibleRange, { timeout: 500 });
      return;
    }

    globalThis.setTimeout(parseVisibleRange, 50);
  }

  private createEditorExtensions(): Extension[] {
    return [
      lineNumbers({
        formatNumber: (lineNumber) => (lineNumber % 5 === 0 ? String(lineNumber) : ""),
      }),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      EditorState.readOnly.of(false),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      markdown(),
      EditorView.lineWrapping,
      syntaxHighlighting(typoraHighlightStyle, { fallback: true }),
      EditorView.editable.of(true),
      EditorView.domEventHandlers({
        paste: (event, view) => this.handleEditorPaste(event, view),
      }),
      EditorView.updateListener.of((update) => {
        if (update.selectionSet || update.docChanged) {
          this.rememberSourceCursor(update.view);
        }

        if (update.docChanged) {
          this.sourceDirty = true;
          this.scheduleRealtimeSave();
        }
      }),
      keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            void this.exitSourceMode(true);
            return true;
          },
        },
        {
          key: "Escape",
          preventDefault: true,
          run: () => {
            void this.handleEscapeExit();
            return true;
          },
        },
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
      ]),
    ];
  }

  private scheduleSourceCursorViewportAlignment(
    view: EditorView,
    position: number,
    viewportY: number | null,
  ) {
    if (viewportY === null || !Number.isFinite(viewportY)) {
      return;
    }

    for (const delay of [60, 180]) {
      window.setTimeout(() => {
        if (this.sourceEditor !== view) {
          return;
        }

        alignSourceCursorToViewportY(view, position, viewportY);
      }, delay);
    }
  }

  private handleEditorPaste(event: ClipboardEvent, view: EditorView): boolean {
    const clipboardText = event.clipboardData?.getData("text/plain");

    if (!clipboardText) {
      return false;
    }

    event.preventDefault();

    const pastedMarkdown = normalizePastedMarkdown(clipboardText);
    const transaction = view.state.replaceSelection(pastedMarkdown);

    view.dispatch({
      ...transaction,
      scrollIntoView: true,
      userEvent: "input.paste",
    });

    return true;
  }

  private isReadonlyContext(): boolean {
    const siyuan = (window as any).siyuan;
    return Boolean(siyuan?.config?.readonly || siyuan?.isPublish);
  }

  private confirmWriteRisk(): Promise<boolean> {
    if (this.hasConfirmedWriteRisk) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      confirm(
        this.t("dialogSaveRiskTitle"),
        this.t("dialogSaveRiskContent"),
        () => {
          this.hasConfirmedWriteRisk = true;
          resolve(true);
        },
        () => resolve(false),
      );
    });
  }

  private async exitSourceMode(save = true) {
    if (!this.isSourceMode || this.isSaving) {
      return;
    }

    const docId = this.activeDocId;
    const editor = this.sourceEditor;

    if (!docId || !editor) {
      this.cleanupSourceMode();
      return;
    }

    const markdown = this.getCurrentSourceMarkdown(editor);
    const sourceCursor = this.getSourceCursorSnapshot(editor);
    const renderCursorHint = captureMarkdownCursorHint(
      markdown,
      sourceCursor.position,
      sourceCursor.viewportY ?? getSourceCursorViewportY(editor, sourceCursor.position),
    );
    this.cacheRenderedCursorHint(docId, renderCursorHint);
    let saved = false;
    let editorToRefresh: ReloadableEditor | null = null;

    try {
      this.isSaving = true;
      this.updateButtonsBusy(true);
      const generation = this.beginOperation();

      if (save) {
        saved = await this.flushRealtimeSave();
        editorToRefresh = this.activeEditor;

        if (generation !== this.operationGeneration) {
          return;
        }

        if (this.hasSourceChanges()) {
          return;
        }
      }

      const shouldReloadEditor = saved || this.hasRealtimeSaved;

      if (shouldReloadEditor) {
        this.tryRestoreRenderedCursor(docId, renderCursorHint);
        this.cleanupSourceMode();
        this.lockRenderedCursorRestore(generation);
        this.reloadEditor(editorToRefresh, docId, renderCursorHint, generation);
        showMessage(this.t("messageMarkdownSaved"), 2000, "info");
      } else {
        this.cleanupSourceMode();
        this.restoreRenderedCursor(docId, renderCursorHint, false, generation);
      }
    } catch (error) {
      console.error(error);
      showMessage(
        this.t("messageSaveFailed", { message: getErrorMessage(error) }),
        5000,
        "error",
      );
    } finally {
      this.isSaving = false;
      this.updateButtonsBusy(false);
    }
  }

  private cleanupSourceMode() {
    this.stopRealtimeSaveTimer();
    this.sourceEditor?.destroy();
    this.sourceEditor = null;
    this.saveStatusElement = null;
    this.fullscreenElement?.remove();
    this.fullscreenElement = null;

    this.isSourceMode = false;
    this.isEntering = false;
    this.isSaving = false;
    this.isRestoringRenderedCursor = false;
    this.activeDocId = null;
    this.activeEditor = null;
    this.activeProtyle = null;
    this.lastSourceCursor = null;
    this.originalMarkdown = "";
    this.lastSavedMarkdown = "";
    this.realtimeSaveRequested = false;
    this.sourceDirty = false;
    this.hasRealtimeSaved = false;
    this.removedFrontMatterCount = 0;
    this.removedDocTitleHeadingCount = 0;
    this.activeDocTitle = null;
    this.sourceEditorTextWidth = null;

    this.updateButtonState(false);
    this.updateButtonsBusy(false);
    this.positionStatusButton();
  }

  private updateButtonState(active: boolean) {
    if (!this.statusButton) {
      return;
    }

    updateModeButtonLabel(
      this.statusButton,
      active ? this.t("buttonExitSourceMode") : this.t("buttonEnterSourceMode"),
    );
    this.statusButton.title = active
      ? this.t("titleSaveAndExitSourceMode")
      : this.t("titleToggleSourceMode");
    this.statusButton.setAttribute(
      "aria-label",
      active ? this.t("titleSaveAndExitSourceMode") : this.t("titleToggleSourceMode"),
    );
    this.statusButton.setAttribute("aria-pressed", String(active));
    this.statusButton.classList.toggle("is-active", active);
    this.statusButton.classList.toggle("is-hidden", active);
  }

  private updateButtonsBusy(busy: boolean) {
    if (this.statusButton) {
      this.statusButton.disabled = busy || this.isRestoringRenderedCursor;
    }

    const exitButton = this.fullscreenElement?.querySelector<HTMLButtonElement>(
      `.${EXIT_BUTTON_CLASS}`,
    );

    if (exitButton) {
      exitButton.disabled = busy;
    }
  }

  private positionStatusButton = () => {
    if (this.isSourceMode) {
      return;
    }

    const button = this.statusButton;

    if (!button) {
      return;
    }

    if (this.statusButtonFrameId !== null) {
      return;
    }

    this.statusButtonFrameId = window.requestAnimationFrame(() => {
      this.statusButtonFrameId = null;
      const context = getActiveEditorContext();
      const rect = context?.protyle.getBoundingClientRect();

      if (!rect || rect.width <= 0 || rect.height <= 0) {
        button.style.left = "12px";
        button.style.bottom = "4px";
        return;
      }

      button.style.left = `${Math.max(8, Math.round(rect.left + 8))}px`;
      button.style.bottom = "4px";
    });
  };

  private windowResizeHandler = () => {
    if (this.isSourceMode) {
      this.scheduleSourceEditorWidthSync();
      return;
    }

    this.positionStatusButton();
  };

  private scheduleSourceEditorWidthSync = () => {
    if (this.sourceWidthFrameId !== null) {
      return;
    }

    this.sourceWidthFrameId = window.requestAnimationFrame(() => {
      this.sourceWidthFrameId = null;
      this.syncSourceEditorWidth();
    });
  };

  private syncSourceEditorWidth = () => {
    const protyle = this.activeProtyle;
    const editorHost = this.fullscreenElement?.querySelector<HTMLElement>(
      `.${EDITOR_CLASS}`,
    );

    if (!protyle || !editorHost) {
      return;
    }

    const nextWidth = normalizeRenderedTextWidth(getRenderedTextWidth(protyle));

    if (nextWidth === this.sourceEditorTextWidth) {
      return;
    }

    this.sourceEditorTextWidth = nextWidth;
    setSourceEditorTextWidth(editorHost, nextWidth);
    this.sourceEditor?.requestMeasure();
  };

  private hasSourceChanges(): boolean {
    if (!this.sourceDirty && !this.needsCleanupSave()) {
      return false;
    }

    const markdown = this.sourceEditor?.state.doc.toString();
    return typeof markdown === "string"
      ? normalizeMarkdownForSave(markdown) !== this.lastSavedMarkdown
      : false;
  }

  private scheduleRealtimeSave() {
    if (!this.isSourceMode || this.isSaving) {
      return;
    }

    this.realtimeSaveRequested = true;
    this.stopRealtimeSaveTimer();
    this.realtimeSaveTimerId = window.setTimeout(() => {
      void this.flushRealtimeSave();
    }, REALTIME_SAVE_DELAY);
  }

  private stopRealtimeSaveTimer() {
    if (this.realtimeSaveTimerId !== null) {
      window.clearTimeout(this.realtimeSaveTimerId);
      this.realtimeSaveTimerId = null;
    }
  }

  private async flushRealtimeSave(): Promise<boolean> {
    if (!this.isSourceMode || !this.sourceEditor || !this.activeDocId) {
      return false;
    }

    if (!this.hasPendingSourceSave()) {
      return false;
    }

    this.realtimeSaveRequested = true;
    this.stopRealtimeSaveTimer();

    if (this.realtimeSavePromise) {
      return this.realtimeSavePromise;
    }

    this.realtimeSavePromise = this.drainRealtimeSaveQueue();

    try {
      return await this.realtimeSavePromise;
    } finally {
      this.realtimeSavePromise = null;
    }
  }

  private async drainRealtimeSaveQueue(): Promise<boolean> {
    let saved = false;

    while (this.realtimeSaveRequested) {
      this.realtimeSaveRequested = false;
      saved = (await this.performRealtimeSave()) || saved;
    }

    return saved;
  }

  private async performRealtimeSave(): Promise<boolean> {
    const docId = this.activeDocId;
    const editor = this.sourceEditor;

    if (!docId || !editor) {
      return false;
    }

    const markdown = normalizeMarkdownForSave(editor.state.doc.toString());
    const needsCleanupSave = this.needsCleanupSave();

    if (markdown === this.lastSavedMarkdown && !needsCleanupSave) {
      this.sourceDirty = false;
      return false;
    }

    try {
      if (this.isReadonlyContext()) {
        this.updateRealtimeSaveStatus(this.t("statusRealtimeReadonly"), true);
        return false;
      }

      this.updateRealtimeSaveStatus(this.t("statusRealtimeSaving"));
      await updateBlockByMarkdown(docId, markdown, {
        docTitle: this.activeDocTitle,
        fallbackMessage: this.t("errorSaveFailed"),
      });
      this.originalMarkdown = markdown;
      this.lastSavedMarkdown = markdown;
      this.sourceDirty = false;
      this.removedFrontMatterCount = 0;
      this.removedDocTitleHeadingCount = 0;
      this.hasRealtimeSaved = true;
      this.updateRealtimeSaveStatus(
        this.t("statusRealtimeSuccess", { time: formatStatusTime(new Date()) }),
      );
      return true;
    } catch (error) {
      const now = Date.now();

      console.error(error);

      if (now - this.lastRealtimeSaveErrorAt > 5000) {
        this.lastRealtimeSaveErrorAt = now;
        this.updateRealtimeSaveStatus(
          this.t("statusRealtimeFailed", { time: formatStatusTime(new Date()) }),
          true,
        );
      }

      return false;
    }
  }

  private updateRealtimeSaveStatus(text: string, isError = false) {
    const element = this.saveStatusElement;

    if (!element) {
      return;
    }

    element.textContent = text;
    element.classList.toggle("is-error", isError);
  }

  private getCurrentSourceMarkdown(editor: EditorView): string {
    if (!this.sourceDirty && !this.realtimeSaveRequested && !this.needsCleanupSave()) {
      return this.lastSavedMarkdown || this.originalMarkdown;
    }

    return normalizeMarkdownForSave(editor.state.doc.toString());
  }

  private hasPendingSourceSave(): boolean {
    return this.realtimeSaveRequested || this.sourceDirty || this.needsCleanupSave();
  }

  private needsCleanupSave(): boolean {
    return this.removedFrontMatterCount > 1 || this.removedDocTitleHeadingCount > 1;
  }

  private rememberSourceCursor(
    editor: EditorView,
    position = editor.state.selection.main.head,
    viewportY = getSourceCursorViewportY(editor, position),
  ) {
    const docId = this.activeDocId;

    if (!docId) {
      return;
    }

    this.lastSourceCursor = {
      docId,
      position: clampEditorPosition(position, editor.state.doc.length),
      viewportY: sanitizeViewportY(viewportY),
      updatedAt: Date.now(),
    };
  }

  private getSourceCursorSnapshot(editor: EditorView): SourceCursorSnapshot {
    const docId = this.activeDocId ?? "";
    const position = clampEditorPosition(editor.state.selection.main.head, editor.state.doc.length);
    const cached = this.lastSourceCursor?.docId === docId ? this.lastSourceCursor : null;

    return {
      docId,
      position,
      viewportY: cached?.position === position
        ? cached.viewportY ?? getSourceCursorViewportY(editor, position)
        : getSourceCursorViewportY(editor, position),
      updatedAt: Date.now(),
    };
  }

  private captureRenderedCursor(context: { docId: string; protyle: HTMLElement }): DocumentCursorHint | null {
    const hint = captureProtyleCursorHint(context.protyle);

    if (!hint) {
      const cached = this.getCachedRenderedCursorHint(context.docId);
      return cached;
    }

    const cursorHint = {
      docId: context.docId,
      hint,
      updatedAt: Date.now(),
    };
    this.lastRenderedCursorHint = cursorHint;
    return cursorHint;
  }

  private getCursorHintForEnter(context: { docId: string; protyle: HTMLElement }): ProtyleCursorHint | null {
    const pending = this.pendingCursorHint;
    const pendingHint =
      pending?.docId === context.docId &&
      Date.now() - pending.updatedAt <= PENDING_CURSOR_HINT_MAX_AGE
        ? pending.hint
        : null;

    if (pendingHint) {
      return pendingHint;
    }

    return this.captureRenderedCursor(context)?.hint ?? null;
  }

  private cacheRenderedCursorHint(docId: string, hint: ProtyleCursorHint | null) {
    if (!hint) {
      return;
    }

    this.lastRenderedCursorHint = { docId, hint, updatedAt: Date.now() };
  }

  private getCachedRenderedCursorHint(docId: string): DocumentCursorHint | null {
    const cached = this.lastRenderedCursorHint;

    if (!cached || cached.docId !== docId) {
      return null;
    }

    if (Date.now() - cached.updatedAt > RENDERED_CURSOR_HINT_CACHE_MAX_AGE) {
      return null;
    }

    return cached;
  }

  private clearLegacyDraft(docId: string) {
    try {
      window.localStorage.removeItem(`${LEGACY_DRAFT_STORAGE_PREFIX}${docId}`);
    } catch {
      // Ignore legacy cleanup failures.
    }
  }

  private reloadEditor(
    editor: ReloadableEditor | null,
    docId: string,
    cursorHint: ProtyleCursorHint | null,
    generation: number,
    onCursorRestored?: () => void,
  ) {
    window.setTimeout(() => {
      if (generation !== this.operationGeneration) {
        onCursorRestored?.();
        return;
      }

      try {
        editor?.reload(false);
        this.restoreRenderedCursor(docId, cursorHint, true, generation, onCursorRestored);
      } catch (error) {
        console.warn(this.t("errorRefreshEditorFailed"), error);
        this.restoreRenderedCursor(docId, cursorHint, true, generation, onCursorRestored);
      }
    });
  }

  private restoreRenderedCursor(
    docId: string,
    cursorHint: ProtyleCursorHint | null,
    afterReload: boolean,
    generation: number,
    onFinished?: (restored: boolean) => void,
  ) {
    if (generation !== this.operationGeneration) {
      onFinished?.(false);
      return;
    }

    if (!cursorHint) {
      this.unlockRenderedCursorRestore(generation);
      onFinished?.(false);
      return;
    }

    if (!afterReload) {
      const restored = this.tryRestoreRenderedCursor(docId, cursorHint);
      onFinished?.(restored);
      return;
    }

    this.lockRenderedCursorRestore(generation);

    let finished = false;
    let debounceId: number | null = null;
    let timeoutId: number | null = null;
    let graceId: number | null = null;
    let observer: MutationObserver | null = null;

    const finish = (success: boolean) => {
      if (finished) {
        return;
      }

      finished = true;

      if (debounceId !== null) {
        window.clearTimeout(debounceId);
        debounceId = null;
      }

      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }

      if (graceId !== null) {
        window.clearTimeout(graceId);
        graceId = null;
      }

      observer?.disconnect();
      observer = null;

      this.unlockRenderedCursorRestore(generation);
      onFinished?.(success);
    };

    const tryRestore = () => {
      if (finished) {
        return;
      }

      if (generation !== this.operationGeneration) {
        finish(false);
        return;
      }

      if (this.tryRestoreRenderedCursor(docId, cursorHint)) {
        finish(true);
      }
    };

    const target = this.findReloadObserverTarget(docId);

    if (target) {
      observer = new MutationObserver(() => {
        if (finished) {
          return;
        }

        if (graceId !== null) {
          window.clearTimeout(graceId);
          graceId = null;
        }

        if (debounceId !== null) {
          window.clearTimeout(debounceId);
        }

        debounceId = window.setTimeout(() => {
          debounceId = null;
          tryRestore();
        }, RELOAD_RESTORE_DEBOUNCE_MS);
      });
      observer.observe(target, { childList: true, subtree: true });
    }

    graceId = window.setTimeout(() => {
      graceId = null;
      tryRestore();
    }, RELOAD_RESTORE_GRACE_MS);

    timeoutId = window.setTimeout(() => {
      timeoutId = null;
      tryRestore();

      if (!finished) {
        finish(false);
      }
    }, RELOAD_RESTORE_TIMEOUT_MS);
  }

  private findReloadObserverTarget(docId: string): HTMLElement | null {
    const context = getEditorContextByDocId(docId);
    return context?.protyle ?? null;
  }

  private beginOperation(): number {
    this.operationGeneration += 1;
    this.isRestoringRenderedCursor = false;
    return this.operationGeneration;
  }

  private lockRenderedCursorRestore(generation: number) {
    if (generation !== this.operationGeneration) {
      return;
    }

    this.isRestoringRenderedCursor = true;
    this.updateButtonsBusy(true);
  }

  private unlockRenderedCursorRestore(generation: number) {
    if (generation !== this.operationGeneration) {
      return;
    }

    this.isRestoringRenderedCursor = false;
    this.updateButtonsBusy(false);
  }

  private tryRestoreRenderedCursor(
    docId: string,
    cursorHint: ProtyleCursorHint | null,
  ): boolean {
    if (!cursorHint) {
      return false;
    }

    const context = getEditorContextByDocId(docId);

    if (!context) {
      return false;
    }

    return restoreProtyleCursorFromHint(context.protyle, cursorHint);
  }

  private keydownHandler = async (event: KeyboardEvent) => {
    const key = event.key.toLowerCase();

    this.trackCtrlTapKeydown(event);

    if (this.isSourceMode && event.ctrlKey && key === "s") {
      this.resetCtrlTap();
      event.preventDefault();
      await this.exitSourceMode(true);
      return;
    }

    if (event.ctrlKey && key !== "control") {
      this.resetCtrlTap();
    }

    if (this.isSourceMode && event.key === "Escape") {
      this.resetCtrlTap();
      event.preventDefault();
      await this.handleEscapeExit();
    }
  };

  private keyupHandler = async (event: KeyboardEvent) => {
    if (event.key !== "Control") {
      return;
    }

    if (!this.ctrlTapArmed || this.ctrlTapHadOtherKey) {
      this.resetCtrlTap();
      return;
    }

    const now = Date.now();
    const isDoubleTap = now - this.lastCtrlTapAt <= DOUBLE_CTRL_TAP_INTERVAL_MS;
    this.lastCtrlTapAt = now;
    this.ctrlTapArmed = false;

    if (isDoubleTap) {
      this.lastCtrlTapAt = 0;
      event.preventDefault();
      await this.toggleSourceMode();
    }
  };

  private trackCtrlTapKeydown(event: KeyboardEvent) {
    if (event.key === "Control") {
      if (event.altKey || event.metaKey || event.shiftKey) {
        this.resetCtrlTap();
        return;
      }

      if (!event.repeat) {
        this.ctrlTapArmed = true;
        this.ctrlTapHadOtherKey = false;
      }
      return;
    }

    if (!event.ctrlKey && this.lastCtrlTapAt > 0) {
      this.resetCtrlTap();
      return;
    }

    if (this.ctrlTapArmed || event.ctrlKey) {
      this.ctrlTapHadOtherKey = true;
    }
  }

  private resetCtrlTap() {
    this.ctrlTapArmed = false;
    this.ctrlTapHadOtherKey = false;
    this.lastCtrlTapAt = 0;
  }

  private async handleEscapeExit() {
    await this.exitSourceMode(true);
  }

  private beforeUnloadHandler = () => {
    void this.flushRealtimeSave();
  };
}

function getSourceCursorViewportY(editor: EditorView, position: number): number | null {
  const coords = editor.coordsAtPos(clampEditorPosition(position, editor.state.doc.length));
  return coords?.top ?? null;
}

function alignSourceCursorToViewportY(
  editor: EditorView,
  position: number,
  viewportY: number | null,
) {
  if (viewportY === null || !Number.isFinite(viewportY)) {
    return;
  }

  const coords = editor.coordsAtPos(clampEditorPosition(position, editor.state.doc.length));

  if (!coords) {
    return;
  }

  const delta = coords.top - clampSourceViewportY(viewportY);

  if (Math.abs(delta) < 1) {
    return;
  }

  editor.scrollDOM.scrollTop += delta;
}

function focusSourceEditorWithoutScroll(editor: EditorView) {
  try {
    editor.contentDOM.focus({ preventScroll: true });
  } catch {
    editor.contentDOM.focus();
  }
}

function parseSourceEditorBeforeReveal(editor: EditorView, position: number) {
  const parseTarget = Math.min(
    editor.state.doc.length,
    Math.max(editor.viewport.to, clampEditorPosition(position, editor.state.doc.length) + 8000),
  );

  forceParsing(editor, parseTarget, 100);
}

function clampSourceViewportY(viewportY: number): number {
  const topPadding = 48;
  const bottomPadding = 64;

  if (window.innerHeight <= topPadding + bottomPadding) {
    return viewportY;
  }

  return Math.max(topPadding, Math.min(viewportY, window.innerHeight - bottomPadding));
}

function formatStatusTime(date: Date): string {
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function clampEditorPosition(position: number, length: number): number {
  return Math.max(0, Math.min(position, length));
}

function sanitizeViewportY(viewportY: number | null | undefined): number | null {
  return typeof viewportY === "number" && Number.isFinite(viewportY) ? viewportY : null;
}

function isSupportedFrontend(): boolean {
  try {
    return SUPPORTED_FRONTENDS.has(getFrontend());
  } catch {
    return true;
  }
}

function preventModeButtonFocus(event: Event) {
  event.preventDefault();
  event.stopPropagation();
}

function setSourceEditorTextWidth(editorHost: HTMLElement, width: number | null) {
  if (width && Number.isFinite(width) && width > 0) {
    editorHost.style.setProperty(RENDERED_TEXT_WIDTH_PROPERTY, `${Math.round(width)}px`);
    return;
  }

  editorHost.style.removeProperty(RENDERED_TEXT_WIDTH_PROPERTY);
}

function normalizeRenderedTextWidth(width: number | null): number | null {
  return width && Number.isFinite(width) && width > 0 ? Math.round(width) : null;
}

function getRenderedTextWidth(protyle: HTMLElement): number | null {
  const widthFromBlock = getFirstVisibleBlockWidth(protyle);

  if (widthFromBlock !== null) {
    return widthFromBlock;
  }

  const wysiwyg = protyle.querySelector<HTMLElement>(".protyle-wysiwyg");
  const widthFromWysiwyg = getElementContentWidth(wysiwyg);

  if (widthFromWysiwyg !== null) {
    return widthFromWysiwyg;
  }

  return getElementContentWidth(protyle.querySelector<HTMLElement>(".protyle-content"));
}

function getFirstVisibleBlockWidth(protyle: HTMLElement): number | null {
  const blocks = protyle.querySelectorAll<HTMLElement>(
    ".protyle-wysiwyg [data-node-id][data-type^='Node']",
  );

  for (const block of blocks) {
    if (
      block.classList.contains("protyle-title") ||
      block.getAttribute("data-type") === "NodeDocument"
    ) {
      continue;
    }

    const rect = block.getBoundingClientRect();

    if (rect.width > 0 && rect.height > 0) {
      return rect.width;
    }
  }

  return null;
}

function getElementContentWidth(element: HTMLElement | null): number | null {
  if (!element) {
    return null;
  }

  const rect = element.getBoundingClientRect();

  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }

  const style = window.getComputedStyle(element);
  const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
  const paddingRight = Number.parseFloat(style.paddingRight) || 0;
  const width = rect.width - paddingLeft - paddingRight;

  return width > 0 ? width : null;
}

function setModeButtonContent(button: HTMLButtonElement, label: string) {
  const icon = document.createElement("span");
  icon.className = BUTTON_ICON_CLASS;
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = [
    '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">',
    '<path class="markdown-edit-mode-btn-icon-code" d="M8 7L3 12l5 5M16 7l5 5-5 5" />',
    '<path class="markdown-edit-mode-btn-icon-slash" d="M14 4l-4 16" />',
    "</svg>",
  ].join("");

  const text = document.createElement("span");
  text.className = BUTTON_LABEL_CLASS;
  text.textContent = label;

  button.replaceChildren(icon, text);
}

function updateModeButtonLabel(button: HTMLButtonElement, label: string) {
  const labelElement = button.querySelector<HTMLElement>(`.${BUTTON_LABEL_CLASS}`);

  if (!labelElement) {
    setModeButtonContent(button, label);
    return;
  }

  labelElement.textContent = label;
}
