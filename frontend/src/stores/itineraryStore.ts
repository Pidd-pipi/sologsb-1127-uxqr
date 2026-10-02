import { create } from 'zustand';
import { db } from '../db';
import type { Itinerary, ItineraryLeg } from '../types/itinerary';
import { makeId, toPlain } from '../utils/format';
import {
  planItinerary,
  revalidateItinerary,
  buildSnapshot,
  type PlanResult,
} from '../utils/itineraryEngine';
import { usePointStore } from './pointStore';
import { useRouteStore } from './routeStore';
import { useElevatorStore } from './elevatorStore';

export interface ItineraryQuery {
  originId: string;
  destinationId: string;
  /** 计划出发时间（ISO） */
  departureAt: string;
}

interface ItineraryState {
  query: ItineraryQuery;
  candidate: PlanResult | null;
  saved: Itinerary[];
  loading: boolean;
  loaded: boolean;
  error: string;
  loadSaved: () => Promise<void>;
  setQuery: (patch: Partial<ItineraryQuery>) => void;
  computeCandidate: () => void;
  saveCandidate: () => Promise<Itinerary | null>;
  deleteItinerary: (id: string) => Promise<void>;
  revalidateAll: () => Promise<void>;
  recomputeCandidate: () => void;
}

function currentCtx() {
  return {
    points: usePointStore.getState().points,
    segments: useRouteStore.getState().segments,
    services: useElevatorStore.getState().services,
  };
}

export const useItineraryStore = create<ItineraryState>((set, get) => ({
  query: { originId: '', destinationId: '', departureAt: '' },
  candidate: null,
  saved: [],
  loading: false,
  loaded: false,
  error: '',

  loadSaved: async () => {
    set({ loading: true, error: '' });
    try {
      const rows = await db.itineraries.toArray();
      set({
        saved: rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
        loading: false,
        loaded: true,
      });
    } catch (e) {
      set({ loading: false, loaded: true, error: e instanceof Error ? e.message : String(e) });
    }
  },

  setQuery: (patch) => {
    set((s) => ({ query: { ...s.query, ...patch } }));
    get().computeCandidate();
  },

  computeCandidate: () => {
    const { query } = get();
    if (!query.originId || !query.destinationId || !query.departureAt) {
      set({ candidate: null });
      return;
    }
    const ctx = currentCtx();
    if (!ctx.points.length || !ctx.segments.length) {
      set({ candidate: null });
      return;
    }
    const candidate = planItinerary(query.originId, query.destinationId, query.departureAt, ctx);
    set({ candidate });
  },

  saveCandidate: async () => {
    const { candidate, query, saved } = get();
    if (!candidate || !candidate.legs.length) return null;
    const now = new Date().toISOString();
    const sameRoute = saved.filter(
      (s) => s.originPointId === query.originId && s.destinationPointId === query.destinationId,
    );
    const version = sameRoute.length ? Math.max(...sameRoute.map((s) => s.version)) + 1 : 1;
    const ctx = currentCtx();
    const record: Itinerary = toPlain({
      id: makeId('itn'),
      version,
      originPointId: query.originId,
      destinationPointId: query.destinationId,
      departureAt: candidate.departureAt,
      status: candidate.status,
      feasible: candidate.feasible,
      totalWalkMin: candidate.totalWalkMin,
      totalWaitMin: candidate.totalWaitMin,
      totalRideMin: candidate.totalRideMin,
      totalMin: candidate.totalMin,
      legs: candidate.legs,
      reason: candidate.reason,
      nextFeasibleAt: candidate.nextFeasibleAt || undefined,
      invalidReason: '',
      snapshot: buildSnapshot(ctx),
      createdAt: now,
      updatedAt: now,
    });
    await db.itineraries.put(record);
    const rows = await db.itineraries.toArray();
    set({ saved: rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)) });
    return record;
  },

  deleteItinerary: async (id) => {
    await db.itineraries.delete(id);
    set((s) => ({ saved: s.saved.filter((it) => it.id !== id) }));
  },

  revalidateAll: async () => {
    const ctx = currentCtx();
    if (!ctx.points.length || !ctx.segments.length) return;
    const { saved } = get();
    const now = new Date().toISOString();
    const next = saved.map((it) => {
      if (it.status === '已拒绝') return it; // 规划时即拒绝，保留原状态
      const r = revalidateItinerary(it.legs as ItineraryLeg[], it.departureAt, ctx);
      if (r.feasible) {
        if (it.status === '可行' && !it.invalidReason) return it;
        return { ...it, status: '可行' as const, feasible: true, invalidReason: '', updatedAt: now };
      }
      return { ...it, status: '已失效' as const, feasible: false, invalidReason: r.reason, updatedAt: now };
    });
    const changed = next.filter((it, i) => it !== saved[i]);
    if (changed.length) {
      await db.itineraries.bulkPut(changed);
      set({ saved: next });
    }
  },

  recomputeCandidate: () => {
    get().computeCandidate();
  },
}));
