import { badRequest, serverError, tooMany } from '@/core/errors';
import {
	ReplayCache,
	type ReplayReservation,
	claimReplaySlotWithRetry,
	replayKey,
} from '@/core/guards/idempotency';
import { requireWgMember } from '@/core/guards/require-wg-member';
import { readShareCode } from '@/core/guards/route-preamble';
import {
	getCachedResponse,
	persistImportReplayWarning,
	readIdempotencyKey,
	releaseResponseSlot,
} from '@/core/idempotency';
import type { RouteCtx } from '@/core/infra/api-types';
import { logApiError } from '@/core/infra/observability';
import { checkRateLimit, importCommitLimiter } from '@/core/rate-limit';
import { MAX_CSV_BYTES, MAX_OCR_BYTES, readImportJsonBody } from '@/features/expenses/import-body';
import { type CommitResult, commitImport, isCommitResult } from '@/features/expenses/import-commit';
import { hashPayload } from '@/features/expenses/import-hash';
import {
	type ParsedExpense,
	UnsupportedCurrencyError,
	findMappingConflicts,
	parseSplidCsv,
	parseSplitwiseCsv,
} from '@/features/expenses/import-parsers';
import { parseOcrText } from '@/features/expenses/ocr';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

// Generous TTL: a re-submitted commit (double click, retry after a client
// timeout) must replay the SAME result — with skipDuplicates:false there is
// no other guard against inserting the same expenses twice.
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;

const importCommitReplay = new ReplayCache<CommitResult>(IDEMPOTENCY_TTL_MS);

function importCommitIdempotencyScope(wgId: string, memberId: string): string {
	return `import-commit:${wgId}:${memberId}`;
}

const commitSchema = z.object({
	source: z.enum(['splitwise_csv', 'splid_csv', 'ocr_text']),
	payload: z.string().min(1),
	memberMapping: z.record(z.string(), z.string().uuid().nullable()),
	previewPayloadHash: z.string().optional(),
	skipDuplicates: z.boolean().optional().default(true),
	skipIndexes: z.array(z.number().int().min(0)).optional().default([]),
});

function parseFor(source: string, payload: string): ParsedExpense[] {
	if (source === 'splitwise_csv') return parseSplitwiseCsv(payload);
	if (source === 'splid_csv') return parseSplidCsv(payload);
	return parseOcrText(payload).expenses;
}

