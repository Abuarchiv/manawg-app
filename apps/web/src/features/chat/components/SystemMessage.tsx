import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker';
import { CheckCircle2, Info, LogIn, LogOut, Receipt } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

interface SystemMessageProps {
	shareCode: string;
	systemKind: string | null;
	payload: Record<string, unknown> | null;
}

function asString(value: unknown, fallback: string): string {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

export function SystemMessage({ shareCode, systemKind, payload }: SystemMessageProps) {
	const data = payload ?? {};
	switch (systemKind) {
		case 'member.joined':
			return (
				<SystemRow icon={LogIn} text={`${asString(data.name, 'Jemand')} ist der WG beigetreten.`} />
			);
		case 'member.left':
			return (
				<SystemRow icon={LogOut} text={`${asString(data.name, 'Jemand')} hat die WG verlassen.`} />
			);
		case 'expense.created': {
			const text = (
				<>
					{asString(data.actorName, 'Jemand')} hat {asString(data.description, 'eine Ausgabe')} für{' '}
					<span className="tabular-nums">{asString(data.amount, '0€')}</span> eingetragen.
				</>
			);
			// Older messages carry no expenseId and stay plain text.
			const expenseId = asString(data.expenseId, '');
			return (
				<SystemRow
					icon={Receipt}
					text={
						expenseId ? (
							<Link
								href={`/wg/${encodeURIComponent(shareCode)}/ausgaben?highlight=${encodeURIComponent(expenseId)}`}
								// The after pseudo-element extends the hit area to 44px without enlarging the pill.
								className="relative underline underline-offset-2 after:absolute after:inset-x-0 after:-inset-y-3.5 focus-visible:outline-2 focus-visible:outline-offset-2"
							>
								{text}
							</Link>
						) : (
							text
						)
					}
				/>
			);
		}
		case 'chore.completed':
			return (
				<SystemRow
					icon={CheckCircle2}
					text={`${asString(data.actorName, 'Jemand')} hat „${asString(data.title, 'eine Aufgabe')}“ erledigt.`}
				/>
			);
		default:
			return <SystemRow icon={Info} text="Systemnachricht" />;
	}
}

function SystemRow({
	icon: Icon,
	text,
}: {
	icon: typeof CheckCircle2;
	text: ReactNode;
}) {
	return (
		<Marker
			variant="separator"
			className="my-2 justify-center text-xs before:min-w-3 after:min-w-3"
		>
			<MarkerIcon>
				<Icon aria-hidden />
			</MarkerIcon>
			<MarkerContent className="max-w-[85%] rounded-2xl bg-muted px-3 py-1 text-center text-foreground/80">
				{text}
			</MarkerContent>
		</Marker>
	);
}
