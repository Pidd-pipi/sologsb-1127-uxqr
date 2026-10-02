import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Radio,
  Row,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  ClockCircleOutlined,
  ReloadOutlined,
  SaveOutlined,
  SettingOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import EmptyState from '../components/common/EmptyState';
import StatusBadge from '../components/common/StatusBadge';
import { usePointStore } from '../stores/pointStore';
import { useRouteStore } from '../stores/routeStore';
import { useTripStore } from '../stores/tripStore';
import type {
  AccessibleTrip,
  DynamicStatus,
  MaintenanceWindow,
  PeakCapacityWindow,
  PlannedTripCandidate,
  RouteSegment,
  SegmentAccessMode,
  TemporaryClosure,
  TripLeg,
} from '../types/route';
import { isStructurallyWheelchairPassable, localDateTimeString } from '../utils/tripPlanner';

interface EdgeFormValues {
  accessMode: SegmentAccessMode;
  start: string;
  end: string;
  headwayMinutes: number;
  offPeakCapacity: number;
  peakCapacity: number;
  peakText: string;
  maintenanceText: string;
  closureText: string;
  dynamicStatus: DynamicStatus;
  closureReason: string;
  upgradedAllDay: boolean;
}

function nowPlusMinutes(minutes: number): dayjs.Dayjs {
  return dayjs().add(minutes, 'minute').second(0).millisecond(0);
}

function parseWindowLines(text: string, withCapacity: boolean): PeakCapacityWindow[] | MaintenanceWindow[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [time = '', capacityOrReason = ''] = line.split('|').map((x) => x.trim());
      const [start = '', end = ''] = time.split('-');
      if (withCapacity) {
        return { start, end, capacity: Number(capacityOrReason) || 1 };
      }
      return { start, end, reason: capacityOrReason || '无障碍设施检修' };
    })
    .filter((w) => w.start && w.end);
}

function windowsToText(windows: Array<PeakCapacityWindow | MaintenanceWindow>, withCapacity: boolean): string {
  return windows
    .map((w) =>
      withCapacity && 'capacity' in w
        ? `${w.start}-${w.end}|${w.capacity}`
        : `${w.start}-${w.end}|${('reason' in w ? w.reason : '') || ''}`,
    )
    .join('\n');
}

function legName(leg: TripLeg, names: Map<string, string>): string {
  return `${names.get(leg.fromPointId) ?? leg.fromPointId} → ${names.get(leg.toPointId) ?? leg.toPointId}`;
}

