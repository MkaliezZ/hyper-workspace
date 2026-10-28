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
  const res = await fetch("/api" + path, {
    credentials: "include",
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const data = await res.json();
  if (!res.ok)
    throw new ApiError(data.message ?? "操作未完成，请稍后重试。", res.status);
  return data;
}
export function mutation<T = any>(
  path: string,
  body: unknown,
  method = "POST",
) {
  return api<T>(path, { method, body: JSON.stringify(body) });
}
