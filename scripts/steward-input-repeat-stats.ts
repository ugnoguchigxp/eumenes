/** Diagnostic statistics of the fixed synthetic evaluation, never product memory decisions. */
function logChoose(n: number, k: number) {
	if (k < 0 || k > n) return -Infinity;
	let value = 0;
	for (let i = 1; i <= Math.min(k, n - k); i++)
		value += Math.log(n - i + 1) - Math.log(i);
	return value;
}

/** Rows are candidate/baseline, columns failure/success. Positive direction means candidate worse. */
export function failureComparison(
	candidateFailures: number,
	candidateN: number,
	baselineFailures: number,
	baselineN: number,
) {
	for (const n of [candidateFailures, candidateN, baselineFailures, baselineN])
		if (!Number.isSafeInteger(n) || n < 0) throw new Error("invalid_count");
	if (
		!candidateN ||
		!baselineN ||
		candidateFailures > candidateN ||
		baselineFailures > baselineN
	)
		throw new Error("invalid_count");
	const failures = candidateFailures + baselineFailures;
	const total = candidateN + baselineN;
	const pmf = (x: number) =>
		Math.exp(
			logChoose(failures, x) +
				logChoose(total - failures, candidateN - x) -
				logChoose(total, candidateN),
		);
	const observed = pmf(candidateFailures);
	let greater = 0;
	let twoSided = 0;
	for (
		let x = Math.max(0, candidateN - (total - failures));
		x <= Math.min(candidateN, failures);
		x++
	) {
		const p = pmf(x);
		if (x >= candidateFailures) greater += p;
		if (p <= observed * (1 + 1e-10)) twoSided += p;
	}
	return {
		candidateFailures,
		candidateN,
		baselineFailures,
		baselineN,
		failureRateDifference:
			candidateFailures / candidateN - baselineFailures / baselineN,
		candidateWorseP: Math.min(1, greater),
		twoSidedP: Math.min(1, twoSided),
	};
}
