import { ClassProp } from 'class-variance-authority/types';
import { ClassValue } from 'clsx';
import * as CollapsiblePrimitive from '@radix-ui/react-collapsible';
import { ComponentType } from 'react';
import { ControllerProps } from 'react-hook-form';
import { CSSProperties } from 'react';
import { default as default_2 } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { DirectionProvider } from '@radix-ui/react-direction';
import { ElementType } from 'react';
import { FieldError } from 'react-hook-form';
import { FieldPath } from 'react-hook-form';
import { FieldValues } from 'react-hook-form';
import { FormProviderProps } from 'react-hook-form';
import { ForwardRefExoticComponent } from 'react';
import { JSX } from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import * as ProgressPrimitive from '@radix-ui/react-progress';
import * as React_2 from 'react';
import { ReactNode } from 'react';
import { RefAttributes } from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import * as SeparatorPrimitive from '@radix-ui/react-separator';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { toast } from 'sonner';
import { Toaster } from 'sonner';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { VariantProps } from 'class-variance-authority';

/**
 * アクションボタンの基底コンポーネント
 * デスクトップとモバイルで自動的に表示形式を切り替えます
 */
export declare const ActionButton: default_2.ForwardRefExoticComponent<ActionButtonProps & default_2.RefAttributes<HTMLButtonElement>>;

export declare interface ActionButtonProps extends Omit<ButtonProps, "variant"> {
    /** デスクトップ時のvariant (デフォルト: 'default') */
    variant?: ButtonProps["variant"];
    /** モバイル時のvariant (未指定時はvariantを使用) */
    mobileVariant?: ButtonProps["variant"];
    /** ラベルテキスト */
    label?: string;
    /** デスクトップ時のアイコン */
    icon?: default_2.ElementType;
    /** モバイル時のアイコン (未指定時はiconを使用) */
    mobileIcon?: default_2.ElementType;
    /** 常にアイコンのみ表示 */
    iconOnly?: boolean;
    /** 常にフルボタン（ラベル付き）表示 */
    alwaysFull?: boolean;
    /** モバイル時にFABとして表示するか */
    isFab?: boolean;
}

/**
 * AdaptiveText Component
 *
 * Adapts the font size of the text to fit within a specified width.
 * - If text fits: Renders normally.
 * - If text exceeds width by <= 30%: Scales down font size to fit.
 * - If text exceeds width by > 30%: Truncates with ellipsis.
 */
export declare const AdaptiveText: default_2.FC<AdaptiveTextProps>;

declare interface AdaptiveTextProps {
    text: string;
    width?: number | string;
    className?: string;
    style?: CSSProperties;
    as?: ElementType;
}

export declare const AsyncDataWrapper: ({ isLoading, isError, refetch, children, isFetching, className, isEmpty, emptyMessage, useSkeletonLoading, loadingText, noDataText, refreshText, }: AsyncDataWrapperProps) => JSX.Element;

declare interface AsyncDataWrapperProps {
    isLoading: boolean;
    isError: unknown;
    refetch: () => void;
    children: React.ReactNode;
    isFetching?: boolean;
    className?: string;
    isEmpty?: boolean;
    emptyMessage?: string;
    /**
     * According to CODING_RULES:
     * "If data is not yet arrived (initial loading), show Skeleton stack + Spinner in center."
     * If false, it might just show spinner (e.g. for small components), but page usage implies true.
     * Default: true
     */
    useSkeletonLoading?: boolean;
    /** Text shown during loading state. Default: "Loading..." */
    loadingText?: string;
    /** Text shown when data is empty. Default: "No data available" */
    noDataText?: string;
    /** Text for refresh button. Default: "Refresh data" */
    refreshText?: string;
}

export declare const Avatar: React_2.NamedExoticComponent<IAvatarProps & React_2.RefAttributes<HTMLDivElement>>;

export declare const Badge: React_2.MemoExoticComponent<({ className, variant, label, pill, children, ...props }: BadgeProps) => React_2.JSX.Element>;

declare interface BadgeProps extends React_2.HTMLAttributes<HTMLDivElement>, VariantProps<typeof BadgeVariants> {
    label?: React_2.ReactNode;
    pill?: boolean;
}

declare const BadgeVariants: (props?: ({
    variant?: "default" | "destructive" | "outline" | "secondary" | "success" | "warning" | "gray" | "green" | "pink" | "red" | "yellow" | "sky" | null | undefined;
} & ClassProp) | undefined) => string;

declare type BaseFormatProps = {
    value: number | null | undefined;
    className?: string;
    locale?: string;
    options?: Intl.NumberFormatOptions;
    fallback?: string;
};

export declare const Button: React_2.ForwardRefExoticComponent<ButtonProps & React_2.RefAttributes<HTMLButtonElement>>;

