export interface CodeChunk {
  id: string;
  filePath: string;
  name: string;
  kind: string;
  content: string;
  startLine: number;
  endLine: number;
  parentName?: string;
  docstring?: string;
  language: string;
  isExported?: boolean;
}
