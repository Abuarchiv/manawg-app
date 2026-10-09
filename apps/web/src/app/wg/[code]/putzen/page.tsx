'use client';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from '@/components/ui/empty';
import { ItemGroup } from '@/components/ui/item';
import { ActionNoticeBanner } from '@/components/wg/ActionNoticeBanner';
import { LoadErrorBanner } from '@/components/wg/LoadErrorBanner';
import { OfflineQueueNotice } from '@/components/wg/OfflineQueueNotice';
import { SubNav } from '@/components/wg/SubNav';
import { ThumbAction } from '@/components/wg/ThumbAction';
import { useWg } from '@/components/wg/WgContextProvider';
import { AbsencePanel } from '@/features/chores/components/AbsencePanel';
import { ChoreForm } from '@/features/chores/components/ChoreForm';
import { ChoreRow } from '@/features/chores/components/ChoreRow';
import { FairnessPanel } from '@/features/chores/components/FairnessPanel';
import { ListSkeleton } from '@/features/chores/components/ListSkeleton';
import { PutzenHeader } from '@/features/chores/components/PutzenHeader';
import { QUICK_CHORE_TEMPLATES } from '@/features/chores/components/constants';
import { usePutzenPage } from '@/features/chores/hooks/use-putzen-page';
import { Plus, Sparkles } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useEffect } from 'react';

const ConfirmDialog = dynamic(() =>
	import('@/components/ui/ConfirmDialog').then((module) => module.ConfirmDialog),
);

