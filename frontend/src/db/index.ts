import Dexie, { type Table } from 'dexie';
import type { AccessPoint } from '../types/point';
import type { Inspection } from '../types/inspection';
import type {
  AccessibleTrip,
  PeakCapacityWindow,
  RouteSegment,
  SegmentAccessMode,
  ServiceSchedule,
  MaintenanceWindow,
} from '../types/route';
import type { RectifyPlan } from '../types/rectify';
import { addDays, makeId, todayStr, toPlain } from '../utils/format';
import { judgeInspection } from '../utils/routeCheck';

export const DB_NAME = 'gbaccessmap-db';

/**
 * 浏览器本地库：IndexedDB（Dexie）
 * v1 建 points / inspections
 * v2 加 routes 表与 pointId 索引
 * v3 加 rectifies 表，并为历史不合格核验补建整改条目
 * v4 加 trips 表，为 routes 补开放时段、检修和高峰容量等动态字段
 */
class AccessMapDb extends Dexie {
  points!: Table<AccessPoint, string>;
  inspections!: Table<Inspection, string>;
  routes!: Table<RouteSegment, string>;
  rectifies!: Table<RectifyPlan, string>;
  trips!: Table<AccessibleTrip, string>;

  constructor() {
    super(DB_NAME);
    this.version(1).stores({
      points: 'id, code, facilityType, district, name',
      inspections: 'id, pointId, date, conclusion',
    });
    this.version(2)
      .stores({
        points: 'id, code, facilityType, district, name',
        inspections: 'id, pointId, date, conclusion',
        routes: 'id, routeName, fromPointId, toPointId, order',
      })
      .upgrade(async (tx) => {
        // v2：把 plan 阶段遗留的 routeName 缺失记录补上默认名称
        const table = tx.table('routes');
        const rows: RouteSegment[] = await table.toArray();
        for (const row of rows) {
          if (!row.routeName) {
            await table.update(row.id, { routeName: '未命名路线' });
          }
        }
      });
    this.version(3)
      .stores({
        points: 'id, code, facilityType, district, name',
        inspections: 'id, pointId, date, conclusion',
        routes: 'id, routeName, fromPointId, toPointId, order',
        rectifies: 'id, pointId, status, deadline',
      })
      .upgrade(async (tx) => {
        // v3：为历史「不合格」核验补建整改条目（已存在同点位待整改条目则跳过）
        const inspections: Inspection[] = await tx.table('inspections').toArray();
        const existed: RectifyPlan[] = await tx.table('rectifies').toArray();
        const pendingPointIds = new Set(
          existed.filter((r) => r.status !== '已整改').map((r) => r.pointId),
        );
        for (const insp of inspections) {
          if (insp.conclusion !== '不合格') continue;
          if (pendingPointIds.has(insp.pointId)) continue;
          pendingPointIds.add(insp.pointId);
          await tx.table('rectifies').add({
            id: `rct-mig-${insp.id}`,
            pointId: insp.pointId,
            requirement: `按核验结论整改：${insp.problem || '整改坡度、净宽与占用问题'}`,
            unit: '待指派责任单位',
            deadline: addDays(insp.date || todayStr(), 30),
            recheckDate: '',
            status: '待整改',
            createdAt: new Date().toISOString(),
          });
        }
      });
    this.version(4)
      .stores({
        points: 'id, code, facilityType, district, name',
        inspections: 'id, pointId, date, conclusion',
        routes: 'id, routeName, fromPointId, toPointId, order',
        rectifies: 'id, pointId, status, deadline',
        trips: 'id, originPointId, destinationPointId, status, createdAt',
      })
      .upgrade(async (tx) => {
        const routes: RouteSegment[] = await tx.table('routes').toArray();
        const now = new Date().toISOString();
        for (const route of routes) {
          await tx.table('routes').put(applyDynamicRouteDefaults(route, now));
        }
        const tripDemoRoutes = buildTripDemoRoutes(now).filter(
          (demo) => !routes.some((route) => route.id === demo.id),
        );
        if (tripDemoRoutes.length && (await tx.table('points').count()) > 0) {
          const points: AccessPoint[] = await tx.table('points').toArray();
          const demoPoints = buildTripDemoPoints(now).filter((p) => !points.some((x) => x.id === p.id));
          await tx.table('points').bulkPut(demoPoints);
          await tx.table('routes').bulkPut(tripDemoRoutes);
        }
      });
  }
}

export const db = new AccessMapDb();