export declare interface ButtonGroupItem {
    label: string;
    icon?: React_2.ReactNode;
    shortcut?: string;
    action?: string;
    onClick?: () => void;
    disabled?: boolean;
    separator?: boolean;
}

export declare interface ButtonProps extends React_2.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
    asChild?: boolean;
    loading?: boolean;
    success?: boolean;
    error?: boolean;
    icon?: React_2.ElementType;
    maxLabelLength?: number;
}

export declare const buttonVariants: (props?: ({
    variant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link" | "success" | "warning" | "info" | "outline-success" | "outline-warning" | "outline-destructive" | "fab" | "circle-help" | "circle-alert" | "option" | "option-active" | null | undefined;
    size?: "default" | "sm" | "lg" | "icon" | "circle" | null | undefined;
} & ClassProp) | undefined) => string;

/**
 * Calculate last row info.
 */
export declare function calculateLastRowInfo(itemCount: number, columnCount: number): {
    lastRowStartIndex: number;
    lastRowItemCount: number;
    isLastRowFull: boolean;
};

/**
 * Calculate optimal column count based on button widths and container width.
 */
export declare function calculateOptimalColumnCount(buttonWidths: number[], containerWidth: number): number;

export declare const Calculator: ({ onResult, className, buttonLabel, }: CalculatorProps) => JSX.Element;

declare interface CalculatorProps {
    onResult?: (result: number) => void;
    className?: string;
    /** Label for calculator button. Default: "Calculator" */
    buttonLabel?: string;
}

declare interface CalendarContextType {
    secondaryCalendar: SecondaryCalendar;
    preferLocalCalendar: boolean;
    setSecondaryCalendar: (calendar: SecondaryCalendar) => void;
    setPreferLocalCalendar: (prefer: boolean) => void;
}

export declare const CalendarProvider: default_2.FC<CalendarProviderProps>;

declare interface CalendarProviderProps {
    children: default_2.ReactNode;
    defaultSecondaryCalendar?: SecondaryCalendar;
    defaultPreferLocalCalendar?: boolean;
}

declare type CalendarSystem = "gregorian" | "japanese" | "buddhist" | "islamic" | "chinese";

/**
 * キャンセルボタン
 */
export declare const CancelButton: default_2.FC<ActionButtonProps>;

export declare const Card: React_2.NamedExoticComponent<CardProps & React_2.RefAttributes<HTMLDivElement>>;

export declare const CardContent: React_2.NamedExoticComponent<React_2.HTMLAttributes<HTMLDivElement> & React_2.RefAttributes<HTMLDivElement>>;

export declare const CardDescription: React_2.NamedExoticComponent<React_2.HTMLAttributes<HTMLDivElement> & React_2.RefAttributes<HTMLDivElement>>;

export declare const CardFooter: React_2.NamedExoticComponent<React_2.HTMLAttributes<HTMLDivElement> & React_2.RefAttributes<HTMLDivElement>>;

export declare const CardHeader: React_2.NamedExoticComponent<React_2.HTMLAttributes<HTMLDivElement> & React_2.RefAttributes<HTMLDivElement>>;

declare interface CardProps extends React_2.HTMLAttributes<HTMLDivElement>, VariantProps<typeof cardVariants> {
}

export declare const CardTitle: React_2.NamedExoticComponent<React_2.HTMLAttributes<HTMLDivElement> & React_2.RefAttributes<HTMLDivElement>>;

declare const cardVariants: (props?: ({
    variant?: "default" | "destructive" | "warning" | null | undefined;
} & ClassProp) | undefined) => string;

export declare const ChatDock: React_2.FC<ChatDockProps>;

export declare interface ChatDockProps {
    isOpen: boolean;
    onOpen: () => void;
    onClose: () => void;
    title?: string;
    buttonLabel?: string;
    children?: React_2.ReactNode;
    className?: string;
    panelClassName?: string;
    bodyClassName?: string;
    buttonClassName?: string;
    footer?: React_2.ReactNode;
    footerClassName?: string;
    bodyRef?: React_2.Ref<HTMLDivElement>;
}

export declare const Checkbox: React_2.NamedExoticComponent<ICheckboxProps & React_2.RefAttributes<HTMLInputElement>>;

/**
 * クラス名を条件に応じて結合し、Tailwind CSSのクラス衝突を解決するユーティリティ。
 */
export declare function cn(...inputs: ClassValue[]): string;

export declare const Collapsible: ForwardRefExoticComponent<CollapsiblePrimitive.CollapsibleProps & RefAttributes<HTMLDivElement>>;

export declare const CollapsibleContent: ForwardRefExoticComponent<CollapsiblePrimitive.CollapsibleContentProps & RefAttributes<HTMLDivElement>>;

