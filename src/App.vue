<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { useOnline } from '@vueuse/core';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { message } from 'ant-design-vue';
import { STORE_KEY, useFlagStore, type GrayBatch } from './stores/flags';

const store = useFlagStore();
const online = useOnline();
const active = computed(() => store.active);
const plan = computed(() => store.activePlan);
const batches = computed(() => (active.value ? store.batchesOf(active.value.id) : []));
const activeBatch = computed(() => store.activeBatch);
const activeHitList = computed(() => (activeBatch.value ? store.hitListOf(activeBatch.value.id) : undefined));
const hitListFresh = computed(() => Boolean(activeBatch.value && activeHitList.value && !activeHitList.value.stale && activeHitList.value.ruleVersion === activeBatch.value.ruleVersion));

// 另一个标签页保存后，通过 storage 事件同步本页状态
function onStorage(event: StorageEvent) { if (event.key === STORE_KEY) store.hydrate(); }
onMounted(() => window.addEventListener('storage', onStorage));
onUnmounted(() => window.removeEventListener('storage', onStorage));

// ---------- 新建开关 ----------
const createOpen = ref(false);
const schema = toTypedSchema(z.object({ name: z.string().min(3), key: z.string().regex(/^[a-z0-9-]+$/, '仅支持小写字母、数字和连字符') }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema });
const [name] = defineField('name');
const [key] = defineField('key');
const create = handleSubmit((values) => {
  const id = `f-${Date.now()}`;
  store.flags.push({ id, name: values.name, key: values.key, enabled: false, status: 'draft' });
  store.plans.push({ id: `p-${Date.now()}`, flagId: id, scheduledAt: '2026-10-02T10:00', approvals: [], version: 1 });
  store.batches.push({ id: `b-${Date.now()}`, flagId: id, name: '第一批', priority: 1, rules: { region: '全部', appVersion: '>= 1.0', authenticated: false }, rollout: 10, status: 'draft', ruleVersion: 1, version: 1, updatedAt: new Date().toLocaleTimeString(), updatedBy: store.actor });
  store.select(id);
  store.log('创建开关', `${values.key} · 初始批次「第一批」`);
  createOpen.value = false;
  resetForm();
});

// ---------- 批次编辑 ----------
const editorOpen = ref(false);
const editor = reactive({ id: '', flagId: '', name: '', priority: 1, region: '全部', appVersion: '>= 1.0', authenticated: false, rollout: 10, version: 0 });
const regionOptions = ['全部', '上海', '北京', '广东', '深圳'].map((value) => ({ value, label: value }));
function openCreateBatch() {
  if (!active.value) return;
  Object.assign(editor, { id: `b-${Date.now()}`, flagId: active.value.id, name: `第 ${batches.value.length + 1} 批`, priority: batches.value.length + 1, region: '全部', appVersion: '>= 1.0', authenticated: false, rollout: 10, version: 0 });
  editorOpen.value = true;
}
function openEditBatch(batch: GrayBatch) {
  Object.assign(editor, { id: batch.id, flagId: batch.flagId, name: batch.name, priority: batch.priority, region: batch.rules.region, appVersion: batch.rules.appVersion, authenticated: batch.rules.authenticated, rollout: batch.rollout, version: batch.version });
  editorOpen.value = true;
}
function saveEditor() {
  const result = store.saveBatch({ id: editor.id, flagId: editor.flagId, name: editor.name, priority: editor.priority, rules: { region: editor.region, appVersion: editor.appVersion, authenticated: editor.authenticated }, rollout: editor.rollout, version: editor.version });
  editorOpen.value = false;
  if (result === 'conflict') message.warning('另一标签页已先保存该批次，本次内容已挂起，待人工确认冲突');
  else message.success('批次已保存');
}

// ---------- 冲突确认 ----------
const conflictBatch = ref<GrayBatch | null>(null);
function resolveConflict(keep: 'current' | 'pending') {
  if (conflictBatch.value) store.resolveConflict(conflictBatch.value.id, keep);
  conflictBatch.value = null;
}

