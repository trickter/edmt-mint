export class EdmtApiError extends Error {
  constructor({ status, code, message, url, cause }) {
    super(message);
    this.name = "EdmtApiError";
    this.status = status;
    this.code = code;
    this.url = url;
    this.cause = cause;
  }

  get isAlreadyMinted() {
    return /already minted/i.test(this.message);
  }

  get isRetryable() {
    return this.status === 0 || this.status >= 500 || this.status === 429;
  }
}

export function createEdmtApi({ baseUrl = "https://api.edmt.io", fetchImpl = fetch } = {}) {
  const cleanBaseUrl = baseUrl.replace(/\/+$/, "");

  async function fetchJson(path, { method = "GET", query, body, signal, timeoutMs = 30_000 } = {}) {
    const url = new URL(`${cleanBaseUrl}${path.startsWith("/") ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    const controller = new AbortController();
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs) : null;
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
    }

    try {
      const headers = { accept: "application/json" };
      const init = { method, headers, signal: controller.signal };
      if (body !== undefined) {
        headers["content-type"] = "application/json";
        init.body = JSON.stringify(body);
      }

      let response;
      try {
        response = await fetchImpl(url, init);
      } catch (cause) {
        throw new EdmtApiError({
          status: 0,
          code: "network_error",
          message: cause instanceof Error ? cause.message : "network error",
          url: url.toString(),
          cause
        });
      }

      const text = await response.text();
      const json = text ? parseJson(text, url.toString(), response.status) : null;

      if (!response.ok) {
        const err = extractApiError(json, response.status);
        throw new EdmtApiError({
          status: response.status,
          code: err.code,
          message: err.message,
          url: url.toString()
        });
      }

      return json;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return {
    fetchJson,
    async status(options) {
      return fetchJson("/api/v1/status", options);
    },
    async pendingMints({ limit, cursor, signal } = {}) {
      return fetchJson("/api/v1/mints/pending", { query: { limit, cursor }, signal });
    },
    async block(blk, options) {
      return fetchJson(`/api/v1/blocks/${blk}`, options);
    },
    async captureFee(blk, options) {
      return fetchJson("/api/v1/mint/capture-fee", { query: { blk }, signal: options?.signal });
    },
    async buildMint({ tick = "enat", blk, signal } = {}) {
      return fetchJson("/api/v1/build/mint", { method: "POST", body: { tick, blk }, signal });
    }
  };
}

export function unwrapData(response) {
  if (response && typeof response === "object" && "data" in response) {
    return response.data;
  }
  return response;
}

function parseJson(text, url, status) {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new EdmtApiError({
      status,
      code: "invalid_json",
      message: "Response body is not valid JSON",
      url,
      cause
    });
  }
}

function extractApiError(json, status) {
  if (json && typeof json === "object") {
    if (json.error && typeof json.error === "object") {
      return {
        code: typeof json.error.code === "string" ? json.error.code : "http_error",
        message: typeof json.error.message === "string" ? json.error.message : `HTTP ${status}`
      };
    }
    if (typeof json.message === "string") {
      return { code: "http_error", message: json.message };
    }
  }
  return { code: "http_error", message: `HTTP ${status}` };
}
