'use client';

import { ErrorBox } from '@/components/neu/ErrorBox';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import {
	clearIdentity,
	getLegacyIdentityCandidates,
	memberAuthHeader,
} from '@/shared/lib/identity';
import { isValidShareCode, normalizeShareCode } from '@/shared/lib/share-code';
import { useRouter } from 'next/navigation';
import { type FormEvent, useRef, useState } from 'react';

const GENERIC_RECOVERY_ERROR =
	'Das alte Profil konnte nicht wiederhergestellt werden. Bitte prüfe den WG-Code und versuche es erneut.';

type ClaimResponse = {
	member?: {
		id?: unknown;
	};
};

function isSuccessfulClaim(body: unknown, memberId: string): body is ClaimResponse {
	if (!body || typeof body !== 'object') return false;
	const member = (body as ClaimResponse).member;
	return Boolean(member && typeof member === 'object' && member.id === memberId);
}

export function LegacyAccountRecovery() {
	const router = useRouter();
	const [shareCode, setShareCode] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const submittingRef = useRef(false);

	async function recover(event: FormEvent<HTMLFormElement>): Promise<void> {
		event.preventDefault();
		if (submittingRef.current) return;

		const normalizedCode = normalizeShareCode(shareCode);
		setError(null);
		if (!isValidShareCode(normalizedCode)) {
			setError('Bitte gib einen gültigen WG-Code ein.');
			return;
		}

		submittingRef.current = true;
		setSubmitting(true);
		try {
			const candidates = getLegacyIdentityCandidates();
			for (const candidate of candidates) {
				try {
					const response = await fetch(
						`/api/wg/${encodeURIComponent(normalizedCode)}/members/${encodeURIComponent(candidate.memberId)}/claim`,
						{
							method: 'POST',
							headers: memberAuthHeader(candidate.memberId, candidate.memberToken),
						},
					);
					if (!response.ok) continue;

					const body: unknown = await response.json();
					if (!isSuccessfulClaim(body, candidate.memberId)) continue;

					clearIdentity(candidate.wgId);
					router.replace(`/wg/${encodeURIComponent(normalizedCode)}`);
					return;
				} catch {
					// Continue with the next local proof without exposing claim details.
				}
			}
			setError(GENERIC_RECOVERY_ERROR);
		} finally {
			submittingRef.current = false;
			setSubmitting(false);
		}
	}

	return (
		<Card aria-labelledby="legacy-account-recovery-heading">
			<CardHeader>
				<CardTitle id="legacy-account-recovery-heading">Altes Profil wiederherstellen</CardTitle>
				<CardDescription>
					Gib den WG-Code ein, um ein gespeichertes Profil nach der Anmeldung zu übernehmen.
				</CardDescription>
			</CardHeader>

			<CardContent>
				<form onSubmit={recover} noValidate>
					<FieldGroup>
						<Field data-invalid={Boolean(error)}>
							<FieldLabel htmlFor="legacy-recovery-share-code">WG-Code</FieldLabel>
							<Input
								id="legacy-recovery-share-code"
								name="shareCode"
								type="text"
								value={shareCode}
								onChange={(event) => setShareCode(event.target.value.toUpperCase())}
								autoComplete="off"
								autoCapitalize="characters"
								inputMode="text"
								enterKeyHint="done"
								maxLength={8}
								aria-describedby={error ? 'legacy-recovery-error' : undefined}
								aria-invalid={error ? true : undefined}
								className="font-mono text-base uppercase"
							/>
						</Field>

						{error ? <ErrorBox id="legacy-recovery-error">{error}</ErrorBox> : null}

						<Button
							type="submit"
							variant="outline"
							size="lg"
							disabled={submitting}
							className="w-full"
						>
							{submitting ? <Spinner data-icon="inline-start" aria-hidden="true" /> : null}
							{submitting ? 'Wird wiederhergestellt …' : 'Profil wiederherstellen'}
						</Button>
					</FieldGroup>
				</form>
			</CardContent>
		</Card>
	);
}
