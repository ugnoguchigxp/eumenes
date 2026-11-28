import {
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type FormEvent,
	type RefObject,
} from "react";
import type { EumenesClient } from "../../../../client";
import type {
	PrototypePreview,
	PrototypeRegistration,
} from "../../../../api/domains/prototype/contracts";
import { Button } from "../../design-system";

export type WorksMediaClient = Pick<
	EumenesClient,
	| "worksImages"
	| "worksImageAsset"
	| "worksImageGenerations"
	| "worksImageStatus"
	| "worksImageContent"
	| "worksImageGrant"
	| "worksImageStart"
	| "worksImageCancel"
	| "imageLibrary"
>;
type Client = WorksMediaClient;
type Policy = Awaited<ReturnType<Client["worksImages"]>>;
type Job = Awaited<ReturnType<Client["worksImageStatus"]>>;

export function useWorksImageChannel(
	client: Client,
	work: PrototypeRegistration,
	frame: RefObject<HTMLIFrameElement | null>,
	preview: PrototypePreview | undefined,
	paused: boolean,
	suggest: (prompt: string, revision: number) => void,
) {
	const port = useRef<MessagePort | undefined>(undefined);
	const url = preview?.url;
	const version = preview?.version;
	useLayoutEffect(
		() => () => {
			port.current?.close();
			port.current = undefined;
		},
		[url, version, paused, work.id, work.generation],
	);
	return () => {
		if (!url || !version || paused || !frame.current?.contentWindow) return;
		const target = new URL(url);
		const session = /^\/v\/([a-f0-9-]{36})\/$/.exec(target.pathname)?.[1];
		if (!session || target.hostname !== "p-" + work.id + ".localhost") return;
		const window = frame.current.contentWindow;
		port.current?.close();
		const channel = new MessageChannel();
		const { port1, port2 } = channel;
		port.current = port1;
		const identity = { project: work.id, version, session };
		let pending = 0;
		port1.onmessage = async (event: MessageEvent) => {
			const request = event.data;
			if (
				port.current !== port1 ||
				frame.current?.contentWindow !== window ||
				request?.project !== identity.project ||
				request.version !== version ||
				request.session !== session ||
				typeof request.id !== "string" ||
				!/^[a-f0-9-]{36}$/.test(request.id)
			)
				return;
			const send = (result: Record<string, unknown>) => {
				if (port.current === port1 && frame.current?.contentWindow === window)
					port1.postMessage({ id: request.id, ...result });
			};
			if (pending >= 4) {
				send({ ok: false, error: "works_image_channel_busy" });
				return;
			}
			pending++;
			try {
				const value = request.value;
				if (
					value !== undefined &&
					(typeof value !== "string" ||
						value.length > (request.method === "suggest" ? 2000 : 160))
				)
					throw new Error("works_image_request_invalid");
				let result: unknown;
				switch (request.method) {
					case "features": {
						const policy = await client.worksImages(work.id);
						result = [
							policy.assets.length ? "library.image.read" : null,
							policy.enabled ? "media.image.generate" : null,
						].filter(Boolean);
						break;
					}
					case "suggest": {
						const text = typeof value === "string" ? value.trim() : "";
						const policy = await client.worksImages(work.id);
						if (!text || !policy.enabled)
							throw new Error("works_image_request_invalid");
						if (
							port.current === port1 &&
							frame.current?.contentWindow === window
						)
							suggest(text, policy.revision);
						break;
					}
					case "assets":
						result = (await client.worksImages(work.id)).assets;
						break;
					case "read":
						result = await client.worksImageAsset(work.id, value);
						break;
					case "generations":
						result = await client.worksImageGenerations(work.id);
						break;
					case "status":
						result = await client.worksImageStatus(work.id, value);
						break;
					case "content":
						result = await client.worksImageContent(work.id, value);
						break;
					default:
						throw new Error("works_image_request_invalid");
				}
				send({ ok: true, value: result });
			} catch {
				send({ ok: false, error: "works_image_unavailable" });
			} finally {
				pending--;
			}
		};
		window.postMessage(
			{ type: "eumenes-works-images", ...identity },
			target.origin,
			[port2],
		);
	};
}

const statusText = (job: Job) =>
	job.phase === "waiting_capacity"
		? "容量待ち"
		: {
				generating: "生成中",
				completed: "完了",
				failed: "失敗",
				cancelled: "取消済み",
			}[job.state];

