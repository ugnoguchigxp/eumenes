import React from "react";
import { Button, type ButtonProps } from "@/components/Button";
import { useIsMobile } from "@/hooks/useMobile";
import { cn } from "@/utils/cn";

export interface ActionButtonProps extends Omit<ButtonProps, "variant"> {
	/** デスクトップ時のvariant (デフォルト: 'default') */
	variant?: ButtonProps["variant"];
	/** モバイル時のvariant (未指定時はvariantを使用) */
	mobileVariant?: ButtonProps["variant"];
	/** ラベルテキスト */
	label?: string;
	/** デスクトップ時のアイコン */
	icon?: React.ElementType;
	/** モバイル時のアイコン (未指定時はiconを使用) */
	mobileIcon?: React.ElementType;
	/** 常にアイコンのみ表示 */
	iconOnly?: boolean;
	/** 常にフルボタン（ラベル付き）表示 */
	alwaysFull?: boolean;
	/** モバイル時にFABとして表示するか */
	isFab?: boolean;
}

/**
 * アクションボタンの基底コンポーネント
 * デスクトップとモバイルで自動的に表示形式を切り替えます
 */
export const ActionButton = React.forwardRef<
	HTMLButtonElement,
	ActionButtonProps
>(
	(
		{
			variant = "default",
			mobileVariant,
			label,
			icon: Icon,
			mobileIcon,
			iconOnly = false,
			alwaysFull = false,
			isFab = false,
			className,
			children,
			size: propsSize,
			...props
		},
		ref,
	) => {
		const isMobile = useIsMobile();

		// モバイル時の設定
		const effectiveVariant =
			isMobile && mobileVariant ? mobileVariant : variant;
		const EffectiveIcon = isMobile && mobileIcon ? mobileIcon : Icon;

		// アイコンのみ表示の判定
		const showIconOnly = iconOnly || (isMobile && !alwaysFull);

		// FAB表示（モバイルかつisFab=trueのみ）
		if (isMobile && isFab) {
			return (
				<Button
					ref={ref}
					variant="fab"
					size="icon"
					className={cn("fixed bottom-6 right-6 z-50", className)}
					icon={EffectiveIcon}
					aria-label={label}
					{...props}
				/>
			);
		}

		// ボタンのサイズ決定
		const size = showIconOnly ? "icon" : propsSize || "default";
		// ラベル/子要素の決定（アイコンのみの場合は表示しない）
		const content = showIconOnly ? undefined : (label ?? children);

		return (
			<Button
				ref={ref}
				variant={effectiveVariant}
				size={size}
				className={className}
				icon={EffectiveIcon}
				aria-label={showIconOnly ? label : undefined}
				{...props}
			>
				{content}
			</Button>
		);
	},
);

ActionButton.displayName = "ActionButton";
