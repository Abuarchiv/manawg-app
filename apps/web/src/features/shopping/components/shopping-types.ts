export interface ShoppingItem {
	id: string;
	addedByMemberId: string;
	name: string;
	quantity: string | null;
	boughtAt: string | null;
	boughtByMemberId: string | null;
	createdAt: string;
	updatedAt?: string;
}

export interface MemberInfo {
	name: string;
	color: string | null;
}
