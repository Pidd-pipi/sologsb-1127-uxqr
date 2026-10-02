/** 行程状态：可行 / 已拒绝（规划时即不可行）/ 已失效（保存后因设施变化失效） */
export type ItineraryStatus = '可行' | '已拒绝' | '已失效';

export type ItineraryLegMode = 'walk' | 'elevator';

/** 行程段：步行段或电梯乘降段 */
export interface ItineraryLeg {
  key: string;
  mode: ItineraryLegMode;
  fromPointId: string;
  toPointId: string;
  /** 段序，从 1 开始 */
  order: number;
  /** 段出发（ISO） */
  departAt: string;
  /** 段到达（ISO） */
  arriveAt: string;
  /** 步行时长（分钟） */
  walkMin: number;
  /** 换乘等待（分钟） */
  waitMin: number;
  /** 电梯乘坐时长（分钟） */
  rideMin: number;
  /** 电梯班次时刻（ISO），仅电梯段 */
  tripAt?: string;
  /** 电梯段：服务的电梯点位 id */
  elevatorPointId?: string;
  /** 该段是否可通行 */
  passable: boolean;
  /** 不可通行原因 */
  reason: string;
}

/** 可达行程 */
export interface Itinerary {
  id: string;
  /** 行程版本号（同一起讫的第 N 次保存） */
  version: number;
  originPointId: string;
  destinationPointId: string;
  /** 计划出发时间（ISO） */
  departureAt: string;
  status: ItineraryStatus;
  /** 全程是否可行 */
  feasible: boolean;
  totalWalkMin: number;
  totalWaitMin: number;
  totalRideMin: number;
  totalMin: number;
  legs: ItineraryLeg[];
  /** 拒绝原因（规划时即不可行） */
  reason: string;
  /** 下一可行出发时间（ISO） */
  nextFeasibleAt?: string;
  /** 失效原因（保存后因设施变化失效） */
  invalidReason?: string;
  /** 保存时依据的服务快照（JSON 字符串） */
  snapshot: string;
  createdAt: string;
  updatedAt: string;
}

export type ItineraryDraft = Omit<Itinerary, 'id' | 'createdAt' | 'updatedAt'>;
