import { describe, expect, it } from "vitest";
import { parseTestingHandoff } from "../src/testing-handoff";

const DIGEST = "a".repeat(64);

describe("testing handoff validation", () => {
  it("accepts the committed staging handoff contract", () => {
    expect(parseTestingHandoff({
      schema_version: "1.0",
      candidate_id: "cap_video_temporal_denoise_001",
      record_revision: 7,
      implementation_revision: `sha256:${DIGEST}`,
      target_path: "capabilities/video/temporal-denoise",
      adapter_contract: { path: "contracts/video-filter-v1.json", sha256: DIGEST },
      required_tests: ["contract", "determinism"],
      sandbox_policy: { network: "denied", filesystem: "tmp_only", max_memory_mb: 256, timeout_seconds: 30 },
      idempotency_key: "plan_v1_cap_video_temporal_denoise_001_rev7",
    })).not.toBeNull();
  });

  it("rejects traversal paths and malformed digests", () => {
    expect(parseTestingHandoff({
      schema_version: "1.0",
      candidate_id: "cap_video_temporal_denoise_001",
      record_revision: 7,
      implementation_revision: "sha256:nope",
      target_path: "../escape",
      adapter_contract: { path: "contract.json", sha256: DIGEST },
      required_tests: ["contract"],
      sandbox_policy: { network: "denied", filesystem: "tmp_only", max_memory_mb: 256, timeout_seconds: 30 },
      idempotency_key: "key",
    })).toBeNull();
  });
});
