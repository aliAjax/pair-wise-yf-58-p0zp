import { defineStore } from 'pinia';

export type FlagStatus = 'draft' | 'approved' | 'rolling' | 'scheduled' | 'stopped' | 'rolled-back';
export type BatchStatus = 'draft' | 'active' | 'paused' | 'conflict';
export interface RuleSet { region: string; appVersion: string; authenticated: boolean; }
export interface FeatureFlag { id: string; name: string; key: string; enabled: boolean; status: FlagStatus; }

/** 冲突时被搁置的待确认版本 */
export interface BatchPending { name: string; priority: number; rules: RuleSet; rollout: number; savedBy: string; savedAt: string; }

/** 灰度批次：一个开关可挂多条，各自携带规则、放量比例和优先级 */
export interface GrayBatch {
  id: string; flagId: string; name: string;
  priority: number;            // 数字越小优先级越高
  rules: RuleSet; rollout: number;
  status: BatchStatus;
  ruleVersion: number;         // 规则/比例每次变更 +1，命中名单按此失效
  version: number;             // 乐观并发令牌，保存时与磁盘比对
  updatedAt: string; updatedBy: string;
  pending?: BatchPending;
}

/** 保存批次时由表单提交的内容 */
export type BatchInput = Pick<GrayBatch, 'id' | 'flagId' | 'name' | 'priority' | 'rules' | 'rollout' | 'version'>;

/** 按某版规则算出的命中名单；规则一变即失效，失效名单不得继续放量 */
export interface HitList { batchId: string; ruleVersion: number; computedAt: string; userIds: string[]; stale: boolean; }

export interface RolloutPlan { id: string; flagId: string; scheduledAt: string; approvals: string[]; version: number; }
export interface AuditRecord { id: string; at: string; actor: string; action: string; detail: string; batchId?: string; batchName?: string; }
export interface SimUser { id: string; region: string; appVersion: string; authenticated: boolean; }
export interface SimResult { hit: boolean; reason: string; batchName: string; alsoMatched: string[]; }

interface State {
  flags: FeatureFlag[]; batches: GrayBatch[]; hitLists: HitList[];
  plans: RolloutPlan[]; audit: AuditRecord[];
  activeId: string; activeBatchId: string; actor: string;
}

export const STORE_KEY = 'yf58-flag-state-v2';
const LEGACY_KEY = 'yf58-flag-state';

/** 内置模拟用户池：命中名单的数据来源 */
export const USER_POOL: SimUser[] = Array.from({ length: 24 }, (_, i) => ({
  id: `u-${1001 + i}`,
  region: ['上海', '北京', '广东', '深圳'][i % 4],
  appVersion: ['8.5.0', '8.1.0', '7.9.0', '8.3.0', '8.0.0', '8.2.1'][i % 6],
  authenticated: i % 2 === 0
}));

function bucketOf(userId: string): number {
  return [...userId].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 100;
}

export function versionSatisfies(rule: string, version: string): boolean {
  const want = rule.trim().match(/^(>=|<=|>|<|=)?\s*(\d+(?:\.\d+)*)$/);
  const got = version.trim().match(/^(\d+(?:\.\d+)*)$/);
  if (!want || !got) return true; // 无法解析的规则不拦截
  const a = got[1].split('.').map(Number);
  const b = want[2].split('.').map(Number);
  let cmp = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0; const y = b[i] ?? 0;
    if (x !== y) { cmp = x < y ? -1 : 1; break; }
  }
  switch (want[1] || '=') {
    case '>=': return cmp >= 0;
    case '<=': return cmp <= 0;
    case '>': return cmp > 0;
    case '<': return cmp < 0;
    default: return cmp === 0;
  }
}

/** 批次规则是否覆盖该用户（不含放量桶），返回 null 表示覆盖，否则返回原因 */
export function rulesMatch(batch: Pick<GrayBatch, 'rules'>, user: SimUser): string | null {
  const { rules } = batch;
  if (rules.region !== '全部' && rules.region !== user.region) return `地区不匹配（要求 ${rules.region}）`;
  if (rules.authenticated && !user.authenticated) return '要求已登录用户';
  if (!versionSatisfies(rules.appVersion, user.appVersion)) return `版本不满足 ${rules.appVersion}`;
  return null;
}

function buildHitList(batch: GrayBatch): HitList {
  return {
    batchId: batch.id,
    ruleVersion: batch.ruleVersion,
    computedAt: new Date().toLocaleTimeString(),
    userIds: USER_POOL.filter((user) => !rulesMatch(batch, user) && bucketOf(user.id) < batch.rollout).map((user) => user.id),
    stale: false
  };
}

