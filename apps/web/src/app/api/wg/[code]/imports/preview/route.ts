import { db, wgMembers } from '@/core/db';
import { badRequest, tooMany } from '@/core/errors';
import { requireWgMember } from '@/core/guards/require-wg-member';
import { withWgRoute } from '@/core/guards/with-wg-route';
import { checkRateLimit, importLimiter } from '@/core/rate-limit';
import { MAX_CSV_BYTES, MAX_OCR_BYTES, readImportJsonBody } from '@/features/expenses/import-body';
import { hashPayload } from '@/features/expenses/import-hash';
import {
	type ParsedExpense,
	UnsupportedCurrencyError,
	collectUniqueNames,
	findMappingConflicts,
	matchMembers,
	parseSplidCsv,
	parseSplitwiseCsv,
} from '@/features/expenses/import-parsers';
import { parseOcrText } from '@/features/expenses/ocr';
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';

// Same `memberMapping` contract as `commit/route.ts`: a UUID or null. A looser
// schema here let a preview succeed with a mapping the commit then rejected
// with `invalid_body`.
const previewSchema = z.object({
	source: z.enum(['splitwise_csv', 'splid_csv', 'ocr_text']),
	payload: z.string().min(1),
	memberMapping: z.record(z.string(), z.string().uuid().nullable()).optional(),
});

export const POST = withWgRoute('imports/preview', async (req, { code }) => {
	const auth = await requireWgMember(req, code);
	if (!auth.ok) return auth.response;
	const wg = auth.wg;

	const raw = await readImportJsonBody(req);
	if (!raw.ok) return badRequest(raw.error);
	const parsedBody = previewSchema.safeParse(raw.value);
	if (!parsedBody.success) return badRequest('invalid_body');
	const { source, payload, memberMapping } = parsedBody.data;
	const payloadSize = Buffer.byteLength(payload, 'utf8');
	const limit = source === 'ocr_text' ? MAX_OCR_BYTES : MAX_CSV_BYTES;
	if (payloadSize > limit) return badRequest('payload_too_large');

	const limited = await checkRateLimit(
		importLimiter,
		`import-preview:${wg.id}:${auth.member.memberId}`,
	);
	if (!limited.success) return tooMany();

	let parsedExpenses: ParsedExpense[];
	try {
		parsedExpenses =
			source === 'splitwise_csv'
				? parseSplitwiseCsv(payload)
				: source === 'splid_csv'
					? parseSplidCsv(payload)
					: parseOcrText(payload).expenses;
	} catch (parseErr) {
		if (parseErr instanceof UnsupportedCurrencyError) {
			return NextResponse.json(
				{ error: 'unsupported_currency', message: parseErr.message, currency: parseErr.currency },
				{ status: 400 },
			);
		}
		throw parseErr;
	}

	const memberRows = await db
		.select({ id: wgMembers.id, name: wgMembers.name, deactivatedAt: wgMembers.deactivatedAt })
		.from(wgMembers)
		.where(eq(wgMembers.wgId, wg.id));

	// `commitImport` validates every mapped member against active WG members
	// only (`assertMembersInWg`), so the preview must apply the same contract:
	// a name auto-matched or requested for a deactivated member is reported as
	// unmapped (a `conflict`) instead of a green preview that later fails the
	// commit with `member_not_in_wg`.
	const activeMembers = memberRows.filter((m) => m.deactivatedAt === null);
	const activeMemberIds = new Set(activeMembers.map((m) => m.id));

	const names = collectUniqueNames(parsedExpenses);
	const autoMatched = matchMembers(names, activeMembers);
	const mapping: Record<string, string | null> = {};
	for (const name of names) {
		const requested = memberMapping?.[name] ?? autoMatched.get(name) ?? null;
		mapping[name] = requested !== null && activeMemberIds.has(requested) ? requested : null;
	}
	const conflicts = findMappingConflicts(parsedExpenses, mapping);

	return NextResponse.json({
		parsed: parsedExpenses,
		payloadHash: hashPayload(payload),
		memberMapping: mapping,
		conflicts,
		members: activeMembers.map(({ id, name }) => ({ id, name })),
	});
});
