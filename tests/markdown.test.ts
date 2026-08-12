import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeMarkdownForSave,
  normalizeSiyuanExportMarkdown,
  preserveBlankParagraphsForSiyuanSave,
} from "../src/markdown";

test("preserves meaningful Unicode format characters while normalizing line endings", () => {
  const markdown = "\uFEFFfamily 👨‍👩‍👧‍👦\r\nPersian: می‌روم\rZero width: a\u200Bb\rNBSP: a\u00A0b";

  assert.equal(
    normalizeMarkdownForSave(markdown),
    "family 👨‍👩‍👧‍👦\nPersian: می‌روم\nZero width: a\u200Bb\nNBSP: a\u00A0b",
  );
});

test("adds SiYuan empty-paragraph markers only when preparing the kernel payload", () => {
  assert.equal(preserveBlankParagraphsForSiyuanSave("alpha\n\nbeta"), "alpha\n\nbeta");
  assert.equal(preserveBlankParagraphsForSiyuanSave("alpha\n\n\nbeta"), "alpha\n\n‍\n\nbeta");
  assert.equal(preserveBlankParagraphsForSiyuanSave("\n"), "‍");
});

test("removes only standalone SiYuan export markers when explicitly requested", () => {
  const markdown = "alpha\n\u200D\nfamily 👨‍👩‍👧‍👦\nPersian: می‌روم";

  assert.equal(normalizeSiyuanExportMarkdown(markdown).markdown, markdown);
  assert.equal(normalizeSiyuanExportMarkdown(markdown, {
    removeEmptyParagraphMarkers: true,
  }).markdown, "alpha\n\nfamily 👨‍👩‍👧‍👦\nPersian: می‌روم");
});
