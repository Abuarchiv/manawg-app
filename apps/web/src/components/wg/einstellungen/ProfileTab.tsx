'use client';

import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { MemberAvatar } from '@/components/wg/MemberAvatar';
import { LinkRow } from '@/components/wg/einstellungen/LinkRow';
import { PayPalConnect } from '@/components/wg/einstellungen/PayPalConnect';
import { Section } from '@/components/wg/einstellungen/Section';
import { InstallButton } from '@/shared/components/install-button';
import { useTheme } from '@/shared/components/theme/ThemeProvider';
import { haptic } from '@/shared/lib/haptics';
import { Monitor, Moon, Sun } from 'lucide-react';

const THEMES = [
	{ value: 'light', label: 'Hell', icon: Sun },
	{ value: 'dark', label: 'Dunkel', icon: Moon },
	{ value: 'system', label: 'System', icon: Monitor },
] as const;

interface ProfileTabProps {
	memberName: string;
	wgName: string;
	shareCode: string;
	memberId: string;
	memberToken?: string | undefined;
}

export function ProfileTab({
	memberName,
	wgName,
	shareCode,
	memberId,
	memberToken,
}: ProfileTabProps) {
	const { theme, setTheme } = useTheme();

	return (
		<>
			<Section title="Dein Profil">
				<div className="flex min-h-[44px] items-center gap-3 px-3 py-2">
					<MemberAvatar name={memberName} size={32} />
					<div className="min-w-0 flex-1">
						<div className="text-foreground truncate text-[14px] font-medium">{memberName}</div>
						<div className="text-muted-foreground mt-0.5 text-[12px]">in {wgName}</div>
					</div>
				</div>
			</Section>

			<Section title="Darstellung">
				<div className="p-2">
					<ToggleGroup
						variant="segmented"
						className="w-full flex-wrap"
						value={[theme]}
						aria-label="Darstellung"
						onValueChange={(values) => {
							const next = THEMES.find((option) => option.value === values[0])?.value;
							if (!next) return;
							haptic('selection');
							setTheme(next);
						}}
					>
						{THEMES.map(({ value, label, icon: Icon }) => (
							<ToggleGroupItem key={value} value={value} className="min-w-max px-1.5">
								<Icon aria-hidden />
								{label}
							</ToggleGroupItem>
						))}
					</ToggleGroup>
				</div>
				<div className="px-2 pb-2">
					<InstallButton label="App installieren" />
				</div>
			</Section>

			<Section title="PayPal">
				<PayPalConnect shareCode={shareCode} memberId={memberId} memberToken={memberToken} />
			</Section>

			<Section
				title="Hilfe"
				hint="Beschreibe, was passiert ist und wie wir den Fehler nachstellen können."
			>
				<ul>
					<LinkRow
						href="mailto:info@manawg.com?subject=Fehler%20in%20ManaWG"
						label="Fehler per E-Mail melden"
					/>
				</ul>
			</Section>
		</>
	);
}
