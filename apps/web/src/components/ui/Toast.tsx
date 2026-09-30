'use client';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { haptic } from '@/shared/lib/haptics';
import { CheckCircle, Info, X, XCircle } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';
import { create } from 'zustand';

type ToastVariant = 'success' | 'error' | 'info';

interface Toast {
	id: string;
	message: string;
	variant: ToastVariant;
}

interface ToastStore {
	toasts: Toast[];
	addToast: (message: string, variant: ToastVariant) => void;
	removeToast: (id: string) => void;
}

// WCAG 2.2.1: a toast must give enough time to read it. The auto-dismiss timer
// lives in ToastItem (not here) so it can pause while hovered or focused.
export const TOAST_DURATION_MS = 4000;

const useToastStore = create<ToastStore>((set) => ({
	toasts: [],
	addToast: (message, variant) => {
		const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
		set((state) => ({ toasts: [...state.toasts, { id, message, variant }] }));
		haptic(variant === 'error' ? 'heavy' : variant === 'success' ? 'medium' : 'light');
	},
	removeToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}));

// Öffentlicher Hook
export function useToast() {
	const { addToast } = useToastStore();
	return {
		success: (message: string) => addToast(message, 'success'),
		error: (message: string) => addToast(message, 'error'),
		info: (message: string) => addToast(message, 'info'),
	};
}

const variantIcons: Record<ToastVariant, typeof CheckCircle> = {
	success: CheckCircle,
	error: XCircle,
	info: Info,
};

function ToastItem({ toast }: { toast: Toast }) {
	const { removeToast } = useToastStore();
	const Icon = variantIcons[toast.variant];
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const clearTimer = useCallback(() => {
		if (timerRef.current !== null) clearTimeout(timerRef.current);
	}, []);

	const scheduleTimer = useCallback(() => {
		clearTimer();
		timerRef.current = setTimeout(() => removeToast(toast.id), TOAST_DURATION_MS);
	}, [clearTimer, removeToast, toast.id]);

	useEffect(() => {
		scheduleTimer();
		return clearTimer;
	}, [scheduleTimer, clearTimer]);

	return (
		<Alert
			variant={toast.variant === 'error' ? 'destructive' : 'default'}
			role={toast.variant === 'error' ? 'alert' : 'status'}
			aria-live={toast.variant === 'error' ? undefined : 'polite'}
			className="flex items-center gap-3"
			onMouseEnter={clearTimer}
			onMouseLeave={scheduleTimer}
			onFocus={clearTimer}
			onBlur={scheduleTimer}
		>
			<Icon className="shrink-0" aria-hidden="true" />
			<AlertDescription className="min-w-0 flex-1 wrap-anywhere">{toast.message}</AlertDescription>
			<Button
				type="button"
				onClick={() => removeToast(toast.id)}
				variant="ghost"
				size="icon"
				className="size-11"
				aria-label="Benachrichtigung schließen"
			>
				<X aria-hidden="true" />
			</Button>
		</Alert>
	);
}

export function ToastContainer() {
	const { toasts } = useToastStore();

	if (toasts.length === 0) return null;

	return (
		<div
			className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--app-nav-height,5rem)+0.5rem+var(--thumb-action-space,0px))] z-50 mx-auto flex w-full max-w-[var(--app-frame-width)] flex-col gap-2 px-4"
			aria-label="Benachrichtigungen"
			// biome-ignore lint/a11y/useSemanticElements: role="region" names the fixed toast stack; <section> would add another landmark.
			role="region"
		>
			{toasts.map((toast) => (
				<div key={toast.id} className="pointer-events-auto">
					<ToastItem toast={toast} />
				</div>
			))}
		</div>
	);
}
