import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { Entry } from "../../../../api/domains/tts-dictionary/contracts";
import type { EumenesClient } from "../../../../client";
import { ApiError } from "../../../../client";

type Draft = Entry & { original: string | null; expectedSpoken: string | null };
const KEY = "tts-dictionary";
const NEW_ROW = "\0new";
const PAGE_SIZE = 90;
const message = (cause: unknown) =>
	cause instanceof ApiError && cause.status === 409
		? "辞書が別の場所で変更されています。最新の登録を読み込みました。"
		: cause instanceof ApiError && cause.status === 400
			? "文字または読み方が不正です（前後の空白・制御文字は使えません）。"
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
	const [adding, setAdding] = useState(false);
	const [search, setSearch] = useState("");
	const [page, setPage] = useState(0);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const newInput = useRef<HTMLInputElement>(null);
	const pending = useRef(false);
	const saveTail = useRef<Promise<void>>(Promise.resolve());

	useEffect(() => {
		entriesRef.current = entries;
		draftsRef.current = drafts;
	});
	useEffect(() => {
		if (adding) newInput.current?.focus();
	}, [adding]);

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
		setDrafts((previous) => ({
			...previous,
			[key]: { ...current, [field]: value },
		}));
		setError("");
	}
	function dropDraft(key: string) {
		setDrafts((previous) => {
			const next = { ...previous };
			delete next[key];
			return next;
		});
	}

	async function save(key: string, applyLatest = false) {
		const draft = draftsRef.current[key];
		if (!draft) return;
		const written = draft.written.trim();
		const spoken = draft.spoken.trim();
		if (!written && !spoken && key === NEW_ROW) return;
		if (!written || (!spoken && key === NEW_ROW)) {
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
		const previous = saveTail.current;
		let release!: () => void;
		saveTail.current = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		pending.current = true;
		setBusy(true);
		try {
			const saved = await client.saveTtsDictionaryEntry({
				original: draft.original,
				entry: { written, spoken },
				expected: {
					spoken: applyLatest
						? (current?.spoken ?? null)
						: draft.expectedSpoken,
				},
			});
			cache.setQueryData(queryKey, saved);
			setDrafts((previousDrafts) => {
				const next = { ...previousDrafts };
				const latest = next[key];
				delete next[key];
				// Edits typed while saving stay as a fresh draft on the saved row.
				if (latest && latest !== draft)
					next[written] = {
						...latest,
						original: written,
						expectedSpoken: spoken,
					};
				return next;
			});
			if (key === NEW_ROW) setAdding(false);
			setError("");
		} catch (cause) {
			setError(message(cause));
			await query.refetch();
		} finally {
			pending.current = false;
			setBusy(false);
			release();
		}
	}

	async function remove(entry: Entry) {
		if (pending.current) return;
		pending.current = true;
		setBusy(true);
		try {
			cache.setQueryData(
				queryKey,
				await client.deleteTtsDictionaryEntry({
					written: entry.written,
					expected: { spoken: entry.spoken },
				}),
			);
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

	const candidates = entries.map((entry) => ({
		key: entry.written,
		entry: entry as Entry | undefined,
	}));
	for (const key of Object.keys(drafts))
		if (key !== NEW_ROW && !entries.some((entry) => entry.written === key))
			candidates.push({ key, entry: undefined });
	const needle = search.toLocaleLowerCase();
	const rows = candidates.filter(({ key, entry }) => {
		const draft = draftFor(key, entry);
		return `${entry?.written ?? ""} ${entry?.spoken ?? ""} ${draft.written} ${draft.spoken}`
			.toLocaleLowerCase()
			.includes(needle);
	});
	const total = rows.length;
	if (adding && !search) rows.push({ key: NEW_ROW, entry: undefined });
	const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
	const currentPage = Math.min(page, pageCount - 1);
	const visibleRows = rows.slice(
		currentPage * PAGE_SIZE,
		(currentPage + 1) * PAGE_SIZE,
	);
	const perTable = Math.max(1, Math.ceil(visibleRows.length / 3));

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
					onClick={() => {
						setSearch("");
						setAdding(true);
						setPage(Math.floor(entries.length / PAGE_SIZE));
					}}
					disabled={adding || busy}
				>
					＋ 行を追加
				</button>
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
									return (
										<tr key={key}>
											<td>
												<input
													ref={key === NEW_ROW ? newInput : undefined}
													aria-label={`${label}の文字`}
													value={draft.written}
													maxLength={200}
													onChange={(event) =>
														edit(key, "written", event.target.value, entry)
													}
													onBlur={(event) => {
														if (
															key === NEW_ROW &&
															(
																event.relatedTarget as HTMLElement | null
															)?.getAttribute("aria-label") === "新規の読み方"
														)
															return;
														void save(key);
													}}
													onKeyDown={(event) => {
														if (event.key === "Enter")
															event.currentTarget.blur();
													}}
												/>
											</td>
											<td>
												<input
													aria-label={`${label}の読み方`}
													value={draft.spoken}
													maxLength={400}
													onChange={(event) =>
														edit(key, "spoken", event.target.value, entry)
													}
													onBlur={() => void save(key)}
													onKeyDown={(event) => {
														if (event.key === "Enter")
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
													aria-label={`${key === NEW_ROW ? "新規行" : label}を削除`}
													disabled={busy}
													onMouseDown={(event) => event.preventDefault()}
													onClick={() => {
														if (entry) void remove(entry);
														else {
															if (key === NEW_ROW) setAdding(false);
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
				{pageCount > 1 && (
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
				)}
			</div>
		</section>
	);
}
