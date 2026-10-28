import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
export class JsonRpcProcess {
  private child?: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private closed = false;
  private closing?: Promise<void>;
  private waiters = new Set<{
    accept: (method: string, params: any) => boolean;
    resolve: (params: any) => void;
    reject: (error: Error) => void;
  }>();
  private pending = new Map<
    string,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  onNotification: (method: string, params: any) => void = () => {};
  onRequest: (method: string, params: any) => Promise<any> = async () => {
    throw new Error("Unsupported runtime request");
  };
  constructor(
    private command: string[],
    private cwd: string,
    private env: NodeJS.ProcessEnv = {},
    private timeoutMs = 120000,
  ) {}
  start() {
    if (this.closed) throw new Error("Runtime connection closed.");
    if (this.child) return;
    const executable = this.command[0];
    if (!executable) throw new Error("Runtime command is empty");
    const child = spawn(executable, this.command.slice(1), {
      cwd: this.cwd,
      env: {
        PATH: process.env.PATH,
        HOME: this.cwd,
        TMPDIR: this.cwd,
        ...this.env,
      },
      stdio: "pipe",
    });
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (!m || typeof m !== "object" || m.jsonrpc !== "2.0") return;
      if (m.method && m.id !== undefined) {
        void this.onRequest(m.method, m.params)
          .then((result) => this.write({ jsonrpc: "2.0", id: m.id, result }))
          .catch(() =>
            this.write({
              jsonrpc: "2.0",
              id: m.id,
              error: {
                code: -32601,
                message: "Host request unavailable or denied",
              },
            }),
          );
      } else if (m.id !== undefined) {
        const p = this.pending.get(String(m.id));
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(String(m.id));
          m.error
            ? p.reject(
                new Error(
                  "Runtime RPC failed (" +
                    (typeof m.error.code === "number"
                      ? m.error.code
                      : "unknown") +
                    ").",
                ),
              )
            : p.resolve(m.result);
        }
      } else if (m.method) {
        for (const waiter of [...this.waiters]) {
          if (waiter.accept(m.method, m.params)) waiter.resolve(m.params);
        }
        this.onNotification(m.method, m.params);
      }
    });
    // Runtime stderr can contain secrets: never echo it into a product event or HTTP response.
    child.stderr.on("data", () => {});
    child.on("error", () =>
      this.fail(new Error("Runtime process could not start.")),
    );
    child.on("exit", (code) =>
      this.fail(new Error("Runtime exited (" + code + ").")),
    );
  }
  private write(message: any) {
    if (this.child && !this.child.stdin.destroyed)
      this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  request<T = any>(method: string, params: any = {}): Promise<T> {
    this.start();
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error("Runtime connection closed."));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Runtime request timed out: " + method));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }
  notify(method: string, params: any = {}) {
    this.start();
    this.write({ jsonrpc: "2.0", method, params });
  }
  waitForNotification(
    method: string,
    predicate: (params: any) => boolean,
    signal: AbortSignal,
    timeoutMs = this.timeoutMs,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error("Runtime connection closed."));
        return;
      }
      if (signal.aborted) {
        reject(new Error("Runtime wait cancelled."));
        return;
      }
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.waiters.delete(waiter);
      };
      const waiter = {
        accept: (name: string, params: any) =>
          name === method && predicate(params),
        resolve: (params: any) => {
          cleanup();
          resolve(params);
        },
        reject: (error: Error) => {
          cleanup();
          reject(error);
        },
      };
      const abort = () => waiter.reject(new Error("Runtime wait cancelled."));
      const timer = setTimeout(
        () => waiter.reject(new Error("Runtime notification timed out.")),
        timeoutMs,
      );
      signal.addEventListener("abort", abort, { once: true });
      this.waiters.add(waiter);
    });
  }
  private fail(e: Error) {
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
    for (const waiter of [...this.waiters]) waiter.reject(e);
  }
  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      this.closing = this.terminate();
    }
    return this.closing;
  }
  private async terminate() {
    const c = this.child;
    this.child = undefined;
    this.fail(new Error("Runtime connection closed."));
    if (!c) return;
    c.stdin.end();
    if (c.exitCode !== null || c.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      let finalTimer: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        c.kill("SIGKILL");
        finalTimer = setTimeout(
          () =>
            reject(new Error("Runtime termination could not be confirmed.")),
          1500,
        );
      }, 1500);
      c.once("exit", () => {
        clearTimeout(timer);
        clearTimeout(finalTimer);
        resolve();
      });
      c.kill("SIGTERM");
    });
  }
}
export function runtimeCommand(raw?: string): string[] | undefined {
  if (!raw) return;
  const c = JSON.parse(raw);
  if (
    !Array.isArray(c) ||
    !c.length ||
    !c.every((x) => typeof x === "string" && x.length)
  )
    throw new Error("Runtime command must be a nonempty JSON argv array.");
  return c;
}
