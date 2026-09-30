import { ChevronRight } from 'lucide-react';
import Link from 'next/link';

export function LinkRow({
	href,
	label,
	external = false,
}: {
	href: string;
	label: string;
	external?: boolean;
}) {
	return (
		<li>
			<Link
				href={href}
				target={external ? '_blank' : undefined}
				rel={external ? 'noopener noreferrer' : undefined}
				aria-label={external ? `${label} (öffnet in neuem Tab)` : undefined}
				className="text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring flex min-h-[44px] items-center justify-between gap-3 px-3 py-2 text-sm transition-colors"
			>
				<span className="min-w-0 flex-1">
					{label}
					{external && (
						<>
							{' '}
							<span className="text-muted-foreground text-xs">(extern)</span>
						</>
					)}
				</span>
				<ChevronRight className="text-muted-foreground h-4 w-4 shrink-0" aria-hidden />
			</Link>
		</li>
	);
}
