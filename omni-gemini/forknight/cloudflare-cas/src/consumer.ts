import type { CasResult, CandidateSnapshot } from "./contracts";
import { isRecord } from "./contracts";
import { parseTestingHandoff, type TestingHandoff } from "./testing-handoff";

const LEASE_SECONDS = 900;
const MAX_DELIVERY_ATTEMPTS = 4;

interface ExecutionReport {
  outcome: "verified" | "rejected" | "blocked";
  details: Record<string, unknown>;
}

class ContractRejectedError extends Error {}
class InfrastructureBlockedError extends Error {}

function parseExecutionReport(value: unknown): ExecutionReport | null {
  if (!isRecord(value) || !["verified", "rejected", "blocked"].includes(String(value.outcome)) || !isRecord(value.details)) return null;
  return value as unknown as ExecutionReport;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function requireApplied(result: CasResult, operation: string): CandidateSnapshot {
  if ((!result.applied && !result.replayed) || !result.snapshot) {
    throw new InfrastructureBlockedError(`${operation} failed: ${result.conflict ?? "missing_snapshot"}`);
  }
  return { ...result.snapshot };
}

function withExecutionRecord(snapshot: CandidateSnapshot, report: ExecutionReport, objectKey: string, reportDigest: string): string {
  const record = JSON.parse(snapshot.recordJson) as unknown;
  if (!isRecord(record)) throw new ContractRejectedError("Candidate record is not a JSON object");
  return JSON.stringify({
    ...record,
    execution: {
      outcome: report.outcome,
      report_key: objectKey,
      report_sha256: reportDigest,
      recorded_at: new Date().toISOString(),
    },
  });
}

async function storeImmutableReport(env: Cloudflare.Env, job: TestingHandoff, report: ExecutionReport): Promise<{ key: string; digest: string }> {
  const body = JSON.stringify(report);
  const digest = await sha256(body);
  const implementationDigest = job.implementation_revision.slice("sha256:".length);
  const key = `reports/${job.candidate_id}/revision-${job.record_revision}/${implementationDigest}/${digest}.json`;
  const stored = await env.REPORTS_BUCKET.put(key, body, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json" },
    customMetadata: { sha256: digest, idempotencyKey: job.idempotency_key },
    sha256: digest,
  });
  if (!stored) {
    const existing = await env.REPORTS_BUCKET.head(key);
    if (!existing || existing.customMetadata?.sha256 !== digest) {
      throw new InfrastructureBlockedError("Immutable report key collision");
    }
  }
  return { key, digest };
}

async function execute(env: Cloudflare.Env, job: TestingHandoff): Promise<ExecutionReport> {
  let response: Response;
  try {
    response = await env.TEST_EXECUTOR.fetch("https://executor.internal/v1/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(job),
    });
  } catch (error) {
    throw new InfrastructureBlockedError(error instanceof Error ? error.message : "Executor unavailable");
  }
  const body = await response.json().catch(() => null);
  if (response.status >= 500) throw new InfrastructureBlockedError(`Executor returned ${response.status}`);
  const report = parseExecutionReport(body);
  if (!response.ok || !report) throw new ContractRejectedError(`Executor contract rejected (${response.status})`);
  return report;
}

async function transitionFinal(
  candidate: DurableObjectStub<import("./candidate-cas").CandidateCasObject>,
  job: TestingHandoff,
  snapshot: CandidateSnapshot,
  leaseOwner: string,
  report: ExecutionReport,
  env: Cloudflare.Env,
): Promise<void> {
  const artifact = await storeImmutableReport(env, job, report);
  const result = await candidate.transition({
    candidateId: job.candidate_id,
    expectedRevision: snapshot.recordRevision,
    expectedStatus: "testing",
    toStatus: report.outcome,
    actorId: leaseOwner,
    reason: `Testing worker completed with ${report.outcome}`,
    idempotencyKey: `${job.idempotency_key}:finalize`,
    leaseOwner,
    recordJson: withExecutionRecord(snapshot, report, artifact.key, artifact.digest),
  });
  requireApplied(result, "finalize");
}

