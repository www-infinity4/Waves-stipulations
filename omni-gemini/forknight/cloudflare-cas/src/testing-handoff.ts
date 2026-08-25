import { isCandidateId, isRecord } from "./contracts";

export interface TestingHandoff {
  schema_version: "1.0";
  candidate_id: string;
  record_revision: number;
  implementation_revision: `sha256:${string}`;
  target_path: string;
  adapter_contract: { path: string; sha256: string };
  required_tests: string[];
  sandbox_policy: {
    network: "allowed" | "denied" | "internal_only";
    filesystem: "allowed" | "denied" | "tmp_only";
    max_memory_mb: number;
    timeout_seconds: number;
  };
  idempotency_key: string;
}

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]{1,512}$/;

export function parseTestingHandoff(value: unknown): TestingHandoff | null {
  if (!isRecord(value) || value.schema_version !== "1.0" || !isCandidateId(value.candidate_id)) return null;
  if (!Number.isSafeInteger(value.record_revision) || Number(value.record_revision) < 1) return null;
  if (typeof value.implementation_revision !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.implementation_revision)) return null;
  if (typeof value.target_path !== "string" || !SAFE_PATH.test(value.target_path)) return null;
  if (!isRecord(value.adapter_contract) || typeof value.adapter_contract.path !== "string" ||
      !SAFE_PATH.test(value.adapter_contract.path) || typeof value.adapter_contract.sha256 !== "string" ||
      !SHA256.test(value.adapter_contract.sha256)) return null;
  if (!Array.isArray(value.required_tests) || value.required_tests.length === 0 ||
      !value.required_tests.every((item) => typeof item === "string" && item.length > 0 && item.length <= 64)) return null;
  if (!isRecord(value.sandbox_policy)) return null;
  const policy = value.sandbox_policy;
  if (!["allowed", "denied", "internal_only"].includes(String(policy.network)) ||
      !["allowed", "denied", "tmp_only"].includes(String(policy.filesystem)) ||
      !Number.isSafeInteger(policy.max_memory_mb) || Number(policy.max_memory_mb) < 1 || Number(policy.max_memory_mb) > 32768 ||
      !Number.isSafeInteger(policy.timeout_seconds) || Number(policy.timeout_seconds) < 1 || Number(policy.timeout_seconds) > 3600) return null;
  if (typeof value.idempotency_key !== "string" || value.idempotency_key.length < 1 || value.idempotency_key.length > 256) return null;
  return value as unknown as TestingHandoff;
}
