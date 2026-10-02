import { create } from 'zustand';
import { db, makeId } from '../db';
import type { AccessibleTrip, PlannedTripCandidate, RouteSegment } from '../types/route';
import { toPlain } from '../utils/format';
import { canReserveCandidate, planAccessibleTrip, validateTrip } from '../utils/tripPlanner';

interface TripState {
  trips: AccessibleTrip[];
  loaded: boolean;
  loading: boolean;
  candidate: PlannedTripCandidate | null;
  planning: boolean;
  error: string;
  load: () => Promise<void>;
  plan: (
    segments: RouteSegment[],
    originId: string,
    destinationId: string,
    requestedAt: string,
  ) => PlannedTripCandidate | null;
  saveCandidate: (segments: RouteSegment[]) => Promise<AccessibleTrip>;
  clearCandidate: () => void;
  revalidate: (segments: RouteSegment[]) => Promise<void>;
}

export const useTripStore = create<TripState>((set, get) => ({
  trips: [],
  loaded: false,
  loading: false,
  candidate: null,
  planning: false,
  error: '',

  load: async () => {
    set({ loading: true, error: '' });
    try {
      const trips = await db.trips.toArray();
      set({
        trips: trips.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        loading: false,
        loaded: true,
      });
    } catch (e) {
      set({ loading: false, loaded: true, error: e instanceof Error ? e.message : String(e) });
    }
  },

  plan: (segments, originId, destinationId, requestedAt) => {
    const activeTrips = get()
      .trips.filter((t) => t.status === 'active')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const candidate = planAccessibleTrip(
      { segments, activeTrips },
      originId,
      destinationId,
      requestedAt,
    );
    set({ candidate });
    return candidate;
  },

  saveCandidate: async (segments) => {
    const candidate = get().candidate;
    if (!candidate) throw new Error('请先生成可达行程');

    const activeTrips = get()
      .trips.filter((t) => t.status === 'active')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (!canReserveCandidate(segments, candidate, activeTrips)) {
      throw new Error('容量刚被其他行程占用，请立即重算下一可行时间');
    }

    const now = new Date().toISOString();
    const snapshot = candidate.legs.map((leg) => {
      const segment = segments.find((s) => s.id === leg.segmentId);
      if (!segment) throw new Error(`路线段 ${leg.segmentId} 已不存在`);
      return toPlain(segment);
    });
    const trip: AccessibleTrip = toPlain({
      id: makeId('trp'),
      originPointId: candidate.originPointId,
      destinationPointId: candidate.destinationPointId,
      requestedDepartureAt: candidate.requestedDepartureAt,
      plannedDepartureAt: candidate.plannedDepartureAt,
      plannedArrivalAt: candidate.plannedArrivalAt,
      totalTravelMinutes: candidate.totalTravelMinutes,
      totalWaitMinutes: candidate.totalWaitMinutes,
      transferCount: candidate.transferCount,
      status: 'active',
      invalidReason: '',
      invalidCheckedAt: now,
      segmentSnapshot: snapshot,
      legs: candidate.legs,
      createdAt: now,
    });
    await db.trips.put(trip);
    set((s) => ({ trips: [trip, ...s.trips], candidate: null }));
    return trip;
  },

  clearCandidate: () => set({ candidate: null }),

  revalidate: async (segments) => {
    const byId = new Map(segments.map((s) => [s.id, s]));
    const ordered = [...get().trips].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const checkedAt = new Date().toISOString();
    const updates: AccessibleTrip[] = [];

    for (const trip of ordered) {
      const updatedById = new Map(updates.map((t) => [t.id, t]));
      const currentActive = ordered
        .map((t) => updatedById.get(t.id) ?? t)
        .filter((t) => t.status === 'active' && t.id !== trip.id && t.createdAt <= trip.createdAt);
      const result = validateTrip(trip, byId, currentActive);
      const next: AccessibleTrip =
        result.valid && trip.status === 'active'
          ? { ...trip, invalidReason: '', invalidCheckedAt: checkedAt }
          : result.valid
            ? trip
            : { ...trip, status: 'invalid', invalidReason: result.reason, invalidCheckedAt: checkedAt };
      updates.push(next);
    }

    const changed = updates.some((u) => {
      const old = get().trips.find((t) => t.id === u.id);
      return old && (old.status !== u.status || old.invalidReason !== u.invalidReason);
    });
    if (changed) {
      await db.trips.bulkPut(updates);
      set({
        trips: updates.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      });
    }
  },
}));