function seedState(): State {
  const b1: GrayBatch = { id: 'b1', flagId: 'f1', name: '第一批 · 上海登录用户', priority: 1, rules: { region: '上海', appVersion: '>= 8.2', authenticated: true }, rollout: 10, status: 'active', ruleVersion: 1, version: 1, updatedAt: '09:10', updatedBy: '产品负责人' };
  const b2: GrayBatch = { id: 'b2', flagId: 'f1', name: '第二批 · 全国放量', priority: 2, rules: { region: '全部', appVersion: '>= 8.0', authenticated: false }, rollout: 5, status: 'draft', ruleVersion: 1, version: 1, updatedAt: '09:10', updatedBy: '产品负责人' };
  const b3: GrayBatch = { id: 'b3', flagId: 'f2', name: '默认灰度批', priority: 1, rules: { region: '全部', appVersion: '>= 8.0', authenticated: false }, rollout: 35, status: 'active', ruleVersion: 2, version: 4, updatedAt: '09:22', updatedBy: '研发负责人' };
  const list1 = buildHitList(b1);
  return {
    activeId: 'f1', activeBatchId: 'b1', actor: '产品负责人',
    flags: [
      { id: 'f1', name: '新版结算页', key: 'checkout-v2', enabled: true, status: 'rolling' },
      { id: 'f2', name: '推荐模型 B', key: 'recommend-model-b', enabled: true, status: 'rolling' }
    ],
    batches: [b1, b2, b3],
    hitLists: [list1, buildHitList(b3)],
    plans: [
      { id: 'p1', flagId: 'f1', scheduledAt: '2026-10-01T10:00', approvals: ['产品负责人', '研发负责人'], version: 3 },
      { id: 'p2', flagId: 'f2', scheduledAt: '2026-10-02T10:00', approvals: ['产品负责人', '研发负责人'], version: 2 }
    ],
    audit: [
      { id: 'a2', at: '09:22', actor: '研发负责人', action: '重算命中名单', detail: `规则 v1 · 命中 ${list1.userIds.length} 人`, batchId: 'b1', batchName: b1.name },
      { id: 'a1', at: '09:10', actor: '产品负责人', action: '创建批次', detail: '第一批 · 上海登录用户 · 优先级 1 · 10%', batchId: 'b1', batchName: b1.name }
    ]
  };
}

/** 从旧版单计划数据迁移：每个开关的规则/比例折叠成一个批次 */
function migrateLegacy(raw: { flags?: Array<Record<string, unknown>>; plans?: RolloutPlan[]; audit?: AuditRecord[] }): State {
  const state = seedState();
  if (!Array.isArray(raw.flags)) return state;
  state.flags = raw.flags.map((f) => ({ id: String(f.id), name: String(f.name), key: String(f.key), enabled: Boolean(f.enabled), status: (f.status as FlagStatus) ?? 'draft' }));
  state.batches = raw.flags.map((f) => ({
    id: `b-${String(f.id)}`, flagId: String(f.id), name: '迁移批次', priority: 1,
    rules: (f.rules as RuleSet) ?? { region: '全部', appVersion: '>= 1.0', authenticated: false },
    rollout: Number(f.rollout) || 0, status: 'draft' as BatchStatus,
    ruleVersion: 1, version: 1, updatedAt: '迁移', updatedBy: '系统迁移'
  }));
  state.plans = Array.isArray(raw.plans) ? raw.plans : [];
  state.audit = Array.isArray(raw.audit) ? raw.audit : [];
  state.hitLists = [];
  state.activeId = state.flags[0]?.id ?? '';
  state.activeBatchId = state.batches[0]?.id ?? '';
  return state;
}

function load(): State {
  const saved = localStorage.getItem(STORE_KEY);
  if (saved) { try { return JSON.parse(saved) as State; } catch { /* 数据损坏则回落 */ } }
  const legacy = localStorage.getItem(LEGACY_KEY);
  if (legacy) { try { return migrateLegacy(JSON.parse(legacy)); } catch { /* 同上 */ } }
  return seedState();
}

function readDisk(): State | null {
  const saved = localStorage.getItem(STORE_KEY);
  if (!saved) return null;
  try { return JSON.parse(saved) as State; } catch { return null; }
}

