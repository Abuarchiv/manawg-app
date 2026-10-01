'use client';

import {
	Collapsible,
	CollapsiblePanel,
	CollapsibleTrigger,
} from '@/components/animate-ui/primitives/base/collapsible';
import { CredentialsAuth } from '@/components/auth/CredentialsAuth';
import { LegacyAccountRecovery } from '@/components/auth/LegacyAccountRecovery';
import { SocialLoginButtons, type SocialProvider } from '@/components/auth/SocialLoginButtons';
import { EntryFrame } from '@/components/entry/EntryFrame';
import { LegalLinks } from '@/components/entry/LegalLinks';
import { BackButton } from '@/components/neu/BackButton';
import { ErrorBox } from '@/components/neu/ErrorBox';
import { Field } from '@/components/neu/Field';
import { InviteStep } from '@/components/neu/InviteStep';
import { Button } from '@/components/ui/button';
import {
	FieldDescription,
	FieldGroup,
	FieldLabel,
	FieldSeparator,
	Field as UiField,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
	Item,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemMedia,
	ItemTitle,
} from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { safeNextPath } from '@/core/auth/next-path';
import { getInitialJoinCode, joinErrorMessage } from '@/core/infra/join-flow';
import { readDraft, removeDraft, writeDraft } from '@/core/offline/drafts';
import { createOfflineIdempotencyKey } from '@/core/offline/offline-queue';
import posthog from '@/shared/lib/analytics';
import { getIdentity, rememberWg } from '@/shared/lib/identity';
import { isValidShareCode, normalizeShareCode } from '@/shared/lib/share-code';
import { ArrowRight, ChevronDown, Home, KeyRound, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

const WG_NAME_MAX = 100;
const NAME_MAX = 80;
const START_DRAFT_KEY = 'manawg:draft:neu';

interface CreateResponse {
	wg: { id: string; shareCode: string; name: string };
	creator: { id: string; name: string };
}

interface CreatedWg {
	code: string;
	name: string;
}

interface JoinWg {
	code: string;
	name: string;
}

interface AccountWg {
	id: string;
	code: string;
	name: string;
}

type StartStep = 'choose' | 'create' | 'join' | 'joinName' | 'invite';
type StartField = 'wgName' | 'creatorName' | 'joinCode' | 'joinName';

function isNeuPath(path: string): boolean {
	try {
		return new URL(path, 'https://manawg.invalid').pathname === '/neu';
	} catch {
		return false;
	}
}

function getWgCodeFromPath(path: string): string | null {
	const match = path.match(/^\/wg\/([^/]+)/);
	if (!match?.[1]) return null;
	try {
		const code = normalizeShareCode(decodeURIComponent(match[1]));
		return isValidShareCode(code) ? code : null;
	} catch {
		return null;
	}
}

function getNeuIntentFromSearch(search: string): { joinCode: string; create: boolean } {
	const currentSearch = search.startsWith('?') ? search : `?${search}`;
	const nested = safeNextPath(new URLSearchParams(currentSearch).get('next'));
	for (const candidate of [currentSearch, nested]) {
		const url = new URL(candidate, 'https://manawg.invalid/neu');
		if (url.pathname !== '/neu') continue;
		const joinCode = getInitialJoinCode(url.search);
		if (joinCode) return { joinCode, create: false };
		if (url.searchParams.get('action') === 'create') return { joinCode: '', create: true };
	}
	return { joinCode: '', create: false };
}

function getJoinCodeFromSearch(search: string): string {
	return getNeuIntentFromSearch(search).joinCode;
}

async function startSocialLogin(provider: SocialProvider, next: string): Promise<void> {
	const { startSocialLogin } = await import('@/core/auth/client');
	await startSocialLogin(provider, next);
}

interface StartDraft extends Record<string, unknown> {
	step?: StartStep;
	wgName?: string;
	creatorName?: string;
	joinCode?: string;
	joinName?: string;
	joinWg?: JoinWg;
}

async function readStartError(response: Response): Promise<string> {
	try {
		const body = (await response.clone().json()) as { code?: unknown; error?: unknown };
		if (typeof body.error === 'string') return body.error;
		if (typeof body.code === 'string') return body.code;
	} catch {
		return '';
	}
	return '';
}

function createWgErrorMessage(status: number, error: string): string {
	if (status === 401 && error === 'auth_required') {
		return 'Melde dich zuerst mit deinem Konto an.';
	}
	if (status === 400 && error === 'name_invalid') {
		return 'WG konnte nicht erstellt werden: Der WG-Name muss 1 bis 100 Zeichen haben.';
	}
	if (status === 400 && error === 'creator_name_invalid') {
		return 'WG konnte nicht erstellt werden: Dein Anzeigename muss 1 bis 80 Zeichen haben.';
	}
	if (status === 400 && (error === 'invalid_body' || error === 'invalid_json')) {
		return 'WG-Name und dein Anzeigename müssen ausgefüllt und kurz genug sein.';
	}
	if (error === 'share_code_exhausted') {
		return 'Gerade konnte kein WG-Code erstellt werden. Bitte versuche es gleich noch einmal.';
	}
	if (error === 'insert_failed' || error === 'member_insert_failed') {
		return 'WG konnte nicht vollständig erstellt werden. Bitte versuche es erneut.';
	}
	if (
		status >= 500 ||
		error === 'server_error' ||
		error === 'unexpected_error' ||
		error === 'db_error'
	) {
		return 'WG konnte nicht erstellt werden: Versuche es gleich erneut.';
	}
	return 'Konnte WG nicht erstellen.';
}

function createWgErrorField(status: number, error: string): StartField | null {
	if (status === 400 && error === 'name_invalid') return 'wgName';
	if (status === 400 && error === 'creator_name_invalid') return 'creatorName';
	return null;
}

function joinErrorField(status: number, error: string): StartField | null {
	if (status === 404 || error === 'wg_not_found' || error === 'invalid_share_code') {
		return 'joinCode';
	}
	return null;
}

function isJoinWg(value: unknown): value is JoinWg {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const code = Reflect.get(value, 'code');
	const name = Reflect.get(value, 'name');
	return (
		typeof code === 'string' &&
		isValidShareCode(normalizeShareCode(code)) &&
		typeof name === 'string' &&
		name.trim().length > 0
	);
}

function isAccountWg(value: unknown): value is AccountWg {
	return isJoinWg(value);
}

export function NeuClient() {
	const router = useRouter();
	const searchParams = useSearchParams();
	const [step, setStep] = useState<StartStep>('choose');
	const [wgName, setWgName] = useState('');
	const [creatorName, setCreatorName] = useState('');
	const [joinCode, setJoinCode] = useState('');
	const [joinName, setJoinName] = useState('');
	const [joinWg, setJoinWg] = useState<JoinWg | null>(null);
	const [accountWgs, setAccountWgs] = useState<AccountWg[]>([]);
	const [authState, setAuthState] = useState<'loading' | 'signed-out' | 'authenticated' | 'error'>(
		'loading',
	);
	const [authRetryNonce, setAuthRetryNonce] = useState(0);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [invalidField, setInvalidField] = useState<StartField | null>(null);
	const [accountSwitchError, setAccountSwitchError] = useState<string | null>(null);
	const [createdWg, setCreatedWg] = useState<CreatedWg | null>(null);
	const [interactive, setInteractive] = useState(false);
	const busyRef = useRef(false);
	const createRequestRef = useRef<{ fingerprint: string; key: string } | null>(null);
	const joinRequestRef = useRef<{ fingerprint: string; key: string } | null>(null);
	const [legacyOpen, setLegacyOpen] = useState(false);

	function clearError(): void {
		setError(null);
		setInvalidField(null);
	}

	function setFormError(message: string): void {
		setError(message);
		setInvalidField(null);
	}

	function setFieldError(field: StartField, message: string): void {
		setError(message);
		setInvalidField(field);
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: mount-only initializer — reads the saved draft and initial URL params once; adding searchParams would re-run on navigation and clobber in-progress step/draft state.
	useEffect(() => {
		const initialSearch =
			typeof window === 'undefined' ? searchParams.toString() : window.location.search;
		const initialParams = new URLSearchParams(initialSearch);
		const intent = getNeuIntentFromSearch(initialSearch);
		const code = intent.joinCode;
		const draft = readDraft<StartDraft>(START_DRAFT_KEY);
		if (draft?.wgName) setWgName(draft.wgName);
		if (draft?.creatorName) setCreatorName(draft.creatorName);
		if (draft?.joinName) setJoinName(draft.joinName);
		if (code) {
			setJoinCode(code);
			setStep('join');
		} else if (intent.create || initialParams.get('action') === 'create') {
			setStep('create');
		} else {
			if (draft?.joinCode) setJoinCode(draft.joinCode);
			if (draft?.step === 'joinName' && isJoinWg(draft.joinWg)) {
				const restoredCode = normalizeShareCode(draft.joinWg.code);
				setJoinWg({ code: restoredCode, name: `WG ${restoredCode}` });
				setStep('joinName');
			} else if (draft?.step === 'create' || draft?.step === 'join') setStep(draft.step);
			else if (draft?.joinCode) setStep('join');
		}
		setInteractive(true);
	}, []);

	useEffect(() => {
		if (!interactive) return;
		let cancelled = false;
		const loadAccountWgs = async () => {
			if (authRetryNonce > 0) {
				setError(null);
				setInvalidField(null);
			}
			setAuthState('loading');
			try {
				const res = await fetch('/api/wg/mine', { cache: 'no-store' });
				if (cancelled) return;
				if (res.status === 401) {
					setAccountWgs([]);
					setAuthState('signed-out');
					return;
				}
				if (!res.ok) {
					setAuthState('error');
					return;
				}
				const data: unknown = await res.json();
				const wgs =
					data && typeof data === 'object' && !Array.isArray(data)
						? Reflect.get(data, 'wgs')
						: null;
				if (!Array.isArray(wgs) || !wgs.every(isAccountWg)) {
					setAuthState('error');
					return;
				}
				setAccountWgs(
					wgs.map((wg) => ({ ...wg, code: normalizeShareCode(wg.code), name: wg.name.trim() })),
				);
				setAuthState('authenticated');
			} catch {
				if (!cancelled) setAuthState('error');
			}
		};
		void loadAccountWgs();
		return () => {
			cancelled = true;
		};
	}, [authRetryNonce, interactive]);

	useEffect(() => {
		if (authState !== 'authenticated') return;
		const intent = getNeuIntentFromSearch(searchParams.toString());
		if (intent.joinCode || intent.create) return;
		const next = safeNextPath(searchParams.get('next'));
		if (next === '/' || isNeuPath(next)) return;
		const nextWgCode = getWgCodeFromPath(next);
		if (nextWgCode && !accountWgs.some((accountWg) => accountWg.code === nextWgCode)) return;
		router.replace(next);
	}, [accountWgs, authState, router, searchParams]);

	useEffect(() => {
		if (!interactive) return;
		if (step === 'invite') {
			removeDraft(START_DRAFT_KEY);
			return;
		}
		const draft: StartDraft = {
			step,
			wgName,
			creatorName,
			joinCode,
			joinName,
			...(joinWg ? { joinWg } : {}),
		};
		const hasDraft = [wgName, creatorName, joinCode, joinName].some(
			(value) => value.trim().length > 0,
		);
		if (hasDraft) writeDraft(START_DRAFT_KEY, draft);
		else removeDraft(START_DRAFT_KEY);
	}, [creatorName, interactive, joinCode, joinName, joinWg, step, wgName]);

	function loginNextPath(): string {
		const params = new URLSearchParams();
		if (step === 'create') params.set('action', 'create');
		const code = joinCode || getJoinCodeFromSearch(searchParams.toString()) || joinWg?.code;
		if ((step === 'join' || step === 'joinName') && code) {
			params.set('code', normalizeShareCode(code));
		}
		const next = safeNextPath(searchParams.get('next'));
		if (next !== '/' && !isNeuPath(next)) params.set('next', next);
		const query = params.toString();
		return query ? `/neu?${query}` : '/neu';
	}

	function explorationHref(): string {
		const code = getJoinCodeFromSearch(searchParams.toString());
		return code ? `/?code=${encodeURIComponent(code)}` : '/';
	}

	function returnToSignIn(): void {
		setAuthState('signed-out');
		clearError();
		router.replace(loginNextPath());
	}

	async function switchAccount(): Promise<void> {
		if (busyRef.current) return;
		busyRef.current = true;
		setBusy(true);
		setAccountSwitchError(null);
		try {
			const { signOutSocialAccount } = await import('@/core/auth/client');
			const pushTargets = accountWgs.flatMap((wg) => {
				const identity = getIdentity(wg.id);
				return identity
					? [
							{
								code: wg.code,
								memberId: identity.memberId,
								...(identity.memberToken ? { memberToken: identity.memberToken } : {}),
							},
						]
					: [];
			});
			const { pushCleanup } = await signOutSocialAccount(pushTargets);
			const intent = getNeuIntentFromSearch(searchParams.toString());
			removeDraft(START_DRAFT_KEY);
			setStep(intent.joinCode ? 'join' : intent.create ? 'create' : 'choose');
			setWgName('');
			setCreatorName('');
			setJoinCode(intent.joinCode);
			setJoinName('');
			setJoinWg(null);
			setCreatedWg(null);
			clearError();
			setAccountWgs([]);
			setAuthState('signed-out');
			if (pushCleanup === 'failed') {
				setAccountSwitchError(
					'Du bist abgemeldet, aber Push konnte auf diesem Browser nicht sicher beendet werden. Deaktiviere Website-Benachrichtigungen in den Browsereinstellungen.',
				);
			}
		} catch {
			setAccountSwitchError('Konto konnte nicht abgemeldet werden. Bitte erneut versuchen.');
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	}

	async function createWg(): Promise<void> {
		if (busyRef.current) return;
		const trimmedWg = wgName.trim();
		const trimmedMe = creatorName.trim();
		if (trimmedWg.length === 0) return setFieldError('wgName', 'WG-Name fehlt.');
		if (trimmedMe.length === 0) return setFieldError('creatorName', 'Dein Anzeigename fehlt.');
		busyRef.current = true;
		setBusy(true);
		clearError();
		const body = { name: trimmedWg, creatorName: trimmedMe };
		const fingerprint = JSON.stringify(body);
		const pendingRequest = createRequestRef.current;
		const idempotencyKey =
			pendingRequest?.fingerprint === fingerprint
				? pendingRequest.key
				: createOfflineIdempotencyKey();
		if (!idempotencyKey) {
			setFormError('WG konnte nicht sicher erstellt werden. Versuche es erneut.');
			busyRef.current = false;
			setBusy(false);
			return;
		}
		createRequestRef.current = { fingerprint, key: idempotencyKey };
		try {
			const res = await fetch('/api/wg', {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'Idempotency-Key': idempotencyKey },
				body: JSON.stringify(body),
			});
			if (res.status === 401) {
				returnToSignIn();
				return;
			}
			if (!res.ok) {
				if (res.status > 0 && res.status < 500) createRequestRef.current = null;
				const apiError = await readStartError(res);
				const message = createWgErrorMessage(res.status, apiError);
				const field = createWgErrorField(res.status, apiError);
				if (field) setFieldError(field, message);
				else setFormError(message);
				return;
			}
			createRequestRef.current = null;
			const data = (await res.json()) as CreateResponse;
			posthog.capture('wg_created');
			rememberWg({
				code: data.wg.shareCode,
				name: data.wg.name,
				lastVisitedAt: Date.now(),
			});
			removeDraft(START_DRAFT_KEY);
			setCreatedWg({ code: data.wg.shareCode, name: data.wg.name });
			setStep('invite');
		} catch {
			setFormError(
				'WG konnte nicht erstellt werden: Prüfe deine Verbindung und versuche es erneut.',
			);
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	}

	async function verifyJoinCode(): Promise<void> {
		if (busyRef.current) return;
		const code = normalizeShareCode(joinCode);
		if (!isValidShareCode(code)) {
			setFieldError(
				'joinCode',
				'Code besteht aus 8 Zeichen (Großbuchstaben/Ziffern, ohne I/L/O/U).',
			);
			return;
		}
		busyRef.current = true;
		setBusy(true);
		clearError();
		try {
			if (process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE === 'true') {
				// The database-free fixture keeps its existing policy-preview contract;
				// production never performs this private metadata lookup before joining.
				const res = await fetch(`/api/wg/${encodeURIComponent(code)}`, { cache: 'no-store' });
				if (!res.ok) {
					const apiError = await readStartError(res);
					const message = joinErrorMessage(res.status, apiError);
					const field = joinErrorField(res.status, apiError);
					if (field) setFieldError(field, message);
					else setFormError(message);
					return;
				}
				const data = (await res.json()) as {
					wg: { id: string; shareCode: string; name: string; joiningEnabled?: boolean };
				};
				if (data.wg.joiningEnabled === false) {
					setFormError(joinErrorMessage(403, 'joining_disabled'));
					return;
				}
			}
			// A valid code is only a local input checkpoint. The authenticated POST
			// remains the authority for existence, membership, and invite policy.
			// The real WG name isn't fetchable pre-join (GET /api/wg/[code] requires
			// membership), so we show the code itself rather than a fabricated name.
			setJoinWg({ code, name: `WG ${code}` });
			setStep('joinName');
		} catch {
			setFormError(joinErrorMessage(0, ''));
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	}

	async function joinExistingWg(): Promise<void> {
		if (busyRef.current) return;
		const name = joinName.trim();
		if (!joinWg) return;
		if (name.length === 0) {
			setFieldError('joinName', 'Dein Anzeigename fehlt.');
			return;
		}
		busyRef.current = true;
		setBusy(true);
		clearError();
		const body = { name };
		const fingerprint = JSON.stringify({ code: joinWg.code, ...body });
		const pendingRequest = joinRequestRef.current;
		const idempotencyKey =
			pendingRequest?.fingerprint === fingerprint
				? pendingRequest.key
				: createOfflineIdempotencyKey();
		if (!idempotencyKey) {
			setFormError('WG-Beitritt konnte nicht sicher gesendet werden. Versuche es erneut.');
			busyRef.current = false;
			setBusy(false);
			return;
		}
		joinRequestRef.current = { fingerprint, key: idempotencyKey };
		try {
			const res = await fetch(`/api/wg/${encodeURIComponent(joinWg.code)}/members`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'Idempotency-Key': idempotencyKey },
				body: JSON.stringify(body),
			});
			if (res.status === 401) {
				returnToSignIn();
				return;
			}
			if (!res.ok) {
				if (res.status > 0 && res.status < 500) joinRequestRef.current = null;
				const apiError = await readStartError(res);
				if (res.status === 409 && apiError === 'already_joined') {
					removeDraft(START_DRAFT_KEY);
					router.push(`/wg/${encodeURIComponent(joinWg.code)}`);
					return;
				}
				const message =
					apiError === 'auth_required'
						? 'Melde dich zuerst mit deinem Konto an.'
						: joinErrorMessage(res.status, apiError);
				if (apiError === 'name_invalid' || (res.status === 409 && apiError === 'name_taken')) {
					setFieldError('joinName', message);
				} else if (joinErrorField(res.status, apiError) === 'joinCode') {
					// The code is only checked by this POST; send the user back to fix it.
					setStep('join');
					setFieldError('joinCode', message);
				} else {
					setFormError(message);
				}
				return;
			}
			joinRequestRef.current = null;
			await res.json();
			posthog.capture('wg_joined');
			rememberWg({ code: joinWg.code, name: joinWg.name, lastVisitedAt: Date.now() });
			removeDraft(START_DRAFT_KEY);
			router.push(`/wg/${encodeURIComponent(joinWg.code)}`);
		} catch {
			setFormError(joinErrorMessage(0, ''));
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	}

	function backToChoose(): void {
		setStep('choose');
		clearError();
		setJoinWg(null);
	}

	const callbackError = searchParams.get('error') === 'auth_callback';

	function handleAuthenticated(): void {
		setAuthState('loading');
		setAuthRetryNonce((value) => value + 1);
	}

	if (authState !== 'authenticated') {
		return (
			<EntryFrame
				title="Anmelden"
				headingId="auth-heading"
				description={
					step === 'create'
						? 'Melde dich an, danach erstellst du deine neue WG.'
						: joinCode
							? 'Melde dich an, um mit deinem Einladungscode beizutreten.'
							: 'Dein Konto bringt dich auf jedem Gerät zurück in deine WG.'
				}
				backHref={explorationHref()}
			>
				{accountSwitchError && <ErrorBox>{accountSwitchError}</ErrorBox>}
				{callbackError && (
					<ErrorBox>
						Die Anmeldung konnte nicht abgeschlossen werden. Bitte versuche es erneut.
					</ErrorBox>
				)}
				{authState === 'error' && (
					<div className="flex flex-col gap-2">
						<ErrorBox>Deine Anmeldung konnte gerade nicht geprüft werden.</ErrorBox>
						<Button variant="outline" onClick={() => setAuthRetryNonce((value) => value + 1)}>
							Erneut prüfen
						</Button>
					</div>
				)}
				{authState === 'loading' ? (
					<output
						aria-live="polite"
						aria-label="Anmeldung wird geprüft"
						className="flex flex-col gap-4"
					>
						<Skeleton className="h-11 w-full" />
						<Skeleton className="h-40 w-full" />
						<span className="sr-only">Anmeldung wird geprüft</span>
					</output>
				) : (
					<FieldGroup>
						<SocialLoginButtons next={loginNextPath()} onOAuthStart={startSocialLogin} />
						<FieldSeparator>oder</FieldSeparator>
						<CredentialsAuth next={loginNextPath()} onAuthenticated={handleAuthenticated} />
					</FieldGroup>
				)}
				<LegalLinks consent />
			</EntryFrame>
		);
	}

	return (
		<EntryFrame
			title={
				step === 'choose'
					? 'Deine WG'
					: step === 'create'
						? 'Neue WG erstellen'
						: step === 'join'
							? 'Per Code beitreten'
							: step === 'joinName'
								? 'Dein Name in der WG'
								: (createdWg?.name ?? 'Mitbewohner einladen')
			}
			description={
				step === 'invite'
					? 'Deine WG ist erstellt. Jetzt kannst du die Einladung teilen.'
					: step === 'joinName'
						? 'Mit diesem Namen sehen dich deine Mitbewohner.'
						: step === 'create'
							? 'Gib eurer WG einen Namen. Danach erhältst du euren Einladungscode.'
							: step === 'join'
								? 'Gib den Einladungscode deiner Mitbewohner ein.'
								: 'Öffne eine bestehende WG oder starte gemeinsam neu.'
			}
			backHref={explorationHref()}
			actions={
				step !== 'invite' ? (
					<Button
						type="button"
						variant="link"
						onClick={() => void switchAccount()}
						disabled={busy}
						className="w-fit px-0 text-muted-foreground underline underline-offset-4"
					>
						{busy ? 'Bitte warten…' : 'Mit anderem Konto anmelden'}
					</Button>
				) : undefined
			}
		>
			{callbackError && (
				<ErrorBox>
					Die Anmeldung konnte nicht abgeschlossen werden. Bitte versuche es erneut.
				</ErrorBox>
			)}
			{accountSwitchError && <ErrorBox>{accountSwitchError}</ErrorBox>}

			{step === 'choose' && (
				<div className="flex flex-col gap-4">
					{accountWgs.length > 0 && (
						<section aria-labelledby="your-wgs-heading" className="flex flex-col gap-3">
							<h2 id="your-wgs-heading" className="text-base font-semibold">
								Deine WGs
							</h2>
							<ItemGroup>
								{accountWgs.map((accountWg) => (
									<Item
										key={accountWg.id}
										variant="outline"
										render={<Link href={`/wg/${encodeURIComponent(accountWg.code)}`} />}
									>
										<ItemMedia variant="icon">
											<Home aria-hidden />
										</ItemMedia>
										<ItemContent className="min-w-0">
											<ItemTitle className="line-clamp-none break-words">
												{accountWg.name}
											</ItemTitle>
											<ItemDescription>WG öffnen</ItemDescription>
										</ItemContent>
									</Item>
								))}
							</ItemGroup>
						</section>
					)}
					<div className="flex flex-col gap-2">
						<Button
							size="lg"
							disabled={!interactive || busy}
							onClick={() => setStep('create')}
							className="w-full"
						>
							<Plus data-icon="inline-start" aria-hidden /> Neue WG erstellen
						</Button>
						<Button
							size="lg"
							variant="outline"
							disabled={!interactive || busy}
							onClick={() => setStep('join')}
							className="w-full"
						>
							<KeyRound data-icon="inline-start" aria-hidden /> Per Code beitreten
						</Button>
					</div>
					<Collapsible open={legacyOpen} onOpenChange={setLegacyOpen}>
						<CollapsibleTrigger
							render={
								<Button
									variant="ghost"
									className="h-auto w-full justify-between whitespace-normal text-left"
								/>
							}
						>
							Altes Profil auf diesem Gerät wiederherstellen
							<ChevronDown data-icon="inline-end" aria-hidden />
						</CollapsibleTrigger>
						<CollapsiblePanel keepRendered>
							<div inert={!legacyOpen} className="pt-3">
								<LegacyAccountRecovery />
							</div>
						</CollapsiblePanel>
					</Collapsible>
				</div>
			)}

			{step === 'create' && (
				<form
					noValidate
					onSubmit={(event) => {
						event.preventDefault();
						void createWg();
					}}
					className="flex flex-col gap-5"
				>
					<FieldGroup>
						<Field
							id="wg-name"
							label="WG-Name"
							placeholder="z. B. WG Kurt-Schumacher"
							value={wgName}
							onChange={setWgName}
							maxLength={WG_NAME_MAX}
							autoComplete="organization"
							autoFocus
							required
							invalid={invalidField === 'wgName'}
							describedBy={invalidField === 'wgName' ? 'create-wg-error' : undefined}
							enterKeyHint="next"
						/>
						<Field
							id="creator-name"
							label="Dein Anzeigename"
							placeholder="z. B. Anna"
							value={creatorName}
							onChange={setCreatorName}
							maxLength={NAME_MAX}
							autoComplete="given-name"
							required
							invalid={invalidField === 'creatorName'}
							describedBy={invalidField === 'creatorName' ? 'create-wg-error' : undefined}
							enterKeyHint="done"
						/>
					</FieldGroup>
					{error && (
						<ErrorBox
							id={
								invalidField === 'wgName' || invalidField === 'creatorName'
									? 'create-wg-error'
									: 'create-wg-form-error'
							}
						>
							{error}
						</ErrorBox>
					)}
					<div className="flex flex-wrap items-center gap-2">
						<BackButton onClick={backToChoose} disabled={busy} />
						<Button
							type="submit"
							disabled={busy}
							aria-label={busy ? 'WG wird erstellt…' : 'WG erstellen'}
							className="flex-1"
						>
							{busy ? (
								<Spinner data-icon="inline-start" aria-hidden />
							) : (
								<ArrowRight data-icon="inline-start" aria-hidden />
							)}
							{busy ? 'Wird erstellt…' : 'WG erstellen'}
						</Button>
					</div>
				</form>
			)}

			{step === 'invite' && createdWg && (
				<InviteStep
					code={createdWg.code}
					wgName={createdWg.name}
					onSkip={() => router.push(`/wg/${encodeURIComponent(createdWg.code)}`)}
				/>
			)}

			{step === 'join' && (
				<form
					noValidate
					onSubmit={(event) => {
						event.preventDefault();
						void verifyJoinCode();
					}}
					className="flex flex-col gap-5"
				>
					<FieldGroup>
						<UiField data-invalid={invalidField === 'joinCode'}>
							<FieldLabel htmlFor="join-code">WG-Code</FieldLabel>
							<Input
								id="join-code"
								type="text"
								value={joinCode}
								onChange={(event) => {
									setJoinCode(event.target.value.toUpperCase());
									if (error) clearError();
								}}
								maxLength={8}
								required
								autoFocus
								autoComplete="off"
								autoCapitalize="characters"
								inputMode="text"
								enterKeyHint="done"
								placeholder="ABCD1234"
								aria-describedby={
									invalidField === 'joinCode' ? 'join-code-hint join-code-error' : 'join-code-hint'
								}
								aria-invalid={invalidField === 'joinCode'}
								className="font-mono text-base"
							/>
							<FieldDescription id="join-code-hint">
								8 Zeichen, ohne I, L, O und U.
							</FieldDescription>
						</UiField>
					</FieldGroup>
					{error && (
						<ErrorBox id={invalidField === 'joinCode' ? 'join-code-error' : 'join-code-form-error'}>
							{error}
						</ErrorBox>
					)}
					<div className="flex flex-wrap items-center gap-2">
						<BackButton onClick={backToChoose} disabled={busy} />
						<Button
							type="submit"
							disabled={busy}
							aria-label={busy ? 'WG-Code wird geprüft…' : 'WG-Code prüfen'}
							className="flex-1"
						>
							{busy ? (
								<Spinner data-icon="inline-start" aria-hidden />
							) : (
								<ArrowRight data-icon="inline-start" aria-hidden />
							)}
							{busy ? 'Wird geprüft…' : 'Code prüfen'}
						</Button>
					</div>
				</form>
			)}

			{step === 'joinName' && joinWg && (
				<form
					noValidate
					onSubmit={(event) => {
						event.preventDefault();
						void joinExistingWg();
					}}
					className="flex flex-col gap-5"
				>
					<FieldGroup>
						<Field
							id="join-name"
							label="Dein Anzeigename"
							placeholder="z. B. Samira"
							value={joinName}
							onChange={(value) => {
								setJoinName(value);
								if (error) clearError();
							}}
							maxLength={NAME_MAX}
							autoComplete="given-name"
							autoFocus
							required
							invalid={invalidField === 'joinName'}
							describedBy={invalidField === 'joinName' ? 'join-name-error' : undefined}
							enterKeyHint="done"
						/>
					</FieldGroup>
					<p className="text-sm text-muted-foreground">
						Du trittst <span className="font-medium text-foreground">{joinWg.name}</span> bei.
					</p>
					{error && (
						<ErrorBox id={invalidField === 'joinName' ? 'join-name-error' : 'join-name-form-error'}>
							{error}
						</ErrorBox>
					)}
					<div className="flex flex-wrap items-center gap-2">
						<BackButton
							onClick={() => {
								clearError();
								setStep('join');
							}}
							disabled={busy}
						/>
						<Button
							type="submit"
							disabled={busy}
							aria-label={busy ? 'Du trittst der WG bei…' : 'WG beitreten'}
							className="flex-1"
						>
							{busy ? (
								<Spinner data-icon="inline-start" aria-hidden />
							) : (
								<ArrowRight data-icon="inline-start" aria-hidden />
							)}
							{busy ? 'Wird beigetreten…' : 'Beitreten'}
						</Button>
					</div>
				</form>
			)}
		</EntryFrame>
	);
}
