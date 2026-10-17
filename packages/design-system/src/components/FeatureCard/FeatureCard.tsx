import {
	Award,
	BarChart3,
	Book,
	Calendar,
	Camera,
	CircleCheck,
	Clock,
	Cloud,
	Coffee,
	CreditCard,
	Gift,
	Globe,
	Heart,
	Leaf,
	Lock,
	type LucideIcon,
	Mail,
	MapPin,
	MessageCircle,
	Moon,
	Music,
	Package,
	Phone,
	Rocket,
	Settings,
	Shield,
	ShoppingCart,
	Sparkles,
	Star,
	Sun,
	Tag,
	TrendingUp,
	Truck,
	User,
	Users,
	Zap,
} from "lucide-react";
import { cn } from "../../utils/cn";
import "./FeatureCard.css";

const featureCardIcons = {
	sparkles: Sparkles,
	star: Star,
	heart: Heart,
	shield: Shield,
	lock: Lock,
	zap: Zap,
	leaf: Leaf,
	sun: Sun,
	moon: Moon,
	cloud: Cloud,
	truck: Truck,
	package: Package,
	gift: Gift,
	"shopping-cart": ShoppingCart,
	"credit-card": CreditCard,
	tag: Tag,
	clock: Clock,
	calendar: Calendar,
	"map-pin": MapPin,
	phone: Phone,
	mail: Mail,
	"message-circle": MessageCircle,
	users: Users,
	user: User,
	award: Award,
	"trending-up": TrendingUp,
	"bar-chart": BarChart3,
	settings: Settings,
	"check-circle": CircleCheck,
	globe: Globe,
	coffee: Coffee,
	camera: Camera,
	music: Music,
	book: Book,
	rocket: Rocket,
} satisfies Record<string, LucideIcon>;

export type FeatureCardIcon = keyof typeof featureCardIcons;

export const featureCardIconNames = Object.keys(
	featureCardIcons,
) as FeatureCardIcon[];

export type FeatureCardProps = {
	icon?: FeatureCardIcon;
	title: string;
	body?: string;
	className?: string;
};

export function FeatureCard({
	icon,
	title,
	body,
	className,
}: FeatureCardProps) {
	const Icon = icon ? featureCardIcons[icon] : undefined;
	return (
		<article className={cn("ds-feature-card", className)}>
			{Icon && (
				<span className="ds-feature-card-icon" data-icon={icon}>
					<Icon size={22} aria-hidden="true" />
				</span>
			)}
			<h3>{title}</h3>
			{body && <p>{body}</p>}
		</article>
	);
}
