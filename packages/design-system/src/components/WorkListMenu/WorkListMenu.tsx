import { useEffect, useRef, useState } from "react";
import { List, X } from "lucide-react";
import { Button } from "../Button";
import { Popover, PopoverContent, PopoverTrigger } from "../Popover";
import { menuKeyDown } from "../../utils/menuKeyboard";
export type WorkListItem = { id: string; label: string; status: string };
export type WorkListMenuProps = {
	items: readonly WorkListItem[];
	selectedId?: string;
	loading?: boolean;
	hasMore?: boolean;
	onSelect: (id: string) => void;
	onLoadMore?: () => void;
};
/** Compact history trigger; its anchored list overlays the surrounding artifact. */
export function WorkListMenu({
	items,
	selectedId,
	loading,
	hasMore,
	onSelect,
	onLoadMore,
}: WorkListMenuProps) {
	const [open, setOpen] = useState(false),
		trigger = useRef<HTMLButtonElement>(null),
		first = useRef<HTMLButtonElement>(null);
	const [availableWidth, setAvailableWidth] = useState<number>();
	const closeButton = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		const parent = trigger.current?.parentElement;
		if (!parent) return;
		const update = () => {
			const width = parent.getBoundingClientRect().width;
			if (width > 0) setAvailableWidth(width);
		};
		update();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(update);
		observer.observe(parent);
		return () => observer.disconnect();
	}, []);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					ref={trigger}
					variant="outline"
					size="sm"
					aria-haspopup="menu"
					aria-expanded={open}
				>
					<List size={16} aria-hidden="true" />
					仕事一覧
				</Button>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				style={{ maxWidth: availableWidth }}
				className="w-[min(25rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] p-3"
				onOpenAutoFocus={(e) => {
					e.preventDefault();
					(first.current ?? closeButton.current)?.focus();
				}}
				onCloseAutoFocus={(e) => {
					e.preventDefault();
					trigger.current?.focus();
				}}
			>
				<div className="mb-3 flex items-center justify-between gap-2">
					<strong>依頼した仕事</strong>
					<Button
						ref={closeButton}
						size="icon"
						variant="ghost"
						aria-label="仕事一覧を閉じる"
						onClick={() => setOpen(false)}
					>
						<X size={16} />
					</Button>
				</div>
				<div
					role="menu"
					tabIndex={-1}
					aria-label="依頼した仕事"
					onKeyDown={menuKeyDown}
					className="max-h-80 overflow-y-auto space-y-1"
				>
					{items.map((item, index) => (
						<button
							ref={index === 0 ? first : undefined}
							key={item.id}
							type="button"
							role="menuitem"
							aria-current={item.id === selectedId ? "true" : undefined}
							className={`w-full rounded-md px-3 py-3 text-left focus-visible:outline focus-visible:outline-2 ${item.id === selectedId ? "bg-accent text-accent-foreground" : "hover:bg-muted"}`}
							onClick={() => {
								onSelect(item.id);
								setOpen(false);
							}}
						>
							<span className="block break-words">{item.label}</span>
							<small className="text-muted-foreground">{item.status}</small>
						</button>
					))}
					{!items.length && (
						<p className="p-3 text-muted-foreground">
							{loading ? "読み込み中…" : "依頼した仕事はありません"}
						</p>
					)}
					{hasMore && (
						<Button variant="ghost" disabled={loading} onClick={onLoadMore}>
							さらに表示
						</Button>
					)}
				</div>
			</PopoverContent>
		</Popover>
	);
}
