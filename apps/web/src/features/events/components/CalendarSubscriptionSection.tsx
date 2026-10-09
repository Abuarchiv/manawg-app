'use client';

import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { useCalendarSubscription } from '@/features/events/hooks/use-calendar-subscription';
import { CalendarPlus, ChevronRight, ExternalLink, RefreshCw, Trash2 } from 'lucide-react';

export function CalendarSubscriptionSection({ encodedShareCode }: { encodedShareCode: string }) {
	const feed = useCalendarSubscription(encodedShareCode);
	const { subscription } = feed;

	return (
		<>
			<details className="group rounded-xl border border-border">
				<summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-semibold [&::-webkit-details-marker]:hidden">
					Kalender abonnieren
					<ChevronRight
						aria-hidden
						className="size-4 text-muted-foreground transition-transform group-open:rotate-90"
					/>
				</summary>
				<div className="flex flex-col gap-3 border-t border-border px-4 py-4">
					<p className="text-sm text-muted-foreground">
						Neue WG-Termine automatisch in Apple Kalender oder Google Kalender erhalten.
					</p>
					{feed.error && (
						<Alert variant="destructive">
							<AlertDescription>{feed.error}</AlertDescription>
						</Alert>
					)}
					{feed.loading ? (
						<p className="text-sm text-muted-foreground">Feed wird geladen…</p>
					) : subscription ? (
						<div className="flex flex-col gap-3">
							<Field>
								<FieldLabel htmlFor="calendar-feed-url">Persönlicher Feed-Link</FieldLabel>
								<div className="flex min-w-0 flex-wrap gap-2">
									<Input
										id="calendar-feed-url"
										type="url"
										readOnly
										value={subscription.feedUrl}
										className="min-w-[min(12rem,100%)] flex-1 text-sm"
									/>
									<Button
										type="button"
										variant="outline"
										onClick={() => void feed.copyUrl()}
										className="min-w-[7.5rem] max-w-full shrink-0 py-1 text-left whitespace-normal"
									>
										{feed.copyState === 'copied' ? 'Kopiert' : 'Link kopieren'}
									</Button>
								</div>
							</Field>
							<div className="flex flex-wrap gap-2">
								<Button
									nativeButton={false}
									className="py-1 text-left"
									render={
										// webcal:// hands the feed to Apple Kalender (and most desktop calendars) in one tap.
										<a href={subscription.feedUrl.replace(/^https?:/, 'webcal:')}>
											<CalendarPlus data-icon="inline-start" aria-hidden />
											In Kalender-App abonnieren
										</a>
									}
								/>
								<Button
									nativeButton={false}
									variant="outline"
									className="py-1 text-left"
									render={
										<a href={subscription.feedUrl} target="_blank" rel="noopener noreferrer">
											<ExternalLink data-icon="inline-start" aria-hidden />
											Feed öffnen
										</a>
									}
								/>
								<Button
									type="button"
									variant="outline"
									className="py-1 text-left"
									disabled={feed.busy}
									onClick={() => feed.setConfirm('rotate')}
								>
									<RefreshCw data-icon="inline-start" aria-hidden />
									Link erneuern
								</Button>
								<Button
									type="button"
									variant="destructive"
									className="py-1 text-left"
									disabled={feed.busy}
									onClick={() => feed.setConfirm('revoke')}
								>
									<Trash2 data-icon="inline-start" aria-hidden />
									Abo widerrufen
								</Button>
							</div>
							{feed.copyState === 'failed' && (
								<Alert variant="destructive">
									<AlertDescription>
										Kopieren fehlgeschlagen. Markiere den Link und kopiere ihn manuell.
									</AlertDescription>
								</Alert>
							)}
							<details className="rounded-lg border border-border px-3 py-2">
								<summary className="cursor-pointer text-sm font-medium">
									Apple- und Android-Anleitung
								</summary>
								<div className="mt-3 flex flex-col gap-3 text-sm text-muted-foreground">
									<div>
										<p className="font-medium text-foreground">Apple (iPhone/iPad)</p>
										<p>
											Kalender-App → Kalender → Kalender hinzufügen → Abonnementkalender hinzufügen.
											Den Feed-Link einfügen.
										</p>
									</div>
									<div>
										<p className="font-medium text-foreground">Android (Google Kalender)</p>
										<p>
											Google Kalender am Computer im Browser öffnen → Weitere Kalender → + → Über
											URL. Den Feed-Link einfügen; die Android-App unterstützt das Hinzufügen per
											URL nicht direkt.
										</p>
									</div>
								</div>
							</details>
							<p className="text-xs text-muted-foreground">
								Der Feed enthält WG-Termine. Putzplan-Aufgaben bleiben in ManaWG und werden nicht
								exportiert.
							</p>
						</div>
					) : (
						<Button
							type="button"
							variant="outline"
							disabled={feed.busy}
							onClick={() => void feed.create()}
							className="max-w-full self-start py-1 text-left whitespace-normal"
						>
							{feed.busy ? <Spinner data-icon="inline-start" aria-hidden /> : null}
							Kalender-Feed erstellen
						</Button>
					)}
					{feed.notice && (
						<Alert>
							<AlertDescription aria-live="polite">{feed.notice}</AlertDescription>
						</Alert>
					)}
				</div>
			</details>
			<ConfirmDialog
				open={feed.confirm !== null}
				onClose={() => feed.setConfirm(null)}
				onConfirm={() => {
					if (feed.confirm === 'rotate') void feed.rotate();
					else void feed.revoke();
				}}
				title={feed.confirm === 'rotate' ? 'Feed-Link erneuern?' : 'Kalender-Feed widerrufen?'}
				description={
					feed.confirm === 'rotate'
						? 'Der bisherige Link wird sofort ungültig. Kalender-Apps müssen mit dem neuen Link aktualisiert werden.'
						: 'Der bisherige Link funktioniert sofort nicht mehr. Du kannst später einen neuen Feed erstellen.'
				}
				confirmLabel={feed.confirm === 'rotate' ? 'Link erneuern' : 'Widerrufen'}
				variant={feed.confirm === 'revoke' ? 'danger' : 'default'}
				icon={feed.confirm === 'revoke' ? Trash2 : RefreshCw}
			/>
		</>
	);
}
