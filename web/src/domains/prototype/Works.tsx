import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type FormEvent,
} from "react";
import type { EumenesClient } from "../../../../client";
import type {
	PrototypePreview,
	PrototypeRegistration,
} from "../../../../api/domains/prototype/contracts";
import { Button } from "../../design-system";
import "./works.css";
import {
	useWorksImageChannel,
	WorksImages,
	type WorksMediaClient,
} from "./WorksImages";
import { worksScreen } from "./resource-screen";
import { TrialForm, TrialReport } from "./WorksTrial";

type Client = Pick<
	EumenesClient,
	| "prototypes"
	| "prototypeRegister"
	| "prototypeCreate"
	| "prototypeMove"
	| "prototypeRemove"
	| "prototypeOpen"
	| "prototypePreview"
	| "prototypeRetry"
	| "prototypeStalled"
	| "prototypeHide"
	| "prototypeTrial"
	| "prototypeTrialInventory"
> &
	WorksMediaClient;
const labels: Record<PrototypePreview["state"], string> = {
	waiting: "待ち",
	building: "準備中",
	ready: "表示中",
	failed: "失敗",
	unresponsive: "応答不能",
	hidden: "非表示",
	environment: "環境の不足",
	registration: "登録先の異常",
	unsupported: "対象外",
};
function supportedBrowser() {
	return (
		["localhost", "127.0.0.1"].includes(window.location.hostname) &&
		/\b(?:Headless)?Chrome\/\d+/.test(navigator.userAgent) &&
		!/(Android|Edg\/|OPR\/)/.test(navigator.userAgent) &&
		/Macintosh/.test(navigator.userAgent)
	);
}
const message = (error: unknown) =>
	error instanceof Error ? error.message : String(error);
const advice: Record<string, string> = {
	prototype_git_overlap: "本体や登録済み作品とGit管理範囲が重なっています。",
	prototype_git_root_required:
		"独立したGitリポジトリのルートを指定してください。",
	runner_git_failed: "コミットのある独立したGitリポジトリを指定してください。",
	prototype_git_identity_required:
		"初回コミット用の Git user.name と user.email を設定してください。",
	prototype_path_invalid:
		"作品フォルダを確認してください。絶対パスを指定できます。",
	prototype_registration_changed:
		"フォルダが移動または変更されました。新しい場所へ結び直してください。",
	prototype_workspace_busy:
		"この作品のClaude Code作業が終わってから、もう一度操作してください。",
	prototype_preview_unresponsive:
		"作品の実行を停止しました。保存後か、再試行で開き直せます。",
};
const explain = (value: string) => advice[value] ?? value;

