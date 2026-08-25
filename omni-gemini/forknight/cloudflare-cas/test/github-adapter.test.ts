import { describe, expect, it } from "vitest";
import { verifyGitHubSignature } from "../src/github-adapter";

describe("GitHub adapter signatures", () => {
  it("accepts only the matching HMAC-SHA256 signature", async () => {
    const secret = "test-webhook-secret";
    const body = new TextEncoder().encode('{"action":"forknight.quarantine"}');
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const digest = await crypto.subtle.sign("HMAC", key, body);
    const signature = `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`.replace(":", "=");
    expect(await verifyGitHubSignature(secret, signature, body)).toBe(true);
    expect(await verifyGitHubSignature(secret, "sha256=invalid", body)).toBe(false);
  });
});
