import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";

export const DOCUMENT_PARSER_VERSION = "document-text-v1";
export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
export const DocumentFormat = z.enum(["pdf", "docx", "xlsx", "pptx"]);
export type DocumentFormat = z.infer<typeof DocumentFormat>;
const Result = z
  .object({
    parserVersion: z.literal(DOCUMENT_PARSER_VERSION),
    format: DocumentFormat,
    text: z.string().min(1).max(18000),
    sections: z
      .array(
        z
          .object({
            locator: z.string().min(1).max(1000),
            text: z.string().min(1).max(18000),
          })
          .strict(),
      )
      .min(1)
      .max(2000),
    warnings: z.array(z.string().max(2000)).max(100),
  })
  .strict();
export type ExtractedDocument = z.infer<typeof Result>;
interface HostConfig {
  python: string;
  script: string;
  timeoutMs: number;
  stdoutLimit: number;
  stderrLimit: number;
}
const defaults: HostConfig = {
  python: fileURLToPath(
    new URL("../../../../.runtime/documents/bin/python", import.meta.url),
  ),
  script: fileURLToPath(
    new URL("../../../../runtime/documents/extract.py", import.meta.url),
  ),
  timeoutMs: 20000,
  stdoutLimit: 512 * 1024,
  stderrLimit: 16 * 1024,
};
let active = 0;
/** Trusted operator configuration only. Callers select bytes/format, never executable paths. */
export class DocumentExtractor {
  constructor(private readonly config: HostConfig = defaults) {}
  async extract(
    bytes: Buffer,
    rawFormat: DocumentFormat,
    signal?: AbortSignal,
  ): Promise<ExtractedDocument> {
    const format = DocumentFormat.parse(rawFormat);
    if (!bytes.length || bytes.length > MAX_DOCUMENT_BYTES)
      throw new BadRequestException("文档为空或超过 8 MiB。");
    if (signal?.aborted) throw new BadRequestException("文档解析已取消。");
    if (active >= 2)
      throw new ServiceUnavailableException("文档解析繁忙，请稍后重试。");
    active++;
    try {
      return await new Promise<ExtractedDocument>((resolve, reject) => {
        const child = spawn(this.config.python, [this.config.script, format], {
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
          env: {
            PYTHONDONTWRITEBYTECODE: "1",
            PYTHONNOUSERSITE: "1",
            PYTHONUTF8: "1",
          },
        });
        const chunks: Buffer[] = [];
        let stdout = 0,
          stderr = 0,
          failure: Error | undefined;
        const stop = (reason: Error) => {
          failure ??= reason;
          child.kill("SIGKILL");
        };
        const onAbort = () => stop(new BadRequestException("文档解析已取消。"));
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
        const timer = setTimeout(
          () =>
            stop(new BadRequestException("文档解析超时，请使用更小的文件。")),
          this.config.timeoutMs,
        );
        child.on("error", () => {
          failure ??= new ServiceUnavailableException(
            "文档解析器尚未安装或无法启动。",
          );
        });
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.length;
          if (stdout > this.config.stdoutLimit)
            stop(new BadRequestException("文档解析结果超过限额。"));
          else chunks.push(chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          // Never retain or log parser diagnostics, which may contain document fragments.
          stderr += chunk.length;
          if (stderr > this.config.stderrLimit)
            stop(new BadRequestException("文档无法在限额内可靠解析。"));
        });
        child.stdin.on("error", () => {}); // EPIPE is resolved by the process's exit state.
        child.on("close", (code) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          if (failure) return reject(failure);
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (
              code === 2 &&
              typeof result.error === "string" &&
              result.error.length <= 200
            )
              return reject(new BadRequestException(result.error));
            if (code !== 0) throw new Error("parser exit");
            const parsed = Result.parse(result);
            if (
              parsed.format !== format ||
              parsed.text !==
                parsed.sections
                  .map((s) => `[${s.locator}]\n${s.text}`)
                  .join("\n\n")
            )
              throw new Error("inconsistent parser output");
            resolve(parsed);
          } catch {
            reject(
              new BadRequestException("文档损坏或解析结果不完整，未保存。"),
            );
          }
        });
        child.stdin.end(bytes);
      });
    } finally {
      // Release capacity only after close, including cancellation and timeout.
      active--;
    }
  }
}