function Preview({
	client,
	work,
	hide,
}: {
	client: Client;
	work: PrototypeRegistration;
	hide(): void;
}) {
	const [state, setState] = useState<PrototypePreview>();
	const [error, setError] = useState<string>();
	const frame = useRef<HTMLIFrameElement>(null);
	const [paused, setPaused] = useState<string>();
	const [imageSuggestion, setImageSuggestion] = useState<{
		url: string;
		prompt: string;
		revision: number;
	}>();
	const lastBeat = useRef(0);
	const active = useRef(true);
	const connectImages = useWorksImageChannel(
		client,
		work,
		frame,
		state,
		Boolean(state?.url && paused === state.url),
		(prompt, revision) => {
			if (state?.url) setImageSuggestion({ url: state.url, prompt, revision });
		},
	);
	useEffect(() => {
		active.current = true;
		let disposed = false;
		let pending = false;
		const refresh = async (reopen = false) => {
			if (pending || disposed) return;
			pending = true;
			try {
				const next = await (reopen
					? client.prototypeOpen(work.id)
					: client.prototypePreview(work.id));
				if (!disposed) {
					setState(next);
					setError(undefined);
				}
			} catch (e) {
				if (!disposed) setError(message(e));
			} finally {
				pending = false;
			}
		};
		const run = setTimeout(() => {
			void refresh(true);
		}, 0);
		const timer = setInterval(() => {
			void refresh();
		}, 700);
		return () => {
			disposed = true;
			active.current = false;
			clearTimeout(run);
			clearInterval(timer);
			void client.prototypeHide(work.id).catch(() => undefined);
		};
	}, [client, work.id, work.generation]);

	const stop = useCallback(
		(url: string, version: string) => {
			setPaused(url);
			void client.prototypeStalled(work.id, version).then(
				(next) => {
					if (active.current) setState(next);
				},
				(e) => {
					if (active.current) setError(message(e));
				},
			);
		},
		[client, work.id],
	);
	useEffect(() => {
		const url = state?.url;
		const version = state?.version;
		if (!url || !version || paused === url) return;
		const origin = new URL(url).origin;
		lastBeat.current = Date.now();
		const onMessage = (event: MessageEvent) => {
			if (
				event.source === frame.current?.contentWindow &&
				event.origin === origin &&
				event.data?.type === "eumenes-prototype-heartbeat"
			)
				lastBeat.current = Date.now();
		};
		window.addEventListener("message", onMessage);
		const timer = setInterval(() => {
			if (document.visibilityState !== "visible") {
				lastBeat.current = Date.now();
				return;
			}
			if (Date.now() - lastBeat.current > 10_000) stop(url, version);
		}, 1_000);
		return () => {
			window.removeEventListener("message", onMessage);
			clearInterval(timer);
		};
	}, [state?.url, state?.version, paused, stop]);

	return (
		<section className="works-preview" aria-label={work.name}>
			<header>
				<h2>{work.name}</h2>
				<output aria-label={work.name + "の状態"}>
					{state ? labels[state.state] : "待ち"}
				</output>
				{state?.url && state.version && (
					<Button
						variant="secondary"
						onClick={() => stop(state.url!, state.version!)}
					>
						停止
					</Button>
				)}
				<Button variant="secondary" onClick={hide}>
					閉じる
				</Button>
			</header>
			<WorksImages
				client={client}
				work={work}
				suggestion={
					imageSuggestion?.url === state?.url ? imageSuggestion : undefined
				}
				clearSuggestion={() => setImageSuggestion(undefined)}
			/>
			{work.trial && <TrialReport client={client} work={work} />}
			{state?.url && paused !== state.url && (
				<iframe
					ref={frame}
					onLoad={connectImages}
					title={work.name}
					key={state.url}
					src={state.url}
					sandbox="allow-scripts allow-same-origin"
					referrerPolicy="no-referrer"
				/>
			)}
			{state?.version && state.state !== "ready" && (
				<p>
					表示中の入力版 <code>{state.version.slice(0, 12)}</code>
				</p>
			)}
			{error && <p role="alert">{explain(error)}</p>}
			{state?.diagnostics.length ? (
				<ul className="works-diagnostics">
					{state.diagnostics.map((diag, i) => (
						<li key={i}>{explain(diag)}</li>
					))}
				</ul>
			) : null}
			{state &&
				["failed", "environment", "unresponsive", "registration"].includes(
					state.state,
				) && (
					<Button
						variant="secondary"
						onClick={() => {
							void client
								.prototypeRetry(work.id)
								.then(setState, (e) => setError(message(e)));
						}}
					>
						再試行
					</Button>
				)}
		</section>
	);
}

