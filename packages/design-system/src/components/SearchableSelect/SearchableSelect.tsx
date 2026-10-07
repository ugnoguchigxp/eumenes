import * as React from "react";
import { Input } from "@/components/Input";
import { cn } from "@/utils/cn";

export interface Option {
	label: string;
	value: string;
}

export interface SearchableSelectProps {
	options: Option[];
	value?: string;
	onChange?: (value: string) => void;
	placeholder?: string;
	className?: string;
	id?: string;
	name?: string;
	disabled?: boolean;
	required?: boolean;
	noResultsText?: string;
}

export const SearchableSelect = React.forwardRef<
	HTMLInputElement,
	SearchableSelectProps
>(
	(
		{
			options,
			value,
			onChange,
			placeholder,
			className,
			id,
			name,
			disabled = false,
			required = false,
			noResultsText = "No results",
		},
		ref,
	) => {
		const containerRef = React.useRef<HTMLDivElement>(null);
		const listboxId = React.useId();

		const selectedOptionLabel = React.useMemo(() => {
			return options.find((opt) => opt.value === value)?.label ?? "";
		}, [options, value]);

		const [query, setQuery] = React.useState(selectedOptionLabel);
		const [isOpen, setIsOpen] = React.useState(false);
		const [activeIndex, setActiveIndex] = React.useState<number>(-1);

		const lastValueRef = React.useRef(value);
		const justCommittedValueRef = React.useRef<string | null>(null);

		React.useEffect(() => {
			if (value !== lastValueRef.current) {
				lastValueRef.current = value;
				justCommittedValueRef.current = null;
				if (!isOpen) setQuery(selectedOptionLabel);
			}
		}, [isOpen, selectedOptionLabel, value]);

		React.useEffect(() => {
			if (!isOpen) {
				if (justCommittedValueRef.current) return;
				setQuery(selectedOptionLabel);
			}
		}, [isOpen, selectedOptionLabel]);

		const filteredOptions = React.useMemo(() => {
			const q = query.trim().toLowerCase();
			if (!q) return options;
			return options.filter((opt) => {
				const label = opt.label.toLowerCase();
				const val = opt.value.toLowerCase();
				return label.includes(q) || val.includes(q);
			});
		}, [options, query]);

		React.useEffect(() => {
			if (!isOpen) return;
			setActiveIndex(filteredOptions.length ? 0 : -1);
		}, [isOpen, filteredOptions.length]);

		React.useEffect(() => {
			if (!isOpen) return;
			const onMouseDown = (event: MouseEvent) => {
				const target = event.target as Node | null;
				if (
					target &&
					containerRef.current &&
					!containerRef.current.contains(target)
				) {
					setIsOpen(false);
				}
			};
			document.addEventListener("mousedown", onMouseDown);
			return () => document.removeEventListener("mousedown", onMouseDown);
		}, [isOpen]);

		const commitSelection = React.useCallback(
			(opt: Option) => {
				justCommittedValueRef.current = opt.value;
				onChange?.(opt.value);
				setQuery(opt.label);
				setIsOpen(false);
			},
			[onChange],
		);

		const handleBlur = () => {
			setTimeout(() => {
				if (!containerRef.current) return;
				if (containerRef.current.contains(document.activeElement)) return;
				setIsOpen(false);
			}, 0);
		};

		const handleKeyDown: React.KeyboardEventHandler<HTMLInputElement> = (e) => {
			if (disabled) return;

			if (e.key === "ArrowDown") {
				e.preventDefault();
				setIsOpen(true);
				setActiveIndex((idx) => Math.min(idx + 1, filteredOptions.length - 1));
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setIsOpen(true);
				setActiveIndex((idx) => Math.max(idx - 1, 0));
				return;
			}
			if (e.key === "Enter") {
				if (!isOpen) return;
				e.preventDefault();
				const opt = filteredOptions[activeIndex];
				if (opt) commitSelection(opt);
				return;
			}
			if (e.key === "Escape") {
				if (!isOpen) return;
				e.preventDefault();
				setIsOpen(false);
				return;
			}
		};

		return (
			<div className="relative" ref={containerRef}>
				<Input
					ref={ref}
					id={id}
					name={name}
					disabled={disabled}
					required={required}
					value={query}
					placeholder={placeholder}
					autoComplete="off"
					aria-label={placeholder}
					role="combobox"
					aria-expanded={isOpen}
					aria-controls={listboxId}
					aria-autocomplete="list"
					className={cn(className)}
					onFocus={() => !disabled && setIsOpen(true)}
					onBlur={handleBlur}
					onKeyDown={handleKeyDown}
					onChange={(e) => {
						setQuery(e.target.value);
						if (!disabled) setIsOpen(true);
					}}
				/>

				{isOpen && (
					<div
						id={listboxId}
						role="listbox"
						className={cn(
							"absolute z-50 mt-1 w-full overflow-auto rounded-md border border-border bg-background shadow-lg",
							"max-h-60",
						)}
					>
						{filteredOptions.length === 0 ? (
							<div className="px-3 py-2 text-sm text-muted-foreground">
								{noResultsText}
							</div>
						) : (
							filteredOptions.map((opt, idx) => (
								<button
									key={opt.value}
									type="button"
									role="option"
									aria-selected={idx === activeIndex}
									className={cn(
										"w-full px-3 py-2 text-left text-sm text-foreground",
										"hover:bg-accent hover:text-accent-foreground focus:outline-none",
										idx === activeIndex && "bg-accent text-accent-foreground",
									)}
									onMouseDown={(e) => e.preventDefault()}
									onMouseEnter={() => setActiveIndex(idx)}
									onClick={() => commitSelection(opt)}
								>
									{opt.label}
								</button>
							))
						)}
					</div>
				)}
			</div>
		);
	},
);
SearchableSelect.displayName = "SearchableSelect";

export default SearchableSelect;
