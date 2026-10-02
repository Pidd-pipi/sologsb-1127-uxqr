/** 无障碍电梯运行状态 */
export type ElevatorStatus = '正常' | '临时停用';

/** 电梯每日开放时段（分钟），allDay=true 时全天开放 */
export interface OpenWindow {
  /** 星期几 0=周日 … 6=周六；空数组表示每天 */
  weekdays: number[];
  /** 起始分钟 0-1439 */
  startMin: number;
  /** 结束分钟 0-1439；小于 startMin 表示跨到次日 */
  endMin: number;
}

/** 检修窗口 */
export interface MaintenanceWindow {
  id: string;
  /** once=一次性（按日期）；weekly=周期性（按星期） */
  kind: 'once' | 'weekly';
  /** kind=once：YYYY-MM-DD */
  date?: string;
  /** kind=weekly：星期几 0-6 */
  weekday?: number;
  startMin: number;
  endMin: number;
  reason: string;
}

/** 高峰容量窗口：高峰时段每班次轮椅容量折减 */
export interface PeakWindow {
  /** 起始分钟 */
  startMin: number;
  /** 结束分钟（默认不跨天） */
  endMin: number;
  /** 高峰时段每班次可承载轮椅数（0 表示高峰时段轮椅不可乘） */
  peakCapacity: number;
  label: string;
}

/** 电梯班次：固定间隔或固定时刻 */
export interface ElevatorSchedule {
  kind: 'interval' | 'fixed';
  /** kind=interval：发车间隔（分钟） */
  intervalMin?: number;
  /** kind=fixed：每日发车时刻（分钟）列表 */
  fixedMinutes?: number[];
  /** 平峰每班次可承载轮椅数 */
  capacityPerTrip: number;
  /** 电梯乘坐（运行）时长（分钟） */
  rideMin: number;
  /** 高峰容量窗口 */
  peakWindows: PeakWindow[];
}

/** 无障碍电梯运行档案 */
export interface ElevatorService {
  id: string;
  /** 所属无障碍电梯点位 id */
  pointId: string;
  /** 是否全天可用（旧路线升级后按全天可用处理） */
  allDay: boolean;
  status: ElevatorStatus;
  /** 临时停用原因 */
  suspendedReason: string;
  /** 临时停用预计恢复时间（ISO），空字符串表示恢复时间待定 */
  resumeAt: string;
  openWindows: OpenWindow[];
  maintenance: MaintenanceWindow[];
  schedule: ElevatorSchedule;
  updatedAt: string;
}

export type ElevatorServiceDraft = Omit<ElevatorService, 'id' | 'updatedAt'>;

/** 分钟数 → HH:MM */
export function minToHM(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** HH:MM → 分钟数 */
export function hmToMin(hm: string): number {
  const [h, m] = hm.split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}