export default function Works({
	client,
	target,
}: {
	client: Client;
	target?: string;
}) {
	const [projects, setProjects] = useState<PrototypeRegistration[]>([]);
	const [path, setPath] = useState("");
	const [name, setName] = useState("");
	const [move, setMove] = useState<string>();
	const [remove, setRemove] = useState<string>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const [opened, setOpened] = useState<string[]>(target ? [target] : []);
	const [lastTarget, setLastTarget] = useState(target);
	if (lastTarget !== target) {
		setLastTarget(target);
		if (target && !opened.includes(target)) setOpened([...opened, target]);
	}
	const [ready, setReady] = useState(false);
	const [environment, setEnvironment] = useState("");
	const supported = supportedBrowser();
	const refresh = useCallback(
		() =>
			client.prototypes().then(({ projects, defaultVersion }) => {
				setProjects(projects);
				setEnvironment(defaultVersion);
				setReady(true);
			}),
		[client],
	);
	useEffect(() => {
		if (supported) void refresh().catch((e) => setError(message(e)));
	}, [refresh, supported]);
	function perform(
		event: FormEvent,
		action: () => Promise<unknown>,
		done?: () => void,
	) {
		event.preventDefault();
		if (busy) return;
		setBusy(true);
		setError(undefined);
		void action()
			.then(() => refresh())
			.then(done)
			.catch((e) => setError(message(e)))
			.finally(() => setBusy(false));
	}
	return (
		<main className="works-page">
			<header className="works-heading">
				<h1>Works</h1>
				<a
					href="#conversation"
					onClick={() => {
						if (!target) worksScreen.clear();
					}}
				>
					会話に戻る
				</a>
			</header>
			{!supported && (
				<p>Worksはこの機器のmacOS版Google Chromeで開いてください。</p>
			)}
			{error && (
				<p role="alert">
					{ready
						? explain(error)
						: "Worksを開けません。Eumenesの共有環境とWorksフォルダの設定を確認してください。"}
				</p>
			)}
			{ready && (
				<>
					<div className="works-forms">
						<form
							onSubmit={(e) =>
								perform(
									e,
									() =>
										move
											? client.prototypeMove(move, path)
											: client.prototypeRegister(path),
									() => {
										if (move)
											setOpened((ids) => ids.filter((id) => id !== move));
										setPath("");
										setMove(undefined);
									},
								)
							}
						>
							<label htmlFor="works-folder">
								{move ? "移設先のフォルダ" : "既存作品のフォルダ"}
							</label>
							<div>
								<input
									id="works-folder"
									required
									value={path}
									onChange={(e) => setPath(e.target.value)}
									placeholder="/Users/…/Works/project"
								/>
								<Button type="submit" disabled={busy}>
									{move ? "結び直す" : "登録"}
								</Button>
								{move && (
									<Button
										type="button"
										variant="secondary"
										onClick={() => {
											setMove(undefined);
											setPath("");
										}}
									>
										取消
									</Button>
								)}
							</div>
						</form>
						<form
							onSubmit={(e) =>
								perform(
									e,
									() => client.prototypeCreate(name),
									() => setName(""),
								)
							}
						>
							<label htmlFor="works-name">新規作品のフォルダ名</label>
							<div>
								<input
									id="works-name"
									required
									value={name}
									onChange={(e) => setName(e.target.value)}
									placeholder="gravity-playground"
								/>
								<Button type="submit" disabled={busy}>
									作成
								</Button>
							</div>
						</form>
					</div>
					<TrialForm
						environment={environment}
						busy={busy}
						onRegister={(event, input) =>
							perform(event, async () => {
								const work = await client.prototypeTrial(input);
								setOpened((ids) => [...ids, work.id]);
							})
						}
					/>
					<ul className="works-list" aria-label="登録済み作品">
						{projects.map((work) => (
							<li key={work.id}>
								<div>
									<strong>{work.name}</strong>
									{work.trial && <small>試験導入</small>}
									<small>{work.root}</small>
								</div>
								<Button
									disabled={opened.includes(work.id)}
									onClick={() =>
										setOpened((ids) => [...new Set([...ids, work.id])])
									}
								>
									開く
								</Button>
								<Button
									variant="secondary"
									onClick={() => {
										setPath("");
										setMove(work.id);
										document.getElementById("works-folder")?.focus();
									}}
								>
									移設
								</Button>
								{remove === work.id ? (
									<form
										onSubmit={(e) =>
											perform(
												e,
												() => client.prototypeRemove(work.id),
												() => {
													setOpened((ids) =>
														ids.filter((id) => id !== work.id),
													);
													setRemove(undefined);
												},
											)
										}
									>
										<Button type="submit" variant="secondary" disabled={busy}>
											解除を確定
										</Button>
										<Button
											type="button"
											variant="secondary"
											onClick={() => setRemove(undefined)}
										>
											取消
										</Button>
									</form>
								) : (
									<Button
										variant="secondary"
										onClick={() => setRemove(work.id)}
									>
										登録解除
									</Button>
								)}
							</li>
						))}
					</ul>
					<div className="works-previews">
						{projects
							.filter((work) => opened.includes(work.id))
							.map((work) => (
								<Preview
									key={work.id + "/" + work.generation}
									client={client}
									work={work}
									hide={() =>
										setOpened((ids) => ids.filter((id) => id !== work.id))
									}
								/>
							))}
					</div>
				</>
			)}
		</main>
	);
}
