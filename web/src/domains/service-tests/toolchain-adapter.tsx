import type { WebArtifactAdapter } from "../toolchain-artifacts/registry";
import { genericWebAdapter } from "../toolchain-artifacts/generic-adapter";

/** Lists and writes remain registration driven; only WAV bytes need a domain transport. */
export const serviceTestsWebAdapter: WebArtifactAdapter = {
	adapterRef: "adapter:service-tests@1",
	useArtifact(context) {
		const base = genericWebAdapter.useArtifact(context);
		return {
			...base,
			async uploadFile(source, file) {
				if (
					!context.artifact.sourceBindings.some(
						(binding) => binding.source === source,
					)
				)
					return { status: "rejected", message: "この入力は利用できません" };
				if (file.size > 4_000_000 || !/\.wav$/i.test(file.name))
					return {
						status: "rejected",
						message: "4 MB以下のWAVファイルを選んでください。",
					};
				try {
					const uploaded = await context.client.uploadTestAudio(file);
					return { status: "accepted", message: "", value: uploaded.id };
				} catch {
					return {
						status: "rejected",
						message: "WAVファイルを読み込めませんでした。",
					};
				}
			},
		};
	},
};
