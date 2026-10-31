import { BadRequestException } from "@nestjs/common";
export const CHUNK_INDEX_VERSION = "text-chunks-v1";
export const MAX_INDEX_TEXT = 180000;
export interface TextChunk {
  ordinal: number;
  start: number;
  end: number;
  content: string;
}
/** UTF-16 offsets slice the exact source text; never split a surrogate pair. */
export function textChunks(
  text: string,
  max = 2000,
  overlap = 200,
): TextChunk[] {
  if (
    !text.trim() ||
    text.length > MAX_INDEX_TEXT ||
    max < 200 ||
    overlap < 0 ||
    overlap >= max / 2
  )
    throw new BadRequestException(
      "索引文本为空、超过十八万字符或分块参数无效。",
    );
  const result: TextChunk[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + max, text.length);
    if (end < text.length) {
      const paragraph = text.lastIndexOf("\n", end - 1);
      if (paragraph > start + max / 2) end = paragraph + 1;
      if (
        /[\uD800-\uDBFF]/.test(text[end - 1] ?? "") &&
        /[\uDC00-\uDFFF]/.test(text[end] ?? "")
      )
        end--;
    }
    result.push({
      ordinal: result.length,
      start,
      end,
      content: text.slice(start, end),
    });
    if (end === text.length) break;
    start = end - overlap;
    if (
      /[\uDC00-\uDFFF]/.test(text[start] ?? "") &&
      /[\uD800-\uDBFF]/.test(text[start - 1] ?? "")
    )
      start--;
  }
  return result;
}

/** Bounded lexical fallback, with exact positions; callers must label excerpts as partial. */
export function selectTextChunks(text: string, query: string, count = 6) {
  const chunks = textChunks(text),
    lower = query.toLowerCase(),
    terms = new Set(lower.match(/[a-z0-9]{2,}/g) ?? []);
  for (const group of lower.match(/\p{Script=Han}{2,}/gu) ?? [])
    for (let i = 0; i < group.length - 1; i++) terms.add(group.slice(i, i + 2));
  const limited = [...terms].slice(0, 100),
    ranked = chunks
      .map((chunk) => ({
        ...chunk,
        score: limited.reduce(
          (score, term) =>
            score +
            (chunk.content.toLowerCase().includes(term) ? term.length : 0),
          0,
        ),
      }))
      .sort((a, b) => b.score - a.score || a.ordinal - b.ordinal);
  return {
    partial: chunks.length > count,
    matched: ranked.some((chunk) => chunk.score > 0),
    totalChunks: chunks.length,
    chunks: ranked
      .slice(0, Math.max(1, Math.min(count, 10)))
      .sort((a, b) => a.start - b.start),
  };
}
