/** 日内时间窗，时间格式 HH:mm */
export interface TimeWindow {
  start: string;
  end: string;
}

/** 高峰容量窗 */
export interface PeakCapacityWindow extends TimeWindow {
  capacity: number;
}

/** 重复性检修窗口 */
export interface MaintenanceWindow extends TimeWindow {
  reason?: string;
}

/** 临时停用的绝对时间区间，时间为本地 ISO 字符串 */
export interface TemporaryClosure {
  startAt: string;
  endAt: string;
  reason: string;
}

/** 班次安排；全天可用边也保留该结构作为兜底 */
export interface ServiceSchedule {
  /** 首班/开放开始时间 */
  start: string;
  /** 末班必须完成的时间 */
  end: string;
  /** 发车间隔（分钟） */
  headwayMinutes: number;
}

export type DynamicStatus = 'normal' | 'maintenance' | 'temporary_closed';
export type SegmentAccessMode = 'all_day' | 'scheduled';

/** 通行路线段（图中的一条有向边） */
export interface RouteSegment {
  id: string;
  /** 路线/服务名称，同一条服务的多段共用一个名称 */
  routeName: string;
  fromPointId: string;
  toPointId: string;
  /** 长度 m */
  length: number;
  /** 沿途障碍数 */
  obstacleCount: number;
  /** 台阶数 */
  stepCount: number;
  /** 路缘高差 cm */
  curbHeight: number;
  /** 静态核验是否可轮椅通行 */
  wheelchairPassable: boolean;
  /** 在整条路线中的顺序，从 1 开始 */
  order: number;
  createdAt: string;

  /** 通行该边的计划用时（分钟） */
  durationMinutes: number;
  /** 到达下一站后的固定换乘等待（分钟），首段不计 */
  transferWaitMinutes: number;
  /** 全天可用或按班次开放 */
  accessMode: SegmentAccessMode;
  service: ServiceSchedule;
  /** 平峰轮椅容量；按班次时为每班车，全天时为 15 分钟时隙 */
  offPeakCapacity: number;
  /** 高峰轮椅容量 */
  peakCapacity: number;
  /** 高峰时间窗 */
  peakWindows: PeakCapacityWindow[];
  /** 重复性检修窗口 */
  maintenanceWindows: MaintenanceWindow[];
  /** 临时停用区间 */
  temporaryClosures: TemporaryClosure[];
  /** 运行状态：正常、按检修窗口停用、临时停用 */
  dynamicStatus: DynamicStatus;
  /** 旧路线完成无障碍升级后，全天按可用处理，不受旧静态判定限制 */
  upgradedAllDay: boolean;
  /** 静态结构版本：线路、起终点、升级状态等变化时递增 */
  routeVersion: number;
  /** 运行版本：检修、班次、容量等变化时递增 */
  scheduleVersion: number;
}

export type RouteSegmentDraft = Omit<
  RouteSegment,
  | 'id'
  | 'createdAt'
  | 'wheelchairPassable'
  | 'accessMode'
  | 'service'
  | 'offPeakCapacity'
  | 'peakCapacity'
  | 'peakWindows'
  | 'maintenanceWindows'
  | 'temporaryClosures'
  | 'dynamicStatus'
  | 'upgradedAllDay'
  | 'routeVersion'
  | 'scheduleVersion'
>;

/** 全线判定结果 */
export interface RouteVerdict {
  routeName: string;
  passable: boolean;
  totalLength: number;
  totalObstacles: number;
  totalSteps: number;
  maxCurbHeight: number;
  reasons: string[];
}

/** 已保存行程中的一个计划 leg */
export interface TripLeg {
  segmentId: string;
  routeName: string;
  fromPointId: string;
  toPointId: string;
  accessMode: SegmentAccessMode;
  /** 从站点出发的时间 */
  departureAt: string;
  arrivalAt: string;
  travelMinutes: number;
  /** 固定换乘等待 */
  transferWaitMinutes: number;
  /** 等班车/等开放的时间 */
  serviceWaitMinutes: number;
  departureCapacity: number;
  peak: boolean;
}

export type SavedTripStatus = 'active' | 'invalid';

/** 保存时的不可变行程版本 */
export interface AccessibleTrip {
  id: string;
  originPointId: string;
  destinationPointId: string;
  /** 用户请求的出发时间 */
  requestedDepartureAt: string;
  /** 系统给出的实际可行出发时间 */
  plannedDepartureAt: string;
  plannedArrivalAt: string;
  totalTravelMinutes: number;
  totalWaitMinutes: number;
  transferCount: number;
  status: SavedTripStatus;
  /** 失效后保留原版本，仅记录原因；重算结果另存为新版本 */
  invalidReason: string;
  invalidCheckedAt: string;
  /** 保存时刻的边版本快照 */
  segmentSnapshot: RouteSegment[];
  legs: TripLeg[];
  createdAt: string;
}

export interface PlannedTripCandidate {
  originPointId: string;
  destinationPointId: string;
  requestedDepartureAt: string;
  plannedDepartureAt: string;
  plannedArrivalAt: string;
  totalTravelMinutes: number;
  totalWaitMinutes: number;
  transferCount: number;
  legs: TripLeg[];
  /** 为 true 表示原请求时间不可行，以下一可行时间生成 */
  rejectedRequestedTime: boolean;
  rejectionReasons: string[];
}
