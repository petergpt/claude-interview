import { AGENTS } from './participants.js';
export const defaultMix = () => Object.fromEntries(['user', ...AGENTS.map(a => a.id)].map(id => [id, 0]));
export const dbGain = db => 10 ** (db / 20);
export function normalizeMix(patch, current = defaultMix()) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Provide participant audio levels.');
  const next = { ...current };
  for (const [id, db] of Object.entries(patch)) {
    if (!Object.hasOwn(defaultMix(), id) || typeof db !== 'number' || !Number.isFinite(db) || db < -18 || db > 18) throw new Error('Audio levels must be between −18 and +18 dB for an available participant.');
    next[id] = db;
  }
  return next;
}
