const API_BASE = process.env.SIYUAN_API_BASE ?? "http://127.0.0.1:6806";
const TEMP_NOTEBOOK_PREFIX = "codex-container-leaf-matrix-";
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
  const escapedId = blockId.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const idPattern = new RegExp("\\bid=([\"'])" + escapedId + "\\1");
  const candidates = blockKramdown.match(/\{:[^}\r\n]*\}/g) ?? [];

  for (const ial of candidates) {
    if (idPattern.test(ial)) {
      return ial;
    }
  }

  throw new Error("Block Kramdown has no IAL for " + blockId);
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
        "custom-codex-leaf-case": caseName,
        "custom-codex-leaf-index": String(index),
      },
    });
  }
}

function compareSnapshots(before, after, editedId) {
  const beforeById = new Map(before.map((node) => [node.id, node]));
  const afterById = new Map(after.map((node) => [node.id, node]));
  const lostIds = before.filter((node) => !afterById.has(node.id)).map((node) => node.id);
  const addedIds = after.filter((node) => !beforeById.has(node.id)).map((node) => node.id);
  const changedParents = before
    .filter((node) => afterById.has(node.id))
    .filter((node) => {
      const refreshed = afterById.get(node.id);
      return node.parentId !== refreshed.parentId || node.index !== refreshed.index;
    })
    .map((node) => node.id);
  const changedIals = before
    .filter((node) => afterById.has(node.id))
    .filter((node) => !haveSameBlockIal(node.id, node.kramdown, afterById.get(node.id).kramdown))
    .map((node) => node.id);
  const lostTaggedAttrs = before
    .filter((node) => afterById.has(node.id))
    .filter((node) => {
      const refreshed = afterById.get(node.id);
      return (
        node.attrs["custom-codex-leaf-case"] !== refreshed.attrs["custom-codex-leaf-case"] ||
        node.attrs["custom-codex-leaf-index"] !== refreshed.attrs["custom-codex-leaf-index"]
      );
    })
    .map((node) => node.id);

  return {
    allIdsPreserved: lostIds.length === 0 && addedIds.length === 0,
    lostIds,
    addedIds,
    changedParents,
    changedIals,
    lostTaggedAttrs,
    editedBlockSurvived: afterById.has(editedId),
    safeUnderTargetedUpdate:
      lostIds.length === 0 &&
      addedIds.length === 0 &&
      changedParents.length === 0 &&
      changedIals.length === 0 &&
      lostTaggedAttrs.length === 0,
  };
}

const cases = [
  {
    name: "unordered-list-leaf-text",
    markdown: "- alpha\n- beta",
    target: (node) => node.type === "p" && node.content?.includes("alpha"),
    edit: (markdown) => markdown.replace("alpha", "alpha edited"),
  },
  {
    name: "ordered-list-leaf-text",
    markdown: "1. alpha\n2. beta",
    target: (node) => node.type === "p" && node.content?.includes("beta"),
    edit: (markdown) => markdown.replace("beta", "beta edited"),
  },
  {
    name: "task-list-leaf-text",
    markdown: "- [ ] alpha\n- [X] beta",
    target: (node) => node.type === "p" && node.content?.includes("alpha"),
    edit: (markdown) => markdown.replace("alpha", "alpha edited"),
  },
  {
    name: "nested-list-leaf-text",
    markdown: "- alpha\n  - nested\n- beta",
    target: (node) => node.type === "p" && node.content?.includes("nested"),
    edit: (markdown) => markdown.replace("nested", "nested edited"),
  },
  {
    name: "blockquote-leaf-text",
    markdown: "> alpha\n>\n> beta",
    target: (node) => node.type === "p" && node.content?.includes("alpha"),
    edit: (markdown) => markdown.replace("alpha", "alpha edited"),
  },
  {
    name: "unordered-list-item-marker",
    markdown: "- alpha\n- beta",
    target: (node) => node.type === "i" && node.subType === "u" && node.content?.includes("alpha"),
    edit: (markdown) => markdown.replace(/^-/, "*"),
  },
  {
    name: "ordered-list-item-number",
    markdown: "1. alpha\n2. beta",
    target: (node) => node.type === "i" && node.subType === "o" && node.content?.includes("beta"),
    edit: (markdown) => markdown.replace(/^2\./, "5."),
  },
  {
    name: "ordered-list-item-number-width",
    markdown: "1. alpha\n2. beta",
    target: (node) => node.type === "i" && node.subType === "o" && node.content?.includes("beta"),
    edit: (markdown) => markdown.replace(/^2\./, "10."),
  },
  {
    name: "task-list-item-toggle",
    markdown: "- [ ] alpha\n- [X] beta",
    target: (node) => node.type === "i" && node.content?.includes("alpha"),
    edit: (markdown) => markdown.replace("[ ]", "[X]"),
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
    const caseReport = { name: entry.name };

    try {
      const createdDocument = await post("/api/filetree/createDocWithMd", {
        notebook: notebookId,
        path: "/" + entry.name,
        markdown: entry.markdown,
      });
      const docId = extractId(createdDocument);
      assert(typeof docId === "string" && docId.length > 0, "createDocWithMd returned no ID");
      await waitForChildren(docId);

      const initialTree = await snapshotTree(docId);
      await tagSnapshot(entry.name, initialTree);
      const before = await snapshotTree(docId);
      const target = before.find(entry.target);
      assert(target, entry.name + " could not find its update target");
      assert(typeof target.markdown === "string", entry.name + " target has no Markdown source");
      const editedMarkdown = entry.edit(target.markdown);
      const updateData = target.type === "i"
        ? entry.edit(target.kramdown)
        : preserveBlockIal(target.id, editedMarkdown, target.kramdown);
      assert(editedMarkdown !== target.markdown, entry.name + " edit produced no change");
      caseReport.discoveredTarget = {
        id: target.id,
        type: target.type,
        subType: target.subType,
        parentId: target.parentId,
        markdown: target.markdown,
        content: target.content,
        kramdown: target.kramdown,
      };
      caseReport.discoveredTree = before.map(
        ({ id, type, subType, parentId, index, markdown, content, kramdown }) => ({
          id,
          type,
          subType,
          parentId,
          index,
          markdown,
          content,
          kramdown,
        }),
      );

      await post("/api/block/updateBlock", {
        id: target.id,
        dataType: "markdown",
        data: updateData,
      });

      const after = await snapshotTree(docId);
      const topLevelAfter = after.filter((node) => node.parentId === docId);
      Object.assign(caseReport, {
        documentId: docId,
        target: {
          id: target.id,
          type: target.type,
          subType: target.subType,
          parentId: target.parentId,
          beforeMarkdown: target.markdown,
          requestedMarkdown: editedMarkdown,
          returnedMarkdown: after.find((node) => node.id === target.id)?.markdown ?? null,
          beforeKramdown: target.kramdown,
          returnedKramdown: after.find((node) => node.id === target.id)?.kramdown ?? null,
        },
        topLevelMarkdown: topLevelAfter.map((node) => node.markdown),
        treeBefore: before.map(({ id, type, subType, parentId, index, markdown, content }) => ({
          id,
          type,
          subType,
          parentId,
          index,
          markdown,
          content,
        })),
        treeAfter: after.map(({ id, type, subType, parentId, index, markdown, content }) => ({
          id,
          type,
          subType,
          parentId,
          index,
          markdown,
          content,
        })),
        ...compareSnapshots(before, after, target.id),
      });
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
  throw new Error("Container leaf matrix cleanup failed for " + notebookId + ": " + cleanupFailure.message);
}

if (failure) {
  throw failure;
}
