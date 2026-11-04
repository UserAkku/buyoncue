import { describe, expect, it } from "vitest";
import { formatDenomination, formatUsd, parseUsdInput } from "../src/money.js";

describe("money", () => {
  it("formats exact cents without floating point", () => {
    expect(formatUsd(150)).toBe("$1.50");
    expect(formatUsd(5)).toBe("$0.05");
    expect(formatUsd(2000)).toBe("$20.00");
    expect(formatDenomination(50, "INR")).toBe("₹50");
    expect(formatDenomination(10, "CAD")).toBe("10 CAD");
  });

  it("parses USD input to integer cents", () => {
    for (const [input, cents] of [["2", 200], ["$1.50", 150], ["1.5", 150], ["usd 3", 300], ["150 cents", 150], ["150c", 150], ["0", 0], ["19.99", 1999], ["1,000", 100000]] as const) {
      expect(parseUsdInput(input)).toEqual({ ok: true, cents });
    }
  });

  it("refuses other currencies and junk", () => {
    for (const input of ["₹500", "500 INR", "Rs 500", "€5"]) expect(parseUsdInput(input)).toEqual({ ok: false, reason: "non_usd" });
    for (const input of ["", "abc", "1.234", "-5", "1e3"]) expect(parseUsdInput(input)).toEqual({ ok: false, reason: "invalid" });
  });
});
