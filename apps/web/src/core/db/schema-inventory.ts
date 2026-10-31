import { relations, sql } from 'drizzle-orm';
import {
	check,
	index,
	numeric,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from 'drizzle-orm/pg-core';
import { wgMembers, wgs } from './schema';

export const wgInventoryItems = pgTable(
	'wg_inventory_items',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		wgId: uuid('wg_id')
			.notNull()
			.references(() => wgs.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		quantity: numeric('quantity', { precision: 10, scale: 2, mode: 'number' }).notNull().default(0),
		unit: text('unit').notNull().default('piece'),
		threshold: numeric('threshold', { precision: 10, scale: 2, mode: 'number' })
			.notNull()
			.default(1),
		category: text('category').notNull().default('other'),
		lastDecrementedAt: timestamp('last_decremented_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		wgIdx: index('wg_inventory_items_wg_idx').on(t.wgId),
		recentDecrementIdx: index('wg_inventory_items_recent_decrement_idx').on(
			t.wgId,
			t.lastDecrementedAt,
		),
		nameKey: uniqueIndex('wg_inventory_items_unique_name').on(t.wgId, sql`lower(btrim(${t.name}))`),
		// Keep in sync with INVENTORY_UNITS and INVENTORY_CATEGORIES in features/inventory/inventory.ts.
		unitCheck: check(
			'wg_inventory_items_unit_check',
			sql`${t.unit} IN ('piece', 'litre', 'kilogram', 'roll', 'pack')`,
		),
		categoryCheck: check(
			'wg_inventory_items_category_check',
			sql`${t.category} IN ('bathroom', 'kitchen', 'cleaning', 'other')`,
		),
	}),
);

export const wgInventoryLog = pgTable(
	'wg_inventory_log',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		itemId: uuid('item_id')
			.notNull()
			.references(() => wgInventoryItems.id, { onDelete: 'cascade' }),
		memberId: uuid('member_id').references(() => wgMembers.id, { onDelete: 'set null' }),
		delta: numeric('delta', { precision: 10, scale: 2, mode: 'number' }).notNull(),
		kind: text('kind').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		itemIdx: index('wg_inventory_log_item_idx').on(t.itemId, t.createdAt),
		memberIdx: index('wg_inventory_log_member_idx')
			.on(t.memberId)
			.where(sql`${t.memberId} IS NOT NULL`),
	}),
);

export const wgInventoryItemsRelations = relations(wgInventoryItems, ({ one, many }) => ({
	wg: one(wgs, { fields: [wgInventoryItems.wgId], references: [wgs.id] }),
	logs: many(wgInventoryLog),
}));

export const wgInventoryLogRelations = relations(wgInventoryLog, ({ one }) => ({
	item: one(wgInventoryItems, {
		fields: [wgInventoryLog.itemId],
		references: [wgInventoryItems.id],
	}),
	member: one(wgMembers, {
		fields: [wgInventoryLog.memberId],
		references: [wgMembers.id],
	}),
}));

export type WgInventoryItem = typeof wgInventoryItems.$inferSelect;
