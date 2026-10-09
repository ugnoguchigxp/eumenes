import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FocusEvent, useEffect, useRef, useState } from "react";
import type { Entry } from "../../../../api/domains/tts-dictionary/contracts";
import type { EumenesClient } from "../../../../client";
import { ApiError } from "../../../../client";
import { queryRoots } from "../../queryKeys";

type Draft = Entry & { original: string | null; expectedSpoken: string | null };
const KEY = queryRoots.ttsDictionary;
const NEW_ROW = "\0new";
const COLUMNS = 3;
const ROW_HEIGHT = 38;
// Header, toolbar, hint and pager take roughly this much vertical space.
const CHROME_HEIGHT = 340;
const isNewRow = (key: string) => key.startsWith(NEW_ROW);
const fitRows = () =>
	Math.max(8, Math.floor((window.innerHeight - CHROME_HEIGHT) / ROW_HEIGHT));
const message = (cause: unknown) =>
	cause instanceof ApiError && cause.status === 409
		? "辞書が別の場所で変更されています。最新の登録を読み込みました。"
		: cause instanceof ApiError && cause.status === 400
			? "文字または読み方が不正です（前後の空白・制御文字、句読点や . , ; ! ? を含む文字は使えません）。"
			: "辞書を更新できません。APIの接続を確認してください。";

