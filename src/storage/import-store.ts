import type Database from "better-sqlite3";
import type { Statement } from "better-sqlite3";

export interface ImportRecord {
  filePath: string;
  importedName: string;
  sourceModule: string;
  resolvedPath: string | null;
  isDefault: boolean;
  isNamespace: boolean;
}

export class ImportStore {
  private deleteByFileStmt!: Statement;
  private insertStmt!: Statement;
  private getImportsStmt!: Statement;
  private findImporterFilesStmt!: Statement;
  private findByNameStmt!: Statement;
  private findByNameWithFileStmt!: Statement;

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

    // Deduplicate before creating unique index (handles databases from before the index existed)
    // Only run the expensive DELETE if the unique index doesn't exist yet
    const indexExists = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_imports_unique'`)
      .get();
    if (!indexExists) {
      this.db.exec(`
        DELETE FROM imports WHERE id NOT IN (
          SELECT MIN(id) FROM imports
          GROUP BY file_path, imported_name, source_module, is_default, is_namespace
        );
      `);
    }
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_imports_unique ON imports(file_path, imported_name, source_module, is_default, is_namespace);`);

    // Cache prepared statements
    this.deleteByFileStmt = this.db.prepare(`DELETE FROM imports WHERE file_path = ?`);
    this.insertStmt = this.db.prepare(
      `INSERT OR IGNORE INTO imports (file_path, imported_name, source_module, resolved_path, is_default, is_namespace) VALUES (?, ?, ?, ?, ?, ?)`
    );
    this.getImportsStmt = this.db.prepare(
      `SELECT file_path, imported_name, source_module, resolved_path, is_default, is_namespace
       FROM imports WHERE file_path = ?`
    );
    this.findImporterFilesStmt = this.db.prepare(`SELECT DISTINCT file_path FROM imports WHERE resolved_path = ?`);
    this.findByNameStmt = this.db.prepare(
      `SELECT file_path, imported_name, source_module, resolved_path, is_default, is_namespace
       FROM imports WHERE imported_name = ?`
    );
    this.findByNameWithFileStmt = this.db.prepare(
      `SELECT file_path, imported_name, source_module, resolved_path, is_default, is_namespace
       FROM imports WHERE imported_name = ? AND file_path = ?`
    );
  }

  upsertImports(imports: ImportRecord[]): void {
    if (imports.length === 0) return;
    const filePaths = [...new Set(imports.map((i) => i.filePath))];
    this.db.transaction(() => {
      for (const fp of filePaths) this.deleteByFileStmt.run(fp);
      for (const imp of imports) {
        this.insertStmt.run(
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
    this.deleteByFileStmt.run(filePath);
  }

  getImportsForFile(filePath: string): ImportRecord[] {
    const rows = this.getImportsStmt.all(filePath) as Array<{
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
    const rows = this.findImporterFilesStmt.all(resolvedPath) as Array<{ file_path: string }>;
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
      rows = this.findByNameWithFileStmt.all(importedName, filePath) as typeof rows;
    } else {
      rows = this.findByNameStmt.all(importedName) as typeof rows;
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
