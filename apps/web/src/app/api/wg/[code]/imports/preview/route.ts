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
import { and, eq, isNull } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';

const previewSchema = z.object({
	source: z.enum(['splitwise_csv', 'splid_csv', 'ocr_text']),
	payload: z.string().min(1),
	memberMapping: z.record(z.string(), z.string().nullable()).optional(),
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

	// Same contract as the commit: only active members can be mapped, so a
	// clean preview never turns into member_not_in_wg on commit.
	const members = await db
		.select({ id: wgMembers.id, name: wgMembers.name })
		.from(wgMembers)
		.where(and(eq(wgMembers.wgId, wg.id), isNull(wgMembers.deactivatedAt)));
	const activeMemberIds = new Set(members.map((member) => member.id));

	const names = collectUniqueNames(parsedExpenses);
	const autoMatched = matchMembers(names, members);
	const mapping: Record<string, string | null> = {};
	for (const name of names) {
		const candidate = memberMapping?.[name] ?? autoMatched.get(name);
		// An unknown or moved-out member id becomes a conflict for that name.
		mapping[name] = candidate && activeMemberIds.has(candidate) ? candidate : null;
	}
	const conflicts = findMappingConflicts(parsedExpenses, mapping);

	return NextResponse.json({
		parsed: parsedExpenses,
		payloadHash: hashPayload(payload),
		memberMapping: mapping,
		conflicts,
		members,
	});
});
