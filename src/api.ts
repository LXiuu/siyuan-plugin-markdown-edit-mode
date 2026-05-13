import { fetchSyncPost } from "siyuan";

import { normalizeMarkdownForSave, normalizeSiyuanExportMarkdown } from "./markdown";

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
  });
  const response = (await fetchSyncPost("/api/block/updateBlock", {
    id: docId,
    dataType: "markdown",
    data: normalized.markdown,
  })) as SiyuanApiResponse;

  assertSuccessfulResponse(response, options.fallbackMessage ?? "Failed to save Markdown");
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