const SEED_POINTS: Omit<AccessPoint, 'createdAt' | 'updatedAt'>[] = [
  {
    id: 'pt-1001',
    code: 'WZ-2024-001',
    name: '东单北大街缘石坡道',
    facilityType: '缘石坡道',
    lng: 116.4183,
    lat: 39.9142,
    district: '东城区',
    location: '东单北大街与灯市口大街交叉口东南角',
    builtYear: 2016,
    maintainUnit: '市政道路养护一所',
  },
  {
    id: 'pt-1002',
    code: 'WZ-2024-002',
    name: '王府井步行街盲道',
    facilityType: '盲道',
    lng: 116.4109,
    lat: 39.915,
    district: '东城区',
    location: '王府井大街南段 118 号门前',
    builtYear: 2018,
    maintainUnit: '市政道路养护二所',
  },
  {
    id: 'pt-1003',
    code: 'WZ-2024-003',
    name: '西直门站无障碍电梯',
    facilityType: '无障碍电梯',
    lng: 116.3555,
    lat: 39.9405,
    district: '西城区',
    location: '地铁西直门站 A 口地面层',
    builtYear: 2019,
    maintainUnit: '轨道交通运营部',
  },
  {
    id: 'pt-1004',
    code: 'WZ-2024-004',
    name: '朝阳公园南门轮椅坡道',
    facilityType: '轮椅坡道',
    lng: 116.4741,
    lat: 39.9339,
    district: '朝阳区',
    location: '朝阳公园南路南门西侧',
    builtYear: 2015,
    maintainUnit: '园林绿化服务中心',
  },
  {
    id: 'pt-1005',
    code: 'WZ-2024-005',
    name: '中关村广场无障碍卫生间',
    facilityType: '无障碍卫生间',
    lng: 116.3106,
    lat: 39.9842,
    district: '海淀区',
    location: '中关村大街 27 号地下二层',
    builtYear: 2020,
    maintainUnit: '城管委设施科',
  },
  {
    id: 'pt-1006',
    code: 'WZ-2024-006',
    name: '丰台科技园低位服务台',
    facilityType: '低位服务台',
    lng: 116.2956,
    lat: 39.856,
    district: '丰台区',
    location: '丰台科技园政务大厅一层',
    builtYear: 2021,
    maintainUnit: '城管委设施科',
  },
  {
    id: 'pt-1007',
    code: 'WZ-2024-007',
    name: '莲花池东路盲道',
    facilityType: '盲道',
    lng: 116.32,
    lat: 39.8977,
    district: '丰台区',
    location: '莲花池东路北侧辅路人行道',
    builtYear: 2014,
    maintainUnit: '市政道路养护一所',
  },
  {
    id: 'pt-1008',
    code: 'WZ-2024-008',
    name: '鲁谷路无障碍电梯',
    facilityType: '无障碍电梯',
    lng: 116.2213,
    lat: 39.9065,
    district: '石景山区',
    location: '鲁谷路 35 号院 3 号楼东侧',
    builtYear: 2013,
    maintainUnit: '轨道交通运营部',
  },
  {
    id: 'pt-1009',
    code: 'WZ-2024-009',
    name: '动物园枢纽无障碍电梯',
    facilityType: '无障碍电梯',
    lng: 116.3408,
    lat: 39.9428,
    district: '西城区',
    location: '动物园交通枢纽 B 口换乘厅',
    builtYear: 2022,
    maintainUnit: '轨道交通运营部',
  },
  {
    id: 'pt-1010',
    code: 'WZ-2024-010',
    name: '车公庄西轮椅坡道',
    facilityType: '轮椅坡道',
    lng: 116.3478,
    lat: 39.9388,
    district: '西城区',
    location: '车公庄西大街南侧无障碍接驳口',
    builtYear: 2021,
    maintainUnit: '市政道路养护二所',
  },
];

interface SeedInspection {
  pointId: string;
  date: string;
  inspector: string;
  slope: number;
  clearWidth: number;
  hasHandrail: boolean;
  tactileContinuous: boolean;
  occupied: Inspection['occupied'];
  problem: string;
}

