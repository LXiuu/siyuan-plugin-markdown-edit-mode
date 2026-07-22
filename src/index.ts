import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import {
  HighlightStyle,
  bracketMatching,
  forceParsing,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
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

import {
  exportMdContent,
  getBlockKramdown,
  getChildBlocks,
  getSiyuanBlockTree,
  updateBlockByMarkdown,
  updateBlockBySource,
  updateBlockByPreparedSource,
} from "./api";
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
} from "./dom";
import { getErrorMessage } from "./error";
import { normalizeMarkdownForSave, normalizePastedMarkdown } from "./markdown";
import {
  createSiyuanContainerEditPlan,
  haveSameSiyuanBlockTree,
  type SiyuanContainerEditPlan,
  type SiyuanContainerSourceUpdate,
} from "./siyuan-container";
import {
  createSiyuanSourceEditorSupport,
  type SiyuanSourceEditorSupport,
} from "./siyuan-protection";
import {
  collectSiyuanBlockEdits,
  createSiyuanSourceDocument,
  areSiyuanMarkdownBlocksEquivalent,
  getSiyuanChildBlockSource,
  matchesSiyuanBlockIal,
  matchesSiyuanKramdownSnapshot,
  matchesSiyuanSourceSnapshot,
  matchesSiyuanKramdownIals,
  movePositionOutsideProtectedBlock,
  validateSiyuanBlockEdit,
  prepareSiyuanListItemSourceForUpdate,
  type SiyuanBlockEdit,
  type SiyuanBlockValidationIssue,
  type SiyuanChildBlockData,
  type SiyuanSourceBlock,
  type SiyuanSourceDocument,
} from "./siyuan-source";
import "./style.css";

const STATUS_BUTTON_CLASS = "markdown-edit-mode-status-btn";
const FULLSCREEN_CLASS = "markdown-edit-mode-fullscreen";
const BLOCK_SOURCE_CLASS = "is-siyuan-block-source";
const EDITOR_CLASS = "markdown-edit-mode-editor";
const EXIT_BUTTON_CLASS = "markdown-edit-mode-exit-btn";
const SAVE_STATUS_CLASS = "markdown-edit-mode-save-status";
const BUTTON_ICON_CLASS = "markdown-edit-mode-btn-icon";
const BUTTON_LABEL_CLASS = "markdown-edit-mode-btn-label";
const SOURCE_ACTIVE_BODY_CLASS = "markdown-edit-mode-source-active";
const PREPARING_CLASS = "is-preparing";
const RENDERED_TEXT_WIDTH_PROPERTY = "--markdown-edit-mode-rendered-text-width";
const REALTIME_SAVE_DELAY = 1000;
const BLOCK_SOURCE_BACKUP_STORAGE_NAME = "last-block-source-backup.json";
const LEGACY_DRAFT_STORAGE_PREFIX = "siyuan-plugin-markdown-edit-mode:source-draft:v1:";
const PENDING_CURSOR_HINT_MAX_AGE = 600;
const RENDERED_CURSOR_HINT_CACHE_MAX_AGE = 10000;
const RELOAD_RESTORE_TIMEOUT_MS = 6000;
const RELOAD_RESTORE_DEBOUNCE_MS = 80;
const RELOAD_RESTORE_GRACE_MS = 240;
const DOUBLE_CTRL_TAP_INTERVAL_MS = 450;
const SUPPORTED_FRONTENDS = new Set(["desktop", "browser-desktop", "desktop-window"]);
const SOURCE_EDITOR_DEFAULT_TEXT_WIDTH = 690;

