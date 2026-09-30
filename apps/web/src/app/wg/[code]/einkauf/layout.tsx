import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = { title: 'Einkaufsliste — ManaWG' };

export default function Layout({ children }: { children: ReactNode }) {
	return children;
}
