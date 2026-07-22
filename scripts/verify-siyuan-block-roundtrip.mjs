const API_BASE = process.env.SIYUAN_API_BASE ?? "http://127.0.0.1:6806";
const TEMP_NOTEBOOK_PREFIX = "codex-block-roundtrip-";
const FORBIDDEN_NOTEBOOK_ID = "20210808180117-czj9bvb";

if (!process.argv.includes("--confirm")) {
  throw new Error("Refusing to create temporary SiYuan data without --confirm");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function extractId(value) {
  if (typeof value === "string") {
    return value;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  for (const candidate of [value.id, value.notebook, value.document, value.rootID]) {
    const id = typeof candidate === "string" ? candidate : candidate?.id;
    if (typeof id === "string" && id.length > 0) {
      return id;
    }
  }

  return null;
}

function getBlockIal(blockId, blockKramdown) {
  const lines = blockKramdown.replace(/\r\n?/g, "\n").split("\n");

  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }

  const ial = lines[lines.length - 1] ?? "";
  const idMatch = ial.match(/\bid=(["'])([^"']+)\1/);
  assert(/^\{:[\s\S]*\}$/.test(ial), "Block Kramdown has no trailing IAL for " + blockId);
  assert(
    idMatch?.[2] === blockId,
    "Block Kramdown IAL does not contain the expected ID " + blockId,
  );

  return ial;
}

function parseBlockIal(ial) {
  const body = ial.slice(2, -1);
  const attributes = new Map();
  const pattern = /\s*([^\s=]+)=("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gy;
  let index = 0;

  while (index < body.length) {
    if (body.slice(index).trim() === "") {
      break;
    }

    pattern.lastIndex = index;
    const match = pattern.exec(body);
    assert(match?.[1] && match?.[2], "Invalid block IAL: " + ial);
    assert(!attributes.has(match[1]), "Duplicate block IAL attribute: " + match[1]);
    attributes.set(match[1], match[2]);
    index = pattern.lastIndex;
  }

  return attributes;
}

function haveSameBlockIal(blockId, beforeKramdown, afterKramdown) {
  const before = parseBlockIal(getBlockIal(blockId, beforeKramdown));
  const after = parseBlockIal(getBlockIal(blockId, afterKramdown));
  return before.size === after.size && Array.from(before).every(([key, value]) => after.get(key) === value);
}

function preserveBlockIal(blockId, markdown, blockKramdown) {
  const ial = getBlockIal(blockId, blockKramdown);

  return markdown + (markdown.endsWith("\n") ? "" : "\n") + ial;
}

async function post(path, body) {
  const response = await fetch(API_BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload;

  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(path + " returned invalid JSON: " + text.slice(0, 200));
  }

  if (!response.ok || payload?.code !== 0) {
    throw new Error(path + " failed: " + (payload?.msg || response.statusText));
  }

  return payload.data;
}

async function listNotebooks() {
  const data = await post("/api/notebook/lsNotebooks", {});
  const notebooks = Array.isArray(data) ? data : data?.notebooks;
  assert(Array.isArray(notebooks), "lsNotebooks returned an unexpected payload");
  return notebooks;
}

async function getChildBlocks(id) {
  const data = await post("/api/block/getChildBlocks", { id });
  assert(Array.isArray(data), "getChildBlocks returned an unexpected payload");
  return data;
}

async function getBlockKramdown(id) {
  const data = await post("/api/block/getBlockKramdown", { id });
  assert(typeof data?.kramdown === "string", "getBlockKramdown returned no Kramdown for " + id);
  return data.kramdown;
}

async function getBlockAttrs(id) {
  const data = await post("/api/attr/getBlockAttrs", { id });
  assert(data && typeof data === "object", "getBlockAttrs returned an unexpected payload");
  return data;
}

async function waitForChildren(docId) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const children = await getChildBlocks(docId);
    if (children.length > 0) {
      return children;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for temporary document blocks");
}

const notebookName = TEMP_NOTEBOOK_PREFIX + new Date().toISOString().replace(/[^0-9]/g, "");
const nbsp = "\u00A0";
const zwj = "\u200D";
const bom = "\uFEFF";
const codeBefore = [
  "~~~javascript",
  "const nbsp = \"" + nbsp + "\";",
  "const zwj = \"" + zwj + "\";",
  "const bom = \"" + bom + "\";",
  "~~~",
].join("\n");
const fixtureMarkdown = [
  "# Roundtrip heading",
  "paragraph to update",
  "paragraph to clear",
  codeBefore,
  "$$\nx^2\n$$",
  "- protected list item",
].join("\n\n");

let notebookId = null;
let notebookVerified = false;
let failure = null;
let cleanupFailure = null;
const report = {
  apiBase: API_BASE,
  notebookName,
  notebookId: null,
  documentId: null,
  originalOrder: [],
  refreshedOrder: [],
  emptyParagraph: null,
  updatedTypes: {},
  cleanup: "not-started",
};

try {
  const createdNotebook = await post("/api/notebook/createNotebook", { name: notebookName });
  notebookId = extractId(createdNotebook);

  if (!notebookId) {
    const createdMatch = (await listNotebooks()).find((notebook) => notebook?.name === notebookName);
    notebookId = extractId(createdMatch);
  }

  assert(typeof notebookId === "string" && notebookId.length > 0, "createNotebook returned no ID");
  assert(notebookId !== FORBIDDEN_NOTEBOOK_ID, "Temporary notebook resolved to the protected sample ID");
  report.notebookId = notebookId;

  const notebooks = await listNotebooks();
  notebookVerified = notebooks.some(
    (notebook) => notebook?.id === notebookId && notebook?.name === notebookName,
  );
  assert(notebookVerified, "Could not verify the temporary notebook before writing");

  const createdDocument = await post("/api/filetree/createDocWithMd", {
    notebook: notebookId,
    path: "/roundtrip-fixture",
    markdown: fixtureMarkdown,
  });
  const docId = extractId(createdDocument);
  assert(typeof docId === "string" && docId.length > 0, "createDocWithMd returned no document ID");
  report.documentId = docId;

  const children = await waitForChildren(docId);
  const paragraphs = children.filter((block) => block?.type === "p");
  const heading = children.find((block) => block?.type === "h");
  const code = children.find((block) => block?.type === "c");
  const list = children.find((block) => block?.type === "l");

  assert(paragraphs.length >= 2, "Fixture did not create two paragraph blocks");
  assert(heading, "Fixture did not create a heading block");
  assert(code, "Fixture did not create a code block");
  assert(list, "Fixture did not create a protected list block");

  const paragraph = paragraphs[0];
  const emptyParagraph = paragraphs[1];
  const updatedIds = new Set([paragraph.id, emptyParagraph.id, heading.id, code.id]);
  const originalOrder = children.map((block) => block.id);
  report.originalOrder = originalOrder;

  await post("/api/attr/setBlockAttrs", {
    id: paragraph.id,
    attrs: { "custom-codex-roundtrip": "paragraph-attr", style: "color: rgb(123, 45, 67);" },
  });
  await post("/api/attr/setBlockAttrs", {
    id: code.id,
    attrs: { "custom-codex-roundtrip": "code-attr", fold: "1" },
  });

  const originalBlockKramdown = new Map();
  for (const block of children) {
    originalBlockKramdown.set(block.id, await getBlockKramdown(block.id));
  }

  const updatedParagraphMarkdown = "paragraph updated with **Markdown**";
  const updatedHeadingMarkdown = "## Roundtrip heading updated";
  const updatedCodeLines = String(code.markdown).replace(/\r\n?/g, "\n").split("\n");
  let closingFenceIndex = updatedCodeLines.length - 1;

  while (closingFenceIndex > 0 && updatedCodeLines[closingFenceIndex].trim() === "") {
    closingFenceIndex -= 1;
  }

  assert(closingFenceIndex > 0, "Code block has no closing fence");
  updatedCodeLines.splice(closingFenceIndex, 0, "const added = true;");
  const updatedCodeMarkdown = updatedCodeLines.join("\n");

  await post("/api/block/updateBlock", {
    id: paragraph.id,
    dataType: "markdown",
    data: preserveBlockIal(
      paragraph.id,
      updatedParagraphMarkdown,
      originalBlockKramdown.get(paragraph.id),
    ),
  });
  await post("/api/block/updateBlock", {
    id: heading.id,
    dataType: "markdown",
    data: preserveBlockIal(
      heading.id,
      updatedHeadingMarkdown,
      originalBlockKramdown.get(heading.id),
    ),
  });
  await post("/api/block/updateBlock", {
    id: code.id,
    dataType: "markdown",
    data: preserveBlockIal(
      code.id,
      updatedCodeMarkdown,
      originalBlockKramdown.get(code.id),
    ),
  });
  await post("/api/block/updateBlock", {
    id: emptyParagraph.id,
    dataType: "markdown",
    data: preserveBlockIal(
      emptyParagraph.id,
      zwj,
      originalBlockKramdown.get(emptyParagraph.id),
    ),
  });

  const refreshed = await getChildBlocks(docId);
  const refreshedOrder = refreshed.map((block) => block.id);
  report.refreshedOrder = refreshedOrder;
  assert(JSON.stringify(refreshedOrder) === JSON.stringify(originalOrder), "Top-level block IDs or order changed");

  const refreshedById = new Map(refreshed.map((block) => [block.id, block]));
  const refreshedParagraph = refreshedById.get(paragraph.id);
  const refreshedHeading = refreshedById.get(heading.id);
  const refreshedCode = refreshedById.get(code.id);
  const refreshedEmpty = refreshedById.get(emptyParagraph.id);

  assert(refreshedParagraph?.markdown === updatedParagraphMarkdown, "Paragraph Markdown was normalized unexpectedly");
  assert(refreshedHeading?.markdown === updatedHeadingMarkdown, "Heading Markdown was normalized unexpectedly");
  assert(refreshedCode?.markdown === updatedCodeMarkdown, "Code fence or body was normalized unexpectedly");
  assert(refreshedCode.markdown.includes(nbsp), "NBSP was not preserved in code");
  assert(refreshedCode.markdown.includes(zwj), "ZWJ was not preserved in code");
  assert(refreshedCode.markdown.includes(bom), "BOM was not preserved in code");
  assert(refreshedEmpty, "Empty paragraph block disappeared");

  report.emptyParagraph = {
    markdown: refreshedEmpty.markdown,
    content: refreshedEmpty.content,
  };
  report.updatedTypes = {
    paragraph: refreshedParagraph.type,
    heading: refreshedHeading.type,
    headingSubType: refreshedHeading.subType ?? null,
    code: refreshedCode.type,
    emptyParagraph: refreshedEmpty.type,
  };

  const paragraphAttrs = await getBlockAttrs(paragraph.id);
  const codeAttrs = await getBlockAttrs(code.id);
  assert(paragraphAttrs["custom-codex-roundtrip"] === "paragraph-attr", "Paragraph custom attr was lost");
  assert(paragraphAttrs.style === "color: rgb(123, 45, 67);", "Paragraph style attr was lost");
  assert(codeAttrs["custom-codex-roundtrip"] === "code-attr", "Code custom attr was lost");
  assert(codeAttrs.fold === "1", "Code fold attr was lost");

  for (const id of updatedIds) {
    const beforeKramdown = originalBlockKramdown.get(id);
    const afterKramdown = await getBlockKramdown(id);
    assert(
      haveSameBlockIal(id, beforeKramdown, afterKramdown),
      "Updated block IAL attributes changed for " + id,
    );
  }

  for (const [id, before] of originalBlockKramdown) {
    if (!updatedIds.has(id)) {
      const after = await getBlockKramdown(id);
      assert(
        after === before,
        [
          "Untouched block Kramdown changed for " + id,
          "type=" + (refreshedById.get(id)?.type ?? "unknown"),
          "before=" + JSON.stringify(before),
          "after=" + JSON.stringify(after),
        ].join("\n"),
      );
    }
  }
} catch (error) {
  failure = error;
} finally {
  if (notebookId && notebookVerified) {
    try {
      await post("/api/notebook/removeNotebook", { notebook: notebookId });
      const remaining = await listNotebooks();
      assert(!remaining.some((notebook) => notebook?.id === notebookId), "Temporary notebook still exists");
      report.cleanup = "removed";
    } catch (error) {
      cleanupFailure = error;
      report.cleanup = "failed";
    }
  } else {
    report.cleanup = notebookId ? "skipped-unverified" : "not-created";
  }
}

if (cleanupFailure) {
  throw new Error("Roundtrip cleanup failed for " + notebookId + ": " + cleanupFailure.message);
}

if (failure) {
  throw failure;
}

console.log(JSON.stringify(report, null, 2));
