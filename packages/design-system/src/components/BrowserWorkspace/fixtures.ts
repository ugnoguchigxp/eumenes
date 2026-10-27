import type {
	BrowserCaptureItem,
	BrowserHistoryDetail,
	BrowserHistorySummary,
	BrowserReplayItem,
	BrowserTabItem,
	BrowserTaskItem,
} from "./types";

export const sampleTabs: BrowserTabItem[] = [
	{
		tabRef: "t1",
		title: "天気予報",
		url: "https://example.com/weather",
		active: true,
		status: "busy",
		currentTaskLabel: "明日の天気を調べる",
	},
	{
		tabRef: "t2",
		title: "ニュース",
		url: "https://example.com/news",
		active: false,
		status: "open",
	},
	{
		tabRef: "t3",
		title: "フォーム",
		url: "https://example.com/form",
		active: false,
		status: "lost",
	},
	{
		tabRef: "t4",
		title: "旧ページ",
		url: "https://example.com/old",
		active: false,
		status: "closed",
	},
	{
		tabRef: "t5",
		title: "保護されたページ",
		url: "",
		active: false,
		status: "blocked",
	},
];

export const sampleTasks: BrowserTaskItem[] = [
	{
		taskId: "k1",
		requestSummary: "明日の天気を調べる",
		state: "running",
		history: {
			historyId: "h1",
			title: "YouTubeで検索し、結果からランダムに再生する",
		},
		script: {
			revision: 1,
			title: "YouTubeで検索し、結果からランダムに再生する",
			historyId: "h1",
			variables: [{ name: "keyword", label: "検索語", value: "猫 癒し" }],
			summary: "対象地域の予報を開き、明日の天気を確認します。",
			updatedAt: 1792454400000,
			history: [],
			steps: [
				{
					stepId: "weather",
					label: "明日の予報を確認",
					expectation: "地域と日付に合う予報が表示される",
					state: "running",
				},
				{
					stepId: "report",
					label: "天気を伝える",
					expectation: "予報を確認して回答する",
					state: "pending",
				},
			],
		},
	},
	{
		taskId: "k2",
		requestSummary: "ニュースの見出しを読む",
		state: "completed",
		resultSummary: "見出しを3件確認しました。",
	},
	{
		taskId: "k3",
		requestSummary: "フォームに入力する",
		state: "needs_input",
		resultSummary: "住所の入力で止まっています。",
	},
	{ taskId: "k4", requestSummary: "予約を確認する", state: "indeterminate" },
];

export const sampleCaptures: BrowserCaptureItem[] = [
	{
		captureId: "c1",
		range: "viewport",
		capturedAt: "2026-10-18T01:00:00Z",
		width: 1280,
		height: 720,
		bytes: 52_300,
		reductionPercent: 86.4,
		state: "local_ready",
	},
	{
		captureId: "c2",
		range: "full-page",
		capturedAt: "2026-10-18T01:05:00Z",
		width: 1280,
		height: 2400,
		bytes: 0,
		reductionPercent: 0,
		state: "encoding",
	},
	{
		captureId: "c3",
		range: "element",
		capturedAt: "2026-10-18T01:10:00Z",
		width: 300,
		height: 200,
		bytes: 0,
		reductionPercent: 0,
		state: "failed",
	},
];

const youtubeHistory: BrowserHistorySummary = {
	historyId: "h1",
	revision: 3,
	title: "YouTubeで検索し、結果からランダムに再生する",
	request: "おすすめの動画を再生して",
	place: "www.youtube.com",
	variables: [{ name: "keyword", label: "検索語" }],
	stepCount: 2,
	runCount: 3,
	failureCount: 0,
	lastOutcome: "completed",
	hasCommit: false,
	lastUsedAt: 1792454400000,
	createdAt: 1792368000000,
	updatedAt: 1792454400000,
	replay: { blocked: null, blockedLabel: null },
};

const formHistory: BrowserHistorySummary = {
	historyId: "h2",
	revision: 1,
	title: "予約フォームに入力して送信する",
	request: "{{date}}の予約を入れて",
	place: "example.com",
	variables: [],
	stepCount: 3,
	runCount: 1,
	failureCount: 1,
	lastOutcome: "failed",
	hasCommit: true,
	lastUsedAt: 1792368000000,
	createdAt: 1792368000000,
	updatedAt: 1792368000000,
	replay: { blocked: null, blockedLabel: null },
};

export const sampleHistories: BrowserHistorySummary[] = [
	youtubeHistory,
	formHistory,
];

export const sampleReplays: Record<
	"running" | "completed" | "failed" | "cancelled",
	BrowserReplayItem
> = {
	running: {
		replayId: "r1",
		historyId: "h1",
		state: "running",
		startedAt: 1792454400000,
	},
	completed: {
		replayId: "r2",
		historyId: "h1",
		state: "completed",
		startedAt: 1792454400000,
		endedAt: 1792454410000,
	},
	failed: {
		replayId: "r3",
		historyId: "h1",
		state: "failed",
		errorLabel:
			"時間内に終わりませんでした（要素が見つからない可能性があります）",
		startedAt: 1792454400000,
		endedAt: 1792454460000,
	},
	cancelled: {
		replayId: "r4",
		historyId: "h1",
		state: "cancelled",
		startedAt: 1792454400000,
		endedAt: 1792454405000,
	},
};

export const sampleHistoryDetail: BrowserHistoryDetail = {
	...youtubeHistory,
	steps: [
		{
			label: "YouTubeで検索する",
			expectation: "検索結果の一覧が表示される",
		},
		{ label: "動画を再生する", expectation: "再生画面が表示される" },
	],
	actions: [
		{
			seq: 1,
			kind: "navigate",
			stepLabel: "YouTubeで検索する",
			url: "https://www.youtube.com/",
			place: "www.youtube.com/",
			code: "await page.goto('https://www.youtube.com/');",
		},
		{
			seq: 2,
			kind: "type",
			stepLabel: "YouTubeで検索する",
			element: "検索ボックス",
			variable: "keyword",
			purpose: "検索語",
			effect: "input",
			place: "www.youtube.com/",
			code: "await page.getByRole('combobox', { name: '検索' }).fill(keyword);",
		},
		{
			seq: 3,
			kind: "click",
			stepLabel: "動画を再生する",
			element: "<script>alert(1)</script>の動画",
			place: "www.youtube.com/watch",
		},
	],
	replay: {
		code: `async (page) => {
  await page.goto('https://www.youtube.com/');
  await page.getByRole('combobox', { name: '検索' }).fill(vars.keyword);
}`,
		blocked: null,
		blockedLabel: null,
	},
	source: `import { test } from '@playwright/test';

test('YouTubeで検索し、結果からランダムに再生する', async ({ page }) => {
  const keyword = '';
  await page.goto('https://www.youtube.com/');
  await page.getByRole('combobox', { name: '検索' }).fill(keyword);
});
`,
};
