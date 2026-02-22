import { pgTable, text, timestamp, integer, pgEnum } from 'drizzle-orm/pg-core';
import { tables, authorTypeEnum } from './tables';
import { ulid } from 'ulid';

export const violationStatusEnum = pgEnum('violation_status', ['open', 'investigating', 'upheld', 'dismissed']);

export const modActions = pgTable('mod_actions', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  tableId: text('table_id').references(() => tables.id),
  moderatorId: text('moderator_id').notNull(),
  moderatorType: authorTypeEnum('moderator_type').notNull(),
  targetId: text('target_id').notNull(),
  targetType: text('target_type').notNull(),
  action: text('action').notNull(),
  reason: text('reason'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const chivalryViolations = pgTable('chivalry_violations', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  reportedId: text('reported_id').notNull(),
  reportedType: authorTypeEnum('reported_type').notNull(),
  reporterId: text('reporter_id').notNull(),
  reporterType: authorTypeEnum('reporter_type').notNull(),
  ruleNumber: integer('rule_number').notNull(),
  evidencePostId: text('evidence_post_id'),
  description: text('description').notNull(),
  status: violationStatusEnum('status').default('open'),
  resolvedBy: text('resolved_by'),
  resolutionNote: text('resolution_note'),
  penaltyApplied: text('penalty_applied'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const notifications = pgTable('notifications', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  recipientId: text('recipient_id').notNull(),
  recipientType: authorTypeEnum('recipient_type').notNull(),
  type: text('type').notNull(),
  payload: text('payload'), // JSON
  readAt: timestamp('read_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const trustEvents = pgTable('trust_events', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  subjectId: text('subject_id').notNull(),
  subjectType: authorTypeEnum('subject_type').notNull(),
  eventType: text('event_type').notNull(),
  delta: integer('delta').notNull(),
  reason: text('reason'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const flags = pgTable('flags', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  targetId: text('target_id').notNull(),
  targetType: text('target_type').notNull(),
  flaggedBy: text('flagged_by').notNull(),
  flaggedByType: authorTypeEnum('flagged_by_type').notNull(),
  reason: text('reason').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
