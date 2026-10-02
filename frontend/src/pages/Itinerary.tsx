import { useEffect, useMemo, useState } from 'react';
import {
  App,
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Empty,
  Form,
  Row,
  Select,
  Space,
  Statistic,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import {
  ArrowRightOutlined,
  ClockCircleOutlined,
  DeleteOutlined,
  SaveOutlined,
  ThunderboltOutlined,
  UpCircleOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import StatusBadge from '../components/common/StatusBadge';
import EmptyState from '../components/common/EmptyState';
import { usePointStore } from '../stores/pointStore';
import { useRouteStore } from '../stores/routeStore';
import { useElevatorStore } from '../stores/elevatorStore';
import { useItineraryStore } from '../stores/itineraryStore';
import type { Itinerary, ItineraryLeg } from '../types/itinerary';
import { fmtHM, fmtMDHM, fmtYMDHM } from '../utils/itineraryEngine';

const { Text } = Typography;

function legDescription(leg: ItineraryLeg, nameOf: (id: string) => string) {
  if (leg.mode === 'walk') {
    return (
      <Space size={6} wrap>
        <Tag icon={<ArrowRightOutlined />} color="blue">
          步行
        </Tag>
        <Text>
          {nameOf(leg.fromPointId)} → {nameOf(leg.toPointId)}
        </Text>
        <Tag>{leg.walkMin} 分钟</Tag>
      </Space>
    );
  }
  return (
    <Space size={6} wrap>
      <Tag icon={<UpCircleOutlined />} color="purple">
        电梯
      </Tag>
      <Text>在 {nameOf(leg.elevatorPointId ?? leg.toPointId)} 乘梯</Text>
      {leg.tripAt ? <Tag color="geekblue">{fmtHM(leg.tripAt)} 班次</Tag> : null}
      <Tag>等 {leg.waitMin} 分钟</Tag>
      <Tag>乘 {leg.rideMin} 分钟</Tag>
    </Space>
  );
}

export default function Itinerary() {
  const { message, modal } = App.useApp();
  const points = usePointStore((s) => s.points);
  const pointLoaded = usePointStore((s) => s.loaded);
  const loadElevators = useElevatorStore((s) => s.load);
  const elevatorsLoaded = useElevatorStore((s) => s.loaded);
  const {
    query,
    candidate,
    saved,
    loadSaved,
    setQuery,
    saveCandidate,
    deleteItinerary,
  } = useItineraryStore();

  const [departure, setDeparture] = useState<Dayjs>(() => dayjs().add(1, 'hour').minute(0).second(0));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      await Promise.all([loadElevators(), loadSaved()]);
      // 进入页面时用当前服务规则复核已保存行程，标注历史失效
      void useItineraryStore.getState().revalidateAll();
    })();
  }, [loadElevators, loadSaved]);

  // 首次有了点位与路线后，若尚未设置查询则给一个默认起讫
  useEffect(() => {
    if (!pointLoaded || !elevatorsLoaded || query.originId) return;
    if (points.length < 2) return;
    const origin = points.find((p) => p.id === 'pt-1004') ?? points[0];
    const dest = points.find((p) => p.id === 'pt-1006') ?? points[1];
    setQuery({
      originId: origin.id,
      destinationId: dest.id,
      departureAt: departure.toISOString(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointLoaded, elevatorsLoaded, points]);

  // 路线段可能晚于查询就绪，就绪后补算一次候选
  const segmentsLoaded = useRouteStore((s) => s.loaded);
  const computeCandidate = useItineraryStore((s) => s.computeCandidate);
  useEffect(() => {
    if (segmentsLoaded && query.originId && query.destinationId) computeCandidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segmentsLoaded]);

  const pointOptions = useMemo(
    () => points.map((p) => ({ value: p.id, label: `${p.code} ${p.name}` })),
    [points],
  );
  const nameOf = (id: string) => points.find((p) => p.id === id)?.name ?? id;

  const handleSearch = () => {
    if (!query.originId || !query.destinationId) {
      message.warning('请选择起点与终点');
      return;
    }
    if (query.originId === query.destinationId) {
      message.warning('起点与终点不能相同');
      return;
    }
    setQuery({ departureAt: departure.toISOString() });
  };

  const handleSave = async () => {
    if (!candidate || !candidate.legs.length) {
      message.warning('暂无可保存的行程');
      return;
    }
    setSaving(true);
    try {
      const rec = await saveCandidate();
      if (rec) message.success(`已保存行程 v${rec.version}`);
    } catch (e) {
      message.error(`行程保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const adoptNext = () => {
    if (!candidate?.nextFeasibleAt) return;
    const next = dayjs(candidate.nextFeasibleAt);
    setDeparture(next);
    setQuery({ departureAt: next.toISOString() });
  };

  const handleDelete = (it: Itinerary) => {
    modal.confirm({
      title: `删除行程 v${it.version}？`,
      content: `${nameOf(it.originPointId)} → ${nameOf(it.destinationPointId)}（${fmtYMDHM(it.departureAt)}）`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => deleteItinerary(it.id),
    });
  };

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h1 className="gb-page-title">可达行程规划</h1>
          <Typography.Text type="secondary">
            按出发时间生成轮椅可达行程，途经无障碍电梯时匹配开放时段、检修窗口与高峰容量；容量不足则拒绝并给出下一可行时间。
          </Typography.Text>
        </div>
      </div>

      <Card title="出发条件" size="small" style={{ marginBottom: 16 }}>
        <Form layout="vertical">
          <Row gutter={12}>
            <Col xs={24} md={7}>
              <Form.Item label="起点">
                <Select
                  value={query.originId || undefined}
                  onChange={(v) => setQuery({ originId: v })}
                  options={pointOptions}
                  placeholder="选择起点"
                  showSearch
                  optionFilterProp="label"
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={7}>
              <Form.Item label="终点">
                <Select
                  value={query.destinationId || undefined}
                  onChange={(v) => setQuery({ destinationId: v })}
                  options={pointOptions}
                  placeholder="选择终点"
                  showSearch
                  optionFilterProp="label"
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={6}>
              <Form.Item label="出发时间">
                <DatePicker
                  showTime={{ format: 'HH:mm', minuteStep: 15 }}
                  format="YYYY-MM-DD HH:mm"
                  value={departure}
                  onChange={(v) => {
                    if (v) {
                      setDeparture(v);
                      setQuery({ departureAt: v.toISOString() });
                    }
                  }}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={4}>
              <Form.Item label=" ">
                <Button type="primary" icon={<ThunderboltOutlined />} onClick={handleSearch} block>
                  生成行程
                </Button>
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Card>

      {candidate ? (
        <Card
          title="行程方案"
          size="small"
          style={{ marginBottom: 16 }}
          extra={
            candidate.feasible ? (
              <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={handleSave}>
                保存行程
              </Button>
            ) : null
          }
        >
          {candidate.feasible ? (
            <>
              <Alert
                type="success"
                showIcon
                style={{ marginBottom: 16 }}
                message={
                  <Space wrap>
                    <StatusBadge value="可行" kind="route" bordered />
                    <Text strong>
                      {nameOf(query.originId)} → {nameOf(query.destinationId)}
                    </Text>
                    <Text type="secondary">计划 {fmtYMDHM(candidate.departureAt)} 出发</Text>
                  </Space>
                }
              />
              <Row gutter={12} style={{ marginBottom: 16 }}>
                <Col span={6}>
                  <Statistic title="步行" value={candidate.totalWalkMin} suffix="分钟" />
                </Col>
                <Col span={6}>
                  <Statistic title="换乘等待" value={candidate.totalWaitMin} suffix="分钟" />
                </Col>
                <Col span={6}>
                  <Statistic title="电梯乘坐" value={candidate.totalRideMin} suffix="分钟" />
                </Col>
                <Col span={6}>
                  <Statistic title="全程" value={candidate.totalMin} suffix="分钟" />
                </Col>
              </Row>
              <Timeline
                items={candidate.legs.map((leg) => ({
                  color: leg.mode === 'walk' ? 'blue' : 'purple',
                  children: (
                    <Space direction="vertical" size={2}>
                      {legDescription(leg, nameOf)}
                      <Text type="secondary" className="gb-muted">
                        {fmtHM(leg.departAt)} 出发 · {fmtHM(leg.arriveAt)} 到达
                      </Text>
                    </Space>
                  ),
                }))}
              />
            </>
          ) : (
            <Alert
              type="warning"
              showIcon
              icon={<WarningOutlined />}
              message={
                <Space wrap>
                  <StatusBadge value="不可通行" kind="route" bordered />
                  <Text strong>该出发时间无法成行</Text>
                </Space>
              }
              description={
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  <Text>{candidate.reason}</Text>
                  {candidate.nextFeasibleAt ? (
                    <Space wrap>
                      <Tag icon={<ClockCircleOutlined />} color="orange">
                        下一可行时间：{fmtMDHM(candidate.nextFeasibleAt)}
                      </Tag>
                      <Button size="small" type="primary" onClick={adoptNext}>
                        采用下一可行时间
                      </Button>
                    </Space>
                  ) : (
                    <Text type="secondary">未来数日内无可行班次，请调整出发日期或确认电梯恢复安排。</Text>
                  )}
                </Space>
              }
            />
          )}
        </Card>
      ) : (
        <Card size="small" style={{ marginBottom: 16 }}>
          <EmptyState title="尚未生成行程" description="选择起点、终点与出发时间后点击「生成行程」" compact />
        </Card>
      )}

      <Card title="已保存行程" size="small">
        {saved.length ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {saved.map((it) => (
              <SavedItineraryCard key={it.id} it={it} nameOf={nameOf} onDelete={() => handleDelete(it)} />
            ))}
          </Space>
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="暂无保存的行程，生成可行方案后点击「保存行程」"
          />
        )}
      </Card>
    </div>
  );
}

function SavedItineraryCard({
  it,
  nameOf,
  onDelete,
}: {
  it: Itinerary;
  nameOf: (id: string) => string;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const statusColor = it.status === '可行' ? 'success' : it.status === '已失效' ? 'error' : 'warning';
  return (
    <Card size="small" type="inner">
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
          <Space wrap>
            <Tag color={statusColor}>{it.status}</Tag>
            <Text strong>
              {nameOf(it.originPointId)} → {nameOf(it.destinationPointId)}
            </Text>
            <Tag>v{it.version}</Tag>
            <Text type="secondary" className="gb-muted">
              {fmtYMDHM(it.departureAt)} 出发
            </Text>
          </Space>
          <Space>
            <Tag>{it.totalMin} 分钟</Tag>
            <Button size="small" type="text" onClick={() => setOpen((o) => !o)}>
              {open ? '收起原版本' : '查看原版本'}
            </Button>
            <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={onDelete} />
          </Space>
        </Space>
        {it.status === '已失效' && it.invalidReason ? (
          <Alert type="error" showIcon message={`失效原因：${it.invalidReason}`} />
        ) : null}
        {it.status === '已拒绝' && it.reason ? (
          <Alert type="warning" showIcon message={`拒绝原因：${it.reason}`} />
        ) : null}
        {open ? (
          <Timeline
            style={{ marginTop: 8 }}
            items={it.legs.map((leg) => ({
              color: leg.mode === 'walk' ? 'blue' : 'purple',
              children: (
                <Space direction="vertical" size={2}>
                  {legDescription(leg, nameOf)}
                  <Text type="secondary" className="gb-muted">
                    {fmtHM(leg.departAt)} · {fmtHM(leg.arriveAt)}
                  </Text>
                </Space>
              ),
            }))}
          />
        ) : null}
      </Space>
    </Card>
  );
}
