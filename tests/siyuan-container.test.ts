import assert from "node:assert/strict";
import test from "node:test";

import {
  createSiyuanContainerEditPlan,
  haveSameSiyuanBlockTree,
} from "../src/siyuan-container";
import {
  createSiyuanSourceDocument,
  type SiyuanBlockTreeNode,
} from "../src/siyuan-source";

function paragraph(id: string, parentText: string): SiyuanBlockTreeNode {
  return {
    id,
    type: "p",
    subType: null,
    content: parentText,
    markdown: parentText,
    children: [],
  };
}

function unorderedListTree(markdown = "- alpha\n- beta"): SiyuanBlockTreeNode {
  return {
    id: "list",
    type: "l",
    subType: "u",
    content: " alpha beta",
    markdown,
    children: [
      {
        id: "item-1",
        type: "i",
        subType: "u",
        content: " alpha",
        markdown: "- alpha",
        children: [paragraph("p-1", "alpha")],
      },
      {
        id: "item-2",
        type: "i",
        subType: "u",
        content: " beta",
        markdown: "- beta",
        children: [paragraph("p-2", "beta")],
      },
    ],
  };
}

function sourceBlock(tree: SiyuanBlockTreeNode) {
  return createSiyuanSourceDocument([tree], "root").blocks[0]!;
}

test("plans list text edits as descendant paragraph updates", () => {
  const tree = unorderedListTree();
  const plan = createSiyuanContainerEditPlan(
    sourceBlock(tree),
    "- **alpha edited**\n- beta",
    tree,
  );

  assert.deepEqual(plan.updates, [
    {
      ownerId: "list",
      id: "p-1",
      type: "p",
      subType: null,
      kind: "source",
      markdown: "**alpha edited**",
      originalMarkdown: "alpha",
      control: null,
    },
  ]);
});

test("plans task checkbox and task text edits without replacing the list root", () => {
  const tree: SiyuanBlockTreeNode = {
    id: "tasks",
    type: "l",
    subType: "t",
    markdown: "- [ ] alpha\n- [X] beta",
    children: [
      {
        id: "task-1",
        type: "i",
        subType: "t",
        markdown: "- [ ] alpha",
        children: [paragraph("task-p-1", "alpha")],
      },
      {
        id: "task-2",
        type: "i",
        subType: "t",
        markdown: "- [X] beta",
        children: [paragraph("task-p-2", "beta")],
      },
    ],
  };
  const plan = createSiyuanContainerEditPlan(
    sourceBlock(tree),
    "- [X] alpha edited\n- [X] beta",
    tree,
  );

  assert.equal(plan.updates.length, 2);
  assert.deepEqual(plan.updates[0], {
    ownerId: "tasks",
    id: "task-1",
    type: "i",
    subType: "t",
    kind: "list-item-control",
    markdown: null,
    originalMarkdown: null,
    control: {
      originalMarker: "-",
      nextMarker: "-",
      originalTaskMarker: "[ ]",
      nextTaskMarker: "[X]",
    },
  });
  assert.equal(plan.updates[1]?.id, "task-p-1");
  assert.equal(plan.updates[1]?.markdown, "alpha edited");
});

test("maps nested list and blockquote leaves while rejecting block-tree edits", () => {
  const nested: SiyuanBlockTreeNode = {
    id: "outer-list",
    type: "l",
    subType: "u",
    markdown: "- alpha\n\n  - nested\n- beta",
    children: [
      {
        id: "outer-item-1",
        type: "i",
        subType: "u",
        markdown: "- alpha\n\n  - nested",
        children: [
          paragraph("outer-p", "alpha"),
          {
            id: "inner-list",
            type: "l",
            subType: "u",
            markdown: "- nested",
            children: [
              {
                id: "inner-item",
                type: "i",
                subType: "u",
                markdown: "- nested",
                children: [paragraph("inner-p", "nested")],
              },
            ],
          },
        ],
      },
      {
        id: "outer-item-2",
        type: "i",
        subType: "u",
        markdown: "- beta",
        children: [paragraph("outer-p-2", "beta")],
      },
    ],
  };
  const nestedPlan = createSiyuanContainerEditPlan(
    sourceBlock(nested),
    "- alpha\n\n  - nested edited\n- beta",
    nested,
  );
  assert.equal(nestedPlan.updates[0]?.id, "inner-p");
  assert.equal(nestedPlan.updates[0]?.markdown, "nested edited");

  const quote: SiyuanBlockTreeNode = {
    id: "quote",
    type: "b",
    subType: null,
    markdown: "> alpha\n>\n> beta",
    children: [paragraph("quote-p-1", "alpha"), paragraph("quote-p-2", "beta")],
  };
  const quotePlan = createSiyuanContainerEditPlan(
    sourceBlock(quote),
    "> alpha edited\n>\n> beta",
    quote,
  );
  assert.equal(quotePlan.updates[0]?.id, "quote-p-1");

  assert.throws(
    () => createSiyuanContainerEditPlan(
      sourceBlock(unorderedListTree()),
      "- alpha\n- beta\n- gamma",
      unorderedListTree(),
    ),
    /block tree changed|compatible Markdown block/,
  );
});

test("compares complete descendant identity and ordering", () => {
  const before = unorderedListTree();
  assert.equal(haveSameSiyuanBlockTree(before, structuredClone(before)), true);

  const changedId = structuredClone(before);
  changedId.children[0]!.children[0]!.id = "replacement";
  assert.equal(haveSameSiyuanBlockTree(before, changedId), false);

  const reordered = structuredClone(before);
  reordered.children.reverse();
  assert.equal(haveSameSiyuanBlockTree(before, reordered), false);
});
