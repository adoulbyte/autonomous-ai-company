import { getSetting, type Sql, type Tx } from './db.js';
export interface BusinessMode { mode: 'free_pilot' | 'paid'; max_active_pilots: number; ask_review: boolean }
export const getMode = (sql: Sql | Tx) => getSetting<BusinessMode>(sql, 'business.mode', { mode: 'paid', max_active_pilots: 10, ask_review: true });
export const isPilot = (m: BusinessMode) => m.mode === 'free_pilot';
