import { sql } from 'drizzle-orm';
import {
  bigint, boolean, char, date, foreignKey, integer, pgTable, smallint, text, timestamp, uniqueIndex,
} from 'drizzle-orm/pg-core';

/*
 * آینه‌ی TypeScript جدول‌های معمولی (برای کوئری‌های typed).
 * منبع حقیقت ساختار: پوشه‌ی migrations/*.sql. جدول‌های پارتیشن‌شده، EXCLUDE، تابع‌ها
 * و ایندکس‌های ویژه فقط در SQL هستند.
 */

export const offices = pgTable('offices', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  name: text().notNull(),
  code: text().notNull().unique(),
  isActive: boolean('is_active').notNull().default(true),
  dataVersion: bigint('data_version', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const officeSettings = pgTable('office_settings', {
  officeId: integer('office_id').primaryKey().references(() => offices.id),
  newTerminalCutoffDay: smallint('new_terminal_cutoff_day').notNull().default(20),
  preliminaryAlertMinDay: smallint('preliminary_alert_min_day').notNull().default(10),
  dropAlertThresholdPct: smallint('drop_alert_threshold_pct').notNull().default(30),
  updatedBy: integer('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const periods = pgTable('periods', {
  periodId: integer('period_id').primaryKey(),
  calendar: text().notNull().default('jalali'),
  year: smallint().notNull(),
  month: smallint().notNull(),
  startDate: date('start_date').notNull(),
  endDate: date('end_date').notNull(),
});

export const staffUnits = pgTable('staff_units', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  officeId: integer('office_id').notNull().references(() => offices.id),
  name: text().notNull(),
  managerName: text('manager_name'),
  isActive: boolean('is_active').notNull().default(true),
});

export const supporters = pgTable('supporters', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  officeId: integer('office_id').notNull(),
  staffUnitId: integer('staff_unit_id').notNull(),
  fullName: text('full_name').notNull(),
  phone: text(),
  isActive: boolean('is_active').notNull().default(true),
});

export const banks = pgTable('banks', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  officeId: integer('office_id').notNull().references(() => offices.id),
  name: text().notNull(),
  code: text(),
});

export const routeGroups = pgTable('route_groups', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  officeId: integer('office_id').notNull().references(() => offices.id),
  name: text().notNull(),
});

export const userRoles = ['system_admin', 'office_manager', 'unit_head', 'supporter', 'data_admin'] as const;
export type UserRole = (typeof userRoles)[number];

export const users = pgTable(
  'users',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    officeId: integer('office_id').references(() => offices.id), // NULL فقط برای system_admin
    username: text().notNull(),
    passwordHash: text('password_hash').notNull(),
    fullName: text('full_name').notNull(),
    role: text().$type<UserRole>().notNull(),
    staffUnitId: integer('staff_unit_id'),
    supporterId: integer('supporter_id'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.officeId, t.staffUnitId], foreignColumns: [staffUnits.officeId, staffUnits.id] }),
    uniqueIndex('users_username_office_uq').on(t.officeId, t.username).where(sql`office_id IS NOT NULL`),
  ],
);

export const refreshTokens = pgTable('refresh_tokens', {
  id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  userId: integer('user_id').notNull().references(() => users.id),
  tokenHash: char('token_hash', { length: 64 }).notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
