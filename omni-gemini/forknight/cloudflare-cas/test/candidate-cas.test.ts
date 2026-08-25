import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("CandidateCasObject", () => {
  it("allows exactly one CAS claimant and replays idempotently", async () => {
    const candidateId = "cap_video_temporal_denoise_test";
    const stub = env.CANDIDATE_CAS.getByName(candidateId);
    const initialized = await stub.initialize({
      candidateId,
      actorId: "test",
      idempotencyKey: "initialize-1",
      recordJson: JSON.stringify({ schema_version: "1.0" }),
    });
    expect(initialized.applied).toBe(true);

    const specified = await stub.transition({
      candidateId,
      expectedRevision: 1,
      expectedStatus: "discovered",
      toStatus: "specified",
      actorId: "test",
      reason: "contract ready",
      idempotencyKey: "specified-1",
    });
    expect(specified.snapshot?.recordRevision).toBe(2);

    const rebuilding = await stub.transition({
      candidateId,
      expectedRevision: 2,
      expectedStatus: "specified",
      toStatus: "rebuilding",
      actorId: "test",
      reason: "implementation started",
      idempotencyKey: "rebuilding-1",
    });
    const quarantined = await stub.transition({
      candidateId,
      expectedRevision: rebuilding.snapshot!.recordRevision,
      expectedStatus: "rebuilding",
      toStatus: "quarantined",
      actorId: "test",
      reason: "ready for tests",
      idempotencyKey: "quarantined-1",
    });

    const expectedRevision = quarantined.snapshot!.recordRevision;
    const [claimA, claimB] = await Promise.all([
      stub.transition({
        candidateId,
        expectedRevision,
        expectedStatus: "quarantined",
        toStatus: "claimed",
        actorId: "worker-a",
        reason: "claim",
        idempotencyKey: "claim-a",
        leaseOwner: "worker-a",
        leaseDurationSeconds: 30,
      }),
      stub.transition({
        candidateId,
        expectedRevision,
        expectedStatus: "quarantined",
        toStatus: "claimed",
        actorId: "worker-b",
        reason: "claim",
        idempotencyKey: "claim-b",
        leaseOwner: "worker-b",
        leaseDurationSeconds: 30,
      }),
    ]);
    expect([claimA.applied, claimB.applied].filter(Boolean)).toHaveLength(1);

    const winner = claimA.applied ? claimA : claimB;
    const replay = await stub.transition({
      candidateId,
      expectedRevision,
      expectedStatus: "quarantined",
      toStatus: "claimed",
      actorId: winner.snapshot!.leaseOwner!,
      reason: "claim",
      idempotencyKey: claimA.applied ? "claim-a" : "claim-b",
      leaseOwner: winner.snapshot!.leaseOwner!,
      leaseDurationSeconds: 30,
    });
    expect(replay.applied).toBe(true);
    expect(replay.replayed).toBe(true);

    const wrongOwner = await stub.transition({
      candidateId,
      expectedRevision: winner.snapshot!.recordRevision,
      expectedStatus: "claimed",
      toStatus: "testing",
      actorId: "worker-other",
      reason: "start tests",
      idempotencyKey: "wrong-owner",
      leaseOwner: "worker-other",
    });
    expect(wrongOwner.conflict).toBe("lease");

    const testing = await stub.transition({
      candidateId,
      expectedRevision: winner.snapshot!.recordRevision,
      expectedStatus: "claimed",
      toStatus: "testing",
      actorId: winner.snapshot!.leaseOwner!,
      reason: "start tests",
      idempotencyKey: "testing-owner",
      leaseOwner: winner.snapshot!.leaseOwner!,
    });
    expect(testing.applied).toBe(true);
    expect(testing.snapshot?.leaseOwner).toBe(winner.snapshot!.leaseOwner);
  });

  it("stores content by deterministic SHA-256 and lists metadata", async () => {
    const stub = env.CANDIDATE_CAS.getByName("cap_content_test");
    const first = await stub.putContent('{"ok":true}', "application/json");
    const second = await stub.putContent('{"ok":true}', "application/json");
    expect(second.hash).toBe(first.hash);
    expect((await stub.getContent(first.hash))?.content).toBe('{"ok":true}');
    expect(await stub.listContent()).toHaveLength(1);
  });
});
