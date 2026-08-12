import { fetchSyncPost } from "siyuan";

import {
  normalizeMarkdownForSave,
  normalizeSiyuanExportMarkdown,
  preserveBlankParagraphsForSiyuanSave,
} from "./markdown";
import {
  prepareSiyuanBlockSourceForUpdate,
  type SiyuanBlockTreeNode,
  type SiyuanChildBlockData,
} from "./siyuan-source";

interface SiyuanApiResponse<T = unknown> {
  code: number;
  msg?: string;
  data?: T;
}

interface ExportMdContentData {
  hPath?: string;
  content?: string;
}

interface ExportMdContentMessages {
  exportFailed?: string;
}

interface GetBlockKramdownData {
  id?: string;
  kramdown?: string;
}

const TREE_CONTAINER_TYPES = new Set(["l", "i", "b"]);
function assertSuccessfulResponse<T>(
  response: SiyuanApiResponse<T>,
  fallbackMessage: string,
): asserts response is SiyuanApiResponse<T> & { code: 0 } {
  if (response.code !== 0) {
    throw new Error(response.msg || fallbackMessage);
  }
}

export async function exportMdContent(
  docId: string,
  messages: ExportMdContentMessages = {},
): Promise<{
  markdown: string;
  removedFrontMatterCount: number;
  removedDocTitleHeadingCount: number;
  docTitle: string | null;
}> {
  const response = (await fetchSyncPost("/api/export/exportMdContent", {
    id: docId,
  })) as SiyuanApiResponse<ExportMdContentData>;

  assertSuccessfulResponse(response, messages.exportFailed ?? "Failed to export Markdown");

  const docTitle = getDocTitleFromExportPath(response.data?.hPath);
  const normalized = normalizeSiyuanExportMarkdown(response.data?.content ?? "", {
    docTitle,
    removeEmptyParagraphMarkers: true,
  });

  return {
    ...normalized,
    docTitle,
  };
}

export async function updateBlockByMarkdown(
  docId: string,
  markdown: string,
  options: { docTitle?: string | null; fallbackMessage?: string } = {},
): Promise<void> {
  const normalized = normalizeSiyuanExportMarkdown(normalizeMarkdownForSave(markdown), {
    docTitle: options.docTitle,
    removeEmptyParagraphMarkers: false,
  });
  const response = (await fetchSyncPost("/api/block/updateBlock", {
    id: docId,
    dataType: "markdown",
    data: preserveBlankParagraphsForSiyuanSave(normalized.markdown),
  })) as SiyuanApiResponse;

  assertSuccessfulResponse(response, options.fallbackMessage ?? "Failed to save Markdown");
}

export async function getChildBlocks(
  docId: string,
  fallbackMessage = "Failed to load document blocks",
): Promise<SiyuanChildBlockData[]> {
  const response = (await fetchSyncPost("/api/block/getChildBlocks", {
    id: docId,
  })) as SiyuanApiResponse<unknown>;

  assertSuccessfulResponse(response, fallbackMessage);

  if (!Array.isArray(response.data)) {
    throw new Error(fallbackMessage);
  }

  return response.data.map((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.type !== "string") {
      throw new Error(fallbackMessage);
    }

    return {
      id: item.id,
      type: item.type,
      subType: typeof item.subType === "string" ? item.subType : null,
      content: typeof item.content === "string" ? item.content : null,
      markdown: typeof item.markdown === "string" ? item.markdown : null,
    };
  });
}

export async function getSiyuanBlockTree(
  root: SiyuanChildBlockData,
  fallbackMessage = "Failed to load content block tree",
): Promise<SiyuanBlockTreeNode> {
  const children = TREE_CONTAINER_TYPES.has(root.type)
    ? await getChildBlocks(root.id, fallbackMessage)
    : [];

  return {
    ...root,
    children: await Promise.all(
      children.map((child) => getSiyuanBlockTree(child, fallbackMessage)),
    ),
  };
}

export async function getBlockKramdown(
  blockId: string,
  fallbackMessage = "Failed to load block Kramdown",
): Promise<string> {
  const response = (await fetchSyncPost("/api/block/getBlockKramdown", {
    id: blockId,
  })) as SiyuanApiResponse<GetBlockKramdownData>;

  assertSuccessfulResponse(response, fallbackMessage);

  if (typeof response.data?.kramdown !== "string") {
    throw new Error(fallbackMessage);
  }

  return response.data.kramdown;
}

export async function updateBlockBySource(
  blockId: string,
  blockType: string,
  markdown: string,
  originalMarkdown: string,
  blockKramdown: string,
  fallbackMessage = "Failed to update block",
): Promise<void> {
  const response = (await fetchSyncPost("/api/block/updateBlock", {
    id: blockId,
    dataType: "markdown",
    data: prepareSiyuanBlockSourceForUpdate(
      blockId,
      blockType,
      markdown,
      blockKramdown,
      originalMarkdown,
    ),
  })) as SiyuanApiResponse;

  assertSuccessfulResponse(response, fallbackMessage);
}

export async function updateBlockByPreparedSource(
  blockId: string,
  preparedSource: string,
  fallbackMessage = "Failed to update block",
): Promise<void> {
  const response = (await fetchSyncPost("/api/block/updateBlock", {
    id: blockId,
    dataType: "markdown",
    data: preparedSource,
  })) as SiyuanApiResponse;

  assertSuccessfulResponse(response, fallbackMessage);
}

function getDocTitleFromExportPath(hPath: string | undefined): string | null {
  const title = hPath
    ?.split("/")
    .filter((part) => part.length > 0)
    .pop()
    ?.trim();

  if (!title) {
    return null;
  }

  try {
    return decodeURIComponent(title);
  } catch {
    return title;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