const DEFAULT_I18N = {
  name: "Markdown Source Mode",
  description: "Switch the current document into a lightweight Markdown source editor.",
  buttonEnterSourceMode: "Source",
  buttonExitSourceMode: "Exit",
  titleToggleSourceMode: "Toggle Markdown source mode",
  titleSaveAndExitSourceMode: "Save and exit Markdown source mode",
  messageDocumentNotFound: "No active document found",
  messageEnterFailed: "Failed to enter source mode: {{message}}",
  messageBlockSourceFallback: "Block-safe mode is unavailable; using lossy standard Markdown mode.",
  messageMarkdownSaved: "Markdown saved",
  messageSaveFailed: "Failed to save Markdown: {{message}}",
  dialogDiscardTitle: "Discard unsaved source changes?",
  dialogDiscardContent:
    "Saving is still incomplete. Discarding will remove source-editor changes that were not written to SiYuan. Changes already written to SiYuan will be kept and the document will refresh. Discard and exit?",
  dialogSaveRiskTitle: "Save source mode content",
  dialogSaveRiskContent:
    "Saving standard Markdown reparses the document. Complex blocks, block attributes, and child block IDs may not be preserved losslessly. Continue?",
  statusRealtimeEnabled: "Real-time updates enabled",
  statusRealtimeReadonly: "The current context is read-only; real-time updates are disabled",
  statusRealtimeSaving: "Updating...",
  statusRealtimeSuccess: "Updated {{time}}",
  statusRealtimeFailed: "Update failed {{time}}",
  statusBlockReady: "Block-safe updates · {{editable}} editable · {{protected}} protected",
  statusBlockModified: "Changes pending · protected blocks stay untouched",
  statusBlockSaving: "Updating {{count}} content block(s)...",
  statusBlockSuccess: "Updated {{count}} content block(s) {{time}}",
  statusBlockReadonly: "The current context is read-only; block updates are disabled",
  statusProtectedBlock: "This {{type}} edit would change protected block structure and was blocked",
  statusSaveCancelled: "Save cancelled",
  errorExportFailed: "Failed to export Markdown",
  errorSaveFailed: "Failed to save Markdown",
  errorBlockSourceLoadFailed: "Failed to load SiYuan content blocks",
  errorBlockKramdownLoadFailed: "Failed to load the lossless document snapshot",
  errorBlockIalMissing: "SiYuan block attributes could not be preserved safely.",
  errorBlockConflict: "The document changed outside source mode. Reload before saving.",
  errorBlockStructureChanged: "The document block structure changed during saving.",
  errorBlockValidationFailed: "This {{type}} edit would split a block, change protected structure, or convert to an incompatible block.",
  errorBlockBackupFailed: "Failed to create the pre-save recovery snapshot",
  errorBlockVerificationFailed: "SiYuan returned a different block representation after saving.",
  errorRefreshEditorFailed: "Failed to refresh the SiYuan editor",
  blockTypeParagraph: "Paragraph",
  blockTypeHeading: "Heading",
  blockTypeCode: "Code block",
  blockTypeMath: "Math block",
  blockTypeThematicBreak: "Divider",
  blockTypeList: "List",
  blockTypeBlockquote: "Blockquote",
  blockTypeTable: "Table",
  blockTypeCallout: "Callout",
  blockTypeSuperBlock: "Super block",
  blockTypeQueryEmbed: "Query embed",
  blockTypeAttributeView: "Database",
  blockTypeHtml: "HTML block",
  blockTypeIFrame: "Iframe",
  blockTypeVideo: "Video",
  blockTypeAudio: "Audio",
  blockTypeWidget: "Widget",
  blockTypeUnknown: "SiYuan content block",
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
  private sourceModeKind: "block" | "legacy" = "legacy";
  private isSourceMode = false;
  private isEntering = false;
  private isSaving = false;
  private activeDocId: string | null = null;
  private activeProtyle: HTMLElement | null = null;
  private sourceEditor: EditorView | null = null;
  private originalMarkdown = "";
  private removedFrontMatterCount = 0;
  private removedDocTitleHeadingCount = 0;
  private activeDocTitle: string | null = null;
  private statusButton: HTMLButtonElement | null = null;
  private statusButtonContext: { docId: string; protyle: HTMLElement } | null = null;
  private fullscreenElement: HTMLElement | null = null;
  private saveStatusElement: HTMLElement | null = null;
  private hasConfirmedWriteRisk = false;
  private pendingCursorHint: DocumentCursorHint | null = null;
  private lastRenderedCursorHint: DocumentCursorHint | null = null;
  private lastSourceCursor: SourceCursorSnapshot | null = null;
  private realtimeSaveTimerId: number | null = null;
  private readonlySyncTimerId: number | null = null;
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
  private reloadRestoreCleanup: (() => void) | null = null;
  private sourceReadonly = false;
  private blockSourceDocument: SiyuanSourceDocument | null = null;
  private blockEditorSupport: SiyuanSourceEditorSupport | null = null;
  private protectedStatusTimerId: number | null = null;
  private lastProtectedEditNoticeAt = 0;
  private readonlyCompartment = new Compartment();
  private editableCompartment = new Compartment();
  private ctrlTapArmed = false;
  private ctrlTapHadOtherKey = false;
  private lastCtrlTapAt = 0;
  private isDiscardPromptOpen = false;
  private statusButtonClickGate = createClickSuppressionGate();
  private exitButtonClickGate = createClickSuppressionGate();

  private t(key: I18nKey, params: I18nParams = {}): string {
    const value = this.i18n?.[key];
    const template = typeof value === "string" && value.length > 0 ? value : DEFAULT_I18N[key];

    return template.replace(/\{\{(\w+)}}/g, (_, token: string) =>
      String(params[token] ?? ""),
    );
  }

  private getSiyuanBlockTypeLabel(block: Pick<SiyuanSourceBlock, "type" | "subType">): string {
    let key: I18nKey;

    switch (block.type) {
      case "p":
        key = "blockTypeParagraph";
        break;
      case "h":
        key = "blockTypeHeading";
        break;
      case "c":
        key = "blockTypeCode";
        break;
      case "m":
        key = "blockTypeMath";
        break;
      case "tb":
        key = "blockTypeThematicBreak";
        break;
      case "l":
        key = "blockTypeList";
        break;
      case "b":
        key = "blockTypeBlockquote";
        break;
      case "t":
        key = "blockTypeTable";
        break;
      case "callout":
        key = "blockTypeCallout";
        break;
      case "s":
        key = "blockTypeSuperBlock";
        break;
      case "query_embed":
        key = "blockTypeQueryEmbed";
        break;
      case "av":
        key = "blockTypeAttributeView";
        break;
      case "html":
        key = "blockTypeHtml";
        break;
      case "iframe":
        key = "blockTypeIFrame";
        break;
      case "video":
        key = "blockTypeVideo";
        break;
      case "audio":
        key = "blockTypeAudio";
        break;
      case "widget":
        key = "blockTypeWidget";
        break;
      default:
        key = "blockTypeUnknown";
    }

    return this.t(key);
  }

  private getInitialSaveStatus(): string {
    if (this.isReadonlyContext()) {
      return this.sourceModeKind === "block"
        ? this.t("statusBlockReadonly")
        : this.t("statusRealtimeReadonly");
    }

    const sourceDocument = this.blockSourceDocument;

    if (this.sourceModeKind !== "block" || !sourceDocument) {
      return this.t("statusRealtimeEnabled");
    }

    return this.t("statusBlockReady", {
      editable: sourceDocument.blocks.filter((block) => block.editable).length,
      protected: sourceDocument.blocks.filter((block) => !block.editable).length,
    });
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
    window.addEventListener("focusin", this.positionStatusButton, true);
    window.addEventListener("beforeunload", this.beforeUnloadHandler, true);
    window.addEventListener("pagehide", this.beforeUnloadHandler, true);

    this.eventBus.on("switch-protyle", this.protyleSwitchHandler);
    this.eventBus.on("loaded-protyle-static", this.protyleSwitchHandler);
    this.eventBus.on("switch-protyle-mode", this.protyleSwitchHandler);
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
    window.removeEventListener("focusin", this.positionStatusButton, true);
    window.removeEventListener("beforeunload", this.beforeUnloadHandler, true);
    window.removeEventListener("pagehide", this.beforeUnloadHandler, true);

    this.eventBus.off("switch-protyle", this.protyleSwitchHandler);
    this.eventBus.off("loaded-protyle-static", this.protyleSwitchHandler);
    this.eventBus.off("switch-protyle-mode", this.protyleSwitchHandler);

    void this.flushRealtimeSave();
    this.cleanupReloadRestore();
    this.cleanupSourceMode();
    this.cancelScheduledFrames();
    this.operationGeneration += 1;
    this.statusButton?.remove();
    this.statusButton = null;
    this.statusButtonContext = null;
  }

  private createStatusButton() {
    if (this.statusButton) {
      return;
    }

    const button = document.createElement("button");
    button.className = STATUS_BUTTON_CLASS;
    button.classList.add("is-hidden");
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

      const context = this.statusButtonContext ?? getActiveEditorContext();
      this.pendingCursorHint = context ? this.captureRenderedCursor(context) : null;
    };

    button.addEventListener("pointerdown", (event) => {
      this.statusButtonClickGate.clear();
      preventModeButtonFocus(event);
      captureCursor();
    });
    button.addEventListener("mousedown", preventModeButtonFocus);
    button.addEventListener(
      "touchstart",
      (event) => {
        this.statusButtonClickGate.clear();
        preventModeButtonFocus(event);
        captureCursor();
      },
      { passive: false },
    );
    button.addEventListener(
      "touchend",
      (event) => {
        preventModeButtonFocus(event);
        this.statusButtonClickGate.suppress();
        void this.toggleSourceMode(this.statusButtonContext);
      },
      { passive: false },
    );
    button.addEventListener("click", (event) => {
      preventModeButtonFocus(event);
      void this.toggleSourceModeFromButton();
    });

    this.statusButton = button;
    document.body.appendChild(button);
    this.positionStatusButton();
  }

  private async toggleSourceMode(context: { docId: string; protyle: HTMLElement } | null = null) {
    if (this.isEntering || this.isSaving || this.isRestoringRenderedCursor) {
      return;
    }

    if (this.isSourceMode) {
      await this.handleEscapeExit();
      return;
    }

    await this.enterSourceMode(context);
  }

  private async toggleSourceModeFromButton() {
    if (this.statusButtonClickGate.consume()) {
      return;
    }

    await this.toggleSourceMode(this.statusButtonContext);
  }

  private async exitSourceModeFromButton() {
    if (this.exitButtonClickGate.consume()) {
      return;
    }

    await this.handleEscapeExit();
  }

  private async enterSourceMode(
    requestedContext: { docId: string; protyle: HTMLElement } | null = null,
  ) {
    if (this.isSourceMode || this.isEntering || this.isSaving || this.isRestoringRenderedCursor) {
      return;
    }

    const context = requestedContext ?? getActiveEditorContext();

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
      let markdown: string;
      let removedFrontMatterCount = 0;
      let removedDocTitleHeadingCount = 0;
      let docTitle: string | null = null;

      try {
        const [children, rootKramdown] = await Promise.all([
          getChildBlocks(context.docId, this.t("errorBlockSourceLoadFailed")),
          getBlockKramdown(context.docId, this.t("errorBlockKramdownLoadFailed")),
        ]);

        if (generation !== this.operationGeneration) {
          return;
        }

        const sourceDocument = createSiyuanSourceDocument(children, rootKramdown);

        this.sourceModeKind = "block";
        this.blockSourceDocument = sourceDocument;
        this.blockEditorSupport = createSiyuanSourceEditorSupport(sourceDocument, {
          getBlockLabel: (block) => this.getSiyuanBlockTypeLabel(block),
          onBlockedEdit: (block) => this.handleProtectedBlockEdit(block),
        });
        markdown = sourceDocument.markdown;
      } catch (blockSourceError) {
        if (generation !== this.operationGeneration) {
          return;
        }

        console.warn(this.t("errorBlockSourceLoadFailed"), blockSourceError);
        const exported = await exportMdContent(context.docId, {
          exportFailed: this.t("errorExportFailed"),
        });

        if (generation !== this.operationGeneration) {
          return;
        }

        this.sourceModeKind = "legacy";
        this.blockSourceDocument = null;
        this.blockEditorSupport = null;
        markdown = exported.markdown;
        removedFrontMatterCount = exported.removedFrontMatterCount;
        removedDocTitleHeadingCount = exported.removedDocTitleHeadingCount;
        docTitle = exported.docTitle;
        showMessage(this.t("messageBlockSourceFallback"), 5000, "error");
      }

      this.clearLegacyDraft(context.docId);
      const resolvedCursor = resolveMarkdownCursorPosition(markdown, cursorHint);
      const initialCursor = this.blockSourceDocument
        ? movePositionOutsideProtectedBlock(this.blockSourceDocument, resolvedCursor)
        : resolvedCursor;
      this.activeProtyle = context.protyle;
      this.activeDocId = context.docId;
      const editor = this.createFullscreenEditor(
        markdown,
        initialCursor,
        cursorHint?.viewportY ?? null,
        getRenderedTextWidth(context.protyle),
      );

      this.sourceEditor = editor;
      this.startReadonlySync();
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

    if (this.sourceModeKind === "block") {
      fullscreen.classList.add(BLOCK_SOURCE_CLASS);
    }

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
    const rememberCursor = () => this.rememberSourceCursor(editor);
    const exit = () => {
      void this.exitSourceModeFromButton();
    };

    exitButton.addEventListener("pointerdown", (event) => {
      this.exitButtonClickGate.clear();
      preventModeButtonFocus(event);
      rememberCursor();
    });
    exitButton.addEventListener("mousedown", preventModeButtonFocus);
    exitButton.addEventListener(
      "touchstart",
      (event) => {
        this.exitButtonClickGate.clear();
        preventModeButtonFocus(event);
        rememberCursor();
      },
      { passive: false },
    );
    exitButton.addEventListener(
      "touchend",
      (event) => {
        preventModeButtonFocus(event);
        this.exitButtonClickGate.suppress();
        void this.handleEscapeExit();
      },
      { passive: false },
    );
    exitButton.addEventListener("click", (event) => {
      preventModeButtonFocus(event);
      exit();
    });

    const saveStatus = document.createElement("div");
    saveStatus.className = SAVE_STATUS_CLASS;
    saveStatus.textContent = this.getInitialSaveStatus();

    fullscreen.appendChild(editorHost);
    fullscreen.appendChild(exitButton);
    fullscreen.appendChild(saveStatus);
    document.body.appendChild(fullscreen);
    document.body.classList.add(SOURCE_ACTIVE_BODY_CLASS);

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
    this.positionExitButton(exitButton);

    window.setTimeout(() => {
      if (this.sourceEditor !== editor || !this.isSourceMode) {
        return;
      }

      this.syncSourceEditorWidth();
      this.positionExitButton(exitButton);
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
    const readonly = this.isReadonlyContext();

    return [
      lineNumbers({
        formatNumber: (lineNumber) => (lineNumber % 5 === 0 ? String(lineNumber) : ""),
      }),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      this.readonlyCompartment.of(EditorState.readOnly.of(readonly)),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      markdown(),
      EditorView.lineWrapping,
      syntaxHighlighting(typoraHighlightStyle, { fallback: true }),
      ...(this.blockEditorSupport ? [this.blockEditorSupport.extension] : []),
      this.editableCompartment.of(EditorView.editable.of(!readonly)),
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
            void this.handleEscapeExit();
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
    if (view.state.readOnly) {
      event.preventDefault();
      return true;
    }

    const clipboardText = event.clipboardData?.getData("text/plain");

    if (!clipboardText) {
      return false;
    }

    event.preventDefault();

    const pastedMarkdown = this.sourceModeKind === "block"
      ? clipboardText.replace(/\r\n?/g, "\n")
      : normalizePastedMarkdown(clipboardText);
    const transaction = view.state.replaceSelection(pastedMarkdown);

    view.dispatch({
      ...transaction,
      scrollIntoView: true,
      userEvent: "input.paste",
    });

    return true;
  }

  private handleProtectedBlockEdit(block: SiyuanSourceBlock | null) {
    const now = Date.now();

    if (now - this.lastProtectedEditNoticeAt < 120) {
      return;
    }

    this.lastProtectedEditNoticeAt = now;
    this.clearProtectedStatusTimer();
    this.updateRealtimeSaveStatus(
      this.t("statusProtectedBlock", {
        type: block ? this.getSiyuanBlockTypeLabel(block) : this.t("blockTypeUnknown"),
      }),
      true,
    );
    this.protectedStatusTimerId = window.setTimeout(() => {
      this.protectedStatusTimerId = null;

      if (!this.isSourceMode || this.sourceModeKind !== "block") {
        return;
      }

      this.updateRealtimeSaveStatus(
        this.hasSourceChanges() ? this.t("statusBlockModified") : this.getInitialSaveStatus(),
      );
    }, 1800);
  }

  private clearProtectedStatusTimer() {
    if (this.protectedStatusTimerId !== null) {
      window.clearTimeout(this.protectedStatusTimerId);
      this.protectedStatusTimerId = null;
    }
  }

  private isReadonlyContext(): boolean {
    const siyuan = (window as any).siyuan;
    if (
      siyuan?.config?.readonly ||
      siyuan?.config?.editor?.readOnly ||
      siyuan?.isPublish
    ) {
      return true;
    }

    return this.isActiveProtyleDisabled();
  }

  private isActiveProtyleDisabled(): boolean {
    const context = getActiveEditorContext();

    if (context?.disabled === true) {
      return true;
    }

    const protyle = this.activeProtyle ?? context?.protyle ?? null;

    if (!protyle) {
      return false;
    }

    return protyle.querySelector('[contenteditable="true"]') === null;
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

    try {
      this.isSaving = true;
      this.updateButtonsBusy(true);
      const generation = this.beginOperation();
      const readonly = this.isReadonlyContext();

      if (save && !readonly) {
        saved = await this.flushRealtimeSave();

        if (generation !== this.operationGeneration) {
          return;
        }

        if (this.hasSourceChanges()) {
          return;
        }
      } else if (readonly) {
        this.updateRealtimeSaveStatus(
          this.sourceModeKind === "block"
            ? this.t("statusBlockReadonly")
            : this.t("statusRealtimeReadonly"),
          true,
        );
      }

      const shouldReloadEditor = saved || this.hasRealtimeSaved;

      if (shouldReloadEditor) {
        this.tryRestoreRenderedCursor(docId, renderCursorHint);
        this.cleanupSourceMode();
        this.lockRenderedCursorRestore(generation);
        this.reloadEditor(docId, renderCursorHint, generation);
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
    this.clearProtectedStatusTimer();
    this.stopReadonlySync();
    this.sourceEditor?.destroy();
    this.sourceEditor = null;
    this.saveStatusElement = null;
    this.fullscreenElement?.remove();
    this.fullscreenElement = null;
    document.body.classList.remove(SOURCE_ACTIVE_BODY_CLASS);

    this.isSourceMode = false;
    this.isEntering = false;
    this.isSaving = false;
    this.isRestoringRenderedCursor = false;
    this.activeDocId = null;
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
    this.sourceModeKind = "legacy";
    this.blockSourceDocument = null;
    this.blockEditorSupport = null;
    this.lastProtectedEditNoticeAt = 0;
    this.isDiscardPromptOpen = false;
    this.sourceReadonly = false;

    this.updateButtonState(false);
    this.updateButtonsBusy(false);
    this.positionStatusButton();
  }

  private cancelScheduledFrames() {
    if (this.statusButtonFrameId !== null) {
      window.cancelAnimationFrame(this.statusButtonFrameId);
      this.statusButtonFrameId = null;
    }

    if (this.sourceWidthFrameId !== null) {
      window.cancelAnimationFrame(this.sourceWidthFrameId);
      this.sourceWidthFrameId = null;
    }
  }

  private startReadonlySync() {
    this.stopReadonlySync();
    this.syncSourceReadonlyState();
    this.readonlySyncTimerId = window.setInterval(this.syncSourceReadonlyState, 500);
  }

  private stopReadonlySync() {
    if (this.readonlySyncTimerId !== null) {
      window.clearInterval(this.readonlySyncTimerId);
      this.readonlySyncTimerId = null;
    }
  }

  private syncSourceReadonlyState = () => {
    const editor = this.sourceEditor;

    if (!editor) {
      return;
    }

    const readonly = this.isReadonlyContext();

    if (readonly === this.sourceReadonly) {
      return;
    }

    this.sourceReadonly = readonly;
    editor.dispatch({
      effects: [
        this.readonlyCompartment.reconfigure(EditorState.readOnly.of(readonly)),
        this.editableCompartment.reconfigure(EditorView.editable.of(!readonly)),
      ],
    });
    const status = this.sourceModeKind === "block"
      ? readonly
        ? this.t("statusBlockReadonly")
        : this.getInitialSaveStatus()
      : readonly
        ? this.t("statusRealtimeReadonly")
        : this.t("statusRealtimeEnabled");
    this.updateRealtimeSaveStatus(
      status,
      readonly,
    );
  };

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

    if (active) {
      this.statusButton.classList.add("is-hidden");
    }

    if (!active) {
      this.positionStatusButton();
    }
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

      if (this.isSourceMode) {
        return;
      }

      const context = getActiveEditorContext();
      const position = context ? getPanelModeButtonPosition(context.protyle, button) : null;

      this.statusButtonContext = context;

      if (!position) {
        button.classList.add("is-hidden");
        return;
      }

      button.classList.remove("is-hidden");
      button.disabled = this.isEntering || this.isSaving || this.isRestoringRenderedCursor;
      setFixedButtonPosition(button, position);
    });
  };

  private windowResizeHandler = () => {
    if (this.isSourceMode) {
      this.scheduleSourceEditorWidthSync();
      this.scheduleExitButtonReposition();
      return;
    }

    this.positionStatusButton();
  };

  private scheduleExitButtonReposition = () => {
    const fullscreen = this.fullscreenElement;
    if (!fullscreen) {
      return;
    }

    const exitButton = fullscreen.querySelector<HTMLElement>(`.${EXIT_BUTTON_CLASS}`);
    if (!exitButton) {
      return;
    }

    window.requestAnimationFrame(() => {
      if (!this.isSourceMode || this.fullscreenElement !== fullscreen) {
        return;
      }

      this.positionExitButton(exitButton);
    });
  };

  private positionExitButton(exitButton: HTMLElement) {
    const position = getViewportModeButtonPosition(exitButton);

    setFixedButtonPosition(exitButton, position);
  }

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
    if (this.sourceModeKind === "block") {
      try {
        return this.getCurrentBlockEdits().length > 0;
      } catch {
        return this.sourceDirty;
      }
    }

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

    if (this.sourceModeKind === "block") {
      this.updateRealtimeSaveStatus(this.t("statusBlockModified"));
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
    if (this.sourceModeKind === "block") {
      return this.performBlockSourceSave();
    }

    return this.performLegacyRealtimeSave();
  }

  private async performLegacyRealtimeSave(): Promise<boolean> {
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

      if (!(await this.confirmWriteRisk())) {
        this.realtimeSaveRequested = false;
        this.updateRealtimeSaveStatus(this.t("statusSaveCancelled"), true);
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

  private getCurrentBlockEdits(editor: EditorView | null = this.sourceEditor): SiyuanBlockEdit[] {
    const sourceDocument = this.blockSourceDocument;
    const support = this.blockEditorSupport;

    if (!editor || !sourceDocument || !support) {
      return [];
    }

    return collectSiyuanBlockEdits(
      sourceDocument,
      support.getMappedBlocks(editor.state),
      editor.state.doc.toString(),
    );
  }

  private async createSiyuanBlockUpdatePlans(
    edits: readonly SiyuanBlockEdit[],
    sourceById: ReadonlyMap<string, SiyuanSourceBlock>,
    latestChildren: readonly SiyuanChildBlockData[],
  ): Promise<{
    updates: SiyuanContainerSourceUpdate[];
    containerPlans: SiyuanContainerEditPlan[];
  }> {
    const latestById = new Map(latestChildren.map((child) => [child.id, child]));
    const updates: SiyuanContainerSourceUpdate[] = [];
    const containerPlans: SiyuanContainerEditPlan[] = [];

    for (const edit of edits) {
      const sourceBlock = sourceById.get(edit.id);

      if (!sourceBlock) {
        throw new Error(this.t("errorBlockStructureChanged"));
      }

      if (
        (sourceBlock.type === "l" || sourceBlock.type === "b") &&
        edit.type === sourceBlock.type
      ) {
        const latest = latestById.get(edit.id);

        if (!latest) {
          throw new Error(this.t("errorBlockStructureChanged"));
        }

        const tree = await getSiyuanBlockTree(
          latest,
          this.t("errorBlockSourceLoadFailed"),
        );
        const plan = createSiyuanContainerEditPlan(sourceBlock, edit.markdown, tree);
        containerPlans.push(plan);
        updates.push(...plan.updates);
        continue;
      }

      updates.push({
        ownerId: edit.id,
        id: edit.id,
        type: edit.type,
        subType: edit.subType,
        kind: "source",
        markdown: edit.markdown,
        originalMarkdown: sourceBlock.serverMarkdown,
        control: null,
      });
    }

    const updateIds = new Set<string>();

    for (const update of updates) {
      if (updateIds.has(update.id)) {
        throw new Error(this.t("errorBlockStructureChanged"));
      }

      updateIds.add(update.id);
    }

    return { updates, containerPlans };
  }

  private async performBlockSourceSave(): Promise<boolean> {
    const docId = this.activeDocId;
    const editor = this.sourceEditor;
    const sourceDocument = this.blockSourceDocument;

    if (!docId || !editor || !sourceDocument || !this.blockEditorSupport) {
      return false;
    }

    const startMarkdown = editor.state.doc.toString();
    let edits: SiyuanBlockEdit[];

    try {
      edits = this.getCurrentBlockEdits(editor);
    } catch (error) {
      this.reportBlockSaveError(error);
      return false;
    }

    if (edits.length === 0) {
      this.sourceDirty = false;
      this.updateRealtimeSaveStatus(this.getInitialSaveStatus());
      return false;
    }

    const sourceById = new Map(sourceDocument.blocks.map((block) => [block.id, block]));

    for (const edit of edits) {
      const sourceBlock = sourceById.get(edit.id);

      if (!sourceBlock) {
        this.reportBlockSaveError(new Error(this.t("errorBlockStructureChanged")));
        return false;
      }

      const validation = validateSiyuanBlockEdit(sourceBlock, edit.markdown);

      if (!validation.valid) {
        this.reportBlockSaveError(
          this.createBlockValidationError(sourceBlock, validation.issue),
        );
        return false;
      }

      if (validation.nextType) {
        edit.type = validation.nextType;
        edit.subType = null;
      }
    }

    if (this.isReadonlyContext()) {
      this.updateRealtimeSaveStatus(this.t("statusBlockReadonly"), true);
      return false;
    }

    const savedIds = new Set<string>();

    try {
      this.updateRealtimeSaveStatus(
        this.t("statusBlockSaving", { count: edits.length }),
      );

      const [latestChildren, latestKramdown] = await Promise.all([
        getChildBlocks(docId, this.t("errorBlockSourceLoadFailed")),
        getBlockKramdown(docId, this.t("errorBlockKramdownLoadFailed")),
      ]);

      if (
        !matchesSiyuanKramdownSnapshot(sourceDocument.rootKramdown, latestKramdown) ||
        !matchesSiyuanSourceSnapshot(sourceDocument, latestChildren)
      ) {
        throw new Error(this.t("errorBlockConflict"));
      }
      const { updates, containerPlans } = await this.createSiyuanBlockUpdatePlans(
        edits,
        sourceById,
        latestChildren,
      );
      const originalContainerKramdownEntries = await Promise.all(
        containerPlans.map(async (plan) => [
          plan.ownerId,
          await getBlockKramdown(plan.ownerId, this.t("errorBlockKramdownLoadFailed")),
        ] as const),
      );
      const originalContainerKramdownById = new Map(originalContainerKramdownEntries);


      const originalBlockKramdownEntries = await Promise.all(
        updates.map(async (update) => [
          update.id,
          await getBlockKramdown(update.id, this.t("errorBlockKramdownLoadFailed")),
        ] as const),
      );
      const originalBlockKramdownById = new Map(originalBlockKramdownEntries);

      if (
        originalBlockKramdownEntries.some(
          ([id, kramdown]) => !matchesSiyuanBlockIal(id, kramdown, kramdown),
        ) ||
        originalContainerKramdownEntries.some(
          ([id, kramdown]) => !matchesSiyuanBlockIal(id, kramdown, kramdown),
        )
      ) {
        throw new Error(this.t("errorBlockIalMissing"));
      }

      if (!matchesSiyuanKramdownSnapshot(
        latestKramdown,
        await getBlockKramdown(docId, this.t("errorBlockKramdownLoadFailed")),
      )) {
        throw new Error(this.t("errorBlockConflict"));
      }

      const backupResponse = await this.saveData(BLOCK_SOURCE_BACKUP_STORAGE_NAME, {
        version: 1,
        docId,
        createdAt: new Date().toISOString(),
        rootKramdown: sourceDocument.rootKramdown,
        blocks: sourceDocument.blocks.map((block) => ({
          id: block.id,
          type: block.type,
          subType: block.subType,
          markdown: block.markdown,
          serverMarkdown: block.serverMarkdown,
        })),
        editedBlocks: updates.map((update) => ({
          id: update.id,
          ownerId: update.ownerId,
          kramdown: originalBlockKramdownById.get(update.id),
        })),
        editedContainers: containerPlans.map((plan) => ({
          id: plan.ownerId,
          kramdown: originalContainerKramdownById.get(plan.ownerId),
        })),
      });

      if (backupResponse.code !== 0) {
        throw new Error(backupResponse.msg || this.t("errorBlockBackupFailed"));
      }

      for (const update of updates) {
        const originalBlockKramdown = originalBlockKramdownById.get(update.id);

        if (!originalBlockKramdown) {
          throw new Error(this.t("errorBlockIalMissing"));
        }

        if (update.kind === "source") {
          if (update.markdown === null || update.originalMarkdown === null) {
            throw new Error(this.t("errorBlockStructureChanged"));
          }

          await updateBlockBySource(
            update.id,
            update.type,
            update.markdown,
            update.originalMarkdown,
            originalBlockKramdown,
            this.t("errorSaveFailed"),
          );
        } else {
          if (!update.control) {
            throw new Error(this.t("errorBlockStructureChanged"));
          }

          await updateBlockByPreparedSource(
            update.id,
            prepareSiyuanListItemSourceForUpdate(
              update.id,
              originalBlockKramdown,
              update.control,
            ),
            this.t("errorSaveFailed"),
          );
        }

        savedIds.add(update.ownerId);
        this.hasRealtimeSaved = true;
      }

      const [refreshedChildren, refreshedKramdown, refreshedBlockKramdowns] = await Promise.all([
        getChildBlocks(docId, this.t("errorBlockSourceLoadFailed")),
        getBlockKramdown(docId, this.t("errorBlockKramdownLoadFailed")),
        Promise.all(
          updates.map((update) =>
            getBlockKramdown(update.id, this.t("errorBlockKramdownLoadFailed")),
          ),
        ),
      ]);
      const refreshedById = new Map(refreshedChildren.map((child) => [child.id, child]));
      const refreshedContainers = await Promise.all(
        containerPlans.map(async (plan) => {
          const child = refreshedById.get(plan.ownerId);

          if (!child) {
            throw new Error(this.t("errorBlockStructureChanged"));
          }

          const [tree, kramdown] = await Promise.all([
            getSiyuanBlockTree(child, this.t("errorBlockSourceLoadFailed")),
            getBlockKramdown(plan.ownerId, this.t("errorBlockKramdownLoadFailed")),
          ]);
          return { ownerId: plan.ownerId, tree, kramdown };
        }),
      );
      const refreshedContainerById = new Map(
        refreshedContainers.map((entry) => [entry.ownerId, entry]),
      );


      if (!hasSameSiyuanBlockOrder(sourceDocument, refreshedChildren, edits)) {
        throw new Error(this.t("errorBlockStructureChanged"));
      }

      if (!matchesExpectedSiyuanBlockSnapshot(sourceDocument, refreshedChildren, edits)) {
        throw new Error(this.t("errorBlockVerificationFailed"));
      }

      if (
        updates.some((update, index) => {
          const before = originalBlockKramdownById.get(update.id);
          const after = refreshedBlockKramdowns[index];

          return !before || !after || !matchesSiyuanBlockIal(update.id, before, after);
        })
      ) {
        throw new Error(this.t("errorBlockVerificationFailed"));
      }
      for (const plan of containerPlans) {
        const beforeKramdown = originalContainerKramdownById.get(plan.ownerId);
        const refreshed = refreshedContainerById.get(plan.ownerId);

        if (
          !beforeKramdown ||
          !refreshed ||
          !haveSameSiyuanBlockTree(plan.beforeTree, refreshed.tree) ||
          !matchesSiyuanKramdownIals(beforeKramdown, refreshed.kramdown)
        ) {
          throw new Error(this.t("errorBlockVerificationFailed"));
        }
      }


      for (const edit of edits) {
        const block = sourceById.get(edit.id);

        if (block) {
          block.markdown = edit.markdown;
        }
      }
      for (const block of sourceDocument.blocks) {
        const refreshed = refreshedById.get(block.id);

        if (!refreshed) {
          throw new Error(this.t("errorBlockStructureChanged"));
        }

        block.type = refreshed.type;
        block.subType = refreshed.subType ?? null;
        block.serverMarkdown = getSiyuanChildBlockSource(refreshed);
      }


      sourceDocument.rootKramdown = refreshedKramdown;
      this.originalMarkdown = startMarkdown;
      this.lastSavedMarkdown = startMarkdown;
      this.removedFrontMatterCount = 0;
      this.removedDocTitleHeadingCount = 0;
      this.sourceDirty =
        editor.state.doc.toString() !== startMarkdown ||
        this.getCurrentBlockEdits(editor).length > 0;
      this.updateRealtimeSaveStatus(
        this.t("statusBlockSuccess", {
          count: edits.length,
          time: formatStatusTime(new Date()),
        }),
      );
      return true;
    } catch (error) {
      if (savedIds.size > 0) {
        await this.refreshBlockSourceAfterPartialSave(docId, sourceDocument, savedIds);
      }

      this.sourceDirty = true;
      this.reportBlockSaveError(error);
      return false;
    }
  }

  private createBlockValidationError(
    block: SiyuanSourceBlock,
    issue: SiyuanBlockValidationIssue | undefined,
  ): Error {
    const error = new Error(
      this.t("errorBlockValidationFailed", {
        type: this.getSiyuanBlockTypeLabel(block),
      }),
    );
    error.name = issue ?? "invalid-block";
    return error;
  }

  private async refreshBlockSourceAfterPartialSave(
    docId: string,
    sourceDocument: SiyuanSourceDocument,
    savedIds: ReadonlySet<string>,
  ) {
    try {
      const [children, rootKramdown] = await Promise.all([
        getChildBlocks(docId, this.t("errorBlockSourceLoadFailed")),
        getBlockKramdown(docId, this.t("errorBlockKramdownLoadFailed")),
      ]);

      if (!hasSameSiyuanBlockIdentityOrder(sourceDocument, children)) {
        return;
      }

      const childById = new Map(children.map((child) => [child.id, child]));

      for (const block of sourceDocument.blocks) {
        const child = childById.get(block.id);

        if (savedIds.has(block.id) && child) {
          const serverMarkdown = getSiyuanChildBlockSource(child);
          block.type = child.type;
          block.subType = child.subType ?? null;
          block.markdown = serverMarkdown;
          block.serverMarkdown = serverMarkdown;
        }
      }

      sourceDocument.rootKramdown = rootKramdown;
    } catch (refreshError) {
      console.warn(this.t("errorBlockVerificationFailed"), refreshError);
    }
  }

  private reportBlockSaveError(error: unknown) {
    const message = getErrorMessage(error);
    const now = Date.now();

    console.error(error);
    this.updateRealtimeSaveStatus(message, true);

    if (now - this.lastRealtimeSaveErrorAt > 5000) {
      this.lastRealtimeSaveErrorAt = now;
      showMessage(
        this.t("messageSaveFailed", { message }),
        5000,
        "error",
      );
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
    if (this.sourceModeKind === "block") {
      return editor.state.doc.toString();
    }

    if (!this.sourceDirty && !this.realtimeSaveRequested && !this.needsCleanupSave()) {
      return this.lastSavedMarkdown || this.originalMarkdown;
    }

    return normalizeMarkdownForSave(editor.state.doc.toString());
  }

  private hasPendingSourceSave(): boolean {
    return this.realtimeSaveRequested || this.sourceDirty || this.needsCleanupSave();
  }

  private needsCleanupSave(): boolean {
    if (this.sourceModeKind === "block") {
      return false;
    }

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
        const currentContext = getEditorContextByDocId(docId);
        currentContext?.editor?.reload(false);
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
      this.reloadRestoreCleanup = null;

      this.unlockRenderedCursorRestore(generation);
      onFinished?.(success);
    };

    this.cleanupReloadRestore();
    this.reloadRestoreCleanup = () => {
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
      this.reloadRestoreCleanup = null;
      this.unlockRenderedCursorRestore(generation);
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

  private cleanupReloadRestore() {
    const cleanup = this.reloadRestoreCleanup;

    if (!cleanup) {
      return;
    }

    cleanup();
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
      await this.handleEscapeExit();
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
      this.pendingCursorHint = null;
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
    if (this.isDiscardPromptOpen) {
      return;
    }

    await this.exitSourceMode(true);

    if (
      !this.isSourceMode ||
      this.isSaving ||
      this.isDiscardPromptOpen ||
      !this.hasSourceChanges()
    ) {
      return;
    }

    this.isDiscardPromptOpen = true;

    const discard = await new Promise<boolean>((resolve) => {
      confirm(
        this.t("dialogDiscardTitle"),
        this.t("dialogDiscardContent"),
        () => resolve(true),
        () => resolve(false),
      );
    });

    this.isDiscardPromptOpen = false;

    if (discard && this.isSourceMode && !this.isSaving) {
      await this.exitSourceMode(false);
    }
  }

  private beforeUnloadHandler = () => {
    void this.flushRealtimeSave();
  };

  private protyleSwitchHandler = () => {
    if (this.isSourceMode) {
      return;
    }

    this.cleanupReloadRestore();
    this.operationGeneration += 1;
    this.isRestoringRenderedCursor = false;
    this.updateButtonsBusy(false);
    this.positionStatusButton();
  };
}

function hasSameSiyuanBlockIdentityOrder(
  sourceDocument: SiyuanSourceDocument,
  children: readonly SiyuanChildBlockData[],
): boolean {
  return (
    sourceDocument.blocks.length === children.length &&
    sourceDocument.blocks.every((block, index) => children[index]?.id === block.id)
  );
}

function hasSameSiyuanBlockOrder(
  sourceDocument: SiyuanSourceDocument,
  children: readonly SiyuanChildBlockData[],
  edits: readonly SiyuanBlockEdit[] = [],
): boolean {
  if (!hasSameSiyuanBlockIdentityOrder(sourceDocument, children)) {
    return false;
  }

  const expectedTypeById = new Map(edits.map((edit) => [edit.id, edit.type]));
  return sourceDocument.blocks.every((block, index) =>
    children[index]?.type === (expectedTypeById.get(block.id) ?? block.type)
  );
}

function matchesExpectedSiyuanBlockSnapshot(
  sourceDocument: SiyuanSourceDocument,
  children: readonly SiyuanChildBlockData[],
  edits: readonly SiyuanBlockEdit[],
): boolean {
  if (!hasSameSiyuanBlockOrder(sourceDocument, children, edits)) {
    return false;
  }

  const editById = new Map(edits.map((edit) => [edit.id, edit]));

  return sourceDocument.blocks.every((block, index) => {
    const child = children[index];

    if (!child) {
      return false;
    }

    const edit = editById.get(block.id);
    return areSiyuanMarkdownBlocksEquivalent(
      edit?.type ?? block.type,
      edit?.markdown ?? block.serverMarkdown,
      getSiyuanChildBlockSource(child),
    );
  });
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

interface ClickSuppressionGate {
  suppress(): void;
  clear(): void;
  consume(): boolean;
}

function createClickSuppressionGate(): ClickSuppressionGate {
  let suppressUntil = 0;
  return {
    suppress() {
      suppressUntil = Date.now() + 700;
    },
    clear() {
      suppressUntil = 0;
    },
    consume() {
      const now = Date.now();
      if (now <= suppressUntil) {
        suppressUntil = 0;
        return true;
      }
      return false;
    },
  };
}

interface FixedButtonPosition {
  left: number;
  bottom: number;
  minLeft?: number;
  maxLeft?: number;
  minBottom?: number;
  maxBottom?: number;
}

const MODE_BUTTON_PANEL_INSET = 8;
const MODE_BUTTON_MIN_PANEL_WIDTH = 120;
const MODE_BUTTON_BOTTOM_GAP = 4;
const MODE_BUTTON_ESTIMATED_WIDTH = 88;
const MODE_BUTTON_ESTIMATED_HEIGHT = 24;
const MODE_BUTTON_RESERVED_STATUS_WIDTH = 150;

function getPanelModeButtonPosition(
  protyle: HTMLElement,
  button: HTMLElement,
): FixedButtonPosition | null {
  const rect = protyle.getBoundingClientRect();

  if (
    rect.width < MODE_BUTTON_MIN_PANEL_WIDTH ||
    rect.height <= 0 ||
    rect.right <= 0 ||
    rect.bottom <= 0 ||
    rect.left >= window.innerWidth ||
    rect.top >= window.innerHeight
  ) {
    return null;
  }

  const width = getElementRenderedWidth(button);
  const height = getElementRenderedHeight(button);
  const minLeft = Math.max(8, rect.left + MODE_BUTTON_PANEL_INSET);
  const maxLeft = Math.max(minLeft, rect.right - width - MODE_BUTTON_PANEL_INSET);
  const minBottom = Math.max(4, window.innerHeight - rect.bottom + MODE_BUTTON_BOTTOM_GAP);
  const maxBottom = Math.max(minBottom, window.innerHeight - rect.top - height - MODE_BUTTON_BOTTOM_GAP);
  const characterCounter = getCharacterCounterRect(protyle);
  const counterWidth =
    characterCounter && characterCounter.bottom > rect.bottom - 48
      ? rect.right - characterCounter.left + MODE_BUTTON_PANEL_INSET
      : MODE_BUTTON_RESERVED_STATUS_WIDTH;
  const left = Math.min(rect.left + MODE_BUTTON_PANEL_INSET, maxLeft);
  const bottom = minBottom;

  if (left + width + counterWidth > rect.right) {
    return null;
  }

  return {
    left,
    bottom,
    minLeft,
    maxLeft,
    minBottom,
    maxBottom,
  };
}

function setFixedButtonPosition(button: HTMLElement, position: FixedButtonPosition) {
  const width = getElementRenderedWidth(button);
  const height = getElementRenderedHeight(button);
  const minLeft = position.minLeft ?? 8;
  const maxLeft = position.maxLeft ?? Math.max(minLeft, window.innerWidth - width - 8);
  const minBottom = position.minBottom ?? 4;
  const maxBottom = position.maxBottom ?? Math.max(minBottom, window.innerHeight - height - 4);
  const left = Math.max(minLeft, Math.min(Math.round(position.left), maxLeft));
  const bottom = Math.max(minBottom, Math.min(Math.round(position.bottom), maxBottom));

  button.style.left = `${left}px`;
  button.style.bottom = `${bottom}px`;
}

function getViewportModeButtonPosition(button: HTMLElement): FixedButtonPosition {
  const width = getElementRenderedWidth(button);
  const height = getElementRenderedHeight(button);

  return {
    left: 12,
    bottom: 4,
    minLeft: 8,
    maxLeft: Math.max(8, window.innerWidth - width - 8),
    minBottom: 4,
    maxBottom: Math.max(4, window.innerHeight - height - 4),
  };
}

function getElementRenderedWidth(element: HTMLElement): number {
  return element.offsetWidth || element.getBoundingClientRect().width || MODE_BUTTON_ESTIMATED_WIDTH;
}

function getElementRenderedHeight(element: HTMLElement): number {
  return element.offsetHeight || element.getBoundingClientRect().height || MODE_BUTTON_ESTIMATED_HEIGHT;
}

function getCharacterCounterRect(protyle: HTMLElement): DOMRect | null {
  const selectors = [
    ".protyle-breadcrumb__bar",
    ".protyle-breadcrumb",
    ".protyle-status",
    ".protyle-counter",
  ];

  for (const selector of selectors) {
    const element = protyle.querySelector<HTMLElement>(selector);
    const rect = getVisibleElementRect(element);

    if (rect) {
      return rect;
    }
  }

  return null;
}

function getVisibleElementRect(element: HTMLElement | null): DOMRect | null {
  if (!element) {
    return null;
  }

  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? rect : null;
}

function setSourceEditorTextWidth(editorHost: HTMLElement, width: number | null) {
  if (width && Number.isFinite(width) && width > 0) {
    editorHost.style.setProperty(RENDERED_TEXT_WIDTH_PROPERTY, `${Math.round(width)}px`);
    return;
  }

  editorHost.style.removeProperty(RENDERED_TEXT_WIDTH_PROPERTY);
}

function normalizeRenderedTextWidth(width: number | null): number | null {
  if (!width || !Number.isFinite(width) || width <= 0) {
    return SOURCE_EDITOR_DEFAULT_TEXT_WIDTH;
  }

  return Math.max(SOURCE_EDITOR_DEFAULT_TEXT_WIDTH, Math.round(width));
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
