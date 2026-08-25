import { DurableObject } from "cloudflare:workers";
import {
  ALLOWED_TRANSITIONS,
  type CandidateSnapshot,
  type CasResult,
  type ContentEntry,
  type InitializeInput,
  type TransitionInput,
} from "./contracts";

interface CandidateRow extends Record<string, SqlStorageValue> {
  candidate_id: string;
  status: CandidateSnapshot["status"];
  record_revision: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  record_json: string;
  updated_at: number;
}

interface IdempotencyRow extends Record<string, SqlStorageValue> {
  response_json: string;
}

interface ContentRow extends Record<string, SqlStorageValue> {
  hash: string;
  mediaType: string;
  byteLength: number;
  createdAt: number;
  content: string;
}

export class CandidateCasObject extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS candidate (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          candidate_id TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL,
          record_revision INTEGER NOT NULL CHECK (record_revision >= 1),
          lease_owner TEXT,
          lease_expires_at INTEGER,
          record_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS transitions (
          record_revision INTEGER PRIMARY KEY,
          from_status TEXT,
          to_status TEXT NOT NULL,
          changed_at INTEGER NOT NULL,
          actor_id TEXT NOT NULL,
          reason TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE
        );
        CREATE TABLE IF NOT EXISTS idempotency (
          idempotency_key TEXT PRIMARY KEY,
          response_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS content (
          hash TEXT PRIMARY KEY,
          media_type TEXT NOT NULL,
          byte_length INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          content TEXT NOT NULL
        );
      `);
    });
  }

  initialize(input: InitializeInput): CasResult {
    const replay = this.replay(input.idempotencyKey);
    if (replay) return replay;

    return this.ctx.storage.transactionSync(() => {
      if (this.readRow()) return { applied: false, replayed: false, conflict: "already_initialized" };
      const now = Date.now();
      const snapshot: CandidateSnapshot = {
        candidateId: input.candidateId,
        status: "discovered",
        recordRevision: 1,
        leaseOwner: null,
        leaseExpiresAt: null,
        recordJson: input.recordJson,
        updatedAt: now,
      };
      this.ctx.storage.sql.exec(
        "INSERT INTO candidate VALUES (1, ?, ?, 1, NULL, NULL, ?, ?)",
        input.candidateId,
        snapshot.status,
        input.recordJson,
        now,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO transitions VALUES (1, NULL, ?, ?, ?, ?, ?)",
        snapshot.status,
        now,
        input.actorId,
        "Candidate initialized",
        input.idempotencyKey,
      );
      const result: CasResult = { applied: true, replayed: false, snapshot };
      this.remember(input.idempotencyKey, result, now);
      return result;
    });
  }

  transition(input: TransitionInput): CasResult {
    const replay = this.replay(input.idempotencyKey);
    if (replay) return replay;

    return this.ctx.storage.transactionSync(() => {
      const row = this.readRow();
      if (!row) return { applied: false, replayed: false, conflict: "not_initialized" };
      if (row.candidate_id !== input.candidateId || row.record_revision !== input.expectedRevision) {
        return { applied: false, replayed: false, conflict: "revision", snapshot: this.toSnapshot(row) };
      }
      if (row.status !== input.expectedStatus) {
        return { applied: false, replayed: false, conflict: "status", snapshot: this.toSnapshot(row) };
      }
      if (!ALLOWED_TRANSITIONS[row.status].includes(input.toStatus)) {
        return { applied: false, replayed: false, conflict: "transition", snapshot: this.toSnapshot(row) };
      }

      const now = Date.now();
      const existingLeaseActive = row.lease_expires_at !== null && row.lease_expires_at > now;
      const isLeasedState = row.status === "claimed" || row.status === "testing";
      if (isLeasedState) {
        if (!existingLeaseActive) {
          if (input.toStatus !== "quarantined") {
            return { applied: false, replayed: false, conflict: "lease", snapshot: this.toSnapshot(row) };
          }
        } else if (!input.leaseOwner || input.leaseOwner !== row.lease_owner) {
          return { applied: false, replayed: false, conflict: "lease", snapshot: this.toSnapshot(row) };
        }
      }
      if (input.toStatus === "claimed" && existingLeaseActive) {
        return { applied: false, replayed: false, conflict: "lease", snapshot: this.toSnapshot(row) };
      }
      if (input.toStatus === "claimed" && (!input.leaseOwner || !input.leaseDurationSeconds)) {
        return { applied: false, replayed: false, conflict: "lease", snapshot: this.toSnapshot(row) };
      }

      const revision = row.record_revision + 1;
      const leaseOwner = input.toStatus === "claimed"
        ? input.leaseOwner!
        : input.toStatus === "testing"
          ? row.lease_owner
          : null;
      const leaseExpiresAt = input.toStatus === "claimed"
        ? now + input.leaseDurationSeconds! * 1000
        : input.toStatus === "testing"
          ? row.lease_expires_at
          : null;
      const recordJson = input.recordJson ?? row.record_json;
      this.ctx.storage.sql.exec(
        `UPDATE candidate SET status = ?, record_revision = ?, lease_owner = ?,
         lease_expires_at = ?, record_json = ?, updated_at = ? WHERE singleton = 1`,
        input.toStatus,
        revision,
        leaseOwner,
        leaseExpiresAt,
        recordJson,
        now,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO transitions VALUES (?, ?, ?, ?, ?, ?, ?)",
        revision,
        row.status,
        input.toStatus,
        now,
        input.actorId,
        input.reason,
        input.idempotencyKey,
      );
      const snapshot = this.getSnapshot()!;
      const result: CasResult = { applied: true, replayed: false, snapshot };
      this.remember(input.idempotencyKey, result, now);
      return result;
    });
  }

  getSnapshot(): CandidateSnapshot | null {
    const row = this.readRow();
    return row ? this.toSnapshot(row) : null;
  }

  async putContent(content: string, mediaType: string): Promise<ContentEntry> {
    const bytes = new TextEncoder().encode(content);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const createdAt = Date.now();
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO content VALUES (?, ?, ?, ?, ?)",
      hash,
      mediaType,
      bytes.byteLength,
      createdAt,
      content,
    );
    return this.getContent(hash)!;
  }

  getContent(hash: string): ContentEntry | null {
    const row = this.ctx.storage.sql.exec<ContentRow>(
      `SELECT hash, media_type AS mediaType, byte_length AS byteLength,
       created_at AS createdAt, content FROM content WHERE hash = ?`,
      hash,
    ).toArray()[0];
    return row ? { ...row } : null;
  }

  listContent(limit = 100): Omit<ContentEntry, "content">[] {
    const bounded = Math.max(1, Math.min(Math.trunc(limit), 100));
    return this.ctx.storage.sql.exec<Omit<ContentEntry, "content">>(
      `SELECT hash, media_type AS mediaType, byte_length AS byteLength,
       created_at AS createdAt FROM content ORDER BY created_at DESC LIMIT ?`,
      bounded,
    ).toArray();
  }

  private readRow(): CandidateRow | null {
    return this.ctx.storage.sql.exec<CandidateRow>("SELECT * FROM candidate WHERE singleton = 1").toArray()[0] ?? null;
  }

  private toSnapshot(row: CandidateRow): CandidateSnapshot {
    return {
      candidateId: row.candidate_id,
      status: row.status,
      recordRevision: row.record_revision,
      leaseOwner: row.lease_owner,
      leaseExpiresAt: row.lease_expires_at,
      recordJson: row.record_json,
      updatedAt: row.updated_at,
    };
  }

  private replay(idempotencyKey: string): CasResult | null {
    const row = this.ctx.storage.sql.exec<IdempotencyRow>(
      "SELECT response_json FROM idempotency WHERE idempotency_key = ?",
      idempotencyKey,
    ).toArray()[0];
    if (!row) return null;
    const result = JSON.parse(row.response_json) as CasResult;
    return { ...result, replayed: true };
  }

  private remember(idempotencyKey: string, result: CasResult, createdAt: number): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO idempotency VALUES (?, ?, ?)",
      idempotencyKey,
      JSON.stringify(result),
      createdAt,
    );
  }
}
