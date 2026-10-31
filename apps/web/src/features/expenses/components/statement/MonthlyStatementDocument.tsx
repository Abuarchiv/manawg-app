import { useLocale, useTranslations } from 'next-intl';
import { LogoMark } from '@/components/ui/LogoMark';
import { MemberAvatar } from '@/components/wg/MemberAvatar';
import { formatEuroCents } from '@/core/utils/money';
import { dayMonthOptions } from '@/core/utils/time';
import type { MonthlyStatement } from '@/features/expenses/monthly-statement';
import { dateTimeFormat } from '@/shared/i18n/intl';
import type { Locale } from '@/shared/i18n/locale';
import { cn } from '@/shared/lib/cn';

const EYEBROW = 'font-mono text-[11px] tracking-[0.1em] uppercase text-muted-foreground';
const H2 = 'font-heading text-[18px] font-semibold tracking-[-0.02em] print:text-[22px]';
const MONEY = 'font-mono tabular-nums whitespace-nowrap';
const TH = 'py-2 font-normal';

interface MonthlyStatementDocumentProps {
	statement: MonthlyStatement;
	wgName: string;
	shareCode: string;
	viewerId: string;
	viewerName: string;
}

function monthTitle(monthKey: string, locale: Locale): string {
	const [year, month] = monthKey.split('-').map(Number);
	return dateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
		new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, 1)),
	);
}

/** First and last day of the month, formatted in `locale`. */
function periodBounds(monthKey: string, locale: Locale): { start: string; end: string } {
	const [year, month] = monthKey.split('-').map(Number);
	const first = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, 1));
	const last = new Date(Date.UTC(year ?? 0, month ?? 1, 0));
	return {
		start: dateTimeFormat(locale, { ...dayMonthOptions(locale), timeZone: 'UTC' }).format(first),
		end: dateTimeFormat(locale, { ...dayMonthOptions(locale, true), timeZone: 'UTC' }).format(last),
	};
}

