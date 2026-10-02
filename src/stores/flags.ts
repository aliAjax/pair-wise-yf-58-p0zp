import { defineStore } from 'pinia';

export type FlagStatus = 'draft' | 'approved' | 'rolling' | 'scheduled' | 'stopped' | 'rolled-back';
export interface RuleSet { region: string; appVersion: string; authenticated: boolean; }

export interface FeatureFlag { id: string; name: string; key: string; enabled: boolean; status: FlagStatus; }

export interface HitUser { id: string; region: string; appVersion: string; authenticated: boolean; bucket: number; }

export interface GrayBatch {
  id: string;
  flagId: string;
  name: string;
  priority: number;            // 数字越小优先级越高
  rules: RuleSet;
  rollout: number;
  status: FlagStatus;
  scheduledAt: string;
  approvals: string[];
  version: number;            // 乐观锁版本号（多标签页并发控制）
  rulesVersion: number;       // 规则版本号，规则/放量变更时递增，使命中名单失效
  hitListRulesVersion: number; // 命中名单是针对哪个 rulesVersion 计算的（0 = 尚未计算）
  hitList: HitUser[];
  conflict: boolean;
  conflictNote: string;
  updatedAt: string;
  updatedBy: string;
}

export interface AuditRecord { id: string; at: string; actor: string; action: string; detail: string; batchId?: string; batchName?: string; }

interface State { flags: FeatureFlag[]; batches: GrayBatch[]; audit: AuditRecord[]; activeId: string; }

const STORAGE_KEY = 'yf58-flag-state';

const REGIONS = ['上海', '北京', '广东', '深圳', '杭州', '成都'];
const VERSIONS = ['8.0.0', '8.2.0', '8.3.0', '9.0.0', '7.5.0'];
const SAMPLE_USERS: HitUser[] = Array.from({ length: 40 }, (_, i) => ({
  id: `user-${1000 + i}`,
  region: REGIONS[i % REGIONS.length],
  appVersion: VERSIONS[i % VERSIONS.length],
  authenticated: i % 3 !== 0,
  bucket: 0
}));

function hashBucket(id: string): number {
  return [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 100;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function versionSatisfies(userVersion: string, rule: string): boolean {
  const m = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(rule.trim());
  if (!m) return true;
  const cmp = compareVersions(userVersion, m[2]);
  switch (m[1]) {
    case '>=': return cmp >= 0;
    case '<=': return cmp <= 0;
    case '>': return cmp > 0;
    case '<': return cmp < 0;
    default: return cmp === 0;
  }
}

function rulesMatch(rules: RuleSet, user: { region: string; appVersion: string; authenticated: boolean }): boolean {
  if (rules.region !== '全部' && rules.region !== user.region) return false;
  if (rules.authenticated && !user.authenticated) return false;
  if (rules.appVersion && !versionSatisfies(user.appVersion, rules.appVersion)) return false;
  return true;
}

function now(): string { return new Date().toLocaleString('zh-CN'); }

const seed: State = {
  activeId: 'f1',
  flags: [
    { id: 'f1', name: '新版结算页', key: 'checkout-v2', enabled: false, status: 'draft' },
    { id: 'f2', name: '推荐模型 B', key: 'recommend-model-b', enabled: true, status: 'rolling' }
  ],
  batches: [
    {
      id: 'b1', flagId: 'f1', name: '上海首批', priority: 1,
      rules: { region: '上海', appVersion: '>= 8.2', authenticated: true }, rollout: 10,
      status: 'draft', scheduledAt: '2026-10-01T10:00', approvals: [],
      version: 1, rulesVersion: 1, hitListRulesVersion: 0, hitList: [],
      conflict: false, conflictNote: '', updatedAt: '09:00', updatedBy: '产品负责人'
    },
    {
      id: 'b2', flagId: 'f1', name: '北京第二批', priority: 2,
      rules: { region: '北京', appVersion: '>= 8.0', authenticated: false }, rollout: 30,
      status: 'draft', scheduledAt: '2026-10-03T10:00', approvals: [],
      version: 1, rulesVersion: 1, hitListRulesVersion: 0, hitList: [],
      conflict: false, conflictNote: '', updatedAt: '09:12', updatedBy: '产品负责人'
    },
    {
      id: 'b3', flagId: 'f2', name: '全国放量', priority: 1,
      rules: { region: '全部', appVersion: '>= 8.0', authenticated: false }, rollout: 35,
      status: 'rolling', scheduledAt: '2026-09-28T10:00', approvals: ['产品负责人', '研发负责人'],
      version: 1, rulesVersion: 1,
      hitListRulesVersion: 1,
      hitList: [
        { id: 'user-1015', region: '北京', appVersion: '8.0.0', authenticated: true, bucket: 0 },
        { id: 'user-1020', region: '上海', appVersion: '8.0.0', authenticated: false, bucket: 5 },
        { id: 'user-1030', region: '杭州', appVersion: '8.0.0', authenticated: true, bucket: 15 }
      ],
      conflict: false, conflictNote: '', updatedAt: '09:00', updatedBy: '研发负责人'
    }
  ],
  audit: [
    { id: 'a1', at: '09:10', actor: '产品负责人', action: '创建草稿', detail: 'checkout-v2 规则草案 v3', batchId: 'b1', batchName: '上海首批' },
    { id: 'a2', at: '09:22', actor: '研发负责人', action: '规则校验', detail: '依赖 payment-v3 已启用' }
  ]
};

function load(): State {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as State;
      if (parsed && Array.isArray(parsed.flags) && Array.isArray(parsed.batches)) return parsed;
    }
  } catch { /* fall through to seed */ }
  return structuredClone(seed);
}

