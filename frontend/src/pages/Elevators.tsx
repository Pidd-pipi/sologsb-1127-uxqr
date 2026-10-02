import { useEffect, useMemo, useState } from 'react';
import {
  App,
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  TimePicker,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckCircleOutlined,
  EditOutlined,
  PlusOutlined,
  UpCircleOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import FacilityIcon from '../components/common/FacilityIcon';
import EmptyState from '../components/common/EmptyState';
import { usePointStore } from '../stores/pointStore';
import { useElevatorStore } from '../stores/elevatorStore';
import type { ElevatorService, MaintenanceWindow, OpenWindow, PeakWindow } from '../types/elevator';
import { hmToMin, minToHM } from '../types/elevator';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

type Draft = Omit<ElevatorService, 'id' | 'updatedAt'> & { id?: string };

function newMaintenance(): MaintenanceWindow {
  return {
    id: `mnt-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'weekly',
    weekday: 1,
    startMin: 10 * 60,
    endMin: 11 * 60,
    reason: '',
  };
}

function newPeak(): PeakWindow {
  return { startMin: 7 * 60 + 30, endMin: 9 * 60, peakCapacity: 0, label: '高峰' };
}

export default function Elevators() {
  const { message } = App.useApp();
  const points = usePointStore((s) => s.points);
  const elevatorPoints = useMemo(
    () => points.filter((p) => p.facilityType === '无障碍电梯'),
    [points],
  );
  const { services, load, upsertService } = useElevatorStore();
  const [editing, setEditing] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

  const serviceOf = (pointId: string) => services.find((s) => s.pointId === pointId);

  const openEditor = (pointId: string) => {
    const existing = serviceOf(pointId);
    if (existing) {
      setEditing({ ...existing });
    } else {
      setEditing({
        pointId,
        allDay: false,
        status: '正常',
        suspendedReason: '',
        resumeAt: '',
        openWindows: [{ weekdays: [], startMin: 6 * 60, endMin: 22 * 60 }],
        maintenance: [],
        schedule: {
          kind: 'interval',
          intervalMin: 15,
          capacityPerTrip: 2,
          rideMin: 3,
          peakWindows: [],
        },
      });
    }
  };

  const handleSave = async () => {
    if (!editing) return;
    if (!editing.allDay && !editing.openWindows.length) {
      message.warning('请至少配置一个开放时段，或升级为全天可用');
      return;
    }
    setSaving(true);
    try {
      await upsertService(editing);
      message.success('电梯运行档案已保存，行程候选已重算');
      setEditing(null);
    } catch (e) {
      message.error(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const columns: ColumnsType<(typeof elevatorPoints)[number]> = [
    {
      title: '无障碍电梯',
      dataIndex: 'name',
      render: (_, p) => (
        <Space>
          <FacilityIcon type="无障碍电梯" size={22} />
          <Space direction="vertical" size={0}>
            <Typography.Text strong>{p.name}</Typography.Text>
            <Typography.Text type="secondary" className="gb-muted">
              {p.code} · {p.location}
            </Typography.Text>
          </Space>
        </Space>
      ),
    },
    {
      title: '开放时段',
      width: 200,
      render: (_, p) => {
        const s = serviceOf(p.id);
        if (!s) return <Tag>未配置</Tag>;
        if (s.allDay) return <Tag color="green">全天可用</Tag>;
        return (
          <Space direction="vertical" size={2}>
            {s.openWindows.map((w, i) => (
              <Tag key={i}>
                {w.weekdays.length ? w.weekdays.map((d) => WEEKDAYS[d]).join('、') : '每天'}{' '}
                {minToHM(w.startMin)}-{minToHM(w.endMin)}
              </Tag>
            ))}
          </Space>
        );
      },
    },
    {
      title: '班次 / 容量',
      width: 200,
      render: (_, p) => {
        const s = serviceOf(p.id);
        if (!s) return '—';
        const sched = s.schedule;
        return (
          <Space direction="vertical" size={2}>
            <Tag icon={<UpCircleOutlined />}>
              {sched.kind === 'interval' ? `每 ${sched.intervalMin} 分钟` : `固定 ${sched.fixedMinutes?.length ?? 0} 班`}
            </Tag>
            <Tag color="blue">平峰 {sched.capacityPerTrip} 轮椅/班</Tag>
            {sched.peakWindows.map((pk, i) => (
              <Tag key={i} color={pk.peakCapacity < 1 ? 'red' : 'orange'}>
                {pk.label} {minToHM(pk.startMin)}-{minToHM(pk.endMin)} {pk.peakCapacity < 1 ? '拒轮椅' : `${pk.peakCapacity} 位`}
              </Tag>
            ))}
          </Space>
        );
      },
    },
    {
      title: '检修窗口',
      width: 160,
      render: (_, p) => {
        const s = serviceOf(p.id);
        if (!s || !s.maintenance.length) return <Tag color="green">无</Tag>;
        return (
          <Space direction="vertical" size={2}>
            {s.maintenance.map((m) => (
              <Tag key={m.id} color="orange">
                {m.kind === 'weekly' ? WEEKDAYS[m.weekday ?? 0] : m.date} {minToHM(m.startMin)}-{minToHM(m.endMin)}
              </Tag>
            ))}
          </Space>
        );
      },
    },
    {
      title: '状态',
      width: 110,
      render: (_, p) => {
        const s = serviceOf(p.id);
        if (!s) return <Tag>未配置</Tag>;
        return s.status === '正常' ? (
          <Tag icon={<CheckCircleOutlined />} color="success">
            正常
          </Tag>
        ) : (
          <Tag icon={<WarningOutlined />} color="error">
            临时停用
          </Tag>
        );
      },
    },
    {
      title: '操作',
      width: 90,
      render: (_, p) => (
        <Button size="small" icon={<EditOutlined />} onClick={() => openEditor(p.id)}>
          配置
        </Button>
      ),
    },
  ];

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h1 className="gb-page-title">无障碍电梯运行</h1>
          <Typography.Text type="secondary">
            维护无障碍电梯的开放时段、检修窗口、班次与高峰容量；临时停用或容量调整后，行程候选立即重算，已保存行程自动标注失效原因。
          </Typography.Text>
        </div>
      </div>

      <Card size="small">
        {elevatorPoints.length ? (
          <Table
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={elevatorPoints}
            columns={columns}
          />
        ) : (
          <EmptyState title="暂无无障碍电梯点位" description="请先在点位登记中添加无障碍电梯" compact />
        )}
      </Card>

      <Modal
        title="配置电梯运行档案"
        open={!!editing}
        onCancel={() => setEditing(null)}
        onOk={handleSave}
        confirmLoading={saving}
        okText="保存并重算"
        cancelText="取消"
        width={760}
      >
        {editing ? <ElevatorEditor draft={editing} onChange={setEditing} /> : null}
      </Modal>
    </div>
  );
}

function ElevatorEditor({ draft, onChange }: { draft: Draft; onChange: (d: Draft) => void }) {
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => onChange({ ...draft, [key]: value });
  const pointName = usePointStore((s) => s.points.find((p) => p.id === draft.pointId)?.name);

  const setSchedule = (patch: Partial<Draft['schedule']>) =>
    onChange({ ...draft, schedule: { ...draft.schedule, ...patch } });

  const updateWindow = (idx: number, patch: Partial<OpenWindow>) => {
    const next = draft.openWindows.map((w, i) => (i === idx ? { ...w, ...patch } : w));
    set('openWindows', next);
  };
  const addWindow = () =>
    set('openWindows', [...draft.openWindows, { weekdays: [], startMin: 9 * 60, endMin: 18 * 60 }]);
  const removeWindow = (idx: number) =>
    set('openWindows', draft.openWindows.filter((_, i) => i !== idx));

  const updateMaint = (id: string, patch: Partial<MaintenanceWindow>) =>
    set('maintenance', draft.maintenance.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  const addMaint = () => set('maintenance', [...draft.maintenance, newMaintenance()]);
  const removeMaint = (id: string) => set('maintenance', draft.maintenance.filter((m) => m.id !== id));

  const updatePeak = (idx: number, patch: Partial<PeakWindow>) =>
    set('schedule', {
      ...draft.schedule,
      peakWindows: draft.schedule.peakWindows.map((p, i) => (i === idx ? { ...p, ...patch } : p)),
    });
  const addPeak = () =>
    setSchedule({ peakWindows: [...draft.schedule.peakWindows, newPeak()] });
  const removePeak = (idx: number) =>
    setSchedule({ peakWindows: draft.schedule.peakWindows.filter((_, i) => i !== idx) });

  return (
    <Form layout="vertical" style={{ marginTop: 8 }}>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message={
          <Space>
            <FacilityIcon type="无障碍电梯" size={20} />
            <Typography.Text strong>{pointName}</Typography.Text>
          </Space>
        }
      />

      <Row gutter={12}>
        <Col span={12}>
          <Form.Item label="运行状态">
            <Select
              value={draft.status}
              onChange={(v) => set('status', v)}
              options={[
                { value: '正常', label: '正常运行' },
                { value: '临时停用', label: '临时停用' },
              ]}
            />
          </Form.Item>
        </Col>
        <Col span={12}>
          <Form.Item label="升级为全天可用（旧路线按全天可用处理）">
            <Switch
              checked={draft.allDay}
              onChange={(v) => set('allDay', v)}
              checkedChildren="全天"
              unCheckedChildren="定时"
            />
          </Form.Item>
        </Col>
      </Row>

      {draft.status === '临时停用' ? (
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item label="停用原因">
              <Input
                value={draft.suspendedReason}
                onChange={(e) => set('suspendedReason', e.target.value)}
                placeholder="如：设备故障抢修"
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item label="预计恢复时间（留空为待定）">
              <DatePicker
                showTime={{ format: 'HH:mm' }}
                format="YYYY-MM-DD HH:mm"
                value={draft.resumeAt ? dayjs(draft.resumeAt) : null}
                onChange={(v) => set('resumeAt', v ? v.toISOString() : '')}
                style={{ width: '100%' }}
              />
            </Form.Item>
          </Col>
        </Row>
      ) : null}

      {!draft.allDay ? (
        <Form.Item label="每日开放时段">
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            {draft.openWindows.map((w, i) => (
              <Space key={i} wrap>
                <Select
                  mode="multiple"
                  value={w.weekdays}
                  onChange={(v) => updateWindow(i, { weekdays: v })}
                  options={WEEKDAYS.map((d, idx) => ({ value: idx, label: d }))}
                  placeholder="每天"
                  style={{ minWidth: 160 }}
                  maxTagCount={2}
                />
                <TimePicker
                  format="HH:mm"
                  minuteStep={15}
                  value={dayjs().startOf('day').add(w.startMin, 'minute')}
                  onChange={(v) => v && updateWindow(i, { startMin: hmToMin(v.format('HH:mm')) })}
                />
                <Typography.Text type="secondary">至</Typography.Text>
                <TimePicker
                  format="HH:mm"
                  minuteStep={15}
                  value={dayjs().startOf('day').add(w.endMin, 'minute')}
                  onChange={(v) => v && updateWindow(i, { endMin: hmToMin(v.format('HH:mm')) })}
                />
                <Button size="small" danger onClick={() => removeWindow(i)}>
                  删除
                </Button>
              </Space>
            ))}
            <Button size="small" icon={<PlusOutlined />} onClick={addWindow}>
              增加开放时段
            </Button>
          </Space>
        </Form.Item>
      ) : null}

      <Form.Item label="检修窗口">
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          {draft.maintenance.map((m) => (
            <Space key={m.id} wrap>
              <Select
                value={m.kind}
                onChange={(v) => updateMaint(m.id, { kind: v })}
                options={[{ value: 'weekly', label: '每周' }, { value: 'once', label: '一次性' }]}
                style={{ width: 90 }}
              />
              {m.kind === 'weekly' ? (
                <Select
                  value={m.weekday}
                  onChange={(v) => updateMaint(m.id, { weekday: v })}
                  options={WEEKDAYS.map((d, idx) => ({ value: idx, label: d }))}
                  style={{ width: 90 }}
                />
              ) : (
                <DatePicker
                  value={m.date ? dayjs(m.date) : null}
                  onChange={(v) => updateMaint(m.id, { date: v ? v.format('YYYY-MM-DD') : '' })}
                  style={{ width: 150 }}
                />
              )}
              <TimePicker
                format="HH:mm"
                minuteStep={15}
                value={dayjs().startOf('day').add(m.startMin, 'minute')}
                onChange={(v) => v && updateMaint(m.id, { startMin: hmToMin(v.format('HH:mm')) })}
              />
              <Typography.Text type="secondary">至</Typography.Text>
              <TimePicker
                format="HH:mm"
                minuteStep={15}
                value={dayjs().startOf('day').add(m.endMin, 'minute')}
                onChange={(v) => v && updateMaint(m.id, { endMin: hmToMin(v.format('HH:mm')) })}
              />
              <Input
                value={m.reason}
                onChange={(e) => updateMaint(m.id, { reason: e.target.value })}
                placeholder="检修原因"
                style={{ width: 140 }}
              />
              <Button size="small" danger onClick={() => removeMaint(m.id)}>
                删除
              </Button>
            </Space>
          ))}
          <Button size="small" icon={<PlusOutlined />} onClick={addMaint}>
            增加检修窗口
          </Button>
        </Space>
      </Form.Item>

      <Row gutter={12}>
        <Col span={8}>
          <Form.Item label="班次类型">
            <Select
              value={draft.schedule.kind}
              onChange={(v) => setSchedule({ kind: v })}
              options={[{ value: 'interval', label: '固定间隔' }, { value: 'fixed', label: '固定时刻' }]}
            />
          </Form.Item>
        </Col>
        <Col span={8}>
          {draft.schedule.kind === 'interval' ? (
            <Form.Item label="发车间隔（分钟）">
              <InputNumber
                min={5}
                max={120}
                value={draft.schedule.intervalMin}
                onChange={(v) => setSchedule({ intervalMin: Number(v ?? 15) })}
                style={{ width: '100%' }}
              />
            </Form.Item>
          ) : (
            <Form.Item label="发车时刻（HH:mm，逗号分隔）">
              <Input
                value={(draft.schedule.fixedMinutes ?? []).map(minToHM).join(', ')}
                onChange={(e) =>
                  setSchedule({
                    fixedMinutes: e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean)
                      .map(hmToMin)
                      .filter((n) => Number.isFinite(n)),
                  })
                }
                placeholder="07:00, 08:00, 09:00"
              />
            </Form.Item>
          )}
        </Col>
        <Col span={8}>
          <Form.Item label="乘坐时长（分钟）">
            <InputNumber
              min={1}
              max={30}
              value={draft.schedule.rideMin}
              onChange={(v) => setSchedule({ rideMin: Number(v ?? 2) })}
              style={{ width: '100%' }}
            />
          </Form.Item>
        </Col>
      </Row>

      <Form.Item label="平峰每班次轮椅容量">
        <InputNumber
          min={0}
          max={20}
          value={draft.schedule.capacityPerTrip}
          onChange={(v) => setSchedule({ capacityPerTrip: Number(v ?? 0) })}
          addonAfter="辆/班"
          style={{ width: 160 }}
        />
      </Form.Item>

      <Form.Item label="高峰容量窗口（高峰时段轮椅容量折减为 0 时拒乘）">
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          {draft.schedule.peakWindows.map((pk, i) => (
            <Space key={i} wrap>
              <Input
                value={pk.label}
                onChange={(e) => updatePeak(i, { label: e.target.value })}
                placeholder="高峰名称"
                style={{ width: 110 }}
              />
              <TimePicker
                format="HH:mm"
                minuteStep={15}
                value={dayjs().startOf('day').add(pk.startMin, 'minute')}
                onChange={(v) => v && updatePeak(i, { startMin: hmToMin(v.format('HH:mm')) })}
              />
              <Typography.Text type="secondary">至</Typography.Text>
              <TimePicker
                format="HH:mm"
                minuteStep={15}
                value={dayjs().startOf('day').add(pk.endMin, 'minute')}
                onChange={(v) => v && updatePeak(i, { endMin: hmToMin(v.format('HH:mm')) })}
              />
              <InputNumber
                min={0}
                max={20}
                value={pk.peakCapacity}
                onChange={(v) => updatePeak(i, { peakCapacity: Number(v ?? 0) })}
                addonAfter="辆"
                style={{ width: 120 }}
              />
              <Button size="small" danger onClick={() => removePeak(i)}>
                删除
              </Button>
            </Space>
          ))}
          <Button size="small" icon={<PlusOutlined />} onClick={addPeak}>
            增加高峰窗口
          </Button>
        </Space>
      </Form.Item>
    </Form>
  );
}
