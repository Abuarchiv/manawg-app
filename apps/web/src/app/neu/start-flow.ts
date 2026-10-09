/**
 * Pure helpers for the start flow (`/neu`): draft shape, URL intent parsing,
 * and mapping API errors to German copy and the field to focus.
 */
import type { SocialProvider } from '@/components/auth/SocialLoginButtons';
import { safeNextPath } from '@/core/auth/next-path';
import { DELETION_PENDING_MESSAGE, getInitialJoinCode } from '@/core/infra/join-flow';
import { isValidShareCode, normalizeShareCode } from '@/core/utils/share-code';

import { MEMBER_NAME_MAX_LENGTH, WG_NAME_MAX_LENGTH } from '@/shared/lib/limits';

export const WG_NAME_MAX = WG_NAME_MAX_LENGTH;
export const NAME_MAX = MEMBER_NAME_MAX_LENGTH;
export const START_DRAFT_KEY = 'manawg:draft:neu';

export interface CreateResponse {
	wg: { id: string; shareCode: string; name: string };
	creator: { id: string; name: string };
}

export interface CreatedWg {
	code: string;
	name: string;
}

export interface JoinWg {
	code: string;
	name: string;
}

export interface AccountWg {
	id: string;
	code: string;
	name: string;
}

export type StartStep = 'choose' | 'create' | 'join' | 'joinName' | 'invite';
export type StartField = 'wgName' | 'creatorName' | 'joinCode' | 'joinName';

export function isNeuPath(path: string): boolean {
	try {
		return new URL(path, 'https://manawg.invalid').pathname === '/neu';
	} catch {
		return false;
	}
}

export function getWgCodeFromPath(path: string): string | null {
	const match = path.match(/^\/wg\/([^/]+)/);
	if (!match?.[1]) return null;
	try {
		const code = normalizeShareCode(decodeURIComponent(match[1]));
		return isValidShareCode(code) ? code : null;
	} catch {
		return null;
	}
}

export function getNeuIntentFromSearch(search: string): { joinCode: string; create: boolean } {
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

export function getJoinCodeFromSearch(search: string): string {
	return getNeuIntentFromSearch(search).joinCode;
}

// Only a fresh sign-in skips the WG picker; a deliberate visit to /neu (second WG) keeps it.
const JUST_SIGNED_IN_KEY = 'manawg:just-signed-in';

export function markJustSignedIn(): void {
	try {
		sessionStorage.setItem(JUST_SIGNED_IN_KEY, '1');
	} catch {
		// Without storage the user simply sees the picker.
	}
}

export function consumeJustSignedIn(): boolean {
	try {
		const value = sessionStorage.getItem(JUST_SIGNED_IN_KEY);
		sessionStorage.removeItem(JUST_SIGNED_IN_KEY);
		return value === '1';
	} catch {
		return false;
	}
}

export async function startSocialLogin(provider: SocialProvider, next: string): Promise<void> {
	markJustSignedIn();
	const { startSocialLogin } = await import('@/core/auth/client');
	await startSocialLogin(provider, next);
}

export interface StartDraft extends Record<string, unknown> {
	step?: StartStep;
	wgName?: string;
	creatorName?: string;
	joinCode?: string;
	joinName?: string;
	joinWg?: JoinWg;
}

export async function readStartError(response: Response): Promise<string> {
	try {
		const body = (await response.clone().json()) as { code?: unknown; error?: unknown };
		if (typeof body.error === 'string') return body.error;
		if (typeof body.code === 'string') return body.code;
	} catch {
		return '';
	}
	return '';
}

export function createWgErrorMessage(status: number, error: string): string {
	if (status === 429) {
		return 'Du hast gerade mehrere WGs erstellt. Bitte versuche es in etwa einer Stunde erneut.';
	}
	if (error === 'account_deletion_pending') return DELETION_PENDING_MESSAGE;
	if (status === 401 && error === 'auth_required') {
		return 'Melde dich zuerst mit deinem Konto an.';
	}
	if (status === 400 && error === 'name_invalid') {
		return `WG konnte nicht erstellt werden: Der WG-Name muss 1 bis ${WG_NAME_MAX} Zeichen haben.`;
	}
	if (status === 400 && error === 'creator_name_invalid') {
		return `WG konnte nicht erstellt werden: Dein Anzeigename muss 1 bis ${NAME_MAX} Zeichen haben.`;
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
	return 'WG konnte nicht erstellt werden. Bitte versuche es erneut.';
}

export function createWgErrorField(status: number, error: string): StartField | null {
	if (status === 400 && error === 'name_invalid') return 'wgName';
	if (status === 400 && error === 'creator_name_invalid') return 'creatorName';
	return null;
}

export function joinErrorField(status: number, error: string): StartField | null {
	if (status === 404 || error === 'wg_not_found' || error === 'invalid_share_code') {
		return 'joinCode';
	}
	return null;
}

export function isJoinWg(value: unknown): value is JoinWg {
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

export function isAccountWg(value: unknown): value is AccountWg {
	return isJoinWg(value);
}
