import { BadRequestException } from "@nestjs/common";
import type { ProviderUsage } from "./model-usage.js";
export class SpendLimitError extends BadRequestException {}
export const micros = (value: string) =>
  BigInt(value.split(".")[0]!) * 1000000n +
  BigInt((value.split(".")[1] ?? "").padEnd(6, "0"));
export const picos = (value: string) =>
  BigInt(value.split(".")[0]!) * 1000000000000n +
  BigInt((value.split(".")[1] ?? "").padEnd(12, "0"));
export function units(value: bigint | string, scale = 12): string {
  const n = BigInt(value),
    negative = n < 0n,
    raw = (negative ? -n : n).toString().padStart(scale + 1, "0");
  const tail = raw.slice(-scale).replace(/0+$/, "");
  return (
    (negative ? "-" : "") + raw.slice(0, -scale) + (tail ? "." + tail : "")
  );
}
/** Rates are micro-currency per million tokens: multiplying tokens produces pico-currency exactly. */
export function estimateUsage(
  price: any,
  usage: ProviderUsage,
  transport: string,
) {
  if (
    usage.status !== "reported" ||
    transport !== "completed" ||
    usage.inputTokens === null
  )
    return null;
  const input = BigInt(usage.inputTokens),
    read =
      usage.cacheReadTokens === null ? null : BigInt(usage.cacheReadTokens),
    write =
      usage.cacheWriteTokens === null ? null : BigInt(usage.cacheWriteTokens);
  const base = BigInt(price.input_rate),
    readRate = BigInt(price.cache_read_rate),
    writeRate = BigInt(price.cache_write_rate),
    outputRate = BigInt(price.output_rate);
  const remaining = input - (read ?? 0n) - (write ?? 0n);
  if (remaining < 0n) return null;
  const possibilities = [
    base,
    ...(read === null ? [readRate] : []),
    ...(write === null ? [writeRate] : []),
  ];
  const upper = possibilities.reduce((a, b) => (a > b ? a : b)),
    lower = possibilities.reduce((a, b) => (a < b ? a : b));
  return {
    amount:
      remaining * upper +
      (read ?? 0n) * readRate +
      (write ?? 0n) * writeRate +
      BigInt(usage.outputTokens ?? 0) * outputRate,
    upper: remaining > 0n && upper !== lower,
  };
}