export default function TripPlanner() {
  const points = usePointStore((s) => s.points);
  const { segments, updateSegmentSchedule } = useRouteStore();
  const { trips, candidate, plan, saveCandidate, revalidate, clearCandidate } = useTripStore();

  const [originId, setOriginId] = useState<string>();
  const [destinationId, setDestinationId] = useState<string>();
  const [departure, setDeparture] = useState<dayjs.Dayjs>(nowPlusMinutes(30));
  const [planning, setPlanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<RouteSegment | null>(null);
  const [form] = Form.useForm<EdgeFormValues>();

  const pointOptions = useMemo(
    () => points.map((p) => ({ value: p.id, label: `${p.code} ${p.name}` })),
    [points],
  );
  const names = useMemo(() => new Map(points.map((p) => [p.id, p.name])), [points]);

  const requestKey = useMemo(
    () => `${originId ?? ''}|${destinationId ?? ''}|${departure.format('YYYY-MM-DD HH:mm')}`,
    [originId, destinationId, departure],
  );
  const segmentKey = useMemo(
    () => segments.map((s) => `${s.id}:${s.scheduleVersion}:${s.routeVersion}`).join(';'),
    [segments],
  );
  const tripKey = useMemo(
    () => trips.map((t) => `${t.id}:${t.status}`).join(';'),
    [trips],
  );

  useEffect(() => {
    void revalidate(segments);
  }, [segmentKey, revalidate, segments]);

  useEffect(() => {
    if (!originId || !destinationId || originId === destinationId) {
      clearCandidate();
      return;
    }
    setPlanning(true);
    const timer = window.setTimeout(() => {
      plan(segments, originId, destinationId, departure.format('YYYY-MM-DD HH:mm'));
      setPlanning(false);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [requestKey, segmentKey, tripKey, originId, destinationId, departure, segments, trips, plan, clearCandidate, revalidate]);

  const handleSave = async () => {
    if (!candidate) return;
    setSaving(true);
    try {
      await saveCandidate(segments);
    } catch (e) {
      Modal.error({
        title: '该行程已不能保存',
        content: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSaving(false);
    }
  };

  const openEditor = (segment: RouteSegment) => {
    setEditing(segment);
    form.setFieldsValue({
      accessMode: segment.accessMode,
      start: segment.service.start,
      end: segment.service.end,
      headwayMinutes: segment.service.headwayMinutes,
      offPeakCapacity: segment.offPeakCapacity,
      peakCapacity: segment.peakCapacity,
      peakText: windowsToText(segment.peakWindows, true),
      maintenanceText: windowsToText(segment.maintenanceWindows, false),
      closureText: '',
      dynamicStatus: segment.dynamicStatus,
      closureReason: segment.temporaryClosures[0]?.reason ?? '',
      upgradedAllDay: segment.upgradedAllDay,
    });
  };

  const handleEditorSubmit = async () => {
    if (!editing) return;
    const values = await form.validateFields();
    const timeOk = (hm: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(hm);
    if (!timeOk(values.start) || !timeOk(values.end) || values.start >= values.end) {
      Modal.error({ title: '开放时间无效', content: '请填写 HH:mm，且开始时间早于截止时间。' });
      return;
    }
    if (values.accessMode === 'scheduled' && values.headwayMinutes < 1) {
      Modal.error({ title: '发车间隔无效', content: '按班次开放时间隔至少为 1 分钟。' });
      return;
    }
    const peakWindows = parseWindowLines(values.peakText, true) as PeakCapacityWindow[];
    const maintenanceWindows = parseWindowLines(values.maintenanceText, false) as MaintenanceWindow[];
    const windowLinesValid = [...peakWindows, ...maintenanceWindows].every((w) => timeOk(w.start) && timeOk(w.end) && w.start < w.end);
    if (!windowLinesValid) {
      Modal.error({ title: '时间窗无效', content: '每行格式为 HH:mm-HH:mm|容量或原因，且开始时间需早于结束时间。' });
      return;
    }
    const temporaryClosures = values.closureText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [time = '', reason = '临时停用'] = line.split('|').map((x) => x.trim());
        const [start = '', end = ''] = time.split('~');
        return { startAt: dayjs(start).toISOString(), endAt: dayjs(end).toISOString(), reason };
      })
      .filter((c) => Number.isFinite(new Date(c.startAt).getTime()) && Number.isFinite(new Date(c.endAt).getTime()));

    const effectiveClosures =
      values.dynamicStatus === 'temporary_closed'
        ? [
            {
              startAt: new Date().toISOString(),
              endAt: dayjs().add(1, 'day').toISOString(),
              reason: values.closureReason || '临时停用',
            } satisfies TemporaryClosure,
          ]
        : temporaryClosures;

    await updateSegmentSchedule(editing.id, {
      accessMode: values.accessMode,
      service: {
        start: values.start,
        end: values.end,
        headwayMinutes: values.accessMode === 'scheduled' ? values.headwayMinutes : 0,
      },
      offPeakCapacity: values.offPeakCapacity,
      peakCapacity: values.peakCapacity,
      peakWindows,
      maintenanceWindows,
      temporaryClosures: effectiveClosures,
      dynamicStatus: values.dynamicStatus,
      upgradedAllDay: values.upgradedAllDay,
    });
    setEditing(null);
  };

  const segmentColumns: ColumnsType<RouteSegment> = [
    { title: '服务/路线', dataIndex: 'routeName' },
    { title: '起点', render: (_, r) => names.get(r.fromPointId) ?? r.fromPointId },
    { title: '终点', render: (_, r) => names.get(r.toPointId) ?? r.toPointId },
    {
      title: '开放/班次',
      render: (_, r) =>
        r.accessMode === 'all_day' ? (
          <Tag color="green">全天 {r.service.start}-{r.service.end}</Tag>
        ) : (
          <Tag color="blue">{r.service.start}-{r.service.end} / {r.service.headwayMinutes} 分钟</Tag>
        ),
    },
    {
      title: '容量',
      render: (_, r) => (
        <Space size={4} wrap>
          <Tag>平峰 {r.offPeakCapacity}</Tag>
          <Tag color="orange">高峰 {r.peakCapacity}</Tag>
        </Space>
      ),
    },
    {
      title: '检修/停用',
      render: (_, r) => (
        <Space size={4} wrap>
          {r.maintenanceWindows.map((w) => (
            <Tag key={`${w.start}-${w.end}`} color="gold">
              检修 {w.start}-{w.end}
            </Tag>
          ))}
          {r.temporaryClosures.map((c) => (
            <Tag key={c.startAt} color="red">
              临时停用
            </Tag>
          ))}
          {!r.maintenanceWindows.length && !r.temporaryClosures.length && <Typography.Text type="secondary">正常</Typography.Text>}
        </Space>
      ),
    },
    {
      title: '状态',
      render: (_, r) => (
        <Space>
          <StatusBadge value={isStructurallyWheelchairPassable(r) ? '可通行' : '不可通行'} kind="route" />
          {r.upgradedAllDay && <Tag color="green">旧线已升级</Tag>}
          {r.dynamicStatus === 'maintenance' && <Tag color="gold">检修</Tag>}
          {r.dynamicStatus === 'temporary_closed' && <Tag color="red">停用</Tag>}
        </Space>
      ),
    },
    {
      title: '版本',
      render: (_, r) => (
        <Typography.Text type="secondary">
          R{r.routeVersion}/S{r.scheduleVersion}
        </Typography.Text>
      ),
      width: 90,
    },
    {
      title: '操作',
      width: 90,
      render: (_, r) => (
        <Button size="small" icon={<SettingOutlined />} onClick={() => openEditor(r)}>
          调整
        </Button>
      ),
    },
  ];

  const tripColumns: ColumnsType<AccessibleTrip> = [
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (_, row) => <StatusBadge value={row.status === 'active' ? '可通行' : '不可通行'} kind="route" />,
    },
    {
      title: '行程',
      render: (_, row) => (
        <Space direction="vertical" size={2}>
          <Typography.Text strong>
            {names.get(row.originPointId) ?? row.originPointId} → {names.get(row.destinationPointId) ?? row.destinationPointId}
          </Typography.Text>
          <Typography.Text type="secondary">
            请求 {row.requestedDepartureAt}；实际 {row.plannedDepartureAt} 出发
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '到达 / 用时',
      render: (_, row) => (
        <Space direction="vertical" size={2}>
          <Typography.Text>{row.plannedArrivalAt}</Typography.Text>
          <Typography.Text type="secondary">{row.totalTravelMinutes} 分钟，等待 {row.totalWaitMinutes} 分钟</Typography.Text>
        </Space>
      ),
    },
    {
      title: '失效原因',
      render: (_, row) =>
        row.status === 'invalid' ? (
          <Typography.Text type="danger">{row.invalidReason}</Typography.Text>
        ) : (
          <Typography.Text type="secondary">保存版本仍有效；原 legs 与边快照不可变</Typography.Text>
        ),
    },
  ];

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h1 className="gb-page-title">轮椅出行可达行程</h1>
          <Typography.Text type="secondary">
            按出发时间计算开放时段、检修窗口、高峰容量和换乘等待；容量不足会拒绝原请求并给下一可行时间。
          </Typography.Text>
        </div>
      </div>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={15}>
          <Card title="按出发时间规划" size="small">
            <Row gutter={12}>
              <Col xs={24} md={8}>
                <Form.Item label="起点" style={{ marginBottom: 12 }}>
                  <Select
                    showSearch
                    optionFilterProp="label"
                    value={originId}
                    onChange={setOriginId}
                    options={pointOptions}
                    placeholder="选择起点站点"
                  />
                </Form.Item>
              </Col>
              <Col xs={24} md={8}>
                <Form.Item label="终点" style={{ marginBottom: 12 }}>
                  <Select
                    showSearch
                    optionFilterProp="label"
                    value={destinationId}
                    onChange={setDestinationId}
                    options={pointOptions}
                    placeholder="选择终点站点"
                  />
                </Form.Item>
              </Col>
              <Col xs={24} md={8}>
                <Form.Item label="请求出发时间" style={{ marginBottom: 12 }}>
                  <DatePicker
                    showNow
                    showTime={{ format: 'HH:mm', minuteStep: 5 }}
                    format="YYYY-MM-DD HH:mm"
                    value={departure}
                    onChange={(v) => v && setDeparture(v)}
                    style={{ width: '100%' }}
                  />
                </Form.Item>
              </Col>
            </Row>

            <Space wrap>
              <Button
                type="primary"
                icon={<ThunderboltOutlined />}
                loading={planning}
                onClick={() => candidate && plan(segments, originId!, destinationId!, departure.format('YYYY-MM-DD HH:mm'))}
                disabled={!originId || !destinationId || originId === destinationId}
              >
                立即重算候选
              </Button>
              <Button icon={<ReloadOutlined />} onClick={() => setDeparture(nowPlusMinutes(30))}>
                使用 30 分钟后
              </Button>
            </Space>

            <CandidateResult
              candidate={candidate}
              names={names}
              saving={saving}
              onSave={handleSave}
            />
          </Card>
        </Col>

        <Col xs={24} xl={9}>
          <Card title="运行规则" size="small">
            <Descriptions column={1} size="small">
              <Descriptions.Item label="开放约束">电梯需在末班前完成整段通行。</Descriptions.Item>
              <Descriptions.Item label="容量口径">班车按班次计；全天路线按 15 分钟时隙计。</Descriptions.Item>
              <Descriptions.Item label="换乘等待">每段固定等待与等班车等待分别累计。</Descriptions.Item>
              <Descriptions.Item label="即时重算">停用、班次、容量、升级状态变化后自动重算。</Descriptions.Item>
              <Descriptions.Item label="版本保留">保存行程保留原 legs 和边快照，失效只记录原因，不覆盖旧路线。</Descriptions.Item>
            </Descriptions>
            <Alert
              style={{ marginTop: 12 }}
              type="info"
              showIcon
              message="可试：西直门站无障碍电梯 → 车公庄西轮椅坡道，选择 09:35 或 08:00 查看检修、高峰容量与下一可行时间。"
            />
          </Card>
        </Col>
      </Row>

      <Card title="已保存行程版本" size="small" style={{ marginTop: 16 }}>
        {trips.length ? (
          <Table<AccessibleTrip>
            rowKey="id"
            size="small"
            pagination={{ pageSize: 5, hideOnSinglePage: true }}
            dataSource={trips}
            columns={tripColumns}
            expandable={{
              expandedRowRender: (trip) => (
                <Space direction="vertical" style={{ width: '100%' }}>
                  {trip.status === 'invalid' && <Alert type="error" showIcon message={trip.invalidReason} />}
                  <Timeline
                    items={trip.legs.map((leg, index) => ({
                      color: leg.peak ? 'orange' : 'blue',
                      children: (
                        <Space direction="vertical" size={2}>
                          <Typography.Text strong>
                            第 {index + 1} 段：{leg.routeName}（{legName(leg, names)}）
                          </Typography.Text>
                          <Typography.Text>
                            {leg.departureAt} 出发，{leg.arrivalAt} 到达；通行 {leg.travelMinutes} 分钟
                          </Typography.Text>
                          <Typography.Text type="secondary">
                            等开放/班次 {leg.serviceWaitMinutes} 分钟；换乘等待 {index ? leg.transferWaitMinutes : 0} 分钟；容量 {leg.departureCapacity}
                            {leg.peak ? '（高峰）' : ''}
                          </Typography.Text>
                        </Space>
                      ),
                    }))}
                  />
                </Space>
              ),
            }}
          />
        ) : (
          <EmptyState title="暂无已保存行程" description="生成候选后点击确认保存，系统会保留当时版本" compact />
        )}
      </Card>

      <Card title="运行网络：班次、检修、容量与升级" size="small" style={{ marginTop: 16 }}>
        <Table<RouteSegment>
          rowKey="id"
          size="small"
          pagination={{ pageSize: 6, hideOnSinglePage: true }}
          dataSource={segments}
          columns={segmentColumns}
        />
      </Card>

      <Drawer
        title={editing ? `调整：${editing.routeName}` : '调整路线'}
        open={Boolean(editing)}
        width={520}
        onClose={() => setEditing(null)}
        extra={
          <Space>
            <Button onClick={() => setEditing(null)}>取消</Button>
            <Button type="primary" icon={<SaveOutlined />} onClick={handleEditorSubmit}>
              保存并重算
            </Button>
          </Space>
        }
      >
        {editing && (
          <Form layout="vertical" form={form}>
            <Form.Item label="通行模式" name="accessMode">
              <Radio.Group
                optionType="button"
                buttonStyle="solid"
                options={[
                  { label: '全天可用', value: 'all_day' },
                  { label: '按班次开放', value: 'scheduled' },
                ]}
              />
            </Form.Item>
            <Row gutter={12}>
              <Col span={8}>
                <Form.Item label="开放开始" name="start">
                  <Input placeholder="06:00" />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item label="完成截止" name="end">
                  <Input placeholder="22:30" />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item shouldUpdate noStyle>
                  {({ getFieldValue }) =>
                    getFieldValue('accessMode') === 'scheduled' ? (
                      <Form.Item label="间隔(分)" name="headwayMinutes">
                        <InputNumber min={1} max={180} style={{ width: '100%' }} />
                      </Form.Item>
                    ) : null
                  }
                </Form.Item>
              </Col>
            </Row>
            <Row gutter={12}>
              <Col span={12}>
                <Form.Item label="平峰轮椅容量" name="offPeakCapacity">
                  <InputNumber min={1} max={20} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item label="高峰轮椅容量" name="peakCapacity">
                  <InputNumber min={1} max={20} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
            </Row>
            <Form.Item
              label="高峰窗口（每行：HH:mm-HH:mm|容量）"
              name="peakText"
              tooltip="例如 07:30-09:30|1"
            >
              <Input.TextArea rows={2} placeholder="07:30-09:30|1" />
            </Form.Item>
            <Form.Item
              label="重复检修窗口（每行：HH:mm-HH:mm|原因）"
              name="maintenanceText"
              tooltip="例如 09:30-10:00|电梯例行检修"
            >
              <Input.TextArea rows={2} placeholder="09:30-10:00|电梯例行检修" />
            </Form.Item>
            <Form.Item label="运行状态" name="dynamicStatus">
              <Radio.Group
                options={[
                  { label: '正常', value: 'normal' },
                  { label: '按检修窗口', value: 'maintenance' },
                  { label: '临时停用 24h', value: 'temporary_closed' },
                ]}
              />
            </Form.Item>
            <Form.Item shouldUpdate noStyle>
              {({ getFieldValue }) =>
                getFieldValue('dynamicStatus') === 'temporary_closed' ? (
                  <Form.Item label="临时停用原因" name="closureReason">
                    <Input placeholder="如：电梯故障抢修" />
                  </Form.Item>
                ) : null
              }
            </Form.Item>
            <Form.Item
              label="绝对时间临时停用（每行：YYYY-MM-DD HH:mm~YYYY-MM-DD HH:mm|原因）"
              name="closureText"
            >
              <Input.TextArea rows={2} />
            </Form.Item>
            <Form.Item
              label="旧路线已完成无障碍升级，升级后按全天可用处理"
              name="upgradedAllDay"
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
          </Form>
        )}
      </Drawer>
    </div>
  );
}

function CandidateResult({
  candidate,
  names,
  saving,
  onSave,
}: {
  candidate: PlannedTripCandidate | null;
  names: Map<string, string>;
  saving: boolean;
  onSave: () => void;
}) {
  if (!candidate) {
    return (
      <div style={{ marginTop: 16 }}>
        <EmptyState
          title="暂无可达候选"
          description="请选择不同的起终点，或调整运行网络中的检修/停用状态"
          compact
        />
      </div>
    );
  }

  return (
    <div style={{ marginTop: 16 }} data-testid="trip-candidate">
      {candidate.rejectedRequestedTime ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={`原请求时间不可行，已改到下一可行时间：${candidate.plannedDepartureAt}`}
          description={
            <ul style={{ margin: 0, paddingInlineStart: 18 }}>
              {candidate.rejectionReasons.slice(0, 6).map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          }
        />
      ) : (
        <Alert type="success" showIcon style={{ marginBottom: 12 }} message="原请求时间存在可确认的轮椅行程" />
      )}

      <Row gutter={12}>
        <Col xs={12} md={6}>
          <div className="gb-trip-stat">
            <div className="gb-trip-stat-label">计划出发</div>
            <ClockText value={candidate.plannedDepartureAt} />
          </div>
        </Col>
        <Col xs={12} md={6}>
          <div className="gb-trip-stat">
            <div className="gb-trip-stat-label">计划到达</div>
            <ClockText value={candidate.plannedArrivalAt} />
          </div>
        </Col>
        <Col xs={12} md={6}>
          <Statistic title="门到门用时" value={candidate.totalTravelMinutes} suffix="分钟" />
        </Col>
        <Col xs={12} md={6}>
          <Statistic title="总等待/换乘" value={`${candidate.totalWaitMinutes}/${candidate.transferCount}`} suffix="分钟/次" />
        </Col>
      </Row>

      <Table<TripLeg>
        style={{ marginTop: 12 }}
        rowKey={(leg) => `${leg.segmentId}-${leg.departureAt}`}
        size="small"
        pagination={false}
        dataSource={candidate.legs}
        columns={[
          {
            title: '段',
            render: (_, leg, index) => (
              <Space direction="vertical" size={2}>
                <Typography.Text strong>
                  {index + 1}. {leg.routeName}
                </Typography.Text>
                <Typography.Text type="secondary">{legName(leg, names)}</Typography.Text>
              </Space>
            ),
          },
          {
            title: '时间',
            render: (_, leg, index) => (
              <Space direction="vertical" size={2}>
                <Typography.Text>{leg.departureAt} → {leg.arrivalAt}</Typography.Text>
                <Typography.Text type="secondary">
                  通行 {leg.travelMinutes} 分钟；等车/等开放 {leg.serviceWaitMinutes} 分钟；换乘等待 {index ? leg.transferWaitMinutes : 0} 分钟
                </Typography.Text>
              </Space>
            ),
          },
          {
            title: '类型/容量',
            width: 130,
            render: (_, leg) => (
              <Space size={4} wrap>
                <Tag color={leg.accessMode === 'scheduled' ? 'blue' : 'green'}>
                  {leg.accessMode === 'scheduled' ? '班次' : '全天'}
                </Tag>
                <Tag color={leg.peak ? 'orange' : 'default'}>{leg.peak ? '高峰' : '平峰'} {leg.departureCapacity}</Tag>
              </Space>
            ),
          },
        ]}
      />
      <Space style={{ marginTop: 12 }}>
        <ClockCircleOutlined />
        <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={onSave}>
          保存该可行行程版本
        </Button>
        <Typography.Text type="secondary">保存后如遇变化，只标记原版本失效，不覆盖原路线。</Typography.Text>
      </Space>
    </div>
  );
}

function ClockText({ value }: { value: string }) {
  return (
    <Typography.Text style={{ fontSize: 16 }} strong>
      {localDateTimeString(dayjs(value).toDate())}
    </Typography.Text>
  );
}
