import { describe, expect, it } from 'vitest';
import {
  buildScoreComments, growthPct, growthToScore, normalizeWeights, overallScore, periodNameFa, projectItemScore, projectsScore,
  scoreBand, scoreMonth, scoreTrend, DEFAULT_SCORE_WEIGHTS,
} from './scoring';

const base = {
  amount: 100, prevAmount: 100, txCount: 10, prevTxCount: 10, activeTerminals: 8, prevActiveTerminals: 8,
  measurableTerminals: 10, projects: [],
};

describe('growth → score', () => {
  it('flat growth is 50, +25% or more is 100, −25% or less is 0', () => {
    expect(growthToScore(0)).toBe(50);
    expect(growthToScore(25)).toBe(100);
    expect(growthToScore(80)).toBe(100);
    expect(growthToScore(-25)).toBe(0);
    expect(growthToScore(-90)).toBe(0);
  });
  it('no base gives null', () => {
    expect(growthPct(10, 0)).toBeNull();
    expect(growthPct(10, null)).toBeNull();
    expect(growthToScore(null)).toBeNull();
    expect(growthPct(125, 100)).toBe(25);
  });
});

describe('projects score', () => {
  it('on schedule = 100, half of expected = 50, nothing expected yet = 100', () => {
    expect(projectItemScore({ total: 10, resolved: 5, expectedPct: 50 })).toBe(100);
    expect(projectItemScore({ total: 10, resolved: 2, expectedPct: 40 })).toBe(50);
    expect(projectItemScore({ total: 10, resolved: 0, expectedPct: 0 })).toBe(100);
  });
  it('is weighted by terminal count; none = null', () => {
    expect(projectsScore([])).toBeNull();
    expect(projectsScore([{ total: 30, resolved: 30, expectedPct: 100 }, { total: 10, resolved: 0, expectedPct: 100 }])).toBe(75);
  });
});

describe('scoreMonth', () => {
  it('redistributes weight of missing components', () => {
    const r = scoreMonth(base);
    expect(r.components.projects).toBeNull();
    expect(r.components.amount).toBe(50);
    // devices = avg(growth 50, ratio 80) = 65
    expect(r.components.devices).toBe(65);
    // (50*30 + 50*15 + 65*20) / 65
    expect(r.total).toBe(Math.round(((50 * 30 + 50 * 15 + 65 * 20) / 65) * 10) / 10);
  });
  it('returns null total when nothing is measurable', () => {
    const r = scoreMonth({ ...base, prevAmount: null, prevTxCount: null, prevActiveTerminals: null, measurableTerminals: 0, activeTerminals: 0 });
    expect(r.total).toBeNull();
  });
  it('weights are normalised and can zero out a component', () => {
    const w = normalizeWeights({ amount: 1, count: 1, devices: 0, projects: 0 });
    expect(w.amount).toBe(0.5);
    const r = scoreMonth({ ...base, amount: 125 }, { amount: 1, count: 0, devices: 0, projects: 0 });
    expect(r.total).toBe(100);
    expect(normalizeWeights({ amount: 0, count: 0, devices: 0, projects: 0 })).toEqual(DEFAULT_SCORE_WEIGHTS);
  });
});

describe('overall / trend / band', () => {
  it('averages only scored months', () => {
    expect(overallScore([60, null, 80])).toBe(70);
    expect(overallScore([null])).toBeNull();
  });
  it('trend compares recent 3 months with the 3 before', () => {
    expect(scoreTrend([40, 40, 40, 60, 60, 60])).toBe('up');
    expect(scoreTrend([70, 70, 70, 50, 50, 50])).toBe('down');
    expect(scoreTrend([60, 61, 60, 61, 60, 61])).toBe('flat');
    expect(scoreTrend([50])).toBeNull();
  });
  it('bands', () => {
    expect(scoreBand(85)).toBe('excellent');
    expect(scoreBand(65)).toBe('good');
    expect(scoreBand(50)).toBe('average');
    expect(scoreBand(40)).toBe('weak');
    expect(scoreBand(10)).toBe('poor');
    expect(scoreBand(null)).toBeNull();
  });
});

describe('comments / names', () => {
  it('mentions each component and best/worst', () => {
    const score = scoreMonth({ ...base, amount: 120, txCount: 8 });
    const c = buildScoreComments({ score, projects: [] });
    expect(c.some((x) => x.includes('مبلغ خرید'))).toBe(true);
    expect(c.some((x) => x.includes('نقطه‌ی قوت'))).toBe(true);
  });
  it('period names', () => {
    expect(periodNameFa(140503)).toBe('خرداد 1405');
  });
});
