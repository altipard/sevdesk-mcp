import { describe, expect, it } from "vitest";
import { netSum, sumWarning, toCents } from "../../src/tools/write-common.js";

const position = (quantity: number, priceNet: number) => ({
  partId: undefined,
  name: "X",
  text: undefined,
  quantity,
  priceNet,
  taxRate: 19,
  unityId: 1,
});

describe("toCents", () => {
  it.each([
    [1.005, 101],
    [0.285, 29],
    [1.255, 126],
    [2.675, 268],
    [3 * 0.335, 101],
    [0, 0],
  ])("rounds %d to %d cents despite float noise", (value, expected) => {
    expect(toCents(value)).toBe(expected);
  });
});

describe("netSum and sumWarning", () => {
  it("rounds each position before adding", () => {
    // 1.005 + 0.285 = 1.29 unrounded, 1.01 + 0.29 = 1.30 per position.
    expect(netSum([position(1, 1.005), position(1, 0.285)])).toBe(1.3);
  });

  it("tolerates one cent per position and warns beyond that", () => {
    expect(sumWarning(10, 10.01, 1)).toBeUndefined();
    expect(sumWarning(10, 10.02, 1)).toContain("Sum mismatch");
    expect(sumWarning(10, 10.04, 4)).toBeUndefined();
    expect(sumWarning(10, 9.95, 4)).toContain("Sum mismatch");
    expect(sumWarning(10, null, 4)).toBeUndefined();
  });
});