/** Monthly statement laid out as a statement; phone column on screen, A4 in print. */
export function MonthlyStatementDocument({
	statement,
	wgName,
	shareCode,
	viewerId,
	viewerName,
}: MonthlyStatementDocumentProps) {
	const t = useTranslations('statement');
	const locale = useLocale();
	const { monthKey, members, transfers, categories, items, totalCents, settled } = statement;
	const money = (cents: number) => formatEuroCents(cents, 'EUR', { locale });
	const dayMonth = dateTimeFormat(locale, {
		...dayMonthOptions(locale),
		timeZone: 'Europe/Berlin',
	});
	const number = `MWG-${monthKey.slice(2, 4)}${monthKey.slice(5, 7)}-${shareCode.slice(0, 3).toUpperCase()}`;
	const viewerShare = members.find((member) => member.id === viewerId)?.shareCents ?? 0;
	const empty = items.length === 0;

	return (
		<article className="flex flex-col gap-8 text-foreground print:gap-10">
			<header className="flex flex-col gap-6">
				<div className="flex flex-wrap items-start justify-between gap-4">
					<span className="flex items-center gap-2">
						<LogoMark size={28} tile={false} aria-hidden />
						<span className="font-heading text-[18px] font-semibold tracking-[-0.03em]">
							ManaWG
						</span>
					</span>
					<dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 text-right text-[12px]">
						<dt className="text-left text-muted-foreground">{t('document.statementNumber')}</dt>
						<dd className="font-mono whitespace-nowrap">{number}</dd>
						<dt className="text-left text-muted-foreground">{t('document.period')}</dt>
						<dd className="font-mono whitespace-nowrap">
							{t('document.periodRange', periodBounds(monthKey, locale))}
						</dd>
						<dt className="text-left text-muted-foreground">{t('document.preparedFor')}</dt>
						<dd>{viewerName}</dd>
					</dl>
				</div>
				<div className="flex flex-col gap-2">
					<p className={cn(EYEBROW, 'tracking-[0.14em]')}>{t('document.eyebrow', { wgName })}</p>
					<h1 className="font-heading text-[32px] leading-none font-semibold tracking-[-0.035em] print:text-[52px]">
						{monthTitle(monthKey, locale)}
					</h1>
				</div>
			</header>

			<dl className="grid grid-cols-2 border-t-2 border-b border-t-foreground border-b-border print:grid-cols-4">
				{[
					[t('document.total'), money(totalCents)],
					[t('document.expenses'), String(items.length)],
					[t('document.yourShare'), money(viewerShare)],
				].map(([label, value], index) => (
					<div
						key={label}
						className={cn(
							'flex flex-col gap-1 py-3',
							index % 2 === 1 ? 'border-l border-border pl-3' : 'pr-3',
							index < 2 && 'border-b border-border print:border-b-0',
							index === 2 && 'print:border-l print:border-border print:pl-3',
						)}
					>
						<dt className="text-[12px] text-muted-foreground">{label}</dt>
						<dd className={cn(MONEY, 'text-[18px] font-medium print:text-[22px]')}>{value}</dd>
					</div>
				))}
				<div className="flex flex-col gap-1 border-l border-border py-3 pl-3">
					<dt className="text-[12px] text-muted-foreground">{t('document.status')}</dt>
					<dd
						className={cn(
							'flex items-center gap-2 text-[15px] font-semibold',
							empty ? 'text-muted-foreground' : settled ? 'text-settled' : 'text-destructive',
						)}
					>
						<span aria-hidden className="size-2 rounded-full bg-current" />
						{empty
							? t('document.statusEmpty')
							: settled
								? t('document.statusSettled')
								: t('document.statusOpen')}
					</dd>
				</div>
			</dl>

			<section aria-labelledby="statement-balances" className="flex flex-col gap-3">
				<div className="flex items-baseline justify-between gap-3">
					<h2 id="statement-balances" className={H2}>
						{t('document.balances')}
					</h2>
					<span className="text-[12px] text-muted-foreground">
						{t('document.splitBetween', { count: members.length })}
					</span>
				</div>
				{/* The name column truncates; the wrapper scrolls only for very large amounts. */}
				{/* biome-ignore lint/a11y/useSemanticElements: A <section> cannot be the scroll container here; role="region" names it. */}
				<div
					// biome-ignore lint/a11y/noNoninteractiveTabindex: The scrollable table must be reachable by keyboard.
					tabIndex={0}
					role="region"
					aria-labelledby="statement-balances"
					className="overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
				>
					<table className="w-full border-collapse text-[14px]">
						<thead>
							<tr className={cn(EYEBROW, 'border-b border-foreground')}>
								<th scope="col" className={cn(TH, 'w-full max-w-0 text-left')}>
									{t('document.person')}
								</th>
								<th scope="col" className={cn(TH, 'pl-2 text-right sm:pl-3')}>
									{t('document.paid')}
								</th>
								<th scope="col" className={cn(TH, 'pl-2 text-right sm:pl-3')}>
									{t('document.share')}
								</th>
								<th scope="col" className={cn(TH, 'pl-2 text-right sm:pl-3')}>
									{t('document.balance')}
								</th>
							</tr>
						</thead>
						<tbody>
							{members.map((member) => (
								<tr key={member.id} className="border-b border-border">
									<th scope="row" className="max-w-0 py-2.5 text-left font-medium">
										<span className="flex min-w-0 items-center gap-2">
											<MemberAvatar name={member.name} size={24} />
											<span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
												<span className="max-w-full truncate" title={member.name}>
													{member.name}
												</span>
												{member.id === viewerId && (
													<span className="text-[12px] font-normal text-muted-foreground">
														{t('document.you')}
													</span>
												)}
											</span>
										</span>
									</th>
									<td className={cn(MONEY, 'pl-3 text-right text-[13px]')}>
										{money(member.paidCents)}
									</td>
									<td className={cn(MONEY, 'pl-3 text-right text-[13px] text-muted-foreground')}>
										{money(member.shareCents)}
									</td>
									<td
										className={cn(
											MONEY,
											'pl-3 text-right text-[13px] font-medium',
											member.balanceCents === 0
												? 'text-muted-foreground'
												: member.balanceCents > 0
													? 'text-settled'
													: 'text-destructive',
										)}
									>
										{formatEuroCents(member.balanceCents, 'EUR', { signed: true, locale }).replace(
											'-',
											'−',
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</section>

			{transfers.length > 0 && (
				<section aria-labelledby="statement-transfers" className="flex flex-col gap-3">
					<h2 id="statement-transfers" className={H2}>
						{t('document.settlement')}
					</h2>
					<p className="text-[13px] leading-relaxed text-muted-foreground">
						{t('document.settlementHint', { count: transfers.length })}
					</p>
					<ul className="flex flex-col border-t border-border">
						{transfers.map((transfer) => (
							<li
								key={`${transfer.fromId}-${transfer.toId}`}
								className="flex items-center gap-3 border-b border-border py-2.5 text-[14px]"
							>
								<span className="min-w-0 flex-1">
									<span className="font-medium">{transfer.fromName}</span>
									<span className="text-muted-foreground"> {t('document.transferTo')} </span>
									<span className="font-medium">{transfer.toName}</span>
								</span>
								<span className={cn(MONEY, 'text-[13px] font-medium')}>
									{money(transfer.cents)}
								</span>
								<span
									className={cn(
										'w-16 text-right font-mono text-[11px] tracking-[0.06em] uppercase',
										settled ? 'text-settled' : 'text-destructive',
									)}
								>
									{settled ? t('document.transferDone') : t('document.transferOpen')}
								</span>
							</li>
						))}
					</ul>
				</section>
			)}

			{!empty && (
				<section aria-labelledby="statement-categories" className="flex flex-col gap-3">
					<h2 id="statement-categories" className={H2}>
						{t('document.categories')}
					</h2>
					<ul className="flex flex-col border-t border-border">
						{categories.map((entry) => (
							<li
								key={entry.category}
								className="flex items-center gap-3 border-b border-border py-2.5 text-[14px]"
							>
								<span className="min-w-0 flex-1 font-medium">
									{t(`document.category.${entry.category}`)}
								</span>
								<span className={cn(MONEY, 'text-[13px] font-medium')}>{money(entry.cents)}</span>
								<span className={cn(MONEY, 'w-10 text-right text-[12px] text-muted-foreground')}>
									{t('document.categoryShare', { share: entry.share })}
								</span>
							</li>
						))}
					</ul>
				</section>
			)}

			{!empty && (
				<section aria-labelledby="statement-items" className="flex flex-col gap-3">
					<div className="flex items-baseline justify-between gap-3">
						<h2 id="statement-items" className={H2}>
							{t('document.allExpenses')}
						</h2>
						<span className="text-[12px] text-muted-foreground">
							{t('document.entriesByDate', { count: items.length })}
						</span>
					</div>
					{/* biome-ignore lint/a11y/useSemanticElements: A <section> cannot be the scroll container here; role="region" names it. */}
					<div
						// biome-ignore lint/a11y/noNoninteractiveTabindex: The scrollable table must be reachable by keyboard.
						tabIndex={0}
						role="region"
						aria-labelledby="statement-items"
						className="overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
					>
						<table className="w-full border-collapse text-[13px]">
							<thead>
								<tr className={cn(EYEBROW, 'border-b border-foreground')}>
									<th scope="col" className={cn(TH, 'w-12 text-left print:w-16')}>
										{t('document.date')}
									</th>
									<th scope="col" className={cn(TH, 'pl-3 text-left')}>
										{t('document.description')}
									</th>
									<th scope="col" className={cn(TH, 'hidden pl-3 text-left print:table-cell')}>
										{t('document.from')}
									</th>
									<th scope="col" className={cn(TH, 'pl-3 text-right')}>
										{t('document.amount')}
									</th>
								</tr>
							</thead>
							<tbody>
								{items.map((item) => (
									<tr
										key={item.id}
										className="break-inside-avoid border-b border-border/60 align-top"
									>
										<td className="py-2 font-mono text-[12px] whitespace-nowrap text-muted-foreground">
											{dayMonth.format(new Date(item.occurredAt))}
										</td>
										<td className="py-2 pl-3 break-words">
											{item.description}
											<span className="block text-[12px] text-muted-foreground print:hidden">
												{item.payerName ?? t('document.formerMember')}
											</span>
										</td>
										<td className="hidden py-2 pl-3 text-muted-foreground print:table-cell">
											{item.payerName ?? t('document.formerMember')}
										</td>
										<td className={cn(MONEY, 'py-2 pl-3 text-right text-[12px]')}>
											{money(item.amountCents)}
										</td>
									</tr>
								))}
							</tbody>
							<tfoot>
								<tr className="border-t border-foreground font-semibold">
									<th scope="row" colSpan={2} className="py-3 text-left print:hidden">
										{t('document.sum')}
									</th>
									<th scope="row" colSpan={3} className="hidden py-3 text-left print:table-cell">
										{t('document.sum')}
									</th>
									<td className={cn(MONEY, 'py-3 pl-3 text-right text-[13px]')}>
										{money(totalCents)}
									</td>
								</tr>
							</tfoot>
						</table>
					</div>
				</section>
			)}

			<footer className="grid gap-5 border-t border-border pt-5 text-[12px] leading-relaxed text-muted-foreground print:grid-cols-2 print:gap-10">
				<div className="flex flex-col gap-1">
					<p className={cn(EYEBROW, 'text-foreground')}>{t('document.howWeCalculate')}</p>
					<p>{t('document.howWeCalculateBody')}</p>
				</div>
				<div className="flex flex-col gap-1">
					<p className={cn(EYEBROW, 'text-foreground')}>{t('document.note')}</p>
					<p>{t('document.noteBody')}</p>
				</div>
			</footer>
		</article>
	);
}
