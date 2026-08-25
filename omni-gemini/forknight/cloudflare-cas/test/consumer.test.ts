import { env } from "cloudflare:workers";
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { processQueueBatch } from "../src/consumer";

const DIGEST = "b".repeat(64);

describe("testing queue consumer", () => {
  it("claims, executes, stores a report, and verifies a candidate", async () => {
    const candidateId = "cap_queue_consumer_test";
    const stub = env.CANDIDATE_CAS.getByName(candidateId);
    await stub.initialize({
      candidateId,
      actorId: "test",
      idempotencyKey: "queue-init",
      recordJson: JSON.stringify({ schema_version: "1.0", references: [] }),
    });
    await stub.transition({ candidateId, expectedRevision: 1, expectedStatus: "discovered", toStatus: "specified", actorId: "test", reason: "specified", idempotencyKey: "queue-specified" });
    await stub.transition({ candidateId, expectedRevision: 2, expectedStatus: "specified", toStatus: "rebuilding", actorId: "test", reason: "rebuilt", idempotencyKey: "queue-rebuilding" });
    await stub.transition({ candidateId, expectedRevision: 3, expectedStatus: "rebuilding", toStatus: "quarantined", actorId: "test", reason: "quarantined", idempotencyKey: "queue-quarantined" });

    const batch = createMessageBatch("forknight-testing-handoff", [{
      id: "message-queue-test",
      timestamp: new Date(),
      attempts: 1,
      body: {
        schema_version: "1.0",
        candidate_id: candidateId,
        record_revision: 4,
        implementation_revision: `sha256:${DIGEST}`,
        target_path: "capabilities/test",
        adapter_contract: { path: "contracts/test.json", sha256: DIGEST },
        required_tests: ["contract"],
        sandbox_policy: { network: "denied", filesystem: "tmp_only", max_memory_mb: 128, timeout_seconds: 30 },
        idempotency_key: "queue-plan-test",
      },
    }]);

    await processQueueBatch(batch, env);
    expect((await getQueueResult(batch, createExecutionContext())).outcome).toBe("ok");
    const snapshot = await stub.getSnapshot();
    expect(snapshot?.status).toBe("verified");
    const record = JSON.parse(snapshot!.recordJson) as { execution: { report_key: string } };
    expect(await env.REPORTS_BUCKET.head(record.execution.report_key)).not.toBeNull();
  });
});
