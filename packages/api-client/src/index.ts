/** Client HTTP des textes (API-009 à API-015). */

export type DocumentMode = "novel" | "screenplay" | "document" | "blank";

export type PageFormat = "novel_13x20" | "pocket_11x17_8" | "trade_15x23" | "a5" | "a4" | "us_letter";

export type DocumentSummary = {
  id: string;
  title: string;
  mode: string;
  wordCount: number;
  updatedAt: string;
  deletedAt: string | null;
  excerpt: string;
};

export type Document = DocumentSummary & {
  pageFormat: string;
  fontFamily: string;
  baseFontSizePt: number;
  schemaVersion: number;
  outline: Array<{ level: number; title: string }>;
  createdAt: string;
};

export type DocumentCreate = {
  id: string;
  mode: DocumentMode;
  title?: string;
  pageFormat?: PageFormat;
  fontFamily?: string;
  importedFrom?: "docx" | "txt" | "md";
};

export type DocumentPatch = {
  title?: string;
  pageFormat?: PageFormat;
  fontFamily?: string;
  baseFontSizePt?: number;
};

export type ListQuery = {
  cursor?: string;
  limit?: number;
  trashed?: boolean;
  updatedSince?: string;
};

export type ApiResult<T> = {
  status: number;
  body: T;
  etag: string | null;
};

export type ApiClientOptions = {
  baseUrl: string;
  cookie?: string;
  fetch?: ApiFetch;
};

type ApiFetch = (
  input: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{
  status: number;
  text: () => Promise<string>;
  headers: { get: (name: string) => string | null };
}>;

function queryString(query: ListQuery): string {
  const parts: string[] = [];
  const add = (key: string, value: string): void => {
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  };
  if (query.cursor !== undefined) {
    add("cursor", query.cursor);
  }
  if (query.limit !== undefined) {
    add("limit", String(query.limit));
  }
  if (query.trashed !== undefined) {
    add("trashed", query.trashed ? "true" : "false");
  }
  if (query.updatedSince !== undefined) {
    add("updatedSince", query.updatedSince);
  }
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

function platformFetch(): ApiFetch {
  const runtime = globalThis as { fetch?: ApiFetch };
  if (runtime.fetch === undefined) {
    throw new Error("fetch absent");
  }
  return runtime.fetch;
}

export function createApiClient(options: ApiClientOptions) {
  const base = options.baseUrl.replace(/\/$/u, "");
  const doFetch = options.fetch ?? platformFetch();

  async function request<T>(
    method: string,
    path: string,
    init?: { body?: unknown; headers?: Record<string, string>; json?: boolean },
  ): Promise<ApiResult<T>> {
    const headers: Record<string, string> = { accept: "application/json", ...(init?.headers ?? {}) };
    if (options.cookie !== undefined) {
      headers.cookie = options.cookie;
    }
    let body: string | undefined;
    if (init?.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.body);
    }
    const response = await doFetch(`${base}${path}`, { method, headers, body });
    const text = await response.text();
    const json = init?.json !== false;
    const parsed = text.length === 0 || !json ? (text as T) : (JSON.parse(text) as T);
    return { status: response.status, body: parsed, etag: response.headers.get("etag") };
  }

  return {
    listDocuments(query: ListQuery = {}) {
      return request<{ items: DocumentSummary[]; nextCursor: string | null }>(
        "GET",
        `/api/v1/documents${queryString(query)}`,
      );
    },
    createDocument(body: DocumentCreate, idempotencyKey?: string) {
      return request<Document>("POST", "/api/v1/documents", {
        body,
        headers: idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey },
      });
    },
    getDocument(documentId: string) {
      return request<Document>("GET", `/api/v1/documents/${documentId}`);
    },
    updateDocument(documentId: string, body: DocumentPatch) {
      return request<Document>("PATCH", `/api/v1/documents/${documentId}`, { body });
    },
    deleteDocument(documentId: string, permanent = false) {
      const suffix = permanent ? "?permanent=true" : "";
      return request<string>("DELETE", `/api/v1/documents/${documentId}${suffix}`, { json: false });
    },
    restoreDocument(documentId: string) {
      return request<Document>("POST", `/api/v1/documents/${documentId}/restore`, { body: {} });
    },
    getDocumentContent(documentId: string, format: "prosemirror-json" | "text" | "markdown" = "prosemirror-json") {
      return request<unknown>("GET", `/api/v1/documents/${documentId}/content?format=${format}`, {
        json: format === "prosemirror-json",
      });
    },
  };
}
