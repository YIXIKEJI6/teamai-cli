import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import { addTokenUsage, emptyTokenUsage, type TokenUsage } from '../types.js';

const alias = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const timestamp = z.string().datetime({ precision: 3 });
const count = z.number().int().min(0).max(1_000_000_000_000).nullable();
export const snapshotSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().uuid(),
  memberId: alias,
  installationId: alias,
  project: alias,
  sessionId: z.string().uuid(),
  firstStopAt: timestamp,
  observedAt: timestamp,
  sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  prompts: count,
  tokens: z.object({ input: count, output: count, cacheRead: count, cacheCreation: count }).strict(),
  producerVersion: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.+-]{0,39}$/),
}).strict();
export type Snapshot = z.infer<typeof snapshotSchema>;

const credential = z.object({
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: timestamp,
  revoked: z.boolean(),
});
const authSchema = z.object({
  schemaVersion: z.literal(1),
  dataset: z.enum(['synthetic', 'production']),
  admins: z.array(credential.extend({ id: alias }).strict()).min(1).max(20),
  installations: z.array(credential.extend({
    memberId: alias, installationId: alias, projects: z.array(alias).min(1).max(100),
  }).strict()).max(1000),
}).strict();
export type AuthConfig = z.infer<typeof authSchema>;
export type Installation = AuthConfig['installations'][number];

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function readAuth(file: string): AuthConfig {
  if (statSync(file).size > 256 * 1024) throw new Error('Invalid credential configuration');
  const config = authSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  const keys = config.installations.map((i) => i.installationId);
  const hashes = [...config.admins, ...config.installations].map((i) => i.tokenHash);
  if (new Set(keys).size !== keys.length || new Set(hashes).size !== hashes.length ||
    new Set(config.admins.map((i) => i.id)).size !== config.admins.length) {
    throw new Error('Duplicate identity or credential');
  }
  return config;
}

export function active(c: z.infer<typeof credential>, now = Date.now()): boolean {
  return !c.revoked && Date.parse(c.expiresAt) > now;
}

export function matches(token: string, hash: string): boolean {
  // Random 256-bit bearer tokens only, never human passwords or arbitrary strings.
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  return timingSafeEqual(Buffer.from(digest(token), 'hex'), Buffer.from(hash, 'hex'));
}

export function bindSnapshot(raw: unknown, installation: Installation, now = Date.now()): Snapshot {
  const value = snapshotSchema.parse(raw);
  if (value.memberId !== installation.memberId || value.installationId !== installation.installationId ||
    !installation.projects.includes(value.project)) throw new Error('Identity or project mismatch');
  if (Date.parse(value.observedAt) < Date.parse(value.firstStopAt) || Date.parse(value.observedAt) > now + 300_000) {
    throw new Error('Invalid snapshot time');
  }
  return value;
}

export function sumSnapshots(snapshots: Snapshot[]) {
  let known = emptyTokenUsage();
  const unknown: Record<keyof TokenUsage, number> = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  let prompts = 0, unknownPrompts = 0;
  for (const snapshot of snapshots) {
    // Reuse upstream arithmetic, while tracking null explicitly instead of silently treating it as zero.
    const measured = emptyTokenUsage();
    for (const key of Object.keys(known) as (keyof TokenUsage)[]) {
      if (snapshot.tokens[key] === null) unknown[key]++;
      else measured[key] = snapshot.tokens[key];
    }
    known = addTokenUsage(known, measured);
    if (snapshot.prompts === null) unknownPrompts++;
    else prompts += snapshot.prompts;
    if (![prompts, ...Object.values(known)].every(Number.isSafeInteger)) throw new Error('Summary exceeds safe integer range');
  }
  return { sessions: snapshots.length, tokens: known, unknown, prompts, unknownPrompts };
}
