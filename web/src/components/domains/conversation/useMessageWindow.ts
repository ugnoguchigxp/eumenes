import {
	useCallback,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type RefObject,
} from "react";
import type { Message } from "../../../../../api/domains/conversation/contracts";

const PAGE_SIZE = 20;
const NO_MESSAGES: Message[] = [];

/** Keep the first displayed message while reading, and compensate for prepended history. */
export function useMessageWindow(
	conversationId: string | undefined,
	input: Message[] | undefined,
	streaming: boolean,
	historyRef?: RefObject<HTMLDivElement | null>,
	followLatest?: boolean,
) {
	const messages = input ?? NO_MESSAGES;
	const listRef = useRef<HTMLDivElement>(null);
	const all = useMemo(
		() => messages.filter((message) => message.presentation !== "artifact"),
		[messages],
	);
	const [start, setStart] = useState<{
		conversationId: string | undefined;
		id: string;
	} | null>(null);
	const retained = useMemo(
		() =>
			start?.conversationId === conversationId
				? all.findIndex((message) => message.id === start?.id)
				: -1,
		[all, start, conversationId],
	);
	const hidden =
		retained >= 0
			? retained
			: Math.max(0, all.length + (streaming ? 1 : 0) - PAGE_SIZE);
	const rows = useMemo(() => {
		if (!hidden) return messages;
		const first = all[hidden];
		return first ? messages.slice(messages.indexOf(first)) : [];
	}, [messages, all, hidden]);
	const pending = useRef<{
		root: HTMLDivElement;
		top: number;
		height: number;
	} | null>(null);
	const showOlder = useCallback(() => {
		const first = all[Math.max(0, hidden - PAGE_SIZE)];
		if (!first || !hidden) return;
		const root = historyRef?.current;
		const list = listRef.current;
		if (root && list)
			pending.current = {
				root,
				top: root.scrollTop,
				height: list.getBoundingClientRect().height,
			};
		setStart({ conversationId, id: first.id });
	}, [all, hidden, historyRef, conversationId]);
	useLayoutEffect(() => {
		const previous = pending.current;
		const list = listRef.current;
		if (!previous || !list) return;
		pending.current = null;
		previous.root.scrollTop =
			previous.top + list.getBoundingClientRect().height - previous.height;
	}, [rows]);
	// Adjust the retained range before committing a change of reading mode.
	if (
		start &&
		(followLatest === true || start.conversationId !== conversationId)
	)
		setStart(null);
	else if (followLatest === false && !start && all[hidden])
		setStart({ conversationId, id: all[hidden].id });
	useLayoutEffect(() => {
		const root = historyRef?.current;
		if (!root || followLatest !== false || !hidden) return;
		const load = () => {
			if (root.scrollTop <= 120) showOlder();
		};
		root.addEventListener("scroll", load, { passive: true });
		// The first gesture may already have reached the top before this listener attaches.
		load();
		return () => root.removeEventListener("scroll", load);
	}, [historyRef, followLatest, hidden, showOlder]);
	return { all, rows, hidden, showOlder, listRef };
}
