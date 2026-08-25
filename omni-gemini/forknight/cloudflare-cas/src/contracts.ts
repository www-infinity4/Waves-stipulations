export const STATUSES = [
  "discovered",
  "specified",
  "rebuilding",
  "quarantined",
  "claimed",
  "testing",
  "verified",
  "promoted",
  "rejected",
  "blocked",
  "superseded",
  "revoked",
] as const;

export type CandidateStatus = (typeof STATUSES)[number];
export interface CandidateSnapshot {
  candidateId: string;
  status: CandidateStatus;
  recordRevision: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  recordJson: string;
  updatedAt: number;
}

export interface InitializeInput {
  candidateId: string;
  actorId: string;
  idempotencyKey: string;
  recordJson: string;
}

export interface TransitionInput {
  candidateId: string;
  expectedRevision: number;
  expectedStatus: CandidateStatus;
  toStatus: CandidateStatus;
  actorId: string;
  reason: string;
  idempotencyKey: string;
  leaseOwner?: string;
  leaseDurationSeconds?: number;
  recordJson?: string;
}

export interface ContentEntry {
  hash: string;
  mediaType: string;
  byteLength: number;
  createdAt: number;
  content: string;
}

export interface CasResult {
  applied: boolean;
  replayed: boolean;
  conflict?: "not_initialized" | "already_initialized" | "revision" | "status" | "transition" | "lease";
  snapshot?: CandidateSnapshot;
}

export const ALLOWED_TRANSITIONS: Readonly<Record<CandidateStatus, readonly CandidateStatus[]>> = {
  discovered: ["specified", "rejected", "blocked", "superseded"],
  specified: ["rebuilding", "rejected", "blocked", "superseded"],
  rebuilding: ["quarantined", "rejected", "blocked", "superseded"],
  quarantined: ["claimed", "rejected", "blocked", "superseded"],
  claimed: ["testing", "quarantined", "blocked", "rejected"],
  testing: ["verified", "blocked", "rejected"],
  verified: ["promoted", "rebuilding", "revoked"],
  promoted: ["revoked", "superseded"],
  rejected: ["rebuilding", "superseded"],
  blocked: ["rebuilding", "quarantined", "superseded"],
  superseded: [],
  revoked: ["rebuilding", "superseded"],
};

export function isCandidateId(value: unknown): value is string {
  return typeof value === "string" && /^cap_[a-z0-9_]+$/.test(value);
}

export function isStatus(value: unknown): value is CandidateStatus {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value);
}