export declare const CollapsibleTrigger: ForwardRefExoticComponent<CollapsiblePrimitive.CollapsibleTriggerProps & RefAttributes<HTMLButtonElement>>;

export declare const ConfirmModal: default_2.FC<IConfirmModalProps>;

export declare const ContentHeader: React.FC<IContentHeaderProps>;

export declare const CopyClipButton: ({ text, copyValue, className, onCopied, onCopyError, }: CopyClipButtonProps) => default_2.JSX.Element;

declare interface CopyClipButtonProps {
    text: string;
    copyValue?: string;
    className?: string;
    onCopied?: (copiedValue: string) => void;
    onCopyError?: (error: unknown) => void;
}

/**
 * 新規作成 / 追加ボタン
 */
export declare const CreateButton: default_2.FC<CreateButtonProps>;

export declare interface CreateButtonProps extends ActionButtonProps {
    /** FABとして配置するかどうか (デフォルト: 'inline') */
    position?: "inline" | "fab";
}

export declare const CurrencyFormat: ({ value, className, locale, options, fallback, currency, }: CurrencyFormatProps) => JSX.Element;

export declare type CurrencyFormatProps = BaseFormatProps & {
    currency: string;
};

/**
 * 日付表示コンポーネント
 */
export declare const DateDisplay: default_2.FC<DateDisplayProps>;

declare interface DateDisplayProps {
    date: Date;
    /**
     * 表示形式
     * - full: 完全な日付と曜日（例: 2025年10月23日（木曜日）、Thursday, 23 October 2025）
     * - date: 日付のみ（例: 2025年10月23日、23 October 2025）
     * - weekday: 曜日のみ（例: 木曜日、Thursday）
     * - weekdayShort: 曜日短縮形（例: 木、Thu）
     * - yearMonth: 年月のみ（例: 2025年10月、October 2025）
     * - monthDay: 月日のみ（例: 10月23日、23 October）
     * - monthDayShort: 月日と曜日短縮形（例: 10/23 (木)、23 Oct (Thu)）
     * - compact: 超コンパクト（例: 11/27改行(木)、27改行Thu）
     */
    format?: "full" | "date" | "weekday" | "weekdayShort" | "yearMonth" | "monthDay" | "monthDayShort" | "compact";
    className?: string;
    /** Optional locale override (e.g. "ja", "en"). Default: "en" */
    locale?: string;
}

export declare const DateFormat: ({ date, showDayOfWeek, showTime, className, calendar, showSecondary, locale: localeProp, }: IDateFormatProps) => JSX.Element;

export declare const DEFAULT_THEME: ThemeName;

/**
 * 削除ボタン
 */
export declare const DeleteButton: default_2.FC<ActionButtonProps>;

export { DirectionProvider }

export declare const Drawer: React_2.FC<DrawerProps>;

declare interface DrawerProps extends VariantProps<typeof drawerVariants> {
    isOpen: boolean;
    onClose: () => void;
    children?: React_2.ReactNode;
    position?: "top" | "bottom" | "left" | "right";
    width?: string;
    noPadding?: boolean;
    title?: string;
    description?: string;
    className?: string;
}

declare const drawerVariants: (props?: ({
    side?: "left" | "right" | "bottom" | "top" | null | undefined;
} & ClassProp) | undefined) => string;

/**
 * ドロップダウンメニュー
 */
export declare const DropdownMenu: React_2.FC<IDropdownMenuProps>;

export declare const EditableSelect: React_2.ForwardRefExoticComponent<IEditableSelectProps & React_2.RefAttributes<HTMLInputElement>>;

/**
 * 編集ボタン
 */
export declare const EditButton: default_2.FC<ActionButtonProps>;

export declare const ErrorState: ({ error, onRetry, className, title: propsTitle, message: propsMessage, retryText, }: ErrorStateProps) => JSX.Element;

declare type ErrorStateProps = {
    error?: unknown;
    onRetry?: () => void;
    className?: string;
    /** エラータイトルの上書き */
    title?: string;
    /** エラーメッセージの上書き。未指定時は error オブジェクトから抽出を試みます。 */
    message?: string;
    /** 再試行ボタンのテキスト (デフォルト: '再読み込み') */
    retryText?: string;
};

export declare const Form: <TFieldValues extends FieldValues, TContext = any, TTransformedValues = TFieldValues>(props: FormProviderProps<TFieldValues, TContext, TTransformedValues>) => React_2.JSX.Element;

export declare const FormControl: React_2.NamedExoticComponent<Omit<React_2.HTMLAttributes<HTMLElement> & {
    children?: React_2.ReactNode;
} & React_2.RefAttributes<HTMLElement>, "ref"> & React_2.RefAttributes<HTMLElement>>;

