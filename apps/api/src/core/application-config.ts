/** Explicit deployment switches. Development keeps loopback binding and the Vite server. */
export function applicationConfig(env: NodeJS.ProcessEnv = process.env) {
  let origin: URL;
  try {
    origin = new URL(env.APP_ORIGIN ?? "");
  } catch {
    throw new Error("APP_ORIGIN must be a canonical HTTP(S) origin.");
  }
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/" ||
    origin.origin !== env.APP_ORIGIN
  )
    throw new Error(
      "APP_ORIGIN must be a canonical HTTP(S) origin without a path.",
    );
  if (
    env.NODE_ENV === "production" &&
    origin.protocol !== "https:" &&
    !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)
  )
    throw new Error(
      "Production APP_ORIGIN requires HTTPS except for local loopback.",
    );
  const host = env.API_HOST ?? "127.0.0.1",
    port = Number(env.API_PORT ?? 3100);
  if (!["127.0.0.1", "0.0.0.0", "::1", "::"].includes(host))
    throw new Error("API_HOST must be an explicit supported bind address.");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("API_PORT must be between 1 and 65535.");
  if (env.SERVE_WEB && !["true", "false"].includes(env.SERVE_WEB))
    throw new Error("SERVE_WEB must be true or false.");
  return {
    host,
    port,
    secureCookie: origin.protocol === "https:",
    serveWeb: env.SERVE_WEB === "true",
  };
}