export function WorksImages({
	client,
	work,
	suggestion,
	clearSuggestion,
}: {
	client: Client;
	work: PrototypeRegistration;
	suggestion?: { prompt: string; revision: number };
	clearSuggestion(): void;
}) {
	const [policy, setPolicy] = useState<Policy>();
	const [library, setLibrary] =
		useState<Awaited<ReturnType<Client["imageLibrary"]>>["images"]>();
	const [jobs, setJobs] = useState<Job[]>([]);
	const [error, setError] = useState(false);
	const [busy, setBusy] = useState(false);
	const [prompt, setPrompt] = useState("");
	const operation = useRef<{ id: string; prompt: string } | undefined>(
		undefined,
	);
	useEffect(() => {
		let active = true;
		const query = async () => {
			try {
				const options = await client.worksImages(work.id);
				if (!active) return;
				setPolicy(options);
				if (options.enabled) {
					const next = await client.worksImageGenerations(work.id);
					if (active) setJobs(next);
				} else setJobs([]);
			} catch {
				if (active) setPolicy(undefined);
			}
		};
		void query();
		const timer = setInterval(() => void query(), 1350);
		return () => {
			active = false;
			clearInterval(timer);
		};
	}, [client, work.id, work.generation]);
	if (!policy || (!policy.canRead && !policy.canGenerate)) return null;
	const update = async (apply: () => Promise<unknown>) => {
		if (busy) return;
		setBusy(true);
		setError(false);
		try {
			await apply();
		} catch {
			setError(true);
		} finally {
			setBusy(false);
		}
	};
	const grant = (enabled: boolean, assetIds: string[]) =>
		void update(async () =>
			setPolicy(
				await client.worksImageGrant(work.id, {
					expectedRevision: policy.revision,
					enabled,
					assetIds,
				}),
			),
		);
	const form = (event: FormEvent) => {
		event.preventDefault();
		const text = prompt.trim();
		if (!text) return;
		void update(async () => {
			if (operation.current?.prompt !== text)
				operation.current = { id: crypto.randomUUID(), prompt: text };
			const result = await client.worksImageStart(work.id, {
				operationId: operation.current.id,
				prompt: text,
				width: 512,
				height: 384,
				format: "png",
				seed: 42,
			});
			setJobs((previous) => [
				result,
				...previous.filter((j) => j.operationId !== result.operationId),
			]);
			operation.current = undefined;
			setPrompt("");
		});
	};
	return (
		<section className="works-images" aria-label="作品の画像">
			{policy.canRead && (
				<div>
					<Button
						variant="secondary"
						disabled={busy}
						onClick={() =>
							void update(async () =>
								setLibrary((await client.imageLibrary()).images),
							)
						}
					>
						保存画像から選ぶ
					</Button>
					{library && (
						<label>
							許可する保存画像
							<select
								multiple
								value={policy.assets.map((a) => a.id)}
								disabled={busy}
								onChange={(event) =>
									grant(
										policy.enabled,
										Array.from(
											event.currentTarget.selectedOptions,
											(o) => o.value,
										).slice(0, 16),
									)
								}
							>
								{library.map((a) => (
									<option value={a.id} key={a.id}>
										{a.width} × {a.height} · {a.createdAt.slice(0, 10)} · {a.id}
									</option>
								))}
							</select>
						</label>
					)}
					{policy.assets.length > 0 && (
						<Button
							variant="secondary"
							disabled={busy}
							onClick={() => grant(policy.enabled, [])}
						>
							保存画像の許可を解除
						</Button>
					)}
				</div>
			)}
			{policy.canGenerate && (
				<div>
					<label>
						<input
							type="checkbox"
							checked={policy.enabled}
							disabled={busy}
							onChange={(event) =>
								grant(
									event.currentTarget.checked,
									policy.assets.map((a) => a.id),
								)
							}
						/>{" "}
						この作品に画像生成を許可
					</label>
					{policy.enabled && (
						<form onSubmit={form}>
							{suggestion && suggestion.revision === policy.revision && (
								<div>
									<p>作品からの画像案 {suggestion.prompt}</p>
									<Button
										type="button"
										variant="secondary"
										onClick={() => {
											setPrompt(suggestion.prompt);
											clearSuggestion();
										}}
									>
										画像案を使う
									</Button>
								</div>
							)}
							<label>
								画像の説明{" "}
								<input
									name="works-image-prompt"
									value={prompt}
									maxLength={2000}
									onChange={(event) => setPrompt(event.currentTarget.value)}
								/>
							</label>
							<Button type="submit" disabled={busy || !prompt.trim()}>
								画像を生成
							</Button>
						</form>
					)}
					{jobs.length ? (
						<ul aria-label="作品の画像履歴">
							{jobs.map((job) => (
								<li key={job.operationId}>
									{statusText(job)}{" "}
									{job.errorCode && job.errorCode !== "cancel_requested" ? (
										<span>{job.errorCode}</span>
									) : null}
									{job.state === "generating" && (
										<Button
											variant="secondary"
											disabled={busy}
											onClick={() =>
												void update(async () => {
													const next = await client.worksImageCancel(
														work.id,
														job.operationId,
													);
													setJobs((items) =>
														items.map((item) =>
															item.operationId === next.operationId
																? next
																: item,
														),
													);
												})
											}
										>
											画像生成を取り消す
										</Button>
									)}
								</li>
							))}
						</ul>
					) : null}
				</div>
			)}
			{error && <p role="alert">画像の操作を完了できませんでした。</p>}
		</section>
	);
}