const SEED_INSPECTIONS: SeedInspection[] = [
  {
    pointId: 'pt-1001',
    date: '2025-03-12',
    inspector: '督导员 李维',
    slope: 3.2,
    clearWidth: 150,
    hasHandrail: true,
    tactileContinuous: true,
    occupied: '无',
    problem: '',
  },
  {
    pointId: 'pt-1002',
    date: '2025-03-14',
    inspector: '督导员 王岚',
    slope: 2.1,
    clearWidth: 130,
    hasHandrail: false,
    tactileContinuous: false,
    occupied: '无',
    problem: '盲道在路口处断开约 4 米，未设置提示盲道',
  },
  {
    pointId: 'pt-1003',
    date: '2025-04-02',
    inspector: '督导员 陈默',
    slope: 1.4,
    clearWidth: 160,
    hasHandrail: true,
    tactileContinuous: true,
    occupied: '无',
    problem: '',
  },
  {
    pointId: 'pt-1004',
    date: '2025-04-08',
    inspector: '督导员 李维',
    slope: 6.4,
    clearWidth: 105,
    hasHandrail: true,
    tactileContinuous: true,
    occupied: '临时占用',
    problem: '坡道中段被共享单车临时占用，实际净宽不足',
  },
  {
    pointId: 'pt-1005',
    date: '2025-04-19',
    inspector: '督导员 赵敏',
    slope: 1.1,
    clearWidth: 155,
    hasHandrail: true,
    tactileContinuous: true,
    occupied: '无',
    problem: '',
  },
  {
    pointId: 'pt-1006',
    date: '2025-05-06',
    inspector: '督导员 赵敏',
    slope: 2.6,
    clearWidth: 140,
    hasHandrail: true,
    tactileContinuous: true,
    occupied: '无',
    problem: '',
  },
  {
    pointId: 'pt-1007',
    date: '2025-05-11',
    inspector: '督导员 王岚',
    slope: 9.5,
    clearWidth: 82,
    hasHandrail: false,
    tactileContinuous: false,
    occupied: '长期占用',
    problem: '盲道被沿街商铺货架长期占用，坡度过大且净宽不足 90cm',
  },
  {
    pointId: 'pt-1008',
    date: '2025-05-20',
    inspector: '督导员 陈默',
    slope: 1.8,
    clearWidth: 145,
    hasHandrail: true,
    tactileContinuous: true,
    occupied: '无',
    problem: '',
  },
];

interface SeedRoute {
  routeName: string;
  pointIds: string[];
  length: number;
  durationMinutes: number;
  transferWaitMinutes: number;
  obstacleCount: number;
  stepCount: number;
  curbHeight: number;
  accessMode: SegmentAccessMode;
  service: ServiceSchedule;
  offPeakCapacity: number;
  peakCapacity: number;
  peakWindows: PeakCapacityWindow[];
  maintenanceWindows: MaintenanceWindow[];
  upgradedAllDay?: boolean;
}

const PEAK_WINDOWS: PeakCapacityWindow[] = [{ start: '07:30', end: '09:30', capacity: 1 }];

const SEED_ROUTES: SeedRoute[] = [
  {
    routeName: '东单—王府井轮椅通道',
    pointIds: ['pt-1001', 'pt-1002'],
    length: 640.5,
    durationMinutes: 9,
    transferWaitMinutes: 2,
    obstacleCount: 1,
    stepCount: 0,
    curbHeight: 2,
    accessMode: 'all_day',
    service: { start: '06:00', end: '23:00', headwayMinutes: 0 },
    offPeakCapacity: 2,
    peakCapacity: 2,
    peakWindows: [],
    maintenanceWindows: [],
  },
  {
    routeName: '西直门—动物园无障碍接驳线',
    pointIds: ['pt-1003', 'pt-1009'],
    length: 1320,
    durationMinutes: 6,
    transferWaitMinutes: 2,
    obstacleCount: 0,
    stepCount: 0,
    curbHeight: 1,
    accessMode: 'scheduled',
    service: { start: '06:00', end: '22:30', headwayMinutes: 20 },
    offPeakCapacity: 2,
    peakCapacity: 1,
    peakWindows: PEAK_WINDOWS,
    maintenanceWindows: [{ start: '09:30', end: '10:00', reason: '无障碍电梯例行检修' }],
  },
  {
    routeName: '动物园—车公庄西地面轮椅通道',
    pointIds: ['pt-1009', 'pt-1010'],
    length: 760,
    durationMinutes: 10,
    transferWaitMinutes: 2,
    obstacleCount: 0,
    stepCount: 0,
    curbHeight: 2,
    accessMode: 'all_day',
    service: { start: '00:00', end: '23:59', headwayMinutes: 0 },
    offPeakCapacity: 3,
    peakCapacity: 2,
    peakWindows: [{ start: '07:30', end: '09:30', capacity: 2 }],
    maintenanceWindows: [],
  },
  {
    routeName: '动物园—车公庄西无障碍电梯快线',
    pointIds: ['pt-1009', 'pt-1010'],
    length: 720,
    durationMinutes: 4,
    transferWaitMinutes: 2,
    obstacleCount: 0,
    stepCount: 0,
    curbHeight: 1,
    accessMode: 'scheduled',
    service: { start: '06:00', end: '22:00', headwayMinutes: 30 },
    offPeakCapacity: 1,
    peakCapacity: 1,
    peakWindows: PEAK_WINDOWS,
    maintenanceWindows: [],
  },
];