export const useFlagStore = defineStore('flags', {
  state: () => load(),
  getters: {
    active(state): FeatureFlag | undefined { return state.flags.find((item) => item.id === state.activeId); },
    activeBatches(state): GrayBatch[] {
      return state.batches
        .filter((item) => item.flagId === state.activeId)
        .sort((a, b) => a.priority - b.priority);
    },
    batchById(state): (id: string) => GrayBatch | undefined {
      return (id: string) => state.batches.find((item) => item.id === id);
    }
  },
  actions: {
    persist() { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.$state)); },
    reload() { this.$state = load(); },
    audit(action: string, detail: string, actor = '当前操作人', batch?: GrayBatch) {
      this.audit.unshift({
        id: `a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        at: new Date().toLocaleTimeString(), actor, action, detail,
        batchId: batch?.id, batchName: batch?.name
      });
      this.persist();
    },
    select(id: string) { this.activeId = id; this.persist(); },

    addBatch(name?: string) {
      if (!this.active) return;
      const latest = load();
      const flagBatches = latest.batches.filter((b) => b.flagId === this.activeId);
      const maxPriority = flagBatches.length ? Math.max(...flagBatches.map((b) => b.priority)) : 0;
      const batch: GrayBatch = {
        id: `b-${Date.now()}`, flagId: this.activeId,
        name: name?.trim() || `批次 ${flagBatches.length + 1}`,
        priority: maxPriority + 1,
        rules: { region: '全部', appVersion: '>= 1.0', authenticated: false },
        rollout: 0, status: 'draft', scheduledAt: '', approvals: [],
        version: 1, rulesVersion: 1, hitListRulesVersion: 0, hitList: [],
        conflict: false, conflictNote: '', updatedAt: now(), updatedBy: '当前操作人'
      };
      latest.batches.push(batch);
      this.$state = latest; this.persist();
      this.audit('新增批次', `「${batch.name}」优先级 ${batch.priority}`, '当前操作人', batch);
    },

    removeBatch(batchId: string) {
      const latest = load();
      const idx = latest.batches.findIndex((b) => b.id === batchId);
      if (idx === -1) return;
      const [removed] = latest.batches.splice(idx, 1);
      this.$state = latest; this.persist();
      this.audit('删除批次', `「${removed.name}」已删除`, '当前操作人', removed);
    },

    moveBatch(batchId: string, direction: -1 | 1) {
      const latest = load();
      const batch = latest.batches.find((b) => b.id === batchId);
      if (!batch) return;
      const siblings = latest.batches
        .filter((b) => b.flagId === batch.flagId)
        .sort((a, b) => a.priority - b.priority);
      const pos = siblings.findIndex((b) => b.id === batchId);
      const target = pos + direction;
      if (target < 0 || target >= siblings.length) return;
      const other = siblings[target];
      const tmp = batch.priority;
      batch.priority = other.priority;
      other.priority = tmp;
      this.$state = latest; this.persist();
      this.audit('调整优先级', `「${batch.name}」→ 优先级 ${batch.priority}`, '当前操作人', batch);
    },

    // 保存批次（带乐观锁：两个标签页保存不同批次都能入库；同一批次冲突则标记待确认）
    saveBatch(batchId: string, payload: Partial<GrayBatch>, expectedVersion: number): { ok: boolean; conflict: boolean } {
      const latest = load();
      const idx = latest.batches.findIndex((b) => b.id === batchId);
      if (idx === -1) return { ok: false, conflict: false };
      const current = latest.batches[idx];
      if (current.version !== expectedVersion) {
        latest.batches[idx] = {
          ...current, conflict: true,
          conflictNote: `保存时检测到并发修改（本地 v${expectedVersion} → 服务端 v${current.version}），已保留对方数据，等待人工确认`
        };
        this.$state = latest; this.persist();
        this.audit('并发冲突', `批次「${current.name}」本地 v${expectedVersion} 已过期，已标记待确认`, '系统', current);
        return { ok: false, conflict: true };
      }
      const rulesChanged = payload.rules !== undefined || payload.rollout !== undefined;
      latest.batches[idx] = {
        ...current, ...payload,
        version: current.version + 1,
        rulesVersion: rulesChanged ? current.rulesVersion + 1 : current.rulesVersion,
        hitListRulesVersion: rulesChanged ? 0 : current.hitListRulesVersion, // 规则/放量变更 → 名单失效
        conflict: false, conflictNote: '',
        updatedAt: now(), updatedBy: '当前操作人'
      };
      this.$state = latest; this.persist();
      if (rulesChanged) {
        this.audit('修改规则', `批次「${current.name}」规则/放量变更，放量 ${latest.batches[idx].rollout}%，命中名单已失效`, '当前操作人', latest.batches[idx]);
      }
      return { ok: true, conflict: false };
    },

    resolveConflict(batchId: string) {
      const latest = load();
      const idx = latest.batches.findIndex((b) => b.id === batchId);
      if (idx === -1) return;
      latest.batches[idx] = { ...latest.batches[idx], conflict: false, conflictNote: '' };
      this.$state = latest; this.persist();
      this.audit('确认冲突', `批次「${latest.batches[idx].name}」冲突已人工确认`, '当前操作人', latest.batches[idx]);
    },

    // 按优先级重算全部命中名单：每个用户最多归入一个批次
    recomputeHitLists() {
      if (!this.active) return;
      const latest = load();
      const flagBatches = latest.batches
        .filter((b) => b.flagId === this.activeId && !b.conflict)
        .sort((a, b) => a.priority - b.priority);
      const assigned = new Map<string, string>();
      for (const u of SAMPLE_USERS) {
        const bucket = hashBucket(u.id);
        for (const b of flagBatches) {
          if (rulesMatch(b.rules, u) && bucket < b.rollout) { assigned.set(u.id, b.id); break; }
        }
      }
      for (const b of flagBatches) {
        const hitList = SAMPLE_USERS
          .filter((u) => assigned.get(u.id) === b.id)
          .map((u) => ({ ...u, bucket: hashBucket(u.id) }));
        const idx = latest.batches.findIndex((x) => x.id === b.id);
        latest.batches[idx] = { ...b, hitList, hitListRulesVersion: b.rulesVersion };
      }
      const flag = latest.flags.find((f) => f.id === this.activeId);
      const total = assigned.size;
      this.$state = latest; this.persist();
      this.audit('重算命中名单', `「${flag?.key ?? ''}」按优先级重算 ${flagBatches.length} 个批次，共 ${total} 人命中`, '系统');
    },

    // 模拟单个用户：命中多个批次时按优先级得出一个结果
    simulateHit(user: { id: string; region: string; appVersion: string; authenticated: boolean }) {
      if (!this.active || !this.active.enabled) return { hit: false, reason: '开关未启用' };
      const batches = this.activeBatches;
      const bucket = hashBucket(user.id);
      const hits: GrayBatch[] = [];
      let firstMatch: GrayBatch | null = null;
      for (const b of batches) {
        if (!rulesMatch(b.rules, user)) continue;
        if (!firstMatch) firstMatch = b;
        if (bucket < b.rollout) hits.push(b);
      }
      if (hits.length) {
        const winner = hits[0];
        return { hit: true, reason: `命中优先级最高批次「${winner.name}」（灰度桶 ${bucket} < ${winner.rollout}%）`, batchId: winner.id, batchName: winner.name };
      }
      if (firstMatch) return { hit: false, reason: `规则匹配「${firstMatch.name}」但灰度桶 ${bucket} ≥ ${firstMatch.rollout}%`, batchId: firstMatch.id, batchName: firstMatch.name };
      return { hit: false, reason: '未匹配任何批次规则' };
    },

    approveBatch(batchId: string, role: string) {
      const latest = load();
      const idx = latest.batches.findIndex((b) => b.id === batchId);
      if (idx === -1) return;
      const batch = latest.batches[idx];
      if (batch.approvals.includes(role)) return;
      batch.approvals.push(role);
      if (batch.approvals.length >= 2) batch.status = 'approved';
      this.$state = latest; this.persist();
      this.audit('审批发布', `${role} 已确认批次「${batch.name}」`, role, batch);
    },

    // 开始灰度：名单必须是最新的，旧名单不能继续放量
    startBatch(batchId: string): { ok: boolean; reason?: string } {
      const latest = load();
      const idx = latest.batches.findIndex((b) => b.id === batchId);
      if (idx === -1) return { ok: false, reason: '批次不存在' };
      const batch = latest.batches[idx];
      if (batch.conflict) return { ok: false, reason: '批次存在并发冲突，请先确认' };
      if (batch.hitListRulesVersion !== batch.rulesVersion) {
        this.audit('放量被拒绝', `批次「${batch.name}」命中名单已失效，请重算后再放量`, '系统', batch);
        return { ok: false, reason: '命中名单已失效，请重算后再放量' };
      }
      if (batch.approvals.length < 2) return { ok: false, reason: '审批未完成' };
      batch.status = 'rolling';
      const flag = latest.flags.find((f) => f.id === batch.flagId);
      if (flag) { flag.enabled = true; flag.status = 'rolling'; }
      this.$state = latest; this.persist();
      this.audit('开始放量', `批次「${batch.name}」启用 ${batch.rollout}%，命中 ${batch.hitList.length} 人`, '当前操作人', batch);
      return { ok: true };
    },

    stopBatch(batchId: string) {
      const latest = load();
      const idx = latest.batches.findIndex((b) => b.id === batchId);
      if (idx === -1) return;
      latest.batches[idx].status = 'stopped';
      const flag = latest.flags.find((f) => f.id === latest.batches[idx].flagId);
      if (flag && !latest.batches.some((b) => b.flagId === flag.id && b.status === 'rolling')) {
        flag.enabled = false; flag.status = 'stopped';
      }
      this.$state = latest; this.persist();
      this.audit('停止放量', `批次「${latest.batches[idx].name}」已停止`, '当前操作人', latest.batches[idx]);
    },

    rollbackBatch(batchId: string) {
      const latest = load();
      const idx = latest.batches.findIndex((b) => b.id === batchId);
      if (idx === -1) return;
      latest.batches[idx].status = 'rolled-back';
      latest.batches[idx].rollout = 0;
      const flag = latest.flags.find((f) => f.id === latest.batches[idx].flagId);
      if (flag) { flag.enabled = false; flag.status = 'rolled-back'; }
      this.$state = latest; this.persist();
      this.audit('执行回滚', `批次「${latest.batches[idx].name}」回滚至关闭状态`, '当前操作人', latest.batches[idx]);
    },

    emergencyStop() {
      if (!this.active) return;
      const latest = load();
      const flag = latest.flags.find((f) => f.id === this.activeId);
      if (flag) { flag.enabled = false; flag.status = 'stopped'; }
      for (const b of latest.batches) {
        if (b.flagId === this.activeId && b.status === 'rolling') b.status = 'stopped';
      }
      this.$state = latest; this.persist();
      this.audit('紧急停止', `「${flag?.key ?? ''}」已立即关闭所有放量批次`);
    },

    rollback() {
      if (!this.active) return;
      const latest = load();
      const flag = latest.flags.find((f) => f.id === this.activeId);
      if (flag) { flag.enabled = false; flag.status = 'rolled-back'; }
      for (const b of latest.batches) {
        if (b.flagId === this.activeId && (b.status === 'rolling' || b.status === 'stopped')) {
          b.status = 'rolled-back'; b.rollout = 0;
        }
      }
      this.$state = latest; this.persist();
      this.audit('执行回滚', `「${flag?.key ?? ''}」所有批次回滚至关闭状态`);
    }
  }
});

// 多标签页并发：其他标签页写入后自动重载，避免互相覆盖
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY) {
      const store = useFlagStore();
      store.reload();
    }
  });
}