export declare const FormDescription: React_2.NamedExoticComponent<React_2.HTMLAttributes<HTMLParagraphElement> & React_2.RefAttributes<HTMLParagraphElement>>;

export declare function FormField<TFieldValues extends FieldValues = FieldValues, TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>>(props: ControllerProps<TFieldValues, TName>): React_2.JSX.Element;

export declare const FormItem: React_2.NamedExoticComponent<React_2.HTMLAttributes<HTMLDivElement> & React_2.RefAttributes<HTMLDivElement>>;

export declare const FormLabel: React_2.NamedExoticComponent<Omit<LabelPrimitive.LabelProps & React_2.RefAttributes<HTMLLabelElement>, "ref"> & React_2.RefAttributes<HTMLLabelElement>>;

export declare const FormMessage: React_2.NamedExoticComponent<React_2.HTMLAttributes<HTMLParagraphElement> & React_2.RefAttributes<HTMLParagraphElement>>;

declare interface IAvatarProps extends React_2.HTMLAttributes<HTMLDivElement> {
    src?: string;
    alt?: string;
    fallback?: React_2.ReactNode | string;
    size?: "xs" | "sm" | "md" | "lg" | "xl";
}

declare interface ICheckboxProps {
    id?: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
    label: string;
    className?: string;
    disabled?: boolean;
    variant?: "default" | "card";
}

declare interface IConfirmModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description?: string;
    onConfirm: () => void;
    onCancel?: () => void;
    /** Text for confirm button. Default: "Confirm" */
    confirmText?: string;
    /** Text for cancel button. Default: "Cancel" */
    cancelText?: string;
    variant?: "default" | "destructive";
    loading?: boolean;
    showCancel?: boolean;
}

export declare interface IContentHeaderProps {
    patientName: string;
    patientId?: string;
    variant?: "session" | "detail" | "compact";
    additionalInfo?: ReactNode;
    className?: string;
    navigationBack?: ReactNode;
    onBack?: () => void;
    backLabel?: string;
}

declare interface IDateFormatProps {
    /** The date to format (string or Date object) */
    date: string | Date | null | undefined;
    /** Whether to show the day of the week (e.g. "(Mon)") */
    showDayOfWeek?: boolean;
    /** Whether to show the time (e.g. "14:30") */
    showTime?: boolean;
    /** Optional custom class name */
    className?: string;
    /** Optional calendar system override (defaults to display settings) */
    calendar?: CalendarSystem;
    /** Optional secondary calendar to show alongside primary */
    showSecondary?: boolean;
    /** Optional locale override (defaults to navigator.language) */
    locale?: string;
}

export declare interface IDropdownMenuItem {
    label: string;
    onClick: () => void;
    icon?: React_2.ReactNode;
}

export declare interface IDropdownMenuProps {
    trigger: React_2.ReactNode;
    items: IDropdownMenuItem[];
    /**
     * Preferred horizontal alignment. When `autoFlip` is true, this may be flipped to avoid overflow.
     */
    align?: "left" | "right";
    /**
     * Preferred vertical side. When `autoSide` is true, this may open upward if there's not enough space.
     */
    side?: "bottom" | "top";
    /**
     * Auto flip left/right when near screen edge.
     * Default: true
     */
    autoFlip?: boolean;
    /**
     * Auto choose top/bottom based on available space.
     * Default: true
     */
    autoSide?: boolean;
    /**
     * Distance in pixels between trigger and menu.
     * Default: 8
     */
    offset?: number;
    /**
     * Minimum width for the menu.
     * Default: 160
     */
    minWidthPx?: number;
    className?: string;
}