// ---------- 命中名单 ----------
function listState(batch: GrayBatch): { text: string; color: string } {
  const list = store.hitListOf(batch.id);
  if (!list) return { text: '未计算', color: 'default' };
  if (list.stale || list.ruleVersion !== batch.ruleVersion) return { text: `已失效（v${list.ruleVersion}）`, color: 'orange' };
  return { text: `v${list.ruleVersion} · ${list.userIds.length} 人`, color: 'green' };
}
function activate(batch: GrayBatch) {
  if (!store.activateBatch(batch.id)) message.error('命中名单缺失或已失效，请先按当前规则重算名单');
}

// ---------- 模拟 ----------
const simulation = ref<ReturnType<typeof store.simulateHit> | null>(null);
const user = reactive({ id: 'u-1001', region: '上海', appVersion: '8.3.0', authenticated: true });
function simulate() { simulation.value = store.simulateHit(user); }

// ---------- 审计过滤 ----------
const auditFilter = ref('all');
const filteredAudit = computed(() => store.audit.filter((item) => {
  if (auditFilter.value === 'all') return true;
  if (auditFilter.value === 'flag') return !item.batchId;
  return item.batchId === auditFilter.value;
}));

const batchColumns = [
  { title: '批次', key: 'name' },
  { title: '优先级', key: 'priority', width: 72 },
  { title: '规则', key: 'rules' },
  { title: '放量', key: 'rollout', width: 64 },
  { title: '状态', key: 'status', width: 96 },
  { title: '命中名单', key: 'hitlist', width: 132 },
  { title: '操作', key: 'actions', width: 250 }
];
const batchStatusText: Record<string, string> = { draft: '编辑中', active: '放量中', paused: '已暂停', conflict: '冲突待确认' };
const batchStatusColor: Record<string, string> = { draft: 'gold', active: 'green', paused: 'orange', conflict: 'red' };
function statusColor(status?: string) { return status === 'rolling' ? 'green' : status === 'approved' ? 'blue' : status === 'stopped' || status === 'rolled-back' ? 'red' : 'gold'; }
</script>

