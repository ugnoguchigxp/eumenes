import type { Rate } from "../contracts";
const scale = 1000000000000n;
/** Decimal rate stored as text. Twelve decimal places for money; no cent rounding per record. */
export const decimal = (n: bigint) => {
	const s = n.toString().padStart(13, "0");
	return s.slice(0, -12) + "." + s.slice(-12);
};
export function liveCost(
	seconds: number | null,
	model: string | null,
	at: number,
	rates: Rate[],
) {
	if (seconds === null || model === null) return null;
	const rate = rates.find(
		(r) => r.model === model && +new Date(r.effectiveFrom) <= at,
	);
	if (!rate) return null;
	const [whole, fraction = ""] = rate.amount.split(".");
	const nanos = BigInt(whole!) * 1000000000n + BigInt(fraction.padEnd(9, "0"));
	// Provider duration remains unchanged. Convert its finite decimal representation for rational multiplication.
	const [mantissa, exponent = "0"] = seconds.toString().split("e");
	const [wholeSeconds, fractionSeconds = ""] = mantissa!.split(".");
	const digits = BigInt(wholeSeconds! + fractionSeconds);
	const power = Number(exponent) - fractionSeconds.length;
	const numerator = power >= 0 ? digits * 10n ** BigInt(power) : digits;
	const denominator = power < 0 ? 10n ** BigInt(-power) : 1n;
	return {
		amount: (numerator * nanos * scale) / (60n * 1000000000n * denominator),
		rateId: rate.id,
	};
}
