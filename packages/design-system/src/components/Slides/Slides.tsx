import { ChevronLeft, ChevronRight } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useState } from "react";
import { cn } from "../../utils/cn";
import { Button } from "../Button";
import "./Slides.css";

export type SlidesItem = { label: string; content: ReactNode };

export type SlidesProps = {
	title?: string;
	slides: SlidesItem[];
	className?: string;
};

/** 1枚ずつ表示する紙芝居。現在の場面は部品内の表示状態で持ち、他の場面は隠すだけでマウントし続ける。 */
export function Slides({ title, slides, className }: SlidesProps) {
	const [requested, setRequested] = useState(0);
	const count = slides.length;
	const index = Math.min(Math.max(requested, 0), Math.max(count - 1, 0));
	const current = slides[index];
	const go = (next: number) =>
		setRequested(Math.min(Math.max(next, 0), Math.max(count - 1, 0)));

	const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey)
			return;
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
		// 場面の中の入力欄・スライダーは自分で矢印キーを使う。
		const target = event.target as HTMLElement;
		if (
			target.isContentEditable ||
			["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
			target.closest('[role="radiogroup"], [role="slider"]')
		)
			return;
		event.preventDefault();
		go(index + (event.key === "ArrowRight" ? 1 : -1));
	};

	if (!current) return null;
	return (
		// oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- 部品内にフォーカスがあるときの左右キー送り
		<section
			className={cn("ds-slides", className)}
			aria-roledescription="紙芝居"
			aria-label={title ?? "紙芝居"}
			onKeyDown={onKeyDown}
		>
			{title && <h3 className="ds-slides-title">{title}</h3>}
			<div className="ds-slides-stage">
				{/* 全場面をマウントしたまま隠す。場面内の入力や下書きが移動で消えない。 */}
				{slides.map((slide, position) => (
					<div
						key={`${position}-${slide.label}`}
						className="ds-slides-slide"
						role="group"
						aria-roledescription="場面"
						aria-label={`${position + 1} / ${count} ${slide.label}`}
						hidden={position !== index}
					>
						{slide.content}
					</div>
				))}
			</div>
			<div className="ds-slides-controls">
				<Button
					type="button"
					variant="outline"
					size="sm"
					icon={ChevronLeft}
					disabled={index === 0}
					onClick={() => go(index - 1)}
				>
					前へ
				</Button>
				<span className="ds-slides-position" aria-live="polite">
					{index + 1} / {count}
				</span>
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={index === count - 1}
					onClick={() => go(index + 1)}
				>
					次へ
					<ChevronRight className="ml-1 h-4 w-4" aria-hidden="true" />
				</Button>
			</div>
			<div className="ds-slides-dots">
				{slides.map((slide, position) => (
					<button
						key={`${position}-${slide.label}`}
						type="button"
						className="ds-slides-dot"
						aria-label={slide.label}
						aria-current={position === index ? "step" : undefined}
						onClick={() => go(position)}
					/>
				))}
			</div>
		</section>
	);
}
