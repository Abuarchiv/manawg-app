'use client';

import { Switch } from '@/components/animate-ui/components/base/switch';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldContent, FieldDescription, FieldTitle } from '@/components/ui/field';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { LoadErrorBanner } from '@/components/wg/LoadErrorBanner';
import { Section } from '@/components/wg/einstellungen/Section';
import { parseQuietHour } from '@/core/notifications/notification-preferences';
import { Bell, CheckCircle2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { NOTIFICATION_PREFERENCES, useNotificationSettings } from './use-notification-settings';

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, hour) => ({
	value: hour,
	label: `${String(hour).padStart(2, '0')}:00`,
}));

function HourSelect({
	label,
	ariaLabel,
	value,
	disabled,
	onChange,
}: {
	label: string;
	ariaLabel: string;
	value: number | null | undefined;
	disabled: boolean;
	onChange: (hour: number | null) => void;
}) {
	return (
		<Field className="min-w-0">
			<FieldTitle>{label}</FieldTitle>
			<NativeSelect
				value={value ?? ''}
				disabled={disabled}
				onChange={(e) => onChange(parseQuietHour(e.target.value))}
				aria-label={ariaLabel}
				className="w-full min-w-0 text-base"
			>
				<NativeSelectOption value="">Aus</NativeSelectOption>
				{HOUR_OPTIONS.map((option) => (
					<NativeSelectOption key={option.label} value={option.value}>
						{option.label}
					</NativeSelectOption>
				))}
			</NativeSelect>
		</Field>
	);
}

export function NotificationSection({
	code,
	memberId,
}: {
	code: string;
	memberId: string;
}) {
	const {
		status,
		pushActive,
		pushBlocked,
		pending,
		pushTarget,
		message,
		error,
		loadingStatus,
		loadStatus,
		setPushEnabled,
		togglePreference,
		saveQuietHours,
		sendTestNotification,
	} = useNotificationSettings({ code, memberId });
	const notificationBusy = pending !== null || loadingStatus;
	const notificationControlsDisabled = !status || notificationBusy;
	const pushConfigured = status?.pushConfigured !== false;
	const quietHoursSet = status?.quietStartHour != null || status?.quietEndHour != null;
	const feedbackRef = useRef<HTMLDivElement>(null);
	// The message sits below all switches; a user toggling one at the top would not see it.
	useEffect(() => {
		if (message || (status && error)) feedbackRef.current?.scrollIntoView({ block: 'nearest' });
	}, [message, error, status]);

	return (
		<Section id="benachrichtigungen" title="Hinweise">
			<div className="grid min-w-0 gap-3 p-3">
				{loadingStatus && (
					<div className="grid gap-2" aria-live="polite">
						<Skeleton className="h-11 w-full" />
						<p className="text-muted-foreground text-xs">Hinweise werden geladen…</p>
					</div>
				)}
				{!status && error && (
					<LoadErrorBanner
						message={error}
						onRetry={() => void loadStatus()}
						busy={loadingStatus}
						retryLabel="Erneut laden"
					/>
				)}
				{status && (
					<>
						<Field
							orientation="horizontal"
							className="has-[>[data-slot=field-content]]:items-center"
						>
							<FieldContent>
								<FieldTitle>
									Web Push
									{pushActive && <Bell className="text-muted-foreground h-3.5 w-3.5" aria-hidden />}
								</FieldTitle>
								{!pushConfigured && <FieldDescription>Nicht konfiguriert</FieldDescription>}
								{pushConfigured && !pushActive && pushBlocked && (
									<FieldDescription>
										Benachrichtigungen sind im Browser blockiert. Erlaube sie in den
										Website-Einstellungen.
									</FieldDescription>
								)}
								{pushConfigured && !pushActive && !pushBlocked && status.pushOptIn && (
									<FieldDescription>Auf diesem Gerät noch nicht aktiv</FieldDescription>
								)}
								{pushActive && (
									<Button
										type="button"
										variant="ghost"
										size="sm"
										onClick={() => void sendTestNotification()}
										disabled={notificationControlsDisabled}
										aria-label={
											pending === 'test'
												? 'Testbenachrichtigung wird gesendet'
												: 'Testbenachrichtigung senden'
										}
										className="-ml-2.5 self-start"
									>
										{pending === 'test' && <Spinner aria-hidden />}
										Test senden
									</Button>
								)}
							</FieldContent>
							<Switch
								checked={pushTarget ?? pushActive}
								disabled={
									notificationControlsDisabled || !pushConfigured || (pushBlocked && !pushActive)
								}
								aria-busy={pending === 'push'}
								aria-label="Web Push"
								onCheckedChange={setPushEnabled}
							/>
						</Field>

						<div className="min-w-0 max-w-full">
							{NOTIFICATION_PREFERENCES.map((pref, index) => (
								<div key={pref.key}>
									{index > 0 && <Separator />}
									<Field
										orientation="horizontal"
										className="min-h-[44px] py-1 has-[>[data-slot=field-content]]:items-center"
									>
										<FieldContent>
											<FieldTitle>{pref.label}</FieldTitle>
											{pref.description && <FieldDescription>{pref.description}</FieldDescription>}
										</FieldContent>
										<Switch
											checked={status?.[pref.key] ?? true}
											disabled={notificationControlsDisabled}
											aria-label={pref.label}
											onCheckedChange={() => void togglePreference(pref.key)}
										/>
									</Field>
								</div>
							))}
						</div>

						<div className="border-border grid min-w-0 max-w-full grid-cols-1 gap-1 border-t pt-2">
							<div className="flex min-h-[44px] flex-wrap items-center justify-between gap-2">
								<div className="text-foreground min-w-0 text-sm font-medium">Ruhezeit</div>
								{quietHoursSet && (
									<Button
										type="button"
										variant="ghost"
										onClick={() => void saveQuietHours(null, null)}
										disabled={notificationControlsDisabled}
									>
										Ausschalten
									</Button>
								)}
							</div>
							<FieldDescription>
								Zeiten in Berlin-Zeit. Fällige Aufgaben und Termine kommen trotzdem durch.
							</FieldDescription>
							<div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-2">
								<HourSelect
									label="Von"
									ariaLabel="Ruhezeit von"
									value={status?.quietStartHour}
									disabled={notificationControlsDisabled}
									onChange={(value) =>
										void (value === null
											? saveQuietHours(null, null)
											: saveQuietHours(value, status?.quietEndHour ?? (value + 8) % 24))
									}
								/>
								<HourSelect
									label="Bis"
									ariaLabel="Ruhezeit bis"
									value={status?.quietEndHour}
									disabled={notificationControlsDisabled}
									onChange={(value) =>
										void (value === null
											? saveQuietHours(null, null)
											: saveQuietHours(status?.quietStartHour ?? (value + 16) % 24, value))
									}
								/>
							</div>
						</div>
					</>
				)}

				<div ref={feedbackRef} className="grid gap-3 scroll-mb-24 empty:hidden">
					{message && (
						<Alert>
							<CheckCircle2 aria-hidden />
							<AlertDescription>{message}</AlertDescription>
						</Alert>
					)}
					{status && error && (
						<Alert variant="destructive">
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					)}
				</div>
			</div>
		</Section>
	);
}
