/**
 * One fetch wrapper for the whole app.
 *
 * Authentication is the session cookie the browser already sends; nothing here
 * reads or stores a token, and there is no Authorization header to forget.
 */

/**
 * A refusal from the API.
 *
 * `message` is the server's `detail`, which every screen can show as-is. `body`
 * is the rest of the error payload, for the refusals that carry more than a
 * sentence — a duplicate upload names the meeting it duplicates, so the dialog
 * can offer to open it. Most callers never look at it.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const JSON_HEADERS = { "Content-Type": "application/json" };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res
      .json()
      .then((b: Record<string, unknown> | null) => b ?? {})
      .catch(() => ({}) as Record<string, unknown>);
    throw new ApiError((body.detail as string) || res.statusText, res.status, body);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const api = {
  get: <T>(url: string) => request<T>(url),
  post: <T>(url: string, body?: unknown) =>
    request<T>(url, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body ?? {}) }),
  put: <T>(url: string, body: unknown) =>
    request<T>(url, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(body) }),
  patch: <T>(url: string, body: unknown) =>
    request<T>(url, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(body) }),
  del: <T>(url: string) => request<T>(url, { method: "DELETE" }),
};

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Upload with a real progress figure.
 *
 * `fetch` cannot report how much of a request body has gone out, and an audio
 * file on a slow link is exactly where a person needs to see it — so this one
 * call uses XMLHttpRequest, which has had `upload.onprogress` all along.
 */
export function upload<T>(
  url: string,
  form: FormData,
  onProgress: (percent: number) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onerror = () => reject(new ApiError("업로드 중 연결이 끊겼습니다.", 0));
    xhr.onload = () => {
      const body = (xhr.response ?? {}) as Record<string, unknown>;
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response as T);
      else reject(new ApiError((body.detail as string) || xhr.statusText, xhr.status, body));
    };
    xhr.send(form);
  });
}
