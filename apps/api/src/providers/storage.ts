import type { SourceFile } from "@hyper/contracts";
export interface StorageProvider {
  list(path: string[]): Promise<SourceFile[]>;
  stat(path: string[]): Promise<SourceFile>;
  read(file: SourceFile): Promise<string>;
  assertReadable(file: SourceFile): Promise<void>;
}