export function TtsDictionaryPanel({ client }: { client: EumenesClient }) {
	const cache = useQueryClient();
	const queryKey = [KEY, client.identity];
	const query = useQuery({
		queryKey,
		queryFn: () => client.ttsDictionary(),
		retry: 0,
		refetchOnWindowFocus: true,
	});
	const entries = query.data ?? [];
	const entriesRef = useRef(entries);
	const [drafts, setDrafts] = useState<Record<string, Draft>>({});
	const draftsRef = useRef(drafts);
	const [perColumn, setPerColumn] = useState(fitRows);
	const [search, setSearch] = useState("");
	const [page, setPage] = useState(0);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const pending = useRef(false);
	const saveTail = useRef<Promise<void>>(Promise.resolve());

	useEffect(() => {
		entriesRef.current = entries;
		draftsRef.current = drafts;
	});
	useEffect(() => {
		const resize = () => setPerColumn(fitRows());
		window.addEventListener("resize", resize);
		return () => window.removeEventListener("resize", resize);
	}, []);

	function draftFor(key: string, entry?: Entry): Draft {
		return (
			drafts[key] ?? {
				original: entry?.written ?? null,
				expectedSpoken: entry?.spoken ?? null,
				written: entry?.written ?? "",
				spoken: entry?.spoken ?? "",
			}
		);
	}
	function edit(
		key: string,
		field: "written" | "spoken",
		value: string,
		entry?: Entry,
	) {
		const current = draftFor(key, entry);
		commitDrafts({
			...draftsRef.current,
			[key]: { ...current, [field]: value },
		});
		setError("");
	}
	// Refs are written synchronously so queued saves never read pre-save state.
	function commitDrafts(next: Record<string, Draft>) {
		draftsRef.current = next;
		setDrafts(next);
	}
	function dropDraft(key: string) {
		const next = { ...draftsRef.current };
		delete next[key];
		commitDrafts(next);
	}

	async function save(key: string, applyLatest = false) {
		if (!draftsRef.current[key]) return;
		// Wait for earlier saves first, then validate against what they left behind.
		const previous = saveTail.current;
		let release!: () => void;
		saveTail.current = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			const draft = draftsRef.current[key];
			if (!draft) return;
			const written = draft.written.trim();
			const spoken = draft.spoken.trim();
			if (!written && !spoken && isNewRow(key)) return;
			if (!written || !spoken) {
				setError("文字と読み方を入力してください。");
				return;
			}
			if (
				entriesRef.current.some(
					(item) => item.written === written && item.written !== draft.original,
				)
			) {
				setError(`「${written}」は登録済みです。`);
				return;
			}
			const current = entriesRef.current.find(
				(item) => item.written === draft.original,
			);
			if (!applyLatest && draft.expectedSpoken !== (current?.spoken ?? null)) {
				setError(
					`「${draft.original ?? written}」が変更されています。行の操作で解決してください。`,
				);
				return;
			}
			if (draft.original === written && current?.spoken === spoken) {
				dropDraft(key);
				return;
			}
			pending.current = true;
			setBusy(true);
			try {
				await cache.cancelQueries({ queryKey });
				const saved = await client.saveTtsDictionaryEntry({
					original: draft.original,
					entry: { written, spoken },
					expected: {
						spoken: applyLatest
							? (current?.spoken ?? null)
							: draft.expectedSpoken,
					},
				});
				entriesRef.current = saved;
				cache.setQueryData(queryKey, saved);
				const next = { ...draftsRef.current };
				const latest = next[key];
				delete next[key];
				// Edits typed while saving stay as a fresh draft on the saved row.
				if (latest && latest !== draft)
					next[written] = {
						...latest,
						original: written,
						expectedSpoken: spoken,
					};
				commitDrafts(next);
				setError("");
			} catch (cause) {
				setError(message(cause));
				await query.refetch();
			} finally {
				pending.current = false;
				setBusy(false);
			}
		} finally {
			release();
		}
	}

	// Moving between the two cells of a new row must not complain about the half-filled row.
	function leave(event: FocusEvent<HTMLInputElement>, key: string) {
		const next = event.relatedTarget as HTMLElement | null;
		if (isNewRow(key) && next?.dataset.row === key) return;
		void save(key);
	}

	async function remove(entry: Entry) {
		if (pending.current) return;
		pending.current = true;
		setBusy(true);
		try {
			await cache.cancelQueries({ queryKey });
			const saved = await client.deleteTtsDictionaryEntry({
				written: entry.written,
				expected: { spoken: entry.spoken },
			});
			entriesRef.current = saved;
			cache.setQueryData(queryKey, saved);
			dropDraft(entry.written);
			setError("");
		} catch (cause) {
			setError(message(cause));
			await query.refetch();
		} finally {
			pending.current = false;
			setBusy(false);
		}
	}

	const dirtyKeys = Object.keys(drafts).filter((key) => {
		const draft = drafts[key]!;
		const entry = entries.find((item) => item.written === draft.original);
		return (
			draft.written.trim() !== (entry?.written ?? "") ||
			draft.spoken.trim() !== (entry?.spoken ?? "")
		);
	});
	async function saveAll() {
		for (const key of dirtyKeys) await save(key);
	}

	const candidates = entries.map((entry) => ({
		key: entry.written,
		entry: entry as Entry | undefined,
	}));
	for (const key of Object.keys(drafts))
		if (!isNewRow(key) && !entries.some((entry) => entry.written === key))
			candidates.push({ key, entry: undefined });
	const needle = search.toLocaleLowerCase();
	const rows = candidates.filter(({ key, entry }) => {
		const draft = draftFor(key, entry);
		return `${entry?.written ?? ""} ${entry?.spoken ?? ""} ${draft.written} ${draft.spoken}`
			.toLocaleLowerCase()
			.includes(needle);
	});
	const total = rows.length;
	const pageSize = perColumn * COLUMNS;
	// Empty slots fill the rest of the page so cells can be typed into directly.
	const pageCount = search
		? Math.max(1, Math.ceil(total / pageSize))
		: Math.floor(total / pageSize) + 1;
	const currentPage = Math.min(page, pageCount - 1);
	const visibleRows = rows.slice(
		currentPage * pageSize,
		(currentPage + 1) * pageSize,
	);
	if (!search)
		for (
			let position = Math.max(total, currentPage * pageSize);
			position < (currentPage + 1) * pageSize;
			position++
		)
			visibleRows.push({
				key: `${NEW_ROW}:${position - total}`,
				entry: undefined,
			});
	const perTable = perColumn;

	return (
		<section className="tts-dictionary-page" aria-label="TTS辞書">
			<div className="tts-dictionary-toolbar">
				<input
					aria-label="辞書を検索"
					placeholder="文字・読み方を検索"
					value={search}
					onChange={(event) => {
						setSearch(event.target.value);
						setPage(0);
					}}
				/>
				<button
					type="button"
					onMouseDown={(event) => event.preventDefault()}
					onClick={() => void saveAll()}
					disabled={busy || dirtyKeys.length === 0}
				>
					保存
				</button>
				<output>
					{busy
						? "保存中…"
						: dirtyKeys.length > 0
							? `未保存の変更が${dirtyKeys.length}件あります`
							: "すべて保存済み"}
				</output>
			</div>
			{(error || query.isError) && (
				<p className="tts-dictionary-error" role="alert">
					{error || "辞書を読み込めません。APIの接続を確認してください。"}
				</p>
			)}
			<div className="tts-dictionary-tables">
				{Array.from({ length: 3 }, (_, index) => (
					<table key={index} aria-label={`辞書 ${index + 1}`}>
						<thead>
							<tr>
								<th>文字</th>
								<th>読み方</th>
								<th>削除</th>
							</tr>
						</thead>
						<tbody>
							{visibleRows
								.slice(index * perTable, (index + 1) * perTable)
								.map(({ key, entry }) => {
									const draft = draftFor(key, entry);
									const conflict =
										!!drafts[key] &&
										draft.expectedSpoken !== (entry?.spoken ?? null);
									const label = entry?.written ?? draft.original ?? "新規";
									const slot = isNewRow(key)
										? Number(key.split(":")[1]) + 1
										: 0;
									return (
										<tr key={key}>
											<td>
												<input
													data-row={key}
													aria-label={`${isNewRow(key) ? `新規${slot}` : label}の文字`}
													value={draft.written}
													maxLength={200}
													onChange={(event) =>
														edit(key, "written", event.target.value, entry)
													}
													onBlur={(event) => leave(event, key)}
													onKeyDown={(event) => {
														if (
															event.key === "Enter" &&
															!event.nativeEvent.isComposing &&
															event.keyCode !== 229
														)
															event.currentTarget.blur();
													}}
												/>
											</td>
											<td>
												<input
													data-row={key}
													aria-label={`${isNewRow(key) ? `新規${slot}` : label}の読み方`}
													value={draft.spoken}
													maxLength={400}
													onChange={(event) =>
														edit(key, "spoken", event.target.value, entry)
													}
													onBlur={(event) => leave(event, key)}
													onKeyDown={(event) => {
														if (
															event.key === "Enter" &&
															!event.nativeEvent.isComposing &&
															event.keyCode !== 229
														)
															event.currentTarget.blur();
													}}
												/>
												{conflict && (
													<div className="tts-dictionary-conflict" role="alert">
														<span>
															{entry
																? `現在の読み: ${entry.spoken || "（読み飛ばし）"}`
																: "この登録は削除されています"}
														</span>
														<button
															type="button"
															disabled={busy}
															onMouseDown={(event) => event.preventDefault()}
															onClick={() => dropDraft(key)}
														>
															最新を使う
														</button>
														<button
															type="button"
															disabled={busy}
															onMouseDown={(event) => event.preventDefault()}
															onClick={() => void save(key, true)}
														>
															編集を適用
														</button>
													</div>
												)}
											</td>
											<td>
												<button
													type="button"
													aria-label={`${isNewRow(key) ? `新規${slot}` : label}を削除`}
													disabled={busy}
													onMouseDown={(event) => event.preventDefault()}
													onClick={() => {
														if (entry) void remove(entry);
														else {
															setError("");
															dropDraft(key);
														}
													}}
												>
													×
												</button>
											</td>
										</tr>
									);
								})}
						</tbody>
					</table>
				))}
			</div>
			<div className="tts-dictionary-count">
				<span>{total}件</span>
				{
					<nav aria-label="辞書のページ">
						<button
							type="button"
							disabled={currentPage === 0}
							onClick={() => setPage(currentPage - 1)}
						>
							前へ
						</button>
						<span>
							{currentPage + 1} / {pageCount}
						</span>
						<button
							type="button"
							disabled={currentPage === pageCount - 1}
							onClick={() => setPage(currentPage + 1)}
						>
							次へ
						</button>
					</nav>
				}
			</div>
		</section>
	);
}
