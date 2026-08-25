import { describe, expect, it } from "vitest";
import { authorize } from "../src/auth";

describe("gateway authentication", () => {
  it("accepts only the matching bearer token", async () => {
    const accepted = new Request("https://example.test", {
      headers: { authorization: "Bearer correct-token" },
    });
    const rejected = new Request("https://example.test", {
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(await authorize(accepted, "correct-token")).toBe(true);
    expect(await authorize(rejected, "correct-token")).toBe(false);
  });
});
