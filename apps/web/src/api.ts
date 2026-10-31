export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export async function api<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const failure = () =>
    options.method && options.method !== "GET"
      ? "暂时无法取得操作回执，请先核对原操作状态，避免重复提交。"
      : "服务暂时不可用，请稍后重试。";
  let res: Response;
  try {
    res = await fetch("/api" + path, {
      credentials: "include",
      ...options,
      headers: { "Content-Type": "application/json", ...options.headers },
    });
  } catch (e) {
    if (options.signal?.aborted) throw e;
    throw new ApiError(failure(), 503);
  }
  // A successful write without its receipt is still unknown, never a made-up success.
  // Preserve HTTP auth/permission errors even if a proxy stripped the response body.
  let data: any;
  try {
    const body = await res.text();
    if (!body.trim()) {
      if (res.ok && [204, 205].includes(res.status)) return undefined as T;
      throw new Error("empty response");
    }
    data = JSON.parse(body);
  } catch {
    throw new ApiError(failure(), res.ok ? 502 : res.status);
  }
  if (!res.ok) {
    const message =
      typeof data?.message === "string"
        ? data.message
        : Array.isArray(data?.message) &&
            data.message.every((m: unknown) => typeof m === "string")
          ? data.message.join("；")
          : failure();
    throw new ApiError(message.slice(0, 1000), res.status);
  }
  return data as T;
}
export function mutation<T = any>(
  path: string,
  body: unknown,
  method = "POST",
) {
  return api<T>(path, { method, body: JSON.stringify(body) });
}