async function processMessage(message: Message<unknown>, env: Cloudflare.Env): Promise<void> {
  const job = parseTestingHandoff(message.body);
  if (!job) {
    console.error(JSON.stringify({ event: "handoff_rejected", messageId: message.id, reason: "invalid_schema" }));
    message.ack();
    return;
  }
  const candidate = env.CANDIDATE_CAS.getByName(job.candidate_id);
  const finalReplay = await candidate.getOperationResult(`${job.idempotency_key}:finalize`);
  if (finalReplay?.snapshot && ["verified", "rejected", "blocked"].includes(finalReplay.snapshot.status)) {
    message.ack();
    return;
  }
  const leaseOwner = `queue:${message.id}`;
  let snapshot: CandidateSnapshot | null = await candidate.getSnapshot();
  if (!snapshot) throw new InfrastructureBlockedError("Candidate is not initialized");

  if (snapshot.status === "quarantined") {
    snapshot = requireApplied(await candidate.transition({
      candidateId: job.candidate_id,
      expectedRevision: job.record_revision,
      expectedStatus: "quarantined",
      toStatus: "claimed",
      actorId: leaseOwner,
      reason: "Queue worker acquired testing lease",
      idempotencyKey: `${job.idempotency_key}:claim`,
      leaseOwner,
      leaseDurationSeconds: LEASE_SECONDS,
    }), "claim");
  }
  if (snapshot.leaseOwner !== leaseOwner || (snapshot.status !== "claimed" && snapshot.status !== "testing")) {
    throw new InfrastructureBlockedError("Candidate lease belongs to another worker");
  }
  if (snapshot.status === "claimed") {
    snapshot = requireApplied(await candidate.transition({
      candidateId: job.candidate_id,
      expectedRevision: snapshot.recordRevision,
      expectedStatus: "claimed",
      toStatus: "testing",
      actorId: leaseOwner,
      reason: "Sandbox execution started",
      idempotencyKey: `${job.idempotency_key}:testing`,
      leaseOwner,
    }), "start testing");
  }
  snapshot = requireApplied(await candidate.renewLease({
    candidateId: job.candidate_id,
    expectedRevision: snapshot.recordRevision,
    leaseOwner,
    leaseDurationSeconds: LEASE_SECONDS,
    actorId: leaseOwner,
    reason: "Lease renewed before executor dispatch",
    idempotencyKey: `${job.idempotency_key}:renew-before-execution`,
  }), "renew lease");

  try {
    const report = await execute(env, job);
    await transitionFinal(candidate, job, snapshot, leaseOwner, report, env);
    message.ack();
  } catch (error) {
    if (error instanceof ContractRejectedError) {
      const report: ExecutionReport = { outcome: "rejected", details: { reason: error.message } };
      await transitionFinal(candidate, job, snapshot, leaseOwner, report, env);
      message.ack();
      return;
    }
    if (message.attempts >= MAX_DELIVERY_ATTEMPTS) {
      const report: ExecutionReport = {
        outcome: "blocked",
        details: { reason: error instanceof Error ? error.message : "Infrastructure failure" },
      };
      await transitionFinal(candidate, job, snapshot, leaseOwner, report, env);
    }
    const delaySeconds = Math.min(30 * 2 ** Math.max(message.attempts - 1, 0), 900);
    message.retry({ delaySeconds });
  }
}

export async function processQueueBatch(batch: MessageBatch<unknown>, env: Cloudflare.Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processMessage(message, env);
    } catch (error) {
      console.error(JSON.stringify({
        event: "handoff_infrastructure_failure",
        messageId: message.id,
        attempts: message.attempts,
        error: error instanceof Error ? error.message : "unknown",
      }));
      const delaySeconds = Math.min(30 * 2 ** Math.max(message.attempts - 1, 0), 900);
      message.retry({ delaySeconds });
    }
  }
}
