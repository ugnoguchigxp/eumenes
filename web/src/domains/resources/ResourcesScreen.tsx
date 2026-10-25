import { Input } from "@eumenes/design-system";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { EumenesClient } from "../../../../client";
import { queryRoots } from "../../queryKeys";
import { resourcesApiFor } from "./api";
import { KindIcon } from "./kind-icon";
import "./ResourcesScreen.css";

const DAY_MS = 24 * 60 * 60 * 1000;
const PERIODS = [
	{ id: "all", label: "すべての期間", ms: 0 },
	{ id: "day", label: "今日", ms: DAY_MS },
	{ id: "week", label: "7日以内", ms: 7 * DAY_MS },
	{ id: "month", label: "30日以内", ms: 30 * DAY_MS },
] as const;
type PeriodId = (typeof PERIODS)[number]["id"];

const SEARCH_DELAY_MS = 250;

const dateOf = (iso: string) =>
	new Date(iso).toLocaleDateString("ja-JP", {
		month: "numeric",
		day: "numeric",
	});

/**
 * 「生成物」: every resource, newest first, narrowed by a search text, a kind and a period.
 * A row opens the resource the way a link in the conversation does.
 */
export function ResourcesScreen({
	client,
	onOpen,
}: {
	client: EumenesClient;
	onOpen: (uri: string) => void;
}) {
	const [text, setText] = useState("");
	const [query, setQuery] = useState("");
	const [kind, setKind] = useState("");
	const [period, setPeriod] = useState<PeriodId>("all");
	useEffect(() => {
		const timer = setTimeout(() => setQuery(text.trim()), SEARCH_DELAY_MS);
		return () => clearTimeout(timer);
	}, [text]);
	const list = useQuery({
		queryKey: [
			queryRoots.resources,
			client.identity,
			"search",
			query,
			kind,
			period,
		],
		queryFn: ({ signal }) => {
			const ms = PERIODS.find((p) => p.id === period)?.ms ?? 0;
			return resourcesApiFor(client).search(
				{
					query,
					kind,
					since: ms ? new Date(Date.now() - ms).toISOString() : undefined,
				},
				signal,
			);
		},
		placeholderData: keepPreviousData,
		retry: false,
	});
	// Kinds are not listed by the API: the filter offers those seen so far, folded in as lists arrive.
	const resources = list.data?.resources;
	const [seen, setSeen] = useState<{
		from: typeof resources;
		kinds: ReadonlyMap<string, string>;
	}>({ from: undefined, kinds: new Map() });
	if (resources && seen.from !== resources) {
		const kinds = new Map(seen.kinds);
		for (const r of resources) kinds.set(r.kind, r.kindLabel);
		setSeen({ from: resources, kinds });
	}
	return (
		<section className="resources-screen" aria-label="生成物">
			<div className="resources-filters">
				<Input
					type="search"
					aria-label="生成物を検索"
					placeholder="名前や内容で探す"
					value={text}
					onChange={(event) => setText(event.target.value)}
				/>
				<select
					aria-label="種類"
					value={kind}
					onChange={(event) => setKind(event.target.value)}
				>
					<option value="">すべての種類</option>
					{[...seen.kinds].map(([id, label]) => (
						<option key={id} value={id}>
							{label}
						</option>
					))}
				</select>
				<select
					aria-label="期間"
					value={period}
					onChange={(event) => setPeriod(event.target.value as PeriodId)}
				>
					{PERIODS.map((p) => (
						<option key={p.id} value={p.id}>
							{p.label}
						</option>
					))}
				</select>
			</div>
			{list.isError && <p role="alert">生成物の一覧を取得できませんでした。</p>}
			{list.isPending && <output>読み込んでいます。</output>}
			{resources && !resources.length && (
				<p className="resources-empty">該当する生成物はありません。</p>
			)}
			{resources?.length ? (
				<ul className="resources-list">
					{resources.map((resource) => (
						<li key={resource.uri}>
							<button
								type="button"
								className="resources-row"
								aria-label={`${resource.kindLabel} ${resource.label}を開く`}
								onClick={() => onOpen(resource.uri)}
							>
								<span className="resources-row-icon">
									<KindIcon kind={resource.kind} />
								</span>
								<span className="resources-row-label">{resource.label}</span>
								<span className="resources-row-kind">{resource.kindLabel}</span>
								<time dateTime={resource.createdAt}>
									{dateOf(resource.createdAt)}
								</time>
							</button>
						</li>
					))}
				</ul>
			) : null}
		</section>
	);
}