export default function PutzenPage() {
	const { wg, members, identity, isAdmin } = useWg();
	const {
		absenceAddPending,
		absenceEnd,
		absenceError,
		absenceId,
		absenceListError,
		absenceMemberId,
		absenceReason,
		absenceStart,
		absences,
		absencesPanelActive,
		absentMemberIds,
		actionError,
		actionNotice,
		activeMembers,
		add,
		addAbsence,
		applyChoreSuggestion,
		applyQuickChore,
		cancelComplete,
		choreAddPending,
		choreGroups,
		completeConfirmId,
		confirmSuggestion,
		fairness,
		flashAbsenceId,
		handleAssignedMemberIdChange,
		handleComplete,
		handleEdit,
		handleIntervalPresetSelect,
		handleRecurrenceUnitToggle,
		handleRemove,
		handleSwapRequest,
		handleTakeOver,
		health,
		hiddenAbsenceCount,
		highlightedId,
		initialLoading,
		isPending,
		items,
		load,
		loadError,
		memberLookup,
		monthCompletions,
		newAssigned,
		newFirstDue,
		newInterval,
		newRecurrenceType,
		newTitle,
		nextAssigneeNameByChoreId,
		overdueFilter,
		ownDueCount,
		pendingSuggestion,
		queuedCount,
		refreshing,
		removeAbsence,
		setAbsenceEnd,
		setAbsenceMemberId,
		setAbsenceReason,
		setAbsenceStart,
		setConfirmSuggestion,
		setNewFirstDue,
		setNewTitle,
		setShowForm,
		showForm,
		showSkeleton,
		swapRequestedIds,
		titleInputRef,
		visibleAbsences,
	} = usePutzenPage();
	const wgBaseHref = `/wg/${encodeURIComponent(wg.shareCode)}`;
	const actionErrorVisible = Boolean(actionError) && !showForm && !completeConfirmId;
	// The error is shown at the top; someone at the absence form below would not see it otherwise.
	useEffect(() => {
		if (actionErrorVisible) {
			document.getElementById('chore-action-error')?.scrollIntoView({ block: 'nearest' });
		}
	}, [actionErrorVisible]);

	return (
		<div data-household-content className="mx-auto flex w-full max-w-4xl flex-col gap-3 px-4 py-3">
			<SubNav liveCount={ownDueCount} />
			<PutzenHeader
				itemCount={items.length}
				loading={showSkeleton}
				health={!showSkeleton && items.length > 0 ? health : null}
			/>
			<ChoreForm
				open={showForm}
				onClose={() => setShowForm(false)}
				error={actionError}
				title={newTitle}
				onTitleChange={setNewTitle}
				titleInputRef={titleInputRef}
				interval={newInterval}
				recurrenceType={newRecurrenceType}
				onRecurrenceUnitToggle={handleRecurrenceUnitToggle}
				onIntervalPresetSelect={handleIntervalPresetSelect}
				firstDueDate={newFirstDue}
				onFirstDueDateChange={setNewFirstDue}
				assignedMemberId={newAssigned}
				onAssignedMemberIdChange={handleAssignedMemberIdChange}
				members={activeMembers}
				pending={choreAddPending}
				onSubmit={() => void add()}
			>
				{pendingSuggestion && (
					<Alert>
						<AlertDescription>
							<p>Dein vorhandener Entwurf bleibt erhalten.</p>
							<Button
								type="button"
								variant="outline"
								onClick={() => setConfirmSuggestion(true)}
								disabled={choreAddPending}
								className="h-auto whitespace-normal text-foreground"
							>
								Entwurf verwerfen und „{pendingSuggestion.title}“ übernehmen
							</Button>
						</AlertDescription>
					</Alert>
				)}
				{confirmSuggestion && (
					<ConfirmDialog
						open
						onClose={() => setConfirmSuggestion(false)}
						onConfirm={() => {
							if (pendingSuggestion) applyChoreSuggestion(pendingSuggestion);
						}}
						title="Entwurf verwerfen?"
						description="Der bisherige Aufgabenentwurf wird durch den Vorschlag ersetzt. Bereits gespeicherte Aufgaben bleiben erhalten."
						confirmLabel="Entwurf verwerfen"
						cancelLabel="Entwurf behalten"
					/>
				)}
			</ChoreForm>
			{actionErrorVisible && (
				<Alert variant="destructive" id="chore-action-error" className="scroll-mt-24">
					<AlertDescription>{actionError}</AlertDescription>
				</Alert>
			)}
			{actionNotice && <ActionNoticeBanner notice={{ tone: 'success', message: actionNotice }} />}
			{queuedCount > 0 && (
				<output aria-live="polite">
					<OfflineQueueNotice queuedCount={queuedCount} />
				</output>
			)}
			{loadError && (
				<LoadErrorBanner
					message={loadError}
					onRetry={() => void load(true)}
					busy={initialLoading || refreshing}
					retryLabel="Putzplan erneut laden"
				/>
			)}

			{showSkeleton ? (
				<ListSkeleton />
			) : loadError && items.length === 0 ? (
				<Empty>
					<EmptyHeader>
						<EmptyTitle>Noch keine Aufgaben geladen</EmptyTitle>
						<EmptyDescription>
							Versuche es erneut, sobald die Verbindung wieder da ist.
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : items.length === 0 && !initialLoading ? (
				<Empty>
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<Sparkles aria-hidden />
						</EmptyMedia>
						<EmptyTitle>Noch keine Aufgaben</EmptyTitle>
						<EmptyDescription>Starte mit einer typischen WG-Aufgabe:</EmptyDescription>
					</EmptyHeader>
					<EmptyContent className="flex-row flex-wrap justify-center">
						{QUICK_CHORE_TEMPLATES.map((template) => (
							<Button
								key={template.title}
								variant="outline"
								onClick={() => applyQuickChore(template)}
							>
								{template.title}
							</Button>
						))}
					</EmptyContent>
				</Empty>
			) : (
				<div id="chore-list" className="flex flex-col gap-4">
					{overdueFilter.active && (
						<div className="flex flex-wrap items-center justify-between gap-2">
							<p className="text-[13px] text-muted-foreground">Nur überfällige Aufgaben</p>
							<Button variant="outline" size="sm" onClick={overdueFilter.showAll}>
								Alle anzeigen
							</Button>
						</div>
					)}
					{choreGroups.map((group) => (
						<section
							key={group.key}
							aria-labelledby={`chore-group-${group.key}`}
							className="flex flex-col gap-2"
						>
							<h2
								id={`chore-group-${group.key}`}
								className="text-[12px] font-medium text-muted-foreground"
							>
								{group.label}
							</h2>
							<ItemGroup
								aria-label={group.label}
								className="gap-0 divide-y overflow-hidden rounded-xl border"
							>
								{group.chores.map((chore) => (
									<ChoreRow
										key={chore.id}
										chore={chore}
										isAdmin={isAdmin}
										assignee={memberLookup(chore.assignedMemberId)}
										members={activeMembers}
										isMine={chore.assignedMemberId === identity.memberId}
										isPending={isPending(chore.id)}
										isSwapPending={isPending(`${chore.id}:swap`)}
										isSwapRequested={swapRequestedIds.has(chore.id)}
										isTakePending={isPending(`${chore.id}:take`)}
										isEditPending={isPending(`${chore.id}:edit`)}
										isCompleteArmed={completeConfirmId === chore.id}
										completeError={actionError}
										nextAssigneeName={nextAssigneeNameByChoreId.get(chore.id) ?? null}
										onCancelComplete={cancelComplete}
										onComplete={handleComplete}
										onSwapRequest={handleSwapRequest}
										onTakeOver={handleTakeOver}
										onEdit={handleEdit}
										onRemove={handleRemove}
										highlighted={highlightedId === chore.id}
									/>
								))}
							</ItemGroup>
						</section>
					))}
				</div>
			)}
			{!showSkeleton && items.length > 0 && (
				<FairnessPanel
					fairness={fairness}
					monthCompletions={monthCompletions}
					members={members.map((member) => ({ id: member.id, name: member.name }))}
					currentMemberId={identity.memberId}
				/>
			)}
			{!showSkeleton && (items.length > 0 || absences.length > 0 || absencesPanelActive) && (
				<AbsencePanel
					active={absencesPanelActive}
					absentCount={absentMemberIds.length}
					// The API allows absences only for oneself or as admin.
					members={
						isAdmin ? activeMembers : activeMembers.filter((m) => m.id === identity.memberId)
					}
					memberId={absenceMemberId}
					onMemberIdChange={setAbsenceMemberId}
					start={absenceStart}
					onStartChange={setAbsenceStart}
					end={absenceEnd}
					onEndChange={setAbsenceEnd}
					reason={absenceReason}
					onReasonChange={setAbsenceReason}
					pending={absenceAddPending}
					onAdd={() => void addAbsence()}
					hiddenCount={hiddenAbsenceCount}
					totalCount={absences.length}
					allAbsencesHref={`${wgBaseHref}/putzen?panel=absences`}
					visibleAbsences={visibleAbsences}
					highlightedAbsenceId={absenceId}
					flashedAbsenceId={flashAbsenceId}
					onRemove={(id) => void removeAbsence(id)}
					isPending={isPending}
					error={absenceError}
					listError={absenceListError}
				/>
			)}
			<ThumbAction>
				<Button type="button" className="min-h-11 w-full" onClick={() => setShowForm(true)}>
					<Plus data-icon="inline-start" aria-hidden />
					Putzaufgabe hinzufügen
				</Button>
			</ThumbAction>
		</div>
	);
}