export const useFlagStore = defineStore('flags', {
  state: (): State => load(),
  getters: {
    active(state): FeatureFlag | undefined { return state.flags.find((item) => item.id === state.activeId); },
    activePlan(state): RolloutPlan | undefined { return state.plans.find((item) => item.flagId === state.activeId); },
    activeBatch(state): GrayBatch | undefined { return state.batches.find((item) => item.id === state.activeBatchId); },
    batchesOf(state) { return (flagId: string): GrayBatch[] => state.batches.filter((item) => item.flagId === flagId).sort((a, b) => a.priority - b.priority); },
    hitListOf(state) { return (batchId: string): HitList | undefined => state.hitLists.find((item) => item.batchId === batchId); }
  },
  actions: {
    persist() {
      // 合入其他标签页已入库、但本页尚未感知的批次/名单/审计，避免整态写回时挤掉别人的数据
      const disk = readDisk();
      if (disk) {
        const batchIds = new Set(this.batches.map((item) => item.id));
        const listIds = new Set(this.hitLists.map((item) => item.batchId));
        const auditIds = new Set(this.audit.map((item) => item.id));
        this.batches.push(...disk.batches.filter((item) => !batchIds.has(item.id)));
        this.hitLists.push(...disk.hitLists.filter((item) => !listIds.has(item.batchId)));
        this.audit.push(...disk.audit.filter((item) => !auditIds.has(item.id)));
      }
      localStorage.setItem(STORE_KEY, JSON.stringify(this.$state));
    },
    /** 另一个标签页写入 localStorage 后，把最新状态同步进本页 */
    hydrate() {
      const disk = readDisk();
      if (disk && JSON.stringify(disk) !== JSON.stringify(this.$state)) this.$patch(disk);
    },
    log(action: string, detail: string, batch?: GrayBatch) {
      this.audit.unshift({ id: `a-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, at: new Date().toLocaleTimeString(), actor: this.actor, action, detail, batchId: batch?.id, batchName: batch?.name });
      this.persist();
    },
    select(id: string) {
      this.activeId = id;
      this.activeBatchId = this.batchesOf(id)[0]?.id ?? '';
      this.persist();
    },
    selectBatch(id: string) { this.activeBatchId = id; this.persist(); },
    setActor(actor: string) { this.actor = actor; this.persist(); },

    /**
     * 保存批次：以磁盘快照为准做三方合并。
     * - 新批次直接入库（两个标签页各建各的批次都保留）；
     * - 版本号一致则干净保存，规则/比例变化时 ruleVersion+1、旧名单失效、放量中的批次暂停；
     * - 版本号落后说明另一标签页先保存了同一批次：保留磁盘版本，把本次内容挂为 pending 并标记冲突，等人确认。
     */
    saveBatch(input: BatchInput): 'saved' | 'conflict' {
      // 响应式 Proxy 不能 structuredClone，用 JSON 深拷贝
      const disk = readDisk() ?? (JSON.parse(JSON.stringify(this.$state)) as State);
      const target = disk.batches.find((item) => item.id === input.id);
      const now = new Date().toLocaleTimeString();
      if (!target) {
        disk.batches.push({ ...input, status: 'draft', ruleVersion: 1, version: 1, updatedAt: now, updatedBy: this.actor });
        this.$patch(disk);
        this.log('创建批次', `${input.name} · 优先级 ${input.priority} · ${input.rollout}%`, this.batches.find((item) => item.id === input.id));
        return 'saved';
      }
      if (target.version === input.version) {
        const ruleChanged = JSON.stringify(target.rules) !== JSON.stringify(input.rules) || target.rollout !== input.rollout;
        Object.assign(target, { name: input.name, priority: input.priority, rules: input.rules, rollout: input.rollout, version: target.version + 1, updatedAt: now, updatedBy: this.actor });
        if (ruleChanged) {
          target.ruleVersion += 1;
          disk.hitLists.forEach((item) => { if (item.batchId === target.id) item.stale = true; });
          if (target.status === 'active') target.status = 'paused';
          const flag = disk.flags.find((item) => item.id === target.flagId);
          if (flag) flag.status = 'draft';
          const plan = disk.plans.find((item) => item.flagId === target.flagId);
          if (plan) plan.approvals = [];
        }
        this.$patch(disk);
        const batch = this.batches.find((item) => item.id === input.id);
        this.log('保存批次', ruleChanged ? `规则变更 → v${target.ruleVersion}，旧命中名单已失效并停止放量` : `更新批次信息 · ${input.rollout}%`, batch);
        return 'saved';
      }
      target.status = 'conflict';
      target.pending = { name: input.name, priority: input.priority, rules: input.rules, rollout: input.rollout, savedBy: this.actor, savedAt: now };
      this.$patch(disk);
      this.log('并发冲突', `与 ${target.updatedBy} 的保存（v${target.version}）冲突，本次内容挂起待确认`, this.batches.find((item) => item.id === input.id));
      return 'conflict';
    },

    /** 人工确认冲突：保留磁盘当前版本，或采用被挂起的待确认版本 */
    resolveConflict(batchId: string, keep: 'current' | 'pending') {
      const batch = this.batches.find((item) => item.id === batchId);
      if (!batch?.pending) return;
      const pending = batch.pending;
      if (keep === 'pending') {
        const ruleChanged = JSON.stringify(batch.rules) !== JSON.stringify(pending.rules) || batch.rollout !== pending.rollout;
        Object.assign(batch, { name: pending.name, priority: pending.priority, rules: pending.rules, rollout: pending.rollout });
        if (ruleChanged) {
          batch.ruleVersion += 1;
          this.hitLists.forEach((item) => { if (item.batchId === batchId) item.stale = true; });
        }
      }
      batch.pending = undefined;
      batch.status = 'draft';
      batch.version += 1;
      batch.updatedBy = this.actor;
      batch.updatedAt = new Date().toLocaleTimeString();
      this.log('确认冲突', keep === 'pending' ? `采用 ${pending.savedBy} 的待确认版本` : '保留当前版本，放弃待确认修改', batch);
    },

    /** 按当前规则重算命中名单，旧名单作废 */
    computeHitList(batchId: string) {
      const batch = this.batches.find((item) => item.id === batchId);
      if (!batch) return;
      const list = buildHitList(batch);
      const index = this.hitLists.findIndex((item) => item.batchId === batchId);
      if (index >= 0) this.hitLists[index] = list; else this.hitLists.push(list);
      this.log('重算命中名单', `规则 v${batch.ruleVersion} · 命中 ${list.userIds.length} 人`, batch);
    },

    /** 启用批次放量：必须持有与当前规则版本一致的有效名单，旧名单一律拒绝 */
    activateBatch(batchId: string): boolean {
      const batch = this.batches.find((item) => item.id === batchId);
      if (!batch) return false;
      const list = this.hitLists.find((item) => item.batchId === batchId);
      if (!list || list.stale || list.ruleVersion !== batch.ruleVersion) {
        this.log('启用被拒', '命中名单缺失或已失效，需按当前规则重算后才能放量', batch);
        return false;
      }
      batch.status = 'active';
      batch.updatedBy = this.actor;
      batch.updatedAt = new Date().toLocaleTimeString();
      this.log('批次放量', `按名单 ${list.userIds.length} 人 · ${batch.rollout}% 放量`, batch);
      return true;
    },
    pauseBatch(batchId: string) {
      const batch = this.batches.find((item) => item.id === batchId);
      if (!batch) return;
      batch.status = 'paused';
      this.log('暂停批次', `${batch.name} 停止放量`, batch);
    },

    schedule(value: string) {
      if (!this.active || !this.activePlan) return;
      this.activePlan.scheduledAt = value;
      this.active.status = 'scheduled';
      this.log('设置定时', `${this.active.key} 于 ${value} 生效`);
    },
    approve(role: string) {
      if (!this.active || !this.activePlan || this.activePlan.approvals.includes(role)) return;
      this.activePlan.approvals.push(role);
      this.active.status = this.activePlan.approvals.length >= 2 ? 'approved' : 'draft';
      this.log('审批发布', `${role} 已确认 ${this.active.key}`, undefined);
    },
    startRollout() {
      if (!this.active || this.active.status !== 'approved') return;
      this.active.enabled = true;
      this.active.status = 'rolling';
      this.log('开始放量', `${this.active.key} 启用，按各批次名单灰度`);
    },
    emergencyStop() {
      if (!this.active) return;
      this.active.enabled = false;
      this.active.status = 'stopped';
      this.log('紧急停止', `${this.active.key} 已立即关闭`);
    },
    rollback() {
      if (!this.active) return;
      this.active.enabled = false;
      this.active.status = 'rolled-back';
      this.batches.forEach((item) => { if (item.flagId === this.activeId && item.status === 'active') item.status = 'paused'; });
      this.log('执行回滚', `${this.active.key} 回滚至关闭状态，全部批次暂停`);
    },

    /** 模拟命中：同一用户被多个批次覆盖时，按优先级取唯一结果 */
    simulateHit(user: SimUser): SimResult {
      const flag = this.active;
      if (!flag) return { hit: false, reason: '未选择开关', batchName: '', alsoMatched: [] };
      if (!flag.enabled) return { hit: false, reason: '开关未启用', batchName: '', alsoMatched: [] };
      const batches = this.batchesOf(flag.id).filter((item) => item.status !== 'conflict');
      const matched = batches.filter((item) => !rulesMatch(item, user));
      if (!matched.length) {
        const reason = batches.map((item) => rulesMatch(item, user)).find(Boolean);
        return { hit: false, reason: reason ?? '无任何批次覆盖该用户', batchName: '', alsoMatched: [] };
      }
      const winner = matched[0];
      const bucket = bucketOf(user.id);
      const hit = bucket < winner.rollout;
      const note = winner.status === 'active' ? '' : `（批次状态 ${winner.status}，仅模拟）`;
      return {
        hit,
        batchName: winner.name,
        alsoMatched: matched.slice(1).map((item) => item.name),
        reason: `按优先级命中「${winner.name}」${note} · 灰度桶 ${bucket} ${hit ? '<' : '≥'} ${winner.rollout}%`
      };
    }
  }
});
