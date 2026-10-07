import { ChevronDown } from "lucide-react";
import * as React from "react";
import {
	type SelectItemVariants,
	type SelectTriggerVariants,
	selectItemVariants,
	selectTriggerVariants,
} from "@/components/Select/selectVariants";
import { cn } from "@/utils/cn";

export interface IEditableSelectProps {
	value: string | number;
	onChange: (value: string) => void;
	options: (string | number)[];
	className?: string;
	placeholder?: string;
	disabled?: boolean;
	/** Visual variant (matches `SelectTrigger`) */
	variant?: SelectTriggerVariants["variant"];
	/** Size variant (matches `SelectTrigger`) */
	size?: SelectTriggerVariants["size"];
}

export const EditableSelect = React.forwardRef<
	HTMLInputElement,
	IEditableSelectProps
>(
	(
		{
			value,
			onChange,
			options,
			className,
			placeholder,
			disabled = false,
			variant = "default",
			size = "md",
		},
		ref,
	) => {
		const [isOpen, setIsOpen] = React.useState(false);
		const containerRef = React.useRef<HTMLDivElement>(null);

		React.useEffect(() => {
			const handleClickOutside = (event: MouseEvent) => {
				if (
					containerRef.current &&
					!containerRef.current.contains(event.target as Node)
				) {
					setIsOpen(false);
				}
			};

			document.addEventListener("mousedown", handleClickOutside);
			return () =>
				document.removeEventListener("mousedown", handleClickOutside);
		}, []);

		const handleOptionClick = (option: string | number) => {
			onChange(String(option));
			setIsOpen(false);
		};

		return (
			<div className={cn("relative", className)} ref={containerRef}>
				<div
					className={cn(
						selectTriggerVariants({ variant, size }),
						"cursor-text",
						"focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2",
						disabled && "pointer-events-none",
					)}
					aria-disabled={disabled}
				>
					<input
						ref={ref}
						type="text"
						value={value}
						onChange={(e) => onChange(e.target.value)}
						placeholder={placeholder}
						disabled={disabled}
						className={cn(
							"w-full bg-transparent border-none text-foreground text-left appearance-none focus:outline-none p-0 m-0",
							"placeholder:text-muted-foreground",
						)}
						onFocus={() => setIsOpen(true)}
					/>
					<button
						type="button"
						onClick={() => setIsOpen((v) => !v)}
						className={cn(
							"inline-flex items-center justify-center rounded",
							"text-muted-foreground hover:bg-accent focus:outline-none",
						)}
						tabIndex={-1}
						aria-label="Toggle options"
					>
						<ChevronDown
							className={cn(size === "lg" ? "h-5 w-5" : "h-4 w-4")}
						/>
					</button>
				</div>

				{isOpen && (
					<div className="absolute z-50 w-full mt-1 max-h-60 overflow-y-auto bg-background border border-border rounded-md shadow-lg scrollbar-thin">
						{options.map((option) => (
							<button
								key={option}
								type="button"
								onClick={() => handleOptionClick(option)}
								className={cn(
									selectItemVariants({
										size: size as SelectItemVariants["size"],
										indicator: "none",
										padding: "plain",
									}),
									"w-full text-left text-foreground hover:bg-accent hover:text-accent-foreground",
								)}
							>
								{option}
							</button>
						))}
					</div>
				)}
			</div>
		);
	},
);
EditableSelect.displayName = "EditableSelect";
