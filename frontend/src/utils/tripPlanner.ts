import type {
  AccessibleTrip,
  PlannedTripCandidate,
  RouteSegment,
  TimeWindow,
  TripLeg,
} from '../types/route';

const MINUTE = 60_000;
const SEARCH_DAYS = 7;

export interface PlannerNetwork {
  segments: RouteSegment[];
  activeTrips: AccessibleTrip[];
}

interface EdgeAvailability {
  departureAt: Date;
  arrivalAt: Date;
  serviceWait: number;
  capacity: number;
  peak: boolean;
  /** 请求时间被开放窗口/检修拒绝，而非普通班车等待 */
  deniedRequested: boolean;
  reasons: string[];
}

function pad2(n: number): string {
  return `${n}`.padStart(2, '0');
}

export function formatHM(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function localDateTimeString(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${formatHM(d)}`;
}

export function parseLocalDateTime(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(value);
  if (!match) return new Date(Number.NaN);
  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    0,
    0,
  );
}

function hmToMinutes(hm: string): number {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}

function setHM(date: Date, minutesOfDay: number): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(minutesOfDay);
  return d;
}

function absoluteWindows(day: Date, windows: TimeWindow[]): Array<{ start: Date; end: Date }> {
  return windows.map((w) => ({
    start: setHM(day, hmToMinutes(w.start)),
    end: setHM(day, hmToMinutes(w.end)),
  }));
}

function overlaps(start: Date, end: Date, windows: Array<{ start: Date; end: Date }>): boolean {
  return windows.some((w) => start < w.end && end > w.start);
}

function withinWindows(date: Date, windows: Array<{ start: Date; end: Date }>): boolean {
  return windows.some((w) => date >= w.start && date < w.end);
}

function intervalMinutes(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / MINUTE);
}

export function isStructurallyWheelchairPassable(segment: RouteSegment): boolean {
  return segment.upgradedAllDay || segment.wheelchairPassable;
}

function isTemporarilyClosed(segment: RouteSegment, at: Date): string {
  const hit = segment.temporaryClosures.find((c) => {
    const start = new Date(c.startAt);
    const end = new Date(c.endAt);
    return at >= start && at < end;
  });
  return hit?.reason || '';
}

function isInMaintenance(segment: RouteSegment, departure: Date, arrival: Date): string {
  const windows = absoluteWindows(departure, segment.maintenanceWindows);
  if (overlaps(departure, arrival, windows)) {
    const hit = segment.maintenanceWindows.find((w) => {
      const s = setHM(departure, hmToMinutes(w.start));
      const e = setHM(departure, hmToMinutes(w.end));
      return departure < e && arrival > s;
    });
    return hit?.reason || '无障碍设施检修';
  }
  return '';
}

function isPeak(segment: RouteSegment, at: Date): boolean {
  return withinWindows(at, absoluteWindows(at, segment.peakWindows));
}

/** 全天可用边使用 15 分钟时隙；按班次边使用具体班次时间。 */
function capacityBucketStart(segment: RouteSegment, departure: Date): Date {
  if (segment.accessMode === 'scheduled') return new Date(departure);
  const slot = 15;
  const index = Math.floor(departure.getHours() * 4 + departure.getMinutes() / slot);
  return setHM(departure, index * slot);
}

function capacityAt(segment: RouteSegment, departure: Date): number {
  return isPeak(segment, departure) ? segment.peakCapacity : segment.offPeakCapacity;
}

function usedCapacity(
  segment: RouteSegment,
  departure: Date,
  activeTrips: AccessibleTrip[],
  excludeTripId?: string,
): number {
  const bucket = capacityBucketStart(segment, departure).getTime();
  return activeTrips.reduce((sum, trip) => {
    if (trip.id === excludeTripId) return sum;
    const leg = trip.legs.find((l) => l.segmentId === segment.id);
    if (!leg) return sum;
    const legBucket = capacityBucketStart(segment, new Date(leg.departureAt)).getTime();
    return legBucket === bucket ? sum + 1 : sum;
  }, 0);
}

function hasCapacity(
  segment: RouteSegment,
  departure: Date,
  activeTrips: AccessibleTrip[],
  excludeTripId?: string,
): boolean {
  return usedCapacity(segment, departure, activeTrips, excludeTripId) < capacityAt(segment, departure);
}

function nextOpenOrService(segment: RouteSegment, after: Date, addDay = 0): Date {
  const day = new Date(after);
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() + addDay);
  const openStart = setHM(day, hmToMinutes(segment.service.start));
  if (after <= openStart) return openStart;

  if (segment.accessMode === 'all_day') {
    const serviceEnd = setHM(day, hmToMinutes(segment.service.end));
    if (after > serviceEnd) return openStart;
    return after < openStart ? openStart : after;
  }

  const headway = Math.max(1, segment.service.headwayMinutes);
  const elapsed = intervalMinutes(openStart, after);
  const quotient = Math.floor(elapsed / headway);
  const candidate = new Date(openStart.getTime() + quotient * headway * MINUTE);
  if (candidate < after) candidate.setMinutes(candidate.getMinutes() + headway);
  return candidate;
}

function findEdgeDeparture(
  segment: RouteSegment,
  arriveAt: Date,
  requestedAt: Date,
  activeTrips: AccessibleTrip[],
): EdgeAvailability | null {
  if (!isStructurallyWheelchairPassable(segment)) return null;
  const effectiveSegment = segment.upgradedAllDay
    ? {
        ...segment,
        accessMode: 'all_day' as const,
        service: { start: '00:00', end: '23:59', headwayMinutes: 0 },
      }
    : segment;

  const horizon = new Date(requestedAt);
  horizon.setDate(horizon.getDate() + SEARCH_DAYS);

  let departure = nextOpenOrService(effectiveSegment, arriveAt);
  const deniedReasons = new Set<string>();
  let deniedRequested = false;

  while (departure <= horizon) {
    const day = departure;
    const openStart = setHM(day, hmToMinutes(effectiveSegment.service.start));
    const serviceEnd = setHM(day, hmToMinutes(effectiveSegment.service.end));

    if (departure < openStart || departure > serviceEnd) {
      departure = nextOpenOrService(effectiveSegment, arriveAt, 1);
      continue;
    }

    const arrival = new Date(departure.getTime() + segment.durationMinutes * MINUTE);
    if (arrival > serviceEnd) {
      deniedReasons.add(`${segment.routeName} 末班 ${segment.service.end} 前无法完成通行`);
      departure = nextOpenOrService(effectiveSegment, arriveAt, 1);
      deniedRequested = true;
      continue;
    }

    const temporaryReason = isTemporarilyClosed(segment, departure);
    if (temporaryReason) {
      deniedReasons.add(`${segment.routeName}：${temporaryReason}`);
      const closure = segment.temporaryClosures
        .map((c) => ({ start: new Date(c.startAt), end: new Date(c.endAt) }))
        .filter((c) => departure >= c.start && departure < c.end)
        .sort((a, b) => b.end.getTime() - a.end.getTime())[0];
      departure = new Date(Math.max(closure.end.getTime(), arriveAt.getTime()));
      deniedRequested = true;
      continue;
    }

    const maintenanceReason = isInMaintenance(segment, departure, arrival);
    if (maintenanceReason) {
      deniedReasons.add(`${segment.routeName}：${maintenanceReason}`);
      const windows = absoluteWindows(departure, segment.maintenanceWindows);
      const hit = windows.filter((w) => departure < w.end && arrival > w.start).sort((a, b) => b.end.getTime() - a.end.getTime())[0];
      departure = new Date(Math.max(hit.end.getTime(), arriveAt.getTime()));
      deniedRequested = true;
      continue;
    }

    if (!hasCapacity(segment, departure, activeTrips)) {
      deniedReasons.add(
        `${segment.routeName} ${localDateTimeString(departure)} ${isPeak(segment, departure) ? '高峰' : '平峰'}轮椅容量已满`,
      );
      if (effectiveSegment.accessMode === 'scheduled') {
        departure.setMinutes(departure.getMinutes() + Math.max(1, effectiveSegment.service.headwayMinutes));
      } else {
        departure = new Date(capacityBucketStart(segment, departure).getTime() + 15 * MINUTE);
      }
      deniedRequested = true;
      continue;
    }

    return {
      departureAt: departure,
      arrivalAt: arrival,
      serviceWait: intervalMinutes(arriveAt, departure),
      capacity: capacityAt(segment, departure),
      peak: isPeak(segment, departure),
      deniedRequested,
      reasons: [...deniedReasons],
    };
  }
  return null;
}

interface Label {
  pointId: string;
  arrival: Date;
  requestedAt: Date;
  denied: boolean;
  reasons: Set<string>;
  legs: TripLeg[];
  waitMinutes: number;
}

function createLeg(
  segment: RouteSegment,
  availability: EdgeAvailability,
  serviceWait: number,
): TripLeg {
  return {
    segmentId: segment.id,
    routeName: segment.routeName,
    fromPointId: segment.fromPointId,
    toPointId: segment.toPointId,
    accessMode: segment.upgradedAllDay ? 'all_day' : segment.accessMode,
    departureAt: localDateTimeString(availability.departureAt),
    arrivalAt: localDateTimeString(availability.arrivalAt),
    travelMinutes: segment.durationMinutes,
    transferWaitMinutes: segment.transferWaitMinutes,
    serviceWaitMinutes: serviceWait,
    departureCapacity: availability.capacity,
    peak: availability.peak,
  };
}

function dominates(a: Label, b: Label): boolean {
  if (b.denied && !a.denied) return false;
  return (
    a.arrival.getTime() <= b.arrival.getTime() &&
    (!a.denied || b.denied) &&
    a.reasons.size <= b.reasons.size
  );
}

/**
 * 时间依赖最短路：候选按“最早到达 + 原请求是否被拒绝”扩展。
 * 每个节点的每段等待均保留在 leg 中，换乘等待单独累计。
 */
export function planAccessibleTrip(
  network: PlannerNetwork,
  originPointId: string,
  destinationPointId: string,
  requestedDepartureAt: string,
): PlannedTripCandidate | null {
  const requested = parseLocalDateTime(requestedDepartureAt);
  if (Number.isNaN(requested.getTime())) return null;

  const adjacency = new Map<string, RouteSegment[]>();
  for (const segment of network.segments) {
    if (!isStructurallyWheelchairPassable(segment)) continue;
    const list = adjacency.get(segment.fromPointId) ?? [];
    list.push(segment);
    adjacency.set(segment.fromPointId, list);
  }
  if (!adjacency.has(originPointId)) return null;

  const labelsByPoint = new Map<string, Label[]>();
  const initial: Label = {
    pointId: originPointId,
    arrival: requested,
    requestedAt: requested,
    denied: false,
    reasons: new Set(),
    legs: [],
    waitMinutes: 0,
  };
  labelsByPoint.set(originPointId, [initial]);
  const queue: Label[] = [initial];
  let bestDestination: Label | null = null;

  while (queue.length) {
    queue.sort((a, b) => {
      if (a.denied !== b.denied) return a.denied ? 1 : -1;
      return a.arrival.getTime() - b.arrival.getTime();
    });
    const label = queue.shift()!;
    if (bestDestination && bestDestination.arrival <= label.arrival && !bestDestination.denied) continue;
    if (label.pointId === destinationPointId) {
      if (!bestDestination || (!label.denied && bestDestination.denied) || label.arrival < bestDestination.arrival) {
        bestDestination = label;
      }
      continue;
    }

    const edges = adjacency.get(label.pointId) ?? [];
    for (const edge of edges) {
      // 到达本站后的固定换乘等待不计入首段；后续班次从“可换乘时间”开始计算。
      const fixedWait = label.legs.length ? edge.transferWaitMinutes : 0;
      const readyAt = new Date(label.arrival.getTime() + fixedWait * MINUTE);
      const availability = findEdgeDeparture(edge, readyAt, requested, network.activeTrips);
      if (!availability) continue;

      const leg = createLeg(edge, availability, availability.serviceWait);
      const nextLabel: Label = {
        pointId: edge.toPointId,
        arrival: availability.arrivalAt,
        requestedAt: requested,
        denied: label.denied || availability.deniedRequested,
        reasons: new Set([...label.reasons, ...availability.reasons]),
        legs: [...label.legs, leg],
        waitMinutes: label.waitMinutes + fixedWait + availability.serviceWait,
      };

      const existing = labelsByPoint.get(nextLabel.pointId) ?? [];
      if (existing.some((l) => dominates(l, nextLabel))) continue;
      const dominatedOut = existing.filter((l) => !dominates(nextLabel, l));
      dominatedOut.push(nextLabel);
      labelsByPoint.set(nextLabel.pointId, dominatedOut);
      queue.push(nextLabel);
    }
  }

  if (!bestDestination) return null;
  const plannedDeparture = bestDestination.legs.length
    ? parseLocalDateTime(bestDestination.legs[0].departureAt)
    : requested;
  const plannedArrival = bestDestination.arrival;
  return {
    originPointId,
    destinationPointId,
    requestedDepartureAt: localDateTimeString(requested),
    plannedDepartureAt: localDateTimeString(plannedDeparture),
    plannedArrivalAt: localDateTimeString(plannedArrival),
    totalTravelMinutes: intervalMinutes(plannedDeparture, plannedArrival),
    totalWaitMinutes: bestDestination.waitMinutes,
    transferCount: Math.max(0, bestDestination.legs.length - 1),
    legs: bestDestination.legs,
    rejectedRequestedTime:
      bestDestination.denied || plannedDeparture.getTime() !== requested.getTime(),
    rejectionReasons: [...bestDestination.reasons],
  };
}

/** 保存行程前再次锁定容量；避免候选生成与保存之间被其他行程抢占。 */
export function canReserveCandidate(
  segments: RouteSegment[],
  candidate: PlannedTripCandidate,
  activeTrips: AccessibleTrip[],
): boolean {
  return candidate.legs.every((leg) => {
    const segment = segments.find((s) => s.id === leg.segmentId);
    if (!segment) return false;
    const departure = parseLocalDateTime(leg.departureAt);
    return hasCapacity(segment, departure, activeTrips);
  });
}

export function validateTrip(
  trip: AccessibleTrip,
  segmentsById: Map<string, RouteSegment>,
  activeTrips: AccessibleTrip[],
): { valid: boolean; reason: string } {
  if (trip.legs.length !== trip.segmentSnapshot.length) {
    return { valid: false, reason: '行程版本缺少路线段快照，无法按原版本复核' };
  }

  for (let i = 0; i < trip.legs.length; i += 1) {
    const leg = trip.legs[i];
    const current = segmentsById.get(leg.segmentId);
    const snapshot = trip.segmentSnapshot[i];

    if (!current) return { valid: false, reason: `路线段「${leg.routeName}」已删除` };
    if (current.fromPointId !== leg.fromPointId || current.toPointId !== leg.toPointId) {
      return { valid: false, reason: `路线段「${leg.routeName}」起终点已调整` };
    }
    if (current.routeVersion !== snapshot.routeVersion) {
      return { valid: false, reason: `路线段「${leg.routeName}」结构或升级状态已变化，需要重新规划` };
    }
    if (!isStructurallyWheelchairPassable(current)) {
      return { valid: false, reason: `路线段「${leg.routeName}」当前静态核验不可通行` };
    }

    const departure = parseLocalDateTime(leg.departureAt);
    const arrival = parseLocalDateTime(leg.arrivalAt);
    const temporary = isTemporarilyClosed(current, departure);
    if (temporary) return { valid: false, reason: `${leg.routeName}临时停用：${temporary}` };
    const maintenance = isInMaintenance(current, departure, arrival);
    if (maintenance) return { valid: false, reason: `${leg.routeName}处于检修窗口：${maintenance}` };
    if (!current.upgradedAllDay && current.accessMode === 'scheduled') {
      const openStart = setHM(departure, hmToMinutes(current.service.start));
      const serviceEnd = setHM(departure, hmToMinutes(current.service.end));
      if (departure < openStart || arrival > serviceEnd) {
        return { valid: false, reason: `${leg.routeName}班次窗口已变化，原乘车时刻不可用` };
      }
      const elapsed = intervalMinutes(openStart, departure);
      if (elapsed % Math.max(1, current.service.headwayMinutes) !== 0) {
        return { valid: false, reason: `${leg.routeName}发班时刻已变化` };
      }
    }
  }

  // 容量按创建顺序锁定，较晚保存且抢不到容量的行程被置为失效。
  const earlierTrips = activeTrips
    .filter((t) => t.status === 'active' && t.id !== trip.id && t.createdAt <= trip.createdAt)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const leg of trip.legs) {
    const segment = segmentsById.get(leg.segmentId);
    if (!segment) return { valid: false, reason: `路线段「${leg.routeName}」已删除` };
    const departure = parseLocalDateTime(leg.departureAt);
    if (!hasCapacity(segment, departure, earlierTrips, trip.id)) {
      return {
        valid: false,
        reason: `${leg.routeName} 在 ${leg.departureAt} 的轮椅容量被更早确认的行程占用`,
      };
    }
  }

  return { valid: true, reason: '' };
}
