import type Database from "better-sqlite3";

export interface CommunityRecord {
  id: string;
  nodeCount: number;
  cohesion: number;
  label: string | null;
  computedAt: string;
}

export interface CommunityMembership {
  chunkId: string;
  communityId: string;
}

export interface SurpriseRecord {
  sourceChunkId: string;
  targetChunkId: string;
  score: number;
  reasons: string[];
  relation: string | null;
  computedAt: string;
}

export interface GodNodeRecord {
  chunkId: string;
  name: string;
  filePath: string;
  degree: number;
  communityId: string | null;
}

export interface SuggestedQuestion {
  type: string;
  question: string | null;
  why: string;
}

export interface TopologySnapshot {
  communities: CommunityRecord[];
  memberships: CommunityMembership[];
  surprises: SurpriseRecord[];
  godNodes: GodNodeRecord[];
  questions: SuggestedQuestion[];
  computedAt: string;
}

export class CommunityStore {
  private getCommunityForChunkStmt!: Database.Statement;
  private getCommunityStmt!: Database.Statement;
  private getAllCommunitiesStmt!: Database.Statement;
  private getTopSurprisesStmt!: Database.Statement;
  private getGodNodesStmt!: Database.Statement;
  private getQuestionsStmt!: Database.Statement;
  private clearCommunitiesStmt!: Database.Statement;
  private clearMembershipsStmt!: Database.Statement;
  private clearSurprisesStmt!: Database.Statement;
  private clearGodNodesStmt!: Database.Statement;
  private clearQuestionsStmt!: Database.Statement;
  private insertCommunityStmt!: Database.Statement;
  private insertMembershipStmt!: Database.Statement;
  private insertSurpriseStmt!: Database.Statement;
  private insertGodNodeStmt!: Database.Statement;
  private insertQuestionStmt!: Database.Statement;

  constructor(private readonly db: Database.Database) {}

  initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS communities (
        id TEXT PRIMARY KEY,
        node_count INTEGER NOT NULL,
        cohesion REAL NOT NULL,
        label TEXT,
        computed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS community_memberships (
        chunk_id TEXT NOT NULL,
        community_id TEXT NOT NULL,
        PRIMARY KEY (chunk_id, community_id)
      );

      CREATE TABLE IF NOT EXISTS community_surprises (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_chunk_id TEXT NOT NULL,
        target_chunk_id TEXT NOT NULL,
        score INTEGER NOT NULL,
        reasons TEXT NOT NULL,
        relation TEXT,
        computed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS community_god_nodes (
        chunk_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        degree INTEGER NOT NULL,
        community_id TEXT
      );

      CREATE TABLE IF NOT EXISTS community_questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        question TEXT,
        why TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_membership_chunk ON community_memberships(chunk_id);
      CREATE INDEX IF NOT EXISTS idx_membership_community ON community_memberships(community_id);
      CREATE INDEX IF NOT EXISTS idx_surprises_score ON community_surprises(score DESC);
    `);

    this.getCommunityForChunkStmt = this.db.prepare(
      `SELECT community_id FROM community_memberships WHERE chunk_id = ?`
    );
    this.getCommunityStmt = this.db.prepare(
      `SELECT id, node_count, cohesion, label, computed_at FROM communities WHERE id = ?`
    );
    this.getAllCommunitiesStmt = this.db.prepare(
      `SELECT id, node_count, cohesion, label, computed_at FROM communities ORDER BY node_count DESC LIMIT ?`
    );
    this.getTopSurprisesStmt = this.db.prepare(
      `SELECT source_chunk_id, target_chunk_id, score, reasons, relation, computed_at
       FROM community_surprises ORDER BY score DESC LIMIT ?`
    );
    this.getGodNodesStmt = this.db.prepare(
      `SELECT chunk_id, name, file_path, degree, community_id
       FROM community_god_nodes ORDER BY degree DESC LIMIT ?`
    );
    this.getQuestionsStmt = this.db.prepare(
      `SELECT type, question, why FROM community_questions LIMIT ?`
    );
    this.clearCommunitiesStmt = this.db.prepare(`DELETE FROM communities`);
    this.clearMembershipsStmt = this.db.prepare(`DELETE FROM community_memberships`);
    this.clearSurprisesStmt = this.db.prepare(`DELETE FROM community_surprises`);
    this.clearGodNodesStmt = this.db.prepare(`DELETE FROM community_god_nodes`);
    this.clearQuestionsStmt = this.db.prepare(`DELETE FROM community_questions`);
    this.insertCommunityStmt = this.db.prepare(
      `INSERT INTO communities (id, node_count, cohesion, label, computed_at) VALUES (?, ?, ?, ?, ?)`
    );
    this.insertMembershipStmt = this.db.prepare(
      `INSERT INTO community_memberships (chunk_id, community_id) VALUES (?, ?)`
    );
    this.insertSurpriseStmt = this.db.prepare(
      `INSERT INTO community_surprises (source_chunk_id, target_chunk_id, score, reasons, relation, computed_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    this.insertGodNodeStmt = this.db.prepare(
      `INSERT INTO community_god_nodes (chunk_id, name, file_path, degree, community_id) VALUES (?, ?, ?, ?, ?)`
    );
    this.insertQuestionStmt = this.db.prepare(
      `INSERT INTO community_questions (type, question, why) VALUES (?, ?, ?)`
    );
  }

  replaceTopology(snapshot: TopologySnapshot): void {
    this.db.transaction(() => {
      this.clearCommunitiesStmt.run();
      this.clearMembershipsStmt.run();
      this.clearSurprisesStmt.run();
      this.clearGodNodesStmt.run();
      this.clearQuestionsStmt.run();

      for (const c of snapshot.communities) {
        this.insertCommunityStmt.run(c.id, c.nodeCount, c.cohesion, c.label, c.computedAt);
      }
      for (const m of snapshot.memberships) {
        this.insertMembershipStmt.run(m.chunkId, m.communityId);
      }
      for (const s of snapshot.surprises) {
        this.insertSurpriseStmt.run(
          s.sourceChunkId, s.targetChunkId, s.score,
          JSON.stringify(s.reasons), s.relation, s.computedAt
        );
      }
      for (const g of snapshot.godNodes) {
        this.insertGodNodeStmt.run(g.chunkId, g.name, g.filePath, g.degree, g.communityId);
      }
      for (const q of snapshot.questions) {
        this.insertQuestionStmt.run(q.type, q.question, q.why);
      }
    })();
  }

  getCommunityForChunk(chunkId: string): string | undefined {
    const row = this.getCommunityForChunkStmt.get(chunkId) as { community_id: string } | undefined;
    return row?.community_id;
  }

  getCommunityInfo(communityId: string): CommunityRecord | undefined {
    const row = this.getCommunityStmt.get(communityId) as {
      id: string; node_count: number; cohesion: number; label: string | null; computed_at: string;
    } | undefined;
    if (!row) return undefined;
    return { id: row.id, nodeCount: row.node_count, cohesion: row.cohesion, label: row.label, computedAt: row.computed_at };
  }

  getAllCommunities(limit = 50): CommunityRecord[] {
    const rows = this.getAllCommunitiesStmt.all(limit) as Array<{
      id: string; node_count: number; cohesion: number; label: string | null; computed_at: string;
    }>;
    return rows.map(r => ({
      id: r.id, nodeCount: r.node_count, cohesion: r.cohesion, label: r.label, computedAt: r.computed_at,
    }));
  }

  getTopSurprises(limit = 10): SurpriseRecord[] {
    const rows = this.getTopSurprisesStmt.all(limit) as Array<{
      source_chunk_id: string; target_chunk_id: string; score: number;
      reasons: string; relation: string | null; computed_at: string;
    }>;
    return rows.map(r => ({
      sourceChunkId: r.source_chunk_id,
      targetChunkId: r.target_chunk_id,
      score: r.score,
      reasons: (() => { try { return JSON.parse(r.reasons) as string[]; } catch { return []; } })(),
      relation: r.relation,
      computedAt: r.computed_at,
    }));
  }

  getGodNodes(limit = 10): GodNodeRecord[] {
    const rows = this.getGodNodesStmt.all(limit) as Array<{
      chunk_id: string; name: string; file_path: string; degree: number; community_id: string | null;
    }>;
    return rows.map(r => ({
      chunkId: r.chunk_id, name: r.name, filePath: r.file_path, degree: r.degree, communityId: r.community_id,
    }));
  }

  getSuggestedQuestions(limit = 7): SuggestedQuestion[] {
    const rows = this.getQuestionsStmt.all(limit) as Array<{
      type: string; question: string | null; why: string;
    }>;
    return rows.map(r => ({ type: r.type, question: r.question, why: r.why }));
  }

  clearAll(): void {
    this.db.transaction(() => {
      this.clearCommunitiesStmt.run();
      this.clearMembershipsStmt.run();
      this.clearSurprisesStmt.run();
      this.clearGodNodesStmt.run();
      this.clearQuestionsStmt.run();
    })();
  }
}
