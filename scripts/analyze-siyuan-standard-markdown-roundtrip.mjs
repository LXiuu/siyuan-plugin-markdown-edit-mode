const API_BASE = process.env.SIYUAN_API_BASE ?? "http://127.0.0.1:6806";
const TEMP_NOTEBOOK_PREFIX = "codex-standard-markdown-matrix-";
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
  assert(Array.isArray(data), "getChildBlocks returned an unexpected payload for " + id);
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

function getBlockIal(blockId, blockKramdown) {
  const lines = blockKramdown.replace(/\r\n?/g, "\n").split("\n");

  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }

  const ial = lines[lines.length - 1] ?? "";
  const idMatch = ial.match(/\bid=(["'])([^"']+)\1/);
  assert(/^\{:[\s\S]*\}$/.test(ial), "Block Kramdown has no trailing IAL for " + blockId);
  assert(idMatch?.[2] === blockId, "Block Kramdown IAL has the wrong ID for " + blockId);
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

async function waitForChildren(docId) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const children = await getChildBlocks(docId);
    if (children.length > 0) {
      return children;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error("Timed out waiting for document blocks: " + docId);
}

async function snapshotTree(rootId) {
  const nodes = [];

  async function visit(parentId) {
    const children = await getChildBlocks(parentId);

    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      const [kramdown, attrs] = await Promise.all([
        getBlockKramdown(child.id),
        getBlockAttrs(child.id),
      ]);

      nodes.push({
        id: child.id,
        type: child.type,
        subType: child.subType ?? null,
        parentId,
        index,
        markdown: child.markdown ?? null,
        content: child.content ?? null,
        kramdown,
        attrs,
      });
      await visit(child.id);
    }
  }

  await visit(rootId);
  return nodes;
}

async function tagSnapshot(caseName, nodes) {
  for (let index = 0; index < nodes.length; index += 1) {
    await post("/api/attr/setBlockAttrs", {
      id: nodes[index].id,
      attrs: {
        "custom-codex-standard-case": caseName,
        "custom-codex-standard-index": String(index),
      },
    });
  }
}

function compareSnapshots(before, after, rootId, expectedMarkdown, expectedType) {
  const beforeById = new Map(before.map((node) => [node.id, node]));
  const afterById = new Map(after.map((node) => [node.id, node]));
  const rootBefore = beforeById.get(rootId);
  const rootAfter = afterById.get(rootId);
  const descendantIds = before.filter((node) => node.id !== rootId).map((node) => node.id);
  const survivingIds = before.filter((node) => afterById.has(node.id)).map((node) => node.id);
  const lostIds = before.filter((node) => !afterById.has(node.id)).map((node) => node.id);
  const addedIds = after.filter((node) => !beforeById.has(node.id)).map((node) => node.id);
  const changedParents = survivingIds.filter((id) => {
    const left = beforeById.get(id);
    const right = afterById.get(id);
    return left.parentId !== right.parentId || left.index !== right.index;
  });
  const lostTaggedAttrs = survivingIds.filter((id) => {
    const left = beforeById.get(id).attrs;
    const right = afterById.get(id).attrs;
    return (
      left["custom-codex-standard-case"] !== right["custom-codex-standard-case"] ||
      left["custom-codex-standard-index"] !== right["custom-codex-standard-index"]
    );
  });
  const changedIals = survivingIds.filter(
    (id) => !haveSameBlockIal(id, beforeById.get(id).kramdown, afterById.get(id).kramdown),
  );

  return {
    rootIdPreserved: Boolean(rootAfter),
    rootTypePreserved: rootAfter?.type === expectedType,
    rootMarkdownMatches: rootAfter?.markdown === expectedMarkdown,
    allOriginalDescendantIdsPreserved: descendantIds.every((id) => afterById.has(id)),
    originalNodeCount: before.length,
    refreshedNodeCount: after.length,
    lostIds,
    addedIds,
    changedParents,
    lostTaggedAttrs,
    changedIals,
    safeUnderRootUpdate:
      Boolean(rootBefore) &&
      Boolean(rootAfter) &&
      rootAfter.type === expectedType &&
      rootAfter.markdown === expectedMarkdown &&
      descendantIds.every((id) => afterById.has(id)) &&
      changedParents.length === 0 &&
      lostTaggedAttrs.length === 0 &&
      changedIals.length === 0,
  };
}

const cases = [
  {
    name: "paragraph-to-table",
    markdown: "alpha",
    type: "p",
    resultType: "t",
    edit: () => "| A | B |\n| --- | --- |\n| alpha | beta |",
  },
  {
    name: "table-to-paragraph",
    markdown: "| A | B |\n| --- | --- |\n| alpha | beta |",
    type: "t",
    resultType: "p",
    edit: () => "alpha",
  },
  {
    name: "paragraph-to-math",
    markdown: "alpha",
    type: "p",
    resultType: "m",
    edit: () => "$$\nx^2\n$$",
  },
  {
    name: "math-to-paragraph",
    markdown: "$$\nx^2\n$$",
    type: "m",
    resultType: "p",
    edit: () => "alpha",
  },
  {
    name: "paragraph-to-divider",
    markdown: "alpha",
    type: "p",
    resultType: "tb",
    edit: () => "---",
  },
  {
    name: "divider-to-paragraph",
    markdown: "---",
    type: "tb",
    resultType: "p",
    edit: () => "alpha",
  },
  {
    name: "paragraph-to-html",
    markdown: "alpha",
    type: "p",
    resultType: "html",
    edit: () => "<div><strong>alpha</strong></div>",
  },
  {
    name: "html-to-paragraph",
    markdown: "<div><strong>alpha</strong></div>",
    type: "html",
    resultType: "p",
    edit: () => "alpha",
  },

  {
    name: "heading-atx-to-setext",
    markdown: "# alpha",
    type: "h",
    edit: () => "alpha edited\n===",
  },
  {
    name: "paragraph-to-heading",
    markdown: "alpha",
    type: "p",
    resultType: "h",
    edit: () => "# alpha",
  },
  {
    name: "heading-to-paragraph",
    markdown: "# alpha",
    type: "h",
    resultType: "p",
    edit: () => "alpha",
  },
  {
    name: "paragraph-to-code",
    markdown: "alpha",
    type: "p",
    resultType: "c",
    edit: () => "~~~text\nalpha\n~~~",
  },
  {
    name: "code-fence-length",
    markdown: "~~~text\nalpha\n~~~",
    type: "c",
    edit: () => "~~~~text\nalpha\n~~~~",
  },
  {
    name: "code-embedded-shorter-fence",
    markdown: "~~~~text\nalpha\n~~~~",
    type: "c",
    edit: () => "~~~~text\nalpha\n```\nomega\n~~~~",
  },
  {
    name: "heading-closing-hashes",
    markdown: "# alpha",
    type: "h",
    edit: () => "## alpha ##",
  },
  {
    name: "heading-empty",
    markdown: "# alpha",
    type: "h",
    edit: () => "# ",
  },
  {
    name: "heading-leading-spaces",
    markdown: "# alpha",
    type: "h",
    edit: () => "   ## beta",
  },
  {
    name: "divider-marker-style",
    markdown: "---",
    type: "tb",
    edit: () => "* * *",
  },
  {
    name: "paragraph-whitespace-only",
    markdown: "alpha",
    type: "p",
    edit: () => "   ",
  },
  {
    name: "paragraph-to-indented-code",
    markdown: "alpha",
    type: "p",
    resultType: "c",
    edit: () => "    alpha\n    beta",
  },
  {
    name: "paragraph-lazy-ordered-continuation",
    markdown: "alpha\n2. beta",
    type: "p",
    edit: (markdown) => markdown.replace("beta", "beta edited"),
  },
  {
    name: "setext-source-shape",
    markdown: "alpha\n===",
    type: "p",
    edit: (markdown) => markdown.replace("alpha", "alpha edited"),
  },
  {
    name: "link-reference-definition",
    markdown: "[ref]: https://example.com \"title\"",
    type: "p",
    edit: (markdown) => markdown.replace("title", "edited"),
  },
  {
    name: "html-comment",
    markdown: "<!-- alpha -->",
    type: "html",
    edit: (markdown) => markdown.replace("alpha", "alpha edited"),
  },
  {
    name: "html-iframe-probe",
    markdown: '<iframe src="https://example.com"></iframe>',
    type: "html",
    edit: (markdown) => markdown.replace("example.com", "example.org"),
  },
  {
    name: "paragraph-to-list",
    markdown: "alpha",
    type: "p",
    resultType: "l",
    edit: () => "- alpha\n- beta",
  },
  {
    name: "paragraph-to-blockquote",
    markdown: "alpha",
    type: "p",
    resultType: "b",
    edit: () => "> alpha\n>\n> beta",
  },

  {
    name: "unordered-list-text",
    markdown: "- alpha\n- beta",
    type: "l",
    edit: (markdown) => markdown.replace("alpha", "alpha edited"),
  },
  {
    name: "unordered-list-add-item",
    markdown: "- alpha\n- beta",
    type: "l",
    edit: (markdown) => markdown + "\n\n- gamma",
  },
  {
    name: "ordered-list-text",
    markdown: "1. alpha\n2. beta",
    type: "l",
    edit: (markdown) => markdown.replace("beta", "beta edited"),
  },
  {
    name: "task-list-toggle",
    markdown: "- [ ] alpha\n- [x] beta",
    type: "l",
    edit: (markdown) => markdown.replace("[ ]", "[x]"),
  },
  {
    name: "nested-list-text",
    markdown: "- alpha\n  - nested\n- beta",
    type: "l",
    edit: (markdown) => markdown.replace("nested", "nested edited"),
  },
  {
    name: "nested-list-reindent",
    markdown: "- alpha\n  - nested\n- beta",
    type: "l",
    edit: (markdown) => markdown.replace("  - nested", "- nested"),
  },
  {
    name: "blockquote-text",
    markdown: "> alpha\n>\n> beta",
    type: "b",
    edit: (markdown) => markdown.replace("alpha", "alpha edited"),
  },
  {
    name: "blockquote-add-line",
    markdown: "> alpha\n>\n> beta",
    type: "b",
    edit: (markdown) => markdown + "\n>\n> gamma",
  },
  {
    name: "table-cell-text",
    markdown: "| A | B |\n| --- | --- |\n| alpha | beta |",
    type: "t",
    edit: (markdown) => markdown.replace("alpha", "alpha edited"),
  },
  {
    name: "table-add-row",
    markdown: "| A | B |\n| --- | --- |\n| alpha | beta |",
    type: "t",
    edit: (markdown) => markdown + "\n| gamma | delta |",
  },
  {
    name: "table-alignments",
    markdown: "| A | B | C |\n| --- | --- | --- |\n| alpha | beta | gamma |",
    type: "t",
    edit: () => "| A | B | C |\n| :--- | :---: | ---: |\n| alpha | beta | gamma |",
  },
  {
    name: "table-add-column",
    markdown: "| A | B |\n| --- | --- |\n| alpha | beta |",
    type: "t",
    edit: () => "| A | B | C |\n| --- | --- | --- |\n| alpha | beta | gamma |",
  },
  {
    name: "table-delete-column",
    markdown: "| A | B | C |\n| --- | --- | --- |\n| alpha | beta | gamma |",
    type: "t",
    edit: () => "| A | B |\n| --- | --- |\n| alpha | beta |",
  },
  {
    name: "table-escaped-pipe",
    markdown: "| A | B |\n| --- | --- |\n| alpha \\| one | beta |",
    type: "t",
    edit: (markdown) => markdown.replace("beta", "beta edited"),
  },

  {
    name: "html-multiline",
    markdown: "<div data-kind=\"fixture\">\n  <span>alpha</span>\n</div>",
    type: "html",
    edit: (markdown) => markdown.replace("alpha", "alpha edited"),
  },
  {
    name: "html-script",
    markdown: "<script>\nconst value = '<alpha>';\n</script>",
    type: "html",
    edit: (markdown) => markdown.replace("<alpha>", "<beta>"),
  },
  {
    name: "html-style",
    markdown: "<style>\n.fixture::before { content: \"alpha\"; }\n</style>",
    type: "html",
    edit: (markdown) => markdown.replace("alpha", "beta"),
  },

  {
    name: "html-text",
    markdown: '<div data-kind="fixture"><span>alpha</span></div>',
    type: "html",
    edit: (markdown) => markdown.replace("alpha", "alpha edited"),
  },
  {
    name: "html-attribute",
    markdown: '<div data-kind="fixture"><span>alpha</span></div>',
    type: "html",
    edit: (markdown) => markdown.replace('data-kind="fixture"', 'data-kind="edited"'),
  },
];

const notebookName = TEMP_NOTEBOOK_PREFIX + new Date().toISOString().replace(/[^0-9]/g, "");
let notebookId = null;
let notebookVerified = false;
let failure = null;
let cleanupFailure = null;
const report = {
  apiBase: API_BASE,
  notebookName,
  notebookId: null,
  siyuanVersion: null,
  cases: [],
  cleanup: "not-started",
};

try {
  report.siyuanVersion = await post("/api/system/version", {});
  const createdNotebook = await post("/api/notebook/createNotebook", { name: notebookName });
  notebookId = extractId(createdNotebook);

  if (!notebookId) {
    const match = (await listNotebooks()).find((notebook) => notebook?.name === notebookName);
    notebookId = extractId(match);
  }

  assert(typeof notebookId === "string" && notebookId.length > 0, "createNotebook returned no ID");
  assert(notebookId !== FORBIDDEN_NOTEBOOK_ID, "Temporary notebook resolved to protected sample ID");
  report.notebookId = notebookId;

  notebookVerified = (await listNotebooks()).some(
    (notebook) => notebook?.id === notebookId && notebook?.name === notebookName,
  );
  assert(notebookVerified, "Could not verify temporary notebook before writing");

  for (const entry of cases) {
    const caseReport = { name: entry.name, expectedType: entry.resultType ?? entry.type };

    try {
      const createdDocument = await post("/api/filetree/createDocWithMd", {
        notebook: notebookId,
        path: "/" + entry.name,
        markdown: entry.markdown,
      });
      const docId = extractId(createdDocument);
      assert(typeof docId === "string" && docId.length > 0, "createDocWithMd returned no ID");

      const topLevel = await waitForChildren(docId);
      assert(topLevel.length === 1, entry.name + " did not create exactly one top-level block");
      const root = topLevel[0];
      assert(root.type === entry.type, entry.name + " created type " + root.type + " instead of " + entry.type);

      const initialTree = await snapshotTree(docId);
      await tagSnapshot(entry.name, initialTree);
      const before = await snapshotTree(docId);
      const beforeRoot = before.find((node) => node.id === root.id);
      assert(beforeRoot, entry.name + " root snapshot is missing");

      const editedMarkdown = entry.edit(String(beforeRoot.markdown));
      assert(editedMarkdown !== beforeRoot.markdown, entry.name + " edit produced no change");

      await post("/api/block/updateBlock", {
        id: root.id,
        dataType: "markdown",
        data: preserveBlockIal(root.id, editedMarkdown, beforeRoot.kramdown),
      });

      const after = await snapshotTree(docId);
      Object.assign(
        caseReport,
        {
          documentId: docId,
          rootId: root.id,
          beforeMarkdown: beforeRoot.markdown,
          beforeKramdown: beforeRoot.kramdown,
          requestedMarkdown: editedMarkdown,
          returnedMarkdown: after.find((node) => node.id === root.id)?.markdown ?? null,
          returnedKramdown: after.find((node) => node.id === root.id)?.kramdown ?? null,
        },
        compareSnapshots(before, after, root.id, editedMarkdown, entry.resultType ?? entry.type),
      );
    } catch (error) {
      caseReport.error = error instanceof Error ? error.message : String(error);
    }

    report.cases.push(caseReport);
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

console.log(JSON.stringify(report, null, 2));

if (cleanupFailure) {
  throw new Error("Matrix cleanup failed for " + notebookId + ": " + cleanupFailure.message);
}

if (failure) {
  throw failure;
}
