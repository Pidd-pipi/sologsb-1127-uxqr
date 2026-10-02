import { create } from 'zustand';
import { db } from '../db';
import type { AccessPoint } from '../types/point';
import type { RouteSegment, RouteVerdict, SegmentAccessMode } from '../types/route';
import { makeId, toPlain } from '../utils/format';
import { judgeSegment, buildVerdict } from '../utils/routeCheck';
import { segmentLength } from '../utils/geo';

/** 编辑中的路段（尚未落库） */
export interface DraftSegment {
  key: string;
  fromPointId: string;
  toPointId: string;
  length: number;
  obstacleCount: number;
  stepCount: number;
  curbHeight: number;
  durationMinutes: number;
  transferWaitMinutes: number;
  order: number;
}

export type SegmentSchedulePatch = Partial<
  Pick<
    RouteSegment,
    | 'accessMode'
    | 'service'
    | 'offPeakCapacity'
    | 'peakCapacity'
    | 'peakWindows'
    | 'maintenanceWindows'
    | 'temporaryClosures'
    | 'dynamicStatus'
    | 'upgradedAllDay'
  >
>;

interface RouteState {
  segments: RouteSegment[];
  loaded: boolean;
  loading: boolean;
  error: string;
  draftName: string;
  chain: string[];
  draftSegments: DraftSegment[];
  verdict: RouteVerdict | null;
  load: () => Promise<void>;
  setDraftName: (name: string) => void;
  setChain: (ids: string[]) => void;
  toggleChainPoint: (id: string) => void;
  buildChainSegments: (points: AccessPoint[]) => void;
  updateDraftSegment: (key: string, patch: Partial<DraftSegment>) => void;
  removeDraftSegment: (key: string) => void;
  computeVerdict: () => RouteVerdict;
  saveRoute: () => Promise<number>;
  updateSegmentSchedule: (id: string, patch: SegmentSchedulePatch) => Promise<RouteSegment>;
  resetDraft: () => void;
}

function newKey(): string {
  return `seg-${Math.random().toString(36).slice(2, 9)}`;
}

function defaultService(accessMode: SegmentAccessMode): RouteSegment['service'] {
  return {
    start: '06:00',
    end: '23:00',
    headwayMinutes: accessMode === 'scheduled' ? 15 : 0,
  };
}

export const useRouteStore = create<RouteState>((set, get) => ({
  segments: [],
  loaded: false,
  loading: false,
  error: '',
  draftName: '无障碍通行路线',
  chain: [],
  draftSegments: [],
  verdict: null,

  load: async () => {
    set({ loading: true, error: '' });
    try {
      const rows = await db.routes.toArray();
      set({
        segments: rows.sort((a, b) =>
          a.routeName === b.routeName ? a.order - b.order : a.routeName.localeCompare(b.routeName),
        ),
        loading: false,
        loaded: true,
      });
    } catch (e) {
      set({ loading: false, loaded: true, error: e instanceof Error ? e.message : String(e) });
    }
  },

  setDraftName: (name) => set({ draftName: name }),

  setChain: (ids) => set({ chain: ids, verdict: null }),

  toggleChainPoint: (id) => {
    const chain = get().chain;
    set({
      chain: chain.includes(id) ? chain.filter((x) => x !== id) : [...chain, id],
      verdict: null,
    });
  },

  /** 选好起终点与途经点后自动串联路段 */
  buildChainSegments: (points) => {
    const chain = get().chain;
    const byId = new Map(points.map((p) => [p.id, p]));
    const ordered = chain.map((id) => byId.get(id)).filter(Boolean) as AccessPoint[];
    const draftSegments: DraftSegment[] = [];
    for (let i = 1; i < ordered.length; i += 1) {
      const from = ordered[i - 1];
      const to = ordered[i];
      draftSegments.push({
        key: newKey(),
        fromPointId: from.id,
        toPointId: to.id,
        length: segmentLength({ lng: from.lng, lat: from.lat }, { lng: to.lng, lat: to.lat }),
        obstacleCount: 0,
        stepCount: 0,
        curbHeight: 2,
        durationMinutes: Math.max(1, Math.round(segmentLength(
          { lng: from.lng, lat: from.lat },
          { lng: to.lng, lat: to.lat },
        ) / 75)),
        transferWaitMinutes: 2,
        order: i,
      });
    }
    set({ draftSegments, verdict: null });
  },

  updateDraftSegment: (key, patch) =>
    set((s) => ({
      draftSegments: s.draftSegments.map((seg) => (seg.key === key ? { ...seg, ...patch } : seg)),
      verdict: null,
    })),

  removeDraftSegment: (key) =>
    set((s) => ({
      draftSegments: s.draftSegments
        .filter((seg) => seg.key !== key)
        .map((seg, i) => ({ ...seg, order: i + 1 })),
      verdict: null,
    })),

  computeVerdict: () => {
    const { draftSegments, draftName } = get();
    const verdict = buildVerdict(draftName, draftSegments);
    set({ verdict });
    return verdict;
  },

  saveRoute: async () => {
    const { draftSegments, draftName } = get();
    const rows: RouteSegment[] = draftSegments.map((seg) =>
      toPlain({
        id: makeId('rts'),
        routeName: draftName || '未命名路线',
        fromPointId: seg.fromPointId,
        toPointId: seg.toPointId,
        length: seg.length,
        obstacleCount: seg.obstacleCount,
        stepCount: seg.stepCount,
        curbHeight: seg.curbHeight,
        wheelchairPassable: judgeSegment(seg).passable,
        order: seg.order,
        durationMinutes: Math.max(1, seg.durationMinutes),
        transferWaitMinutes: seg.transferWaitMinutes,
        accessMode: 'all_day',
        service: defaultService('all_day'),
        offPeakCapacity: 2,
        peakCapacity: 2,
        peakWindows: [],
        maintenanceWindows: [],
        temporaryClosures: [],
        dynamicStatus: 'normal',
        upgradedAllDay: false,
        routeVersion: 1,
        scheduleVersion: 1,
        createdAt: new Date().toISOString(),
      }),
    );
    if (!rows.length) return 0;
    await db.routes.bulkPut(rows);
    const all = await db.routes.toArray();
    set({
      segments: all.sort((a, b) =>
        a.routeName === b.routeName ? a.order - b.order : a.routeName.localeCompare(b.routeName),
      ),
    });
    return rows.length;
  },

  updateSegmentSchedule: async (id, patch) => {
    const segment = await db.routes.get(id);
    if (!segment) throw new Error('路线段不存在');

    const next: RouteSegment = {
      ...segment,
      ...patch,
      service: patch.service ? { ...segment.service, ...patch.service } : segment.service,
      peakWindows: patch.peakWindows ?? segment.peakWindows,
      maintenanceWindows: patch.maintenanceWindows ?? segment.maintenanceWindows,
      temporaryClosures: patch.temporaryClosures ?? segment.temporaryClosures,
    };
    const structuralChanged =
      patch.upgradedAllDay !== undefined ||
      patch.accessMode !== undefined ||
      patch.service?.start !== undefined ||
      patch.service?.end !== undefined;
    next.routeVersion = segment.routeVersion + (structuralChanged ? 1 : 0);
    next.scheduleVersion = segment.scheduleVersion + 1;
    await db.routes.put(next);
    const all = await db.routes.toArray();
    set({
      segments: all.sort((a, b) =>
        a.routeName === b.routeName ? a.order - b.order : a.routeName.localeCompare(b.routeName),
      ),
    });
    return next;
  },

  resetDraft: () => set({ draftSegments: [], verdict: null, chain: [] }),
}));
