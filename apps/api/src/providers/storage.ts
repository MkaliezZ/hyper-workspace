import type { SourceFile } from "@hyper/contracts";
export interface ExtractedFile {
  text: string;
  parserVersion: string;
  format: string;
  sections: { locator: string; text: string }[];
  warnings: string[];
}
export interface StorageProvider {
  list(path: string[]): Promise<SourceFile[]>;
  stat(path: string[]): Promise<SourceFile>;
  read(file: SourceFile): Promise<string>;
  extract(file: SourceFile): Promise<ExtractedFile>;
  assertReadable(file: SourceFile): Promise<void>;
}
