import { useEffect, useRef, useState } from "react";
import type {
	ComputeWorkspaceResource,
	Receipt,
} from "@eumenes/artifact-ui/contracts";
import { computeJobView } from "../../../../client/compute";
import type { WebArtifactAdapter } from "../toolchain-artifacts/registry";
import { z } from "zod";

/** Blob URLs are runtime resources. The bundle holds only a source name. */
export const computeWebAdapter: WebArtifactAdapter = {
	adapterRef: "adapter:compute@1",
	useArtifact({ client, artifactRevisionId, visible }) {
		const [data, setData] = useState<ComputeWorkspaceResource>({
			kind: "compute",
			revision: 0,
			jobs: [],
			available: false,
		});
		const [loading, setLoading] = useState(true),
			[error, setError] = useState(false);
		const urls = useRef(new Map<string, string>()),
			epoch = useRef(0);
		const refreshRef = useRef<() => Promise<void>>(async () => {});
		useEffect(() => {
			const controller = new AbortController();
			const activeUrls = urls.current;
			let busy = false;
			const own = ++epoch.current;
			async function refresh() {
				if (busy || controller.signal.aborted) return;
				busy = true;
				try {
					const source = await client.toolchainArtifactSource(
						artifactRevisionId,
						"compute",
						undefined,
						controller.signal,
					);
					const snapshot = z
						.object({
							jobs: z.array(computeJobView),
							environment: z.unknown().nullable(),
							selectedJobId: z.string().optional(),
						})
						.parse(source.data);
					const jobs = [];
					for (const job of snapshot.jobs) {
						const artifacts = [];
						for (const a of job.artifacts) {
							const key = `${job.id}:${a.id}`;
							if (a.ready && a.mime === "image/png" && !activeUrls.has(key)) {
								try {
									const blob = await client.compute.artifact(
										job.id,
										a.id,
										controller.signal,
									);
									if (blob.type !== "image/png")
										throw new Error("compute_invalid_artifact");
									if (controller.signal.aborted || epoch.current !== own)
										return;
									activeUrls.set(key, URL.createObjectURL(blob));
								} catch {
									// A preview is optional; preserve the authoritative result and downloads.
									if (controller.signal.aborted || epoch.current !== own)
										return;
								}
							}
							artifacts.push({ ...a, url: activeUrls.get(key) });
						}
						jobs.push({ ...job, artifacts });
					}
					const live = new Set(
						jobs.flatMap((j) =>
							j.artifacts.filter((a) => a.ready).map((a) => `${j.id}:${a.id}`),
						),
					);
					for (const [key, url] of activeUrls) {
						if (!live.has(key)) {
							URL.revokeObjectURL(url);
							activeUrls.delete(key);
						}
					}
					if (!controller.signal.aborted && epoch.current === own) {
						setData({
							kind: "compute",
							revision: source.revision,
							jobs,
							selectedJobId: snapshot.selectedJobId,
							available: snapshot.environment !== null,
						});
						setError(false);
						setLoading(false);
					}
				} catch {
					if (!controller.signal.aborted && epoch.current === own) {
						setError(true);
						setLoading(false);
					}
				} finally {
					busy = false;
				}
			}
			refreshRef.current = refresh;
			if (visible) void refresh();
			const timer = visible
				? setInterval(() => {
						void refresh();
					}, 1500)
				: null;
			return () => {
				controller.abort();
				if (timer) clearInterval(timer);
				for (const u of activeUrls.values()) URL.revokeObjectURL(u);
				activeUrls.clear();
			};
		}, [client, artifactRevisionId, visible]);
		return {
			phase: error
				? { kind: "error", message: "計算の状態を取得できませんでした。" }
				: loading
					? { kind: "loading" }
					: { kind: "ready" },
			snapshot: { compute: data },
			targetOf: () => undefined,
			async local(_binding, event): Promise<Receipt> {
				try {
					if (event.source !== "compute")
						return { status: "rejected", message: "参照先が違います。" };
					if (event.action === "compute-reconcile")
						await client.compute.reconcile(String(event.values.jobId));
					else if (event.action === "compute-download") {
						const job = data.jobs.find((j) => j.id === event.values.jobId),
							a = job?.artifacts.find((a) => a.id === event.values.artifactId);
						if (!job || !a?.ready)
							throw new Error("compute_artifact_not_found");
						const url = URL.createObjectURL(
							await client.compute.artifact(job.id, a.id),
						);
						const link = document.createElement("a");
						link.href = url;
						link.download = a.name;
						link.click();
						setTimeout(() => URL.revokeObjectURL(url), 1000);
					} else if (event.action !== "compute-refresh")
						return { status: "rejected", message: "未対応の操作です。" };
					await refreshRef.current();
					return { status: "accepted", message: "" };
				} catch {
					return {
						status: "indeterminate",
						message: "状態を確認できません。新しい計算は投入していません。",
					};
				}
			},
			settled: () => {
				void refreshRef.current();
			},
			refresh: () => {
				void refreshRef.current();
			},
		};
	},
};
