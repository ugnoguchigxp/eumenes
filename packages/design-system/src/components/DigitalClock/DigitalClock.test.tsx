import { describe, expect, it } from "vitest";
import { formatClockSeconds } from "./format";

describe("formatClockSeconds", () => {
	it("formats the planned boundaries", () => {
		expect(formatClockSeconds(0)).toBe("00:00");
		expect(formatClockSeconds(180)).toBe("03:00");
		expect(formatClockSeconds(3599)).toBe("59:59");
		expect(formatClockSeconds(3600)).toBe("01:00:00");
		expect(formatClockSeconds(86400)).toBe("24:00:00");
		expect(formatClockSeconds(3600, "mm:ss")).toBe("60:00");
		expect(formatClockSeconds(-3)).toBe("00:00");
		expect(formatClockSeconds(Number.NaN)).toBe("00:00");
		expect(formatClockSeconds(1.9)).toBe("00:01");
	});
});
