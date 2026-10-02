/**
 * 时间依赖的无障碍行程引擎。
 *
 * 路线受开放时段 / 检修窗口 / 班次 / 高峰容量 / 临时停用约束：
 * - 步行段沿已落库的路线段（静态可通行）展开；
 * - 途经无障碍电梯点位时按到达时刻匹配班次，计入换乘等待；
 * - 当日无法乘梯（停用 / 封闭 / 检修 / 容量不足）则拒绝该出发时刻，
 *   并向前搜索下一可行出发时间。
 */
import type { AccessPoint } from '../types/point';
import type { RouteSegment } from '../types/route';
import type { ElevatorService, ElevatorSchedule, MaintenanceWindow } from '../types/elevator';
import type { ItineraryLeg } from '../types/itinerary';

/** 轮椅步行速度：约 0.83 m/s ≈ 50 m/min */
export const WALK_M_PER_MIN = 50;
/** 班次搜索视野（天） */
const HORIZON_DAYS = 3;
/** 候选路径条数 */
const MAX_PATHS = 3;
/** 下一可行时间搜索迭代上限 */
const MAX_SEARCH_ITER = 24;

const MINUTE = 60_000;

/* ---------------- 时间工具 ---------------- */

function toDate(iso: string): Date {
  return new Date(iso);
}

function iso(d: Date): string {
  return d.toISOString();
}

function addMin(d: Date, min: number): Date {
  return new Date(d.getTime() + min * MINUTE);
}

function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + days);
  return r;
}

function dayStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function minOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** HH:MM */
export function fmtHM(d: Date | string): string {
  const date = typeof d === 'string' ? toDate(d) : d;
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** MM-DD HH:mm */
export function fmtMDHM(d: Date | string): string {
  const date = typeof d === 'string' ? toDate(d) : d;
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${fmtHM(date)}`;
}

/** YYYY-MM-DD HH:mm（本地） */
export function fmtYMDHM(d: Date | string): string {
  const date = typeof d === 'string' ? toDate(d) : d;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${fmtHM(date)}`;
}

/* ---------------- 图与路径 ---------------- */

interface AdjEdge {
  to: string;
  walkMin: number;
  passable: boolean;
}

function buildAdj(segments: RouteSegment[]): Map<string, AdjEdge[]> {
  const adj = new Map<string, AdjEdge[]>();
  for (const seg of segments) {
    const walkMin = round1((Number(seg.length) || 0) / WALK_M_PER_MIN);
    const passable = !!seg.wheelchairPassable;
    const push = (from: string, to: string) => {
      const list = adj.get(from) ?? [];
      list.push({ to, walkMin, passable });
      adj.set(from, list);
    };
    push(seg.fromPointId, seg.toPointId);
    push(seg.toPointId, seg.fromPointId);
  }
  return adj;
}

/** 简单路径（不重复经过节点），按步行耗时排序，取前 MAX_PATHS 条 */
function findPaths(
  origin: string,
  dest: string,
  adj: Map<string, AdjEdge[]>,
): { path: string[]; walkMin: number }[] {
  const found: { path: string[]; walkMin: number }[] = [];
  const visited = new Set<string>();
  const depthLimit = adj.size + 1;
  const dfs = (id: string, path: string[], walk: number) => {
    if (found.length >= MAX_PATHS * 6) return;
    if (path.length > depthLimit) return;
    if (id === dest) {
      found.push({ path: [...path], walkMin: round1(walk) });
      return;
    }
    visited.add(id);
    const edges = (adj.get(id) ?? []).filter((e) => e.passable && !visited.has(e.to));
    for (const e of edges) {
      path.push(e.to);
      dfs(e.to, path, walk + e.walkMin);
      path.pop();
      if (found.length >= MAX_PATHS * 6) break;
    }
    visited.delete(id);
  };
  dfs(origin, [origin], 0);
  return found.sort((a, b) => a.walkMin - b.walkMin).slice(0, MAX_PATHS);
}

/* ---------------- 电梯评估 ---------------- */

interface ElevatorEval {
  boardable: boolean;
  reason: string;
  tripAt: Date | null;
  arriveAt: Date | null;
  waitMin: number;
  rideMin: number;
  /** 拒绝时的下一可乘班次（可能跨日） */
  nextTripAt: Date | null;
}

function inMaintenance(m: MaintenanceWindow, trip: Date): boolean {
  const wd = trip.getDay();
  if (m.kind === 'once') {
    if (!m.date) return false;
    const d = dayStart(trip);
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (ymd !== m.date) return false;
  } else if (m.weekday !== wd) {
    return false;
  }
  const cur = minOfDay(trip);
  if (m.endMin <= m.startMin) {
    // 跨天：当天 startMin 之后 或 次日 endMin 之前
    return cur >= m.startMin || cur < m.endMin;
  }
  return cur >= m.startMin && cur < m.endMin;
}

function inPeakNoCapacity(service: ElevatorSchedule, trip: Date): boolean {
  const cur = minOfDay(trip);
  for (const p of service.peakWindows) {
    const cross = p.endMin <= p.startMin;
    const inWindow = cross ? cur >= p.startMin || cur < p.endMin : cur >= p.startMin && cur < p.endMin;
    if (inWindow && p.peakCapacity < 1) return true;
  }
  return false;
}

/** 某日可乘班次（已排除检修 / 高峰无容量），按时刻排序 */
function boardableTripsOnDay(service: ElevatorService, day: Date): Date[] {
  const trips: Date[] = [];
  const sched = service.schedule;
  const pushRange = (startMin: number, endMin: number) => {
    if (sched.kind === 'interval') {
      const step = sched.intervalMin || 15;
      for (let m = startMin; m < endMin; m += step) {
        trips.push(addMin(day, m));
      }
    } else {
      for (const m of sched.fixedMinutes ?? []) {
        if (m >= startMin && m < endMin) trips.push(addMin(day, m));
      }
    }
  };

  if (service.allDay) {
    pushRange(0, 24 * 60);
  } else {
    const wd = day.getDay();
    const wins = service.openWindows.filter((w) => w.weekdays.length === 0 || w.weekdays.includes(wd));
    for (const w of wins) {
      const end = w.endMin > w.startMin ? w.endMin : w.endMin + 24 * 60;
      pushRange(w.startMin, end);
    }
  }

  return trips
    .filter((t) => !service.maintenance.some((m) => inMaintenance(m, t)))
    .filter((t) => !inPeakNoCapacity(sched, t))
    .sort((a, b) => a.getTime() - b.getTime());
}

function evaluateElevator(service: ElevatorService, arrival: Date): ElevatorEval {
  const rideMin = service.schedule.rideMin || 2;

  if (service.status === '临时停用') {
    return {
      boardable: false,
      reason: `电梯临时停用${service.suspendedReason ? `：${service.suspendedReason}` : '，恢复时间待定'}`,
      tripAt: null,
      arriveAt: null,
      waitMin: 0,
      rideMin,
      nextTripAt: service.resumeAt ? toDate(service.resumeAt) : null,
    };
  }

  if (service.schedule.capacityPerTrip < 1) {
    return {
      boardable: false,
      reason: '电梯班次容量为 0，无法承载轮椅',
      tripAt: null,
      arriveAt: null,
      waitMin: 0,
      rideMin,
      nextTripAt: null,
    };
  }

  const startDay = dayStart(arrival);
  const days: { day: Date; trips: Date[] }[] = [];
  for (let d = 0; d < HORIZON_DAYS; d += 1) {
    const day = addDays(startDay, d);
    days.push({ day, trips: boardableTripsOnDay(service, day) });
  }

  // 全天电梯：搭乘到达时刻之后的最早班次
  if (service.allDay) {
    const first = days.flatMap((x) => x.trips).find((t) => t.getTime() >= arrival.getTime());
    if (first) {
      return {
        boardable: true,
        reason: '',
        tripAt: first,
        arriveAt: addMin(first, rideMin),
        waitMin: round1((first.getTime() - arrival.getTime()) / MINUTE),
        rideMin,
        nextTripAt: null,
      };
    }
    return {
      boardable: false,
      reason: `未来 ${HORIZON_DAYS} 天内无可乘班次`,
      tripAt: null,
      arriveAt: null,
      waitMin: 0,
      rideMin,
      nextTripAt: null,
    };
  }

  // 非全天电梯：只在同一服务日内乘降，跨日则拒绝
  const todayTrips = days[0].trips;
  const todayLater = todayTrips.filter((t) => t.getTime() >= arrival.getTime());
  if (todayLater.length) {
    const t = todayLater[0];
    return {
      boardable: true,
      reason: '',
      tripAt: t,
      arriveAt: addMin(t, rideMin),
      waitMin: round1((t.getTime() - arrival.getTime()) / MINUTE),
      rideMin,
      nextTripAt: null,
    };
  }

  // 今日已无班次：下一可乘班次在明日或之后
  const firstBoardable = days
    .slice(1)
    .flatMap((x) => x.trips)
    .find((t) => t.getTime() >= arrival.getTime());
  const reason = todayTrips.length
    ? '已过电梯当日运营时段（或当日容量已约满）'
    : '电梯当日无运营班次（开放时段 / 检修或容量限制）';
  return {
    boardable: false,
    reason,
    tripAt: null,
    arriveAt: null,
    waitMin: 0,
    rideMin,
    nextTripAt: firstBoardable ?? null,
  };
}

/* ---------------- 行程模拟 ---------------- */

interface SimContext {
  points: AccessPoint[];
  segments: RouteSegment[];
  services: ElevatorService[];
}

interface SimResult {
  feasible: boolean;
  legs: ItineraryLeg[];
  reason: string;
  failElevatorId: string;
  nextTripAt: Date | null;
  /** 到达失败电梯的时刻 */
  arrivalAtFail: Date | null;
}

function serviceAt(services: ElevatorService[], pointId: string): ElevatorService | undefined {
  return services.find((s) => s.pointId === pointId);
}

function pointName(points: AccessPoint[], id: string): string {
  return points.find((p) => p.id === id)?.name ?? id;
}

function simulate(path: string[], origin: Date, ctx: SimContext): SimResult {
  const adj = buildAdj(ctx.segments);
  const legs: ItineraryLeg[] = [];
  let cur = new Date(origin);
  let key = 0;

  for (let i = 0; i < path.length - 1; i += 1) {
    const from = path[i];
    const to = path[i + 1];
    const edges = adj.get(from) ?? [];
    const edge = edges.find((e) => e.to === to && e.passable);
    if (!edge) {
      return {
        feasible: false,
        legs,
        reason: `路段 ${pointName(ctx.points, from)} → ${pointName(ctx.points, to)} 存在静态障碍，无法通行`,
        failElevatorId: '',
        nextTripAt: null,
        arrivalAtFail: null,
      };
    }
    const departAt = new Date(cur);
    const arriveAt = addMin(cur, edge.walkMin);
    legs.push({
      key: `leg-${key++}`,
      mode: 'walk',
      fromPointId: from,
      toPointId: to,
      order: legs.length + 1,
      departAt: iso(departAt),
      arriveAt: iso(arriveAt),
      walkMin: edge.walkMin,
      waitMin: 0,
      rideMin: 0,
      passable: true,
      reason: '',
    });
    cur = arriveAt;

    // 途经电梯点位（非终点）：计入乘梯等待与开放 / 容量约束
    if (i + 1 < path.length - 1) {
      const svc = serviceAt(ctx.services, to);
      if (svc) {
        const ev = evaluateElevator(svc, cur);
        if (!ev.boardable) {
          return {
            feasible: false,
            legs,
            reason: ev.reason,
            failElevatorId: to,
            nextTripAt: ev.nextTripAt,
            arrivalAtFail: cur,
          };
        }
        legs.push({
          key: `leg-${key++}`,
          mode: 'elevator',
          fromPointId: to,
          toPointId: to,
          order: legs.length + 1,
          departAt: iso(cur),
          arriveAt: iso(ev.arriveAt!),
          walkMin: 0,
          waitMin: ev.waitMin,
          rideMin: ev.rideMin,
          tripAt: iso(ev.tripAt!),
          elevatorPointId: to,
          passable: true,
          reason: '',
        });
        cur = ev.arriveAt!;
      }
    }
  }

  return { feasible: true, legs, reason: '', failElevatorId: '', nextTripAt: null, arrivalAtFail: null };
}

/* ---------------- 行程规划主入口 ---------------- */

export interface PlanResult {
  feasible: boolean;
  status: '可行' | '已拒绝';
  legs: ItineraryLeg[];
  reason: string;
  nextFeasibleAt: string;
  totalWalkMin: number;
  totalWaitMin: number;
  totalRideMin: number;
  totalMin: number;
  path: string[];
  departureAt: string;
}

function totalsOf(legs: ItineraryLeg[]) {
  const totalWalkMin = round1(legs.reduce((n, l) => n + l.walkMin, 0));
  const totalWaitMin = round1(legs.reduce((n, l) => n + l.waitMin, 0));
  const totalRideMin = round1(legs.reduce((n, l) => n + l.rideMin, 0));
  return { totalWalkMin, totalWaitMin, totalRideMin, totalMin: round1(totalWalkMin + totalWaitMin + totalRideMin) };
}

/** 按出发时间生成可达行程；容量 / 时段不足时拒绝并给出下一可行时间 */
export function planItinerary(
  originId: string,
  destId: string,
  departureIso: string,
  ctx: SimContext,
): PlanResult {
  const origin = toDate(departureIso);
  const adj = buildAdj(ctx.segments);
  const paths = findPaths(originId, destId, adj);

  if (!paths.length) {
    return {
      feasible: false,
      status: '已拒绝',
      legs: [],
      reason: '起讫点之间没有可轮椅通行的路线（静态障碍阻断）',
      nextFeasibleAt: '',
      totalWalkMin: 0,
      totalWaitMin: 0,
      totalRideMin: 0,
      totalMin: 0,
      path: [],
      departureAt: departureIso,
    };
  }

  let bestReject: { sim: SimResult; path: string[]; nextFeasible: Date | null } | null = null;

  for (const { path } of paths) {
    // 1) 按用户请求的出发时间评估
    const requested = simulate(path, new Date(origin), ctx);
    if (requested.feasible) {
      const totals = totalsOf(requested.legs);
      return {
        feasible: true,
        status: '可行',
        legs: requested.legs,
        reason: '',
        nextFeasibleAt: '',
        path,
        departureAt: iso(origin),
        ...totals,
      };
    }

    // 2) 请求时刻不可行：向前搜索下一可行出发时间（仅用于给出 nextFeasibleAt）
    let candidate = new Date(origin);
    let search = requested;
    let nextFeasible: Date | null = null;
    for (let iter = 0; iter < MAX_SEARCH_ITER; iter += 1) {
      if (!search.nextTripAt || !search.arrivalAtFail) break; // 该路径无望（停用 / 无班次）
      const elapsedMin = (search.arrivalAtFail.getTime() - candidate.getTime()) / MINUTE;
      const next = addMin(search.nextTripAt, -elapsedMin);
      if (next.getTime() <= candidate.getTime()) break;
      candidate = next;
      search = simulate(path, candidate, ctx);
      if (search.feasible) {
        nextFeasible = candidate;
        break;
      }
    }

    if (
      !bestReject ||
      (nextFeasible && (!bestReject.nextFeasible || nextFeasible < bestReject.nextFeasible))
    ) {
      bestReject = { sim: requested, path, nextFeasible };
    }
  }

  const sim = bestReject!.sim;
  const totals = totalsOf(sim.legs);
  return {
    feasible: false,
    status: '已拒绝',
    legs: sim.legs,
    reason: sim.reason || '当前出发时间无法满足电梯开放 / 容量约束',
    nextFeasibleAt: bestReject!.nextFeasible ? iso(bestReject!.nextFeasible) : '',
    path: bestReject!.path,
    departureAt: iso(origin),
    ...totals,
  };
}

/* ---------------- 失效重算 ---------------- */

/** 由行程段还原点位链 */
export function pathFromLegs(legs: ItineraryLeg[]): string[] {
  const path: string[] = [];
  for (const l of legs) {
    if (!path.length || path[path.length - 1] !== l.fromPointId) path.push(l.fromPointId);
    if (path[path.length - 1] !== l.toPointId) path.push(l.toPointId);
  }
  return path;
}

/** 用当前服务规则复核已保存行程；返回是否仍可行及失效原因 */
export function revalidateItinerary(
  legs: ItineraryLeg[],
  departureIso: string,
  ctx: SimContext,
): { feasible: boolean; reason: string } {
  const path = pathFromLegs(legs);
  if (path.length < 2) return { feasible: false, reason: '行程段不完整' };
  const sim = simulate(path, toDate(departureIso), ctx);
  if (sim.feasible) return { feasible: true, reason: '' };
  const elevatorName = sim.failElevatorId ? pointName(ctx.points, sim.failElevatorId) : '';
  const reason = elevatorName
    ? `途经电梯「${elevatorName}」${sim.reason}`
    : sim.reason;
  return { feasible: false, reason };
}

/* ---------------- 快照 ---------------- */

export function buildSnapshot(ctx: SimContext): string {
  const snap = {
    v: 1,
    elevators: ctx.services.map((s) => ({
      pointId: s.pointId,
      status: s.status,
      allDay: s.allDay,
      resumeAt: s.resumeAt,
      openWindows: s.openWindows,
      maintenance: s.maintenance,
      schedule: {
        intervalMin: s.schedule.intervalMin,
        fixedMinutes: s.schedule.fixedMinutes,
        capacityPerTrip: s.schedule.capacityPerTrip,
        rideMin: s.schedule.rideMin,
        peakWindows: s.schedule.peakWindows,
      },
    })),
    routes: ctx.segments.map((seg) => ({
      id: seg.id,
      from: seg.fromPointId,
      to: seg.toPointId,
      passable: seg.wheelchairPassable,
    })),
  };
  return JSON.stringify(snap);
}