const DEFAULT_SERVICE: ServiceSchedule = { start: '06:00', end: '23:00', headwayMinutes: 0 };

/** 旧版本路线升级到 v4 时补默认值；老路线原静态判定保持不变，除非显式标记升级。 */
function applyDynamicRouteDefaults(route: RouteSegment, now: string): RouteSegment {
  return {
    ...route,
    durationMinutes: route.durationMinutes ?? Math.max(1, Math.round((route.length || 100) / 75)),
    transferWaitMinutes: route.transferWaitMinutes ?? 2,
    accessMode: (route.accessMode ?? 'all_day') as SegmentAccessMode,
    service: route.service ?? DEFAULT_SERVICE,
    offPeakCapacity: route.offPeakCapacity ?? 2,
    peakCapacity: route.peakCapacity ?? route.offPeakCapacity ?? 2,
    peakWindows: route.peakWindows ?? [],
    maintenanceWindows: route.maintenanceWindows ?? [],
    temporaryClosures: route.temporaryClosures ?? [],
    dynamicStatus: route.dynamicStatus ?? 'normal',
    upgradedAllDay: route.upgradedAllDay ?? false,
    routeVersion: route.routeVersion ?? 1,
    scheduleVersion: route.scheduleVersion ?? 1,
    createdAt: route.createdAt ?? now,
  };
}

function buildTripDemoPoints(now: string): AccessPoint[] {
  return [
    {
      id: 'pt-1009',
      code: 'WZ-2024-009',
      name: '动物园枢纽无障碍电梯',
      facilityType: '无障碍电梯',
      lng: 116.3408,
      lat: 39.9428,
      district: '西城区',
      location: '动物园交通枢纽 B 口换乘厅',
      builtYear: 2022,
      maintainUnit: '轨道交通运营部',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'pt-1010',
      code: 'WZ-2024-010',
      name: '车公庄西轮椅坡道',
      facilityType: '轮椅坡道',
      lng: 116.3478,
      lat: 39.9388,
      district: '西城区',
      location: '车公庄西大街南侧无障碍接驳口',
      builtYear: 2021,
      maintainUnit: '市政道路养护二所',
      createdAt: now,
      updatedAt: now,
    },
  ];
}

function buildTripDemoRoutes(now: string): RouteSegment[] {
  const defs: Array<Partial<RouteSegment> & Pick<RouteSegment, 'id' | 'routeName' | 'fromPointId' | 'toPointId' | 'length' | 'durationMinutes' | 'accessMode' | 'service' | 'offPeakCapacity' | 'peakCapacity' | 'peakWindows' | 'maintenanceWindows'>> = [
    {
      id: 'rts-seed-demo-1',
      routeName: '西直门—动物园无障碍接驳线',
      fromPointId: 'pt-1003',
      toPointId: 'pt-1009',
      length: 1320,
      durationMinutes: 6,
      accessMode: 'scheduled',
      service: { start: '06:00', end: '22:30', headwayMinutes: 20 },
      offPeakCapacity: 2,
      peakCapacity: 1,
      peakWindows: PEAK_WINDOWS,
      maintenanceWindows: [{ start: '09:30', end: '10:00', reason: '无障碍电梯例行检修' }],
    },
    {
      id: 'rts-seed-demo-2',
      routeName: '动物园—车公庄西地面轮椅通道',
      fromPointId: 'pt-1009',
      toPointId: 'pt-1010',
      length: 760,
      durationMinutes: 10,
      accessMode: 'all_day',
      service: { start: '00:00', end: '23:59', headwayMinutes: 0 },
      offPeakCapacity: 3,
      peakCapacity: 2,
      peakWindows: [{ start: '07:30', end: '09:30', capacity: 2 }],
      maintenanceWindows: [],
    },
    {
      id: 'rts-seed-demo-3',
      routeName: '动物园—车公庄西无障碍电梯快线',
      fromPointId: 'pt-1009',
      toPointId: 'pt-1010',
      length: 720,
      durationMinutes: 4,
      accessMode: 'scheduled',
      service: { start: '06:00', end: '22:00', headwayMinutes: 30 },
      offPeakCapacity: 1,
      peakCapacity: 1,
      peakWindows: PEAK_WINDOWS,
      maintenanceWindows: [],
    },
  ];
  return defs.map((def, index) =>
    applyDynamicRouteDefaults(
      {
        ...def,
        order: index + 1,
        obstacleCount: 0,
        stepCount: 0,
        curbHeight: 1,
        wheelchairPassable: true,
        transferWaitMinutes: 2,
        temporaryClosures: [],
        dynamicStatus: 'normal',
        upgradedAllDay: false,
        routeVersion: 1,
        scheduleVersion: 1,
        createdAt: now,
      } as RouteSegment,
      now,
    ),
  );
}

