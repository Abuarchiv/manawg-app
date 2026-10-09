import type { Metadata } from 'next';
import { EntryClient } from './EntryClient';

export const metadata: Metadata = {
	title: 'ManaWG',
	description: 'Ausgaben, Einkauf, Putzen und Pinnwand für deine WG.',
	alternates: { canonical: '/' },
};

export default function Entry() {
	return <EntryClient />;
}