export declare interface IEditableSelectProps {
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

declare interface IImageViewerProps {
    src: string;
    alt?: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Optional max width for large images */
    maxWidthPx?: number;
}

/**
 * Image with preview capability
 * Displays a thumbnail that opens the full-screen viewer on click
 */
declare interface IImageWithPreviewProps {
    src: string;
    alt?: string;
    className?: string;
    width?: string | number;
    height?: string | number;
    children?: default_2.ReactNode;
}

/** Responsive image viewer using shadcn dialog */
export declare const ImageViewer: default_2.FC<IImageViewerProps>;

export declare const ImageWithPreview: default_2.FC<IImageWithPreviewProps>;

export declare interface IMenuButtonGroupProps {
    items: ButtonGroupItem[];
    selectedId?: string | null;
    onAction?: (actionId: string) => void;
    className?: string;
    stretchLastRow?: boolean;
    /* Excluded from this release type: _testColumnCount */
}

declare interface IModalProps extends React_2.ComponentPropsWithoutRef<typeof DialogPrimitive.Root> {
    trigger?: React_2.ReactNode;
    title?: string;
    description?: string;
    footer?: React_2.ReactNode;
    footerClassName?: string;
    className?: string;
    contentClassName?: string;
    onClose?: () => void;
    noHeader?: boolean;
    noPadding?: boolean;
    draggable?: boolean;
}

export declare const InfiniteListMenu: React_2.FC<InfiniteListMenuProps>;

export declare interface InfiniteListMenuItem {
    id: string;
    label: React_2.ReactNode;
    description?: React_2.ReactNode;
    icon?: React_2.ReactNode;
    badge?: React_2.ReactNode;
    meta?: React_2.ReactNode;
    disabled?: boolean;
}

export declare interface InfiniteListMenuProps {
    title?: string;
    items?: InfiniteListMenuItem[];
    selectedId?: string;
    onSelect?: (id: string, item: InfiniteListMenuItem) => void;
    onLoadMore?: () => void;
    hasMore?: boolean;
    isLoading?: boolean;
    loadMoreOffset?: number;
    emptyText?: string;
    loadingText?: string;
    endText?: string;
    headerMeta?: React_2.ReactNode;
    hideHeader?: boolean;
    resizable?: boolean;
    resizeMinWidth?: number;
    resizeMaxWidth?: number | string;
    className?: string;
    listClassName?: string;
    showDividers?: boolean;
    enableAdaptiveText?: boolean;
    width?: number | string;
    onResize?: (width: number) => void;
    selectedItem?: InfiniteListMenuItem | null;
}

export declare const Input: React_2.ForwardRefExoticComponent<InputProps & React_2.RefAttributes<HTMLInputElement>>;

export declare interface InputProps extends React_2.InputHTMLAttributes<HTMLInputElement> {
}

export declare interface IScaleInputProps {
    /** Label for the input */
    label?: string;
    /** Current selected value */
    value?: number;
    /** Callback when value changes */
    onChange: (value: number) => void;
    /** Minimum value (default: 0) */
    min?: number;
    /** Maximum value (default: 10) */
    max?: number;
    /** Label for the minimum value (e.g. "No Pain") */
    minLabel?: string;
    /** Label for the maximum value (e.g. "Worst Pain") */
    maxLabel?: string;
    /** Additional class name */
    className?: string;
    /** Disabled state */
    disabled?: boolean;
}

declare interface IScrollAreaProps extends React_2.HTMLAttributes<HTMLDivElement> {
    children: React_2.ReactNode;
}

declare interface ISkeletonProps extends React_2.HTMLAttributes<HTMLDivElement> {
    showSpinner?: boolean;
    spinnerSize?: "xs" | "sm" | "md" | "lg" | "xl";
    spinnerVariant?: "primary" | "secondary" | "accent";
}

declare interface ISpinnerProps extends React_2.HTMLAttributes<HTMLOutputElement> {
    size?: "xs" | "sm" | "md" | "lg" | "xl";
    variant?: "primary" | "secondary" | "accent";
}

export declare interface IThemeColors {
    tone: ThemeTone;
}

declare interface IUseImageViewerResult {
    open: boolean;
    show: (src: string, alt?: string) => void;
    hide: () => void;
    src: string | null;
    alt: string | undefined;
}

export declare const KeypadModal: default_2.FC<UnifiedKeypadModalProps>;

declare type KeypadVariant = "number" | "phone" | "time";

export declare const Label: React_2.NamedExoticComponent<Omit<LabelPrimitive.LabelProps & React_2.RefAttributes<HTMLLabelElement>, "ref"> & React_2.RefAttributes<HTMLLabelElement>>;

declare interface LanguageOption {
    value: string;
    label: string;
}

export declare const LanguageSelector: default_2.FC<LanguageSelectorProps>;

declare interface LanguageSelectorProps {
    className?: string;
    buttonClassName?: string;
    id?: string;
    align?: "left" | "right";
    value?: string;
    onValueChange?: (lng: string) => void | Promise<void>;
    /**
     * 表示する言語のリスト。未指定時は日本語と英語が表示されます。
     */
    languages?: LanguageOption[];
}

export declare const MenuButtonGroup: React_2.FC<IMenuButtonGroupProps>;

/**
 * Compact, borderless table for small item comparisons (e.g., wound care materials or therapy items).
 */
export declare const MiniTable: React.FC<MiniTableProps>;

declare interface MiniTableColumn {
    key: string;
    label: string;
    align?: "left" | "center" | "right";
    width?: string;
}

declare interface MiniTableProps {
    columns: MiniTableColumn[];
    rows: MiniTableRow[];
    dense?: boolean;
    size?: "sm" | "md" | "lg";
    headerBg?: string;
    hideHeader?: boolean;
}

declare interface MiniTableRow {
    key: string;
    cells: Record<string, ReactNode>;
}

export declare const Modal: React_2.NamedExoticComponent<IModalProps & React_2.RefAttributes<HTMLDivElement>>;

export declare const ModalFooter: React_2.FC<{
    children: React_2.ReactNode;
    className?: string;
}>;

declare interface MultiOptionButtonGroupProps<T extends string> extends OptionButtonGroupBaseProps<T> {
    multiple: true;
    value: T[];
    onChange: (value: T[]) => void;
    allowNull?: never;
    nullLabel?: never;
}

declare interface NavigationStep {
    id: string;
    title: string;
    description?: string;
    disabled?: boolean;
}

export declare const NavigationStepper: default_2.FC<NavigationStepperProps>;

declare interface NavigationStepperProps {
    steps: NavigationStep[];
    activeStep: number;
    onStepChange?: (nextStep: number) => void;
    renderStepContent?: (step: NavigationStep, index: number) => default_2.ReactNode;
    orientation?: "horizontal" | "vertical";
    variant?: "split" | "accordion";
    compactOnMobile?: boolean;
    inlineContentOnVerticalMobile?: boolean;
    className?: string;
}

export declare const NotificationToast: React_2.NamedExoticComponent<NotificationToastProps>;

export declare interface NotificationToastProps extends React_2.HTMLAttributes<HTMLDivElement> {
    type: NotificationToastType;
    title: string;
    message: string;
    linkLabel?: string;
    onClickLink?: () => void;
    onClose?: () => void;
    showCloseButton?: boolean;
}

export declare type NotificationToastType = "info" | "success" | "warning" | "error";

export declare const NumberFormat: ({ value, className, locale, options, fallback, }: NumberFormatProps) => JSX.Element;

export declare type NumberFormatProps = BaseFormatProps;

declare interface Option_2 {
    label: string;
    value: string;
}
export { Option_2 as Option }

declare interface Option_3 {
    label: string;
    value: string;
}

export declare function OptionButtonGroup<T extends string>(props: OptionButtonGroupProps<T>): JSX.Element;

declare interface OptionButtonGroupBaseProps<T extends string> {
    options: OptionButtonItem<T>[];
    columns?: 1 | 2 | 3 | 4;
    className?: string;
}

export declare type OptionButtonGroupProps<T extends string> = SingleOptionButtonGroupProps<T> | MultiOptionButtonGroupProps<T>;

export declare interface OptionButtonItem<T extends string> {
    value: T;
    label: string;
    description?: string;
}

export declare const Pagination: default_2.MemoExoticComponent<({ currentPage, totalPages, onPrevPage, onNextPage, prevLabel, nextLabel, prevContent, nextContent, pageInfoFormatter, className, }: PaginationProps) => default_2.JSX.Element | null>;

declare interface PaginationProps {
    currentPage: number;
    totalPages: number;
    onPrevPage: () => void;
    onNextPage: () => void;
    prevLabel?: string;
    nextLabel?: string;
    prevContent?: ReactNode;
    nextContent?: ReactNode;
    pageInfoFormatter?: (currentPage: number, totalPages: number) => ReactNode;
    className?: string;
}

export declare const PercentFormat: ({ value, className, locale, options, fallback, valueScale, }: PercentFormatProps) => JSX.Element;

export declare type PercentFormatProps = BaseFormatProps & {
    valueScale?: PercentValueScale;
};

export declare type PercentValueScale = "ratio" | "percent";

export declare const Popover: React_2.FC<PopoverPrimitive.PopoverProps>;

export declare const PopoverContent: React_2.ForwardRefExoticComponent<Omit<PopoverPrimitive.PopoverContentProps & React_2.RefAttributes<HTMLDivElement>, "ref"> & React_2.RefAttributes<HTMLDivElement>>;

export declare const PopoverTrigger: React_2.ForwardRefExoticComponent<PopoverPrimitive.PopoverTriggerProps & React_2.RefAttributes<HTMLButtonElement>>;

export declare const ProgressBar: React_2.ForwardRefExoticComponent<ProgressBarProps & React_2.RefAttributes<HTMLDivElement>>;

declare interface ProgressBarProps extends React_2.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> {
    value: number;
    label?: React_2.ReactNode;
    subLabel?: React_2.ReactNode;
    height?: string;
    color?: string;
    striped?: boolean;
    animated?: boolean;
    status?: "normal" | "paused" | "error";
}

/**
 * 保存ボタン
 */
export declare const SaveButton: default_2.FC<ActionButtonProps>;

export declare const ScaleInput: React_2.MemoExoticComponent<({ label, value, onChange, min, max, minLabel, maxLabel, className, disabled, }: IScaleInputProps) => React_2.JSX.Element>;

export declare const ScrollArea: React_2.NamedExoticComponent<IScrollAreaProps & React_2.RefAttributes<HTMLDivElement>>;

export declare const SearchableSelect: React_2.ForwardRefExoticComponent<SearchableSelectProps & React_2.RefAttributes<HTMLInputElement>>;

export declare interface SearchableSelectProps {
    options: Option_2[];
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

declare type SecondaryCalendar = "none" | "japanese" | "buddhist" | "islamic" | "chinese";

export declare const Select: React_2.FC<SelectPrimitive.SelectProps>;

export declare const SelectableTextInput: default_2.FC<SelectableTextInputProps>;

declare interface SelectableTextInputProps {
    options: Option_3[];
    value?: string;
    onChange?: (value: string) => void;
    placeholder?: string;
    className?: string;
}

export declare const SelectContent: React_2.NamedExoticComponent<Omit<SelectPrimitive.SelectContentProps & React_2.RefAttributes<HTMLDivElement>, "ref"> & {
    width?: "stretch" | "content";
} & React_2.RefAttributes<HTMLDivElement>>;

export declare const SelectGroup: React_2.ForwardRefExoticComponent<SelectPrimitive.SelectGroupProps & React_2.RefAttributes<HTMLDivElement>>;

export declare const SelectItem: React_2.NamedExoticComponent<Omit<SelectPrimitive.SelectItemProps & React_2.RefAttributes<HTMLDivElement>, "ref"> & SelectItemVariants & React_2.RefAttributes<HTMLDivElement>>;

export declare type SelectItemVariants = VariantProps<typeof selectItemVariants>;

declare const selectItemVariants: (props?: ({
    indicator?: "none" | "check" | null | undefined;
    size?: "sm" | "lg" | "md" | null | undefined;
    padding?: "plain" | "withIndicator" | null | undefined;
} & ClassProp) | undefined) => string;

export declare const SelectLabel: React_2.ForwardRefExoticComponent<Omit<SelectPrimitive.SelectLabelProps & React_2.RefAttributes<HTMLDivElement>, "ref"> & React_2.RefAttributes<HTMLDivElement>>;

export declare const SelectSeparator: React_2.ForwardRefExoticComponent<Omit<SelectPrimitive.SelectSeparatorProps & React_2.RefAttributes<HTMLDivElement>, "ref"> & React_2.RefAttributes<HTMLDivElement>>;

export declare const SelectTrigger: React_2.NamedExoticComponent<Omit<SelectPrimitive.SelectTriggerProps & React_2.RefAttributes<HTMLButtonElement>, "ref"> & SelectTriggerVariants & React_2.RefAttributes<HTMLButtonElement>>;

export declare type SelectTriggerVariants = VariantProps<typeof selectTriggerVariants>;

declare const selectTriggerVariants: (props?: ({
    variant?: "default" | "outline" | "ghost" | null | undefined;
    size?: "sm" | "lg" | "md" | null | undefined;
} & ClassProp) | undefined) => string;

export declare const SelectValue: React_2.ForwardRefExoticComponent<SelectPrimitive.SelectValueProps & React_2.RefAttributes<HTMLSpanElement>>;

export declare const Separator: React_2.ForwardRefExoticComponent<Omit<SeparatorPrimitive.SeparatorProps & React_2.RefAttributes<HTMLDivElement>, "ref"> & React_2.RefAttributes<HTMLDivElement>>;

export declare const SimpleSearchInput: default_2.NamedExoticComponent<SimpleSearchInputProps & default_2.RefAttributes<HTMLInputElement>>;

declare interface SimpleSearchInputProps extends default_2.InputHTMLAttributes<HTMLInputElement> {
    onSearch?: (query: string) => void;
}

declare interface SingleOptionButtonGroupProps<T extends string> extends OptionButtonGroupBaseProps<T> {
    multiple?: false;
    value: T | null;
    onChange: (value: T | null) => void;
    allowNull?: boolean;
    nullLabel?: string;
}

export declare const Skeleton: React_2.NamedExoticComponent<ISkeletonProps>;

export declare const Spinner: React_2.NamedExoticComponent<ISpinnerProps>;

export declare const Switch: React_2.ForwardRefExoticComponent<Omit<SwitchPrimitive.SwitchProps & React_2.RefAttributes<HTMLButtonElement>, "ref"> & React_2.RefAttributes<HTMLButtonElement>>;

export declare const Tabs: React_2.ForwardRefExoticComponent<TabsPrimitive.TabsProps & React_2.RefAttributes<HTMLDivElement>>;

export declare const TabsContent: React_2.ForwardRefExoticComponent<Omit<TabsPrimitive.TabsContentProps & React_2.RefAttributes<HTMLDivElement>, "ref"> & React_2.RefAttributes<HTMLDivElement>>;

export declare const TabsList: React_2.ForwardRefExoticComponent<TabsListProps & React_2.RefAttributes<HTMLDivElement>>;

declare interface TabsListProps extends React_2.ComponentPropsWithoutRef<typeof TabsPrimitive.List> {
    onBack?: () => void;
    backButtonLabel?: string;
}

export declare const TabsTrigger: React_2.ForwardRefExoticComponent<TabsTriggerProps & React_2.RefAttributes<HTMLButtonElement>>;

declare interface TabsTriggerProps extends React_2.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger> {
    icon?: React_2.ElementType;
}

export declare const Textarea: React_2.ForwardRefExoticComponent<TextareaProps & React_2.RefAttributes<HTMLTextAreaElement>>;

declare interface TextareaProps extends React_2.TextareaHTMLAttributes<HTMLTextAreaElement> {
}

export declare const TextInput: default_2.FC<TextInputProps>;

declare interface TextInputProps extends Omit<InputProps, "type" | "onChange" | "value"> {
    type?: TextInputType;
    value?: string;
    onChange?: (value: string) => void;
    /**
     * キーパッドモーダルのタイトル
     * 指定しない場合はデフォルトのタイトルが使用されます
     */
    modalTitle?: string;
}

declare type TextInputType = "text" | "numeric" | "time" | "phone";

export declare const THEME_COLORS: Record<ThemeName, {
    tone: ThemeTone;
}>;

export declare const THEME_CONSTANTS: {
    readonly LIGHT: "light";
    readonly DARK: "dark";
};

export declare type ThemeName = "dark" | "tokyonight" | "eclipse" | "macosclassic" | "fire" | "classicterminal" | "sakurabloom" | "leafmint" | "lattecream" | "sunshineOrange" | "light" | (string & {});

export declare type ThemeTone = "light" | "dark";

export { toast }

export { Toaster }

export declare const Tooltip: React_2.FC<TooltipPrimitive.TooltipProps>;

export declare const TooltipContent: React_2.NamedExoticComponent<Omit<TooltipPrimitive.TooltipContentProps & React_2.RefAttributes<HTMLDivElement>, "ref"> & {
    align?: "start" | "center" | "end";
} & React_2.RefAttributes<HTMLDivElement>>;

export declare const TooltipProvider: React_2.FC<TooltipPrimitive.TooltipProviderProps>;

export declare const TooltipTrigger: React_2.ForwardRefExoticComponent<TooltipPrimitive.TooltipTriggerProps & React_2.RefAttributes<HTMLButtonElement>>;

export declare const TreeMenu: default_2.FC<TreeMenuProps>;

export declare interface TreeMenuItem {
    id: string;
    label: default_2.ReactNode;
    icon?: default_2.ReactNode;
    disabled?: boolean;
    badge?: default_2.ReactNode;
    children?: TreeMenuItem[];
}

export declare interface TreeMenuProps {
    title?: string;
    items?: TreeMenuItem[];
    selectedId?: string;
    onSelect?: (id: string, item: TreeMenuItem) => void;
    /** Uncontrolled expanded state */
    defaultExpandedIds?: string[];
    /** Controlled expanded state */
    expandedIds?: string[];
    onExpandedChange?: (expandedIds: string[]) => void;
    dense?: boolean;
    className?: string;
    showCloseButton?: boolean;
    onCloseMenu?: () => void;
    hideControlBar?: boolean;
}

declare interface UnifiedKeypadModalProps {
    open: boolean;
    onClose: () => void;
    onSubmit: (value: string) => void;
    variant?: KeypadVariant;
    initialValue?: string;
    title?: string;
    placeholder?: string;
    maxLength?: number;
    allowDecimal?: boolean;
}

export declare const useCalendarSettings: () => CalendarContextType;

export declare function useFormField(): {
    invalid: boolean;
    isDirty: boolean;
    isTouched: boolean;
    isValidating: boolean;
    error?: FieldError;
    id: string;
    name: string;
    formItemId: string;
    formDescriptionId: string;
    formMessageId: string;
};

/** Hook to manage image viewer state */
export declare const useImageViewer: () => IUseImageViewerResult;

declare interface ViewOption {
    value: string;
    icon: ComponentType<{
        className?: string;
    }>;
    tooltip: string;
}

export declare const ViewSwitcher: default_2.MemoExoticComponent<({ options, value, onChange, className }: ViewSwitcherProps) => default_2.JSX.Element>;

declare interface ViewSwitcherProps {
    options: ViewOption[];
    value: string;
    onChange: (value: string) => void;
    className?: string;
}

export { }