function buildSeed() {
  const now = new Date().toISOString();
  const today = todayStr();
  const points: AccessPoint[] = SEED_POINTS.map((p) => ({ ...p, createdAt: now, updatedAt: now }));
  const inspections: Inspection[] = SEED_INSPECTIONS.map((s, i) => {
    const judged = judgeInspection({
      slope: s.slope,
      clearWidth: s.clearWidth,
      hasHandrail: s.hasHandrail,
      tactileContinuous: s.tactileContinuous,
      occupied: s.occupied,
    });
    return {
      id: `ins-seed-${i + 1}`,
      pointId: s.pointId,
      date: s.date,
      inspector: s.inspector,
      slope: s.slope,
      clearWidth: s.clearWidth,
      hasHandrail: s.hasHandrail,
      tactileContinuous: s.tactileContinuous,
      occupied: s.occupied,
      conclusion: judged.conclusion,
      problem: s.problem,
      createdAt: now,
    };
  });
  const routes: RouteSegment[] = [];
  SEED_ROUTES.forEach((r) => {
    for (let i = 1; i < r.pointIds.length; i += 1) {
      routes.push({
        id: `rts-seed-${routes.length + 1}`,
        routeName: r.routeName,
        fromPointId: r.pointIds[i - 1],
        toPointId: r.pointIds[i],
        length: Math.round((r.length / (r.pointIds.length - 1)) * 10) / 10,
        durationMinutes: r.durationMinutes,
        transferWaitMinutes: r.transferWaitMinutes,
        obstacleCount: r.obstacleCount,
        stepCount: r.stepCount,
        curbHeight: r.curbHeight,
        wheelchairPassable: r.stepCount === 0 && r.curbHeight <= 3 && r.obstacleCount <= 2,
        order: i,
        accessMode: r.accessMode,
        service: r.service,
        offPeakCapacity: r.offPeakCapacity,
        peakCapacity: r.peakCapacity,
        peakWindows: r.peakWindows,
        maintenanceWindows: r.maintenanceWindows,
        temporaryClosures: [],
        dynamicStatus: 'normal',
        upgradedAllDay: Boolean(r.upgradedAllDay),
        routeVersion: 1,
        scheduleVersion: 1,
        createdAt: now,
      });
    }
  });
  const rectifies: RectifyPlan[] = [
    {
      id: 'rct-seed-1',
      pointId: 'pt-1007',
      requirement: '清退盲道上的商铺货架，重做坡道并加装扶手，复测净宽不低于 120cm',
      unit: '市政道路养护一所',
      deadline: addDays(today, -21),
      recheckDate: '',
      status: '待整改',
      createdAt: now,
    },
    {
      id: 'rct-seed-2',
      pointId: 'pt-1002',
      requirement: '补齐路口断开的盲道并增设提示盲道',
      unit: '市政道路养护二所',
      deadline: addDays(today, -6),
      recheckDate: '',
      status: '待整改',
      createdAt: now,
    },
    {
      id: 'rct-seed-3',
      pointId: 'pt-1004',
      requirement: '划设共享单车禁停区，恢复坡道净宽至 120cm 以上',
      unit: '园林绿化服务中心',
      deadline: addDays(today, 18),
      recheckDate: '',
      status: '待整改',
      createdAt: now,
    },
    {
      id: 'rct-seed-4',
      pointId: 'pt-1008',
      requirement: '更换电梯轿厢呼叫按钮盲文标识',
      unit: '轨道交通运营部',
      deadline: addDays(today, -40),
      recheckDate: addDays(today, -12),
      status: '已整改',
      createdAt: now,
    },
  ];
  return { points, inspections, routes, rectifies };
}

/** 首次打开时写入示例数据；已有数据则跳过 */
export async function ensureSeed(): Promise<void> {
  const count = await db.points.count();
  if (count > 0) return;
  const seed = toPlain(buildSeed());
  await db.transaction('rw', db.points, db.inspections, db.routes, db.rectifies, db.trips, async () => {
    await db.points.bulkPut(seed.points);
    await db.inspections.bulkPut(seed.inspections);
    await db.routes.bulkPut(seed.routes);
    await db.rectifies.bulkPut(seed.rectifies);
  });
}

export { makeId };
