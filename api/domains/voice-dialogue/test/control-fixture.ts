import type { InferencePort, Receipt } from "../../inference";
import type { Messages } from "../../inference/contracts";
import { defaults } from "../../settings";
/** Synthetic authority fixture; real inference policy is tested separately. */
export function withLanguageControl(port: InferencePort): InferencePort {
	const requests = new Map<
		string,
		{ subject: string; purpose: string; accepted: boolean }
	>();
	const snapshot = defaults({});
	const capture = (subject: string, purpose: string) => {
		const id = crypto.randomUUID();
		requests.set(id, { subject, purpose, accepted: false });
		return id;
	};
	const receipt = (requestId: string, value: Receipt["value"]): Receipt => ({
		requestId,
		attemptId: crypto.randomUUID(),
		value,
	});
	return {
		...port,
		captureInTransaction: (_db, subject, purpose) => capture(subject, purpose),
		snapshotFor: () => snapshot,
		requestFor: (_db, subject, purpose) =>
			[...requests].find(
				([, r]) => r.subject === subject && r.purpose === purpose,
			)?.[0] ?? null,
		captureControlInTransaction: (_db, input) =>
			capture(input.subject, "control"),
		executeControl: async (id) =>
			receipt(
				id,
				JSON.stringify({
					status: "identified",
					languages: ["ja"],
					confidence: 0.99,
				}),
			),
		executeRequest: async (id, input, signal) =>
			receipt(
				id,
				requests.get(id)?.purpose === "asr"
					? await port.transcribe(input as Uint8Array, signal)
					: requests.get(id)?.purpose === "tts"
						? await port.speak(input as string, signal)
						: await port.answer(input as Messages, signal),
			),
		bindInTransaction: (_db, _voice, run) => {
			capture(run, "llm");
		},
		acceptInTransaction: (_db, r) => {
			const request = requests.get(r.requestId);
			if (!request) return false;
			request.accepted = true;
			return true;
		},
		validRequest: (id) => requests.has(id),
		validInTransaction: (_db, id) => requests.has(id),
		cancelRequestsInTransaction: (_db, ids) => {
			for (const id of ids)
				if (!requests.get(id)?.accepted) requests.delete(id);
		},
	};
}
