import { create } from 'zustand';
import { db } from '../db';
import type { ElevatorService } from '../types/elevator';
import { makeId, toPlain } from '../utils/format';
import { useItineraryStore } from './itineraryStore';

interface ElevatorState {
  services: ElevatorService[];
  loaded: boolean;
  loading: boolean;
  error: string;
  load: () => Promise<void>;
  upsertService: (draft: Omit<ElevatorService, 'id' | 'updatedAt'> & { id?: string }) => Promise<ElevatorService>;
  getByPoint: (pointId: string) => ElevatorService | undefined;
}

export const useElevatorStore = create<ElevatorState>((set, get) => ({
  services: [],
  loaded: false,
  loading: false,
  error: '',

  load: async () => {
    set({ loading: true, error: '' });
    try {
      const rows = await db.elevatorServices.toArray();
      set({ services: rows, loading: false, loaded: true });
    } catch (e) {
      set({ loading: false, loaded: true, error: e instanceof Error ? e.message : String(e) });
    }
  },

  upsertService: async (draft) => {
    const now = new Date().toISOString();
    const existing = draft.id ? await db.elevatorServices.get(draft.id) : undefined;
    const service: ElevatorService = toPlain({
      ...draft,
      id: draft.id ?? existing?.id ?? makeId('elv'),
      updatedAt: now,
    });
    await db.elevatorServices.put(service);
    const rows = await db.elevatorServices.toArray();
    set({ services: rows });
    // 班次 / 容量 / 停用变化后立即重算候选并复核已保存行程
    void useItineraryStore.getState().recomputeCandidate();
    void useItineraryStore.getState().revalidateAll();
    return service;
  },

  getByPoint: (pointId) => get().services.find((s) => s.pointId === pointId),
}));
