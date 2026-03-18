import type Database from "better-sqlite3";

export interface ImportRecord {
  filePath: string;
  importedName: string;
  sourceModule: string;
  resolvedPath: string | null;
  isDefault: boolean;
  isNamespace: boolean;
}

export class ImportStore {
  constructor(private readonly db: Database.Database) {}

  initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS imports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        imported_name TEXT NOT NULL,
        source_module TEXT NOT NULL,
        resolved_path TEXT,
        is_default INTEGER NOT NULL DEFAULT 0,
        is_namespace INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_imports_name ON imports(imported_name);
      CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(file_path);
      CREATE INDEX IF NOT EXISTS idx_imports_resolved ON imports(resolved_path);
      CREATE INDEX IF NOT EXISTS idx_imports_name_file ON imports(imported_name, file_path);
    `);
  }

  upsertImports(imports: ImportRecord[]): void {
    if (imports.length === 0) return;
    const filePaths = [...new Set(imports.map((i) => i.filePath))];
    const del = this.db.prepare(`DELETE FROM imports WHERE file_path = ?`);
    const ins = this.db.prepare(
      `INSERT INTO imports (file_path, imported_name, source_module, resolved_path, is_default, is_namespace) VALUES (?, ?, ?, ?, ?, ?)`
    );
    this.db.transaction(() => {
      for (const fp of filePaths) del.run(fp);
      for (const imp of imports) {
        ins.run(
          imp.filePath,
          imp.importedName,
          imp.sourceModule,
          imp.resolvedPath,
          imp.isDefault ? 1 : 0,
          imp.isNamespace ? 1 : 0
        );
      }
    })();
  }

  removeImportsForFile(filePath: string): void {
    this.db.prepare(`DELETE FROM imports WHERE file_path = ?`).run(filePath);
  }

  getImportsForFile(filePath: string): ImportRecord[] {
    const rows = this.db
      .prepare(
        `SELECT file_path, imported_name, source_module, resolved_path, is_default, is_namespace
         FROM imports WHERE file_path = ?`
      )
      .all(filePath) as Array<{
      file_path: string;
      imported_name: string;
      source_module: string;
      resolved_path: string | null;
      is_default: number;
      is_namespace: number;
    }>;

    return rows.map((r) => ({
      filePath: r.file_path,
      importedName: r.imported_name,
      sourceModule: r.source_module,
      resolvedPath: r.resolved_path,
      isDefault: r.is_default === 1,
      isNamespace: r.is_namespace === 1,
    }));
  }

  findImporterFiles(resolvedPath: string): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT file_path FROM imports WHERE resolved_path = ?`)
      .all(resolvedPath) as Array<{ file_path: string }>;
    return rows.map((r) => r.file_path);
  }

  findImportByName(importedName: string, filePath?: string): ImportRecord[] {
    let rows: Array<{
      file_path: string;
      imported_name: string;
      source_module: string;
      resolved_path: string | null;
      is_default: number;
      is_namespace: number;
    }>;

    if (filePath) {
      rows = this.db
        .prepare(
          `SELECT file_path, imported_name, source_module, resolved_path, is_default, is_namespace
           FROM imports WHERE imported_name = ? AND file_path = ?`
        )
        .all(importedName, filePath) as typeof rows;
    } else {
      rows = this.db
        .prepare(
          `SELECT file_path, imported_name, source_module, resolved_path, is_default, is_namespace
           FROM imports WHERE imported_name = ?`
        )
        .all(importedName) as typeof rows;
    }

    return rows.map((r) => ({
      filePath: r.file_path,
      importedName: r.imported_name,
      sourceModule: r.source_module,
      resolvedPath: r.resolved_path,
      isDefault: r.is_default === 1,
      isNamespace: r.is_namespace === 1,
    }));
  }
}