export async function POST(
	req: NextRequest,
	ctx: RouteCtx<{ code: string }>,
): Promise<NextResponse> {
	const codeResult = await readShareCode(ctx);
	if (!codeResult.ok) return codeResult.response;
	const { code } = codeResult;
	const idemKey = readIdempotencyKey(req);
	let replayReservation: Extract<ReplayReservation<CommitResult>, { owned: true }> | null = null;
	// Set once this request owns the Postgres claim. A failure after that point
	// must release it, otherwise the claim's 15-minute lease turns the caller's
	// immediate retry (same Idempotency-Key, unchanged body) into
	// `idempotency_response_pending` instead of the original error.
	let claimedSlot: { scope: string; key: string } | null = null;

	const raw = await readImportJsonBody(req);
	if (!raw.ok) return badRequest(raw.error);
	const parsedBody = commitSchema.safeParse(raw.value);
	if (!parsedBody.success) return badRequest('invalid_body');
	const { source, payload, memberMapping, previewPayloadHash, skipDuplicates, skipIndexes } =
		parsedBody.data;

	const payloadSize = Buffer.byteLength(payload, 'utf8');
	const limit = source === 'ocr_text' ? MAX_OCR_BYTES : MAX_CSV_BYTES;
	if (payloadSize > limit) return badRequest('payload_too_large');
	const payloadHash = hashPayload(payload);
	if (skipIndexes.length > 0 && previewPayloadHash === undefined) {
		return badRequest('preview_hash_required');
	}
	if (previewPayloadHash !== undefined && previewPayloadHash !== payloadHash) {
		return badRequest('payload_changed');
	}

	try {
		const auth = await requireWgMember(req, code);
		if (!auth.ok) return auth.response;
		const wg = auth.wg;

		const idemScope = idemKey ? importCommitIdempotencyScope(wg.id, auth.member.memberId) : null;
		const idemReplayKey = idemScope && idemKey ? replayKey(idemScope, idemKey) : null;

		// Replay only after WG/member auth, scoped by both IDs to prevent
		// cross-WG or cross-member response leaks for client-provided keys.
		if (idemScope && idemKey && idemReplayKey) {
			const localReplay = importCommitReplay.get(idemReplayKey);
			if (localReplay) return NextResponse.json(await localReplay);

			const cached = await getCachedResponse<CommitResult>(idemScope, idemKey);
			if (cached) {
				if (!isCommitResult(cached)) throw new Error('idempotency_response_unavailable');
				importCommitReplay.remember(idemReplayKey, cached);
				return NextResponse.json(cached);
			}
		}

		const limited = await checkRateLimit(
			importCommitLimiter,
			`import-commit:${wg.id}:${auth.member.memberId}`,
		);
		if (!limited.success) return tooMany();

		let parsedExpenses: ParsedExpense[];
		try {
			parsedExpenses = parseFor(source, payload);
		} catch (parseErr) {
			if (parseErr instanceof UnsupportedCurrencyError) {
				return NextResponse.json(
					{ error: 'unsupported_currency', message: parseErr.message, currency: parseErr.currency },
					{ status: 400 },
				);
			}
			throw parseErr;
		}
		if (parsedExpenses.length === 0) return badRequest('empty_payload');
		if (skipIndexes.some((index) => index >= parsedExpenses.length)) {
			return badRequest('invalid_skip_indexes');
		}

		const skipSet = new Set(skipIndexes);
		const conflicts = findMappingConflicts(
			parsedExpenses.filter((_expense, index) => !skipSet.has(index)),
			memberMapping,
		);
		if (conflicts.length > 0) {
			return NextResponse.json({ error: 'mapping_incomplete', conflicts }, { status: 400 });
		}

		const items = parsedExpenses.map((parsed, index) => ({
			parsed,
			skip: skipSet.has(index),
		}));

		const replaySlot = idemReplayKey === null ? null : importCommitReplay.reserve(idemReplayKey);
		if (replaySlot?.owned === false) {
			return NextResponse.json(await replaySlot.promise);
		}
		replayReservation = replaySlot;

		// Cross-process dedup: claim a Postgres slot so a concurrent cold Lambda
		// with the same Idempotency-Key sees our claim and fetches the cached
		// response instead of committing the import a second time.
		if (idemScope && idemKey) {
			const slot = await claimReplaySlotWithRetry<CommitResult>(idemScope, idemKey);
			if (!slot.won) {
				if (!isCommitResult(slot.cached)) throw new Error('idempotency_response_unavailable');
				replayReservation?.resolve(slot.cached);
				return NextResponse.json(slot.cached);
			}
			claimedSlot = { scope: idemScope, key: idemKey };
		}

		const dbSource = source === 'ocr_text' ? ('ocr_screenshot' as const) : source;
		let result: CommitResult;
		try {
			result = await commitImport({
				wg,
				source: dbSource,
				importedByMemberId: auth.member.memberId,
				importedByName: auth.member.name,
				expenses: items,
				mapping: memberMapping,
				skipDuplicates,
				rawPayloadHash: payloadHash,
				...(idemScope && idemKey ? { replay: { scope: idemScope, key: idemKey } } : {}),
			});
		} catch (writeErr) {
			replayReservation?.reject(writeErr);
			throw writeErr;
		}

		if (idemScope && idemKey && result.warning !== null) {
			try {
				const persisted = await persistImportReplayWarning(
					idemScope,
					idemKey,
					result.importId,
					result.warning,
				);
				if (!persisted) {
					logApiError(
						'[imports/commit] replay warning persistence failed',
						new Error('replay_row_missing'),
					);
				}
			} catch (warningErr) {
				logApiError('[imports/commit] replay warning persistence failed', warningErr);
			}
		}
		if (replayReservation?.owned) replayReservation.resolve(result);
		return NextResponse.json(result);
	} catch (err) {
		// Free the Postgres claim before answering: the client reuses the same
		// Idempotency-Key for an unchanged body, and a claim left behind for its
		// 15-minute lease makes that retry poll for a response that will never
		// arrive (`idempotency_response_pending` → 503 instead of this status).
		// `releaseResponseSlot` only deletes a still-unfilled claim, so a
		// response persisted by a completed commit is left untouched.
		if (claimedSlot) await releaseResponseSlot(claimedSlot.scope, claimedSlot.key);
		replayReservation?.reject(err);
		if (err instanceof Error && err.message === 'member_not_in_wg') {
			return badRequest('member_not_in_wg');
		}
		logApiError('[imports/commit]', err);
		return serverError(err);
	}
}
