import { jsonb, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  uid: text("uid").notNull().unique(),
  email: text("email"),
  subscriptionStatus: text("subscription_status").default("Free"),
  limit: integer("limit").default(5),
  redeemedCode: text("redeemed_code"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow()
});

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  settings: jsonb("settings").notNull(),
  batches: jsonb("batches"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow()
});

export const batches = pgTable("batches", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  name: text("name").notNull(),
  timestamp: text("timestamp"),
  templateType: text("template_type"),
  data: jsonb("data").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow()
});

export const studentCodes = pgTable("student_codes", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  redemptionCount: integer("redemption_count").default(0),
  maxRedemptions: integer("max_redemptions").default(10),
  redeemedUserIds: jsonb("redeemed_user_ids").default([]),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow()
});