<template>
  <a-config-provider><a-layout class="app-shell">
    <a-layout-header class="topbar">
      <div><div class="eyebrow">FEATURE FLAG / PORT 62023</div><h1>{{ $t('title') }}</h1></div>
      <a-space>
        <a-tag :color="online ? 'green' : 'orange'">{{ online ? '控制面在线' : '离线草稿' }}</a-tag>
        <a-select :value="store.actor" style="width: 132px" :options="['产品负责人', '研发负责人', '值班人员', '运营'].map((value) => ({ value, label: value }))" @change="(value: string) => store.setActor(value)" />
        <a-button type="primary" @click="createOpen = true">新建功能开关</a-button>
      </a-space>
    </a-layout-header>
    <a-layout-content class="content">
      <a-alert v-if="!online" type="warning" show-icon message="离线状态" description="批次修改保留在浏览器，恢复网络后仍需完成审批才能发布。" class="mb" />
      <a-row :gutter="[18, 18]">
        <a-col :xs="24" :lg="7">
          <a-card title="功能开关" size="small">
            <a-list :data-source="store.flags" bordered>
              <template #renderItem="{ item }">
                <a-list-item :class="{ selected: item.id === store.activeId }" @click="store.select(item.id)">
                  <a-list-item-meta>
                    <template #title><a-space><span>{{ item.name }}</span><a-tag :color="statusColor(item.status)">{{ item.status }}</a-tag></a-space></template>
                    <template #description><code>{{ item.key }}</code> · {{ store.batchesOf(item.id).length }} 个批次</template>
                  </a-list-item-meta>
                </a-list-item>
              </template>
            </a-list>
          </a-card>
          <a-card title="规则命中模拟" size="small" class="mt">
            <a-form layout="vertical">
              <a-form-item label="用户 ID"><a-input v-model:value="user.id" /></a-form-item>
              <a-row :gutter="8">
                <a-col :span="12"><a-form-item label="地区"><a-input v-model:value="user.region" /></a-form-item></a-col>
                <a-col :span="12"><a-form-item label="版本"><a-input v-model:value="user.appVersion" /></a-form-item></a-col>
              </a-row>
              <a-checkbox v-model:checked="user.authenticated">已登录</a-checkbox>
              <a-button type="primary" block class="mt" @click="simulate">{{ $t('simulate') }}</a-button>
            </a-form>
            <a-alert v-if="simulation" class="mt" :type="simulation.hit ? 'success' : 'info'" show-icon :message="simulation.hit ? `命中新功能 · ${simulation.batchName}` : '未命中'" :description="simulation.reason" />
            <a-alert v-if="simulation?.alsoMatched.length" class="mt" type="warning" show-icon message="多批次覆盖" :description="`该用户同时被「${simulation.alsoMatched.join('」「')}」覆盖，已按优先级取「${simulation.batchName}」作为唯一结果。`" />
          </a-card>
        </a-col>
        <a-col :xs="24" :lg="17">
          <template v-if="active && plan">
            <a-card :title="active.name" class="mb">
              <template #extra>
                <a-space>
                  <a-tag :color="statusColor(active.status)">{{ active.status }}</a-tag>
                  <a-button danger :disabled="!active.enabled" @click="store.emergencyStop">紧急停止</a-button>
                  <a-button danger ghost @click="store.rollback">回滚</a-button>
                </a-space>
              </template>
              <a-descriptions bordered :column="{ xs: 1, md: 3 }">
                <a-descriptions-item label="开关 Key"><code>{{ active.key }}</code></a-descriptions-item>
                <a-descriptions-item label="审批">{{ plan.approvals.join('、') || '待审批' }}</a-descriptions-item>
                <a-descriptions-item label="定时生效">{{ plan.scheduledAt }}</a-descriptions-item>
              </a-descriptions>
              <a-divider>定时与审批</a-divider>
              <a-space wrap>
                <a-input type="datetime-local" :value="plan.scheduledAt" @change="(event: Event) => store.schedule((event.target as HTMLInputElement).value)" />
                <a-button :disabled="plan.approvals.includes('产品负责人')" @click="store.approve('产品负责人')">产品审批</a-button>
                <a-button :disabled="plan.approvals.includes('研发负责人')" @click="store.approve('研发负责人')">研发审批</a-button>
                <a-button type="primary" :disabled="active.status !== 'approved'" @click="store.startRollout">开始灰度发布</a-button>
              </a-space>
            </a-card>

            <a-card title="灰度批次" class="mb">
              <template #extra><a-button type="primary" size="small" @click="openCreateBatch">新建批次</a-button></template>
              <a-alert v-if="batches.some((item) => item.status === 'conflict')" type="error" show-icon class="mb" message="存在并发保存冲突" description="标红的批次被两个标签页同时修改，已双双入库，请确认保留哪个版本。" />
              <a-table :data-source="batches" :columns="batchColumns" :pagination="false" size="small" row-key="id"
                :row-class-name="(record: GrayBatch) => record.id === store.activeBatchId ? 'row-selected' : ''"
                :custom-row="(record: GrayBatch) => ({ onClick: () => store.selectBatch(record.id) })">
                <template #bodyCell="{ column, record }">
                  <template v-if="column.key === 'name'">
                    <a-badge v-if="record.status === 'conflict'" status="error" /><b>{{ record.name }}</b>
                    <div class="cell-sub">v{{ record.version }} · {{ record.updatedBy }} · {{ record.updatedAt }}</div>
                  </template>
                  <template v-else-if="column.key === 'priority'"><a-tag color="blue">P{{ record.priority }}</a-tag></template>
                  <template v-else-if="column.key === 'rules'">
                    <span>{{ record.rules.region }} · {{ record.rules.appVersion }} · {{ record.rules.authenticated ? '需登录' : '不限登录' }}</span>
                    <div class="cell-sub">规则 v{{ record.ruleVersion }}</div>
                  </template>
                  <template v-else-if="column.key === 'rollout'"><b class="rollout-label">{{ record.rollout }}%</b></template>
                  <template v-else-if="column.key === 'status'"><a-tag :color="batchStatusColor[record.status]">{{ batchStatusText[record.status] }}</a-tag></template>
                  <template v-else-if="column.key === 'hitlist'"><a-tag :color="listState(record).color">{{ listState(record).text }}</a-tag></template>
                  <template v-else-if="column.key === 'actions'">
                    <a-space :size="4" wrap>
                      <a-button size="small" @click.stop="openEditBatch(record)">编辑</a-button>
                      <a-button size="small" @click.stop="store.computeHitList(record.id)">重算名单</a-button>
                      <a-button v-if="record.status === 'conflict'" size="small" danger @click.stop="conflictBatch = record">处理冲突</a-button>
                      <a-button v-else-if="record.status !== 'active'" size="small" type="primary" :disabled="listState(record).color !== 'green'" @click.stop="activate(record)">启用</a-button>
                      <a-button v-else size="small" @click.stop="store.pauseBatch(record.id)">暂停</a-button>
                    </a-space>
                  </template>
                </template>
              </a-table>
            </a-card>

            <a-card v-if="activeBatch" :title="`命中名单 · ${activeBatch.name}`" class="mb">
              <template #extra><a-button size="small" type="primary" @click="store.computeHitList(activeBatch.id)">按当前规则重算</a-button></template>
              <a-alert v-if="activeHitList && !hitListFresh" type="warning" show-icon class="mb"
                message="名单已失效，停止按旧名单放量"
                :description="`名单按规则 v${activeHitList.ruleVersion} 计算，当前规则为 v${activeBatch.ruleVersion}。模拟与列表均以新规则为准，请重算后再启用。`" />
              <template v-if="activeHitList">
                <p class="cell-sub">规则 v{{ activeHitList.ruleVersion }} · 计算于 {{ activeHitList.computedAt }} · 共 {{ activeHitList.userIds.length }} 人</p>
                <a-space :size="4" wrap><a-tag v-for="id in activeHitList.userIds" :key="id" :color="hitListFresh ? 'green' : 'default'">{{ id }}</a-tag></a-space>
              </template>
              <a-empty v-else description="尚未计算命中名单" />
            </a-card>

            <a-card title="审计记录">
              <template #extra>
                <a-select v-model:value="auditFilter" size="small" style="width: 200px"
                  :options="[{ value: 'all', label: '全部记录' }, { value: 'flag', label: '仅开关级' }, ...batches.map((item) => ({ value: item.id, label: `批次：${item.name}` }))]" />
              </template>
              <a-timeline>
                <a-timeline-item v-for="item in filteredAudit" :key="item.id" :color="item.action.includes('停止') || item.action.includes('回滚') || item.action.includes('冲突') ? 'red' : 'blue'">
                  <b>{{ item.at }} · {{ item.actor }}</b>
                  <a-tag v-if="item.batchName" color="purple">{{ item.batchName }}</a-tag>
                  <p>{{ item.action }}：{{ item.detail }}</p>
                </a-timeline-item>
              </a-timeline>
            </a-card>
          </template>
        </a-col>
      </a-row>
    </a-layout-content>

    <a-modal v-model:open="createOpen" title="新建功能开关" @ok="create">
      <a-form layout="vertical">
        <a-form-item label="展示名称" :validate-status="errors.name ? 'error' : ''" :help="errors.name"><a-input v-model:value="name" /></a-form-item>
        <a-form-item label="开关 Key" :validate-status="errors.key ? 'error' : ''" :help="errors.key"><a-input v-model:value="key" /></a-form-item>
      </a-form>
    </a-modal>

    <a-modal v-model:open="editorOpen" title="编辑灰度批次" @ok="saveEditor">
      <a-form layout="vertical">
        <a-form-item label="批次名称"><a-input v-model:value="editor.name" /></a-form-item>
        <a-row :gutter="12">
          <a-col :span="12"><a-form-item label="优先级（小者优先）"><a-input-number v-model:value="editor.priority" :min="1" style="width: 100%" /></a-form-item></a-col>
          <a-col :span="12"><a-form-item label="目标地区"><a-select v-model:value="editor.region" :options="regionOptions" /></a-form-item></a-col>
        </a-row>
        <a-form-item label="客户端版本"><a-input v-model:value="editor.appVersion" placeholder="如 >= 8.2" /></a-form-item>
        <a-form-item label="登录要求"><a-switch v-model:checked="editor.authenticated" /></a-form-item>
        <a-form-item :label="`放量比例 ${editor.rollout}%`"><a-slider v-model:value="editor.rollout" :min="0" :max="100" :step="5" /></a-form-item>
      </a-form>
    </a-modal>

    <a-modal :open="!!conflictBatch" title="确认并发冲突" :footer="null" @cancel="conflictBatch = null">
      <template v-if="conflictBatch?.pending">
        <a-alert type="warning" show-icon class="mb" message="两个标签页同时保存了该批次" description="两个版本都已入库，请选择保留哪一个，未被选中的修改将作废。" />
        <a-row :gutter="12">
          <a-col :span="12">
            <a-card size="small" title="当前入库版本">
              <p>{{ conflictBatch.name }} · P{{ conflictBatch.priority }} · {{ conflictBatch.rollout }}%</p>
              <p class="cell-sub">{{ conflictBatch.rules.region }} · {{ conflictBatch.rules.appVersion }} · {{ conflictBatch.rules.authenticated ? '需登录' : '不限登录' }}</p>
              <p class="cell-sub">{{ conflictBatch.updatedBy }} 保存于 {{ conflictBatch.updatedAt }}</p>
              <a-button block @click="resolveConflict('current')">保留当前版本</a-button>
            </a-card>
          </a-col>
          <a-col :span="12">
            <a-card size="small" title="待确认版本">
              <p>{{ conflictBatch.pending.name }} · P{{ conflictBatch.pending.priority }} · {{ conflictBatch.pending.rollout }}%</p>
              <p class="cell-sub">{{ conflictBatch.pending.rules.region }} · {{ conflictBatch.pending.rules.appVersion }} · {{ conflictBatch.pending.rules.authenticated ? '需登录' : '不限登录' }}</p>
              <p class="cell-sub">{{ conflictBatch.pending.savedBy }} 保存于 {{ conflictBatch.pending.savedAt }}</p>
              <a-button block type="primary" @click="resolveConflict('pending')">采用待确认版本</a-button>
            </a-card>
          </a-col>
        </a-row>
      </template>
    </a-modal>
  </a-layout></a-config-provider>
</template>

<style>
* { box-sizing: border-box; }
body { margin: 0; background: #f4f6fb; font-family: Inter, "PingFang SC", sans-serif; }
.app-shell { min-height: 100vh; background: transparent; }
.topbar { height: auto; min-height: 88px; display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 16px 32px; color: white; background: linear-gradient(120deg, #111827, #312e81); }
.topbar h1 { color: white; margin: 3px 0; font-size: 25px; }
.eyebrow { color: #a5b4fc; font-size: 11px; letter-spacing: .13em; }
.content { max-width: 1400px; width: 100%; margin: 0 auto; padding: 24px; }
.mb { margin-bottom: 18px; }
.mt { margin-top: 14px; }
.selected { background: #eef2ff; cursor: pointer; }
.rollout-label { color: #4338ca; font-weight: 700; }
.ant-list-item { cursor: pointer; }
.row-selected { background: #eef2ff; }
.cell-sub { color: #8c8c8c; font-size: 12px; }
@media (max-width: 720px) { .topbar { padding: 18px; flex-direction: column; align-items: flex-start; } .content { padding: 16px; } }
</style>
