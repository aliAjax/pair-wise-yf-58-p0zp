<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useFlagStore, type GrayBatch } from '../stores/flags';

const props = defineProps<{ batch: GrayBatch }>();
const store = useFlagStore();

const REGION_OPTIONS = ['全部', '上海', '北京', '广东', '深圳', '杭州', '成都'];

const draft = reactive({
  name: props.batch.name,
  rules: { ...props.batch.rules },
  rollout: props.batch.rollout,
  scheduledAt: props.batch.scheduledAt
});
const expectedVersion = ref(props.batch.version);
const savedHint = ref(false);
const actionMsg = ref<{ type: 'success' | 'error'; text: string } | null>(null);

const stale = computed(() => props.batch.hitListRulesVersion !== props.batch.rulesVersion);
const externalUpdate = computed(() => props.batch.version !== expectedVersion.value);

function refresh() {
  draft.name = props.batch.name;
  draft.rules = { ...props.batch.rules };
  draft.rollout = props.batch.rollout;
  draft.scheduledAt = props.batch.scheduledAt;
  expectedVersion.value = props.batch.version;
}

function save() {
  const result = store.saveBatch(props.batch.id, {
    name: draft.name,
    rules: { ...draft.rules },
    rollout: draft.rollout,
    scheduledAt: draft.scheduledAt
  }, expectedVersion.value);
  if (result.ok) {
    expectedVersion.value = store.batchById(props.batch.id)?.version ?? expectedVersion.value;
    savedHint.value = true;
    window.setTimeout(() => { savedHint.value = false; }, 2000);
  }
}

function start() {
  const result = store.startBatch(props.batch.id);
  if (!result.ok) { actionMsg.value = { type: 'error', text: result.reason ?? '无法开始放量' }; return; }
  actionMsg.value = { type: 'success', text: `批次「${props.batch.name}」已开始放量` };
}

function statusColor(status?: string) {
  return status === 'rolling' ? 'green' : status === 'approved' ? 'blue' : status === 'stopped' || status === 'rolled-back' ? 'red' : 'gold';
}
</script>

<template>
  <a-card size="small" class="batch-card" :class="{ 'batch-conflict': batch.conflict }">
    <template #title>
      <a-space wrap>
        <span class="batch-priority">#{{ batch.priority }}</span>
        <a-input v-model:value="draft.name" size="small" style="width: 160px" />
        <a-tag :color="statusColor(batch.status)">{{ batch.status }}</a-tag>
        <a-tag v-if="stale" color="orange">名单已失效</a-tag>
        <a-tag v-if="batch.conflict" color="red">冲突待确认</a-tag>
        <a-tag v-if="externalUpdate" color="purple">外部已更新</a-tag>
      </a-space>
    </template>
    <template #extra>
      <a-space>
        <a-button size="small" @click="store.moveBatch(batch.id, -1)" :disabled="batch.priority <= 1">↑</a-button>
        <a-button size="small" @click="store.moveBatch(batch.id, 1)">↓</a-button>
        <a-popconfirm title="确定删除该批次？" @confirm="store.removeBatch(batch.id)"><a-button size="small" danger>删除</a-button></a-popconfirm>
      </a-space>
    </template>

    <a-alert v-if="batch.conflict" type="error" show-icon class="mb"
      message="并发冲突：该批次被两个标签页同时修改"
      :description="batch.conflictNote || '已保留对方数据，请确认后再编辑。'"
      action="确认"
      @click="store.resolveConflict(batch.id)">
      <template #action><a-button size="small" danger @click="store.resolveConflict(batch.id)">确认</a-button></template>
    </a-alert>
    <a-alert v-if="externalUpdate && !batch.conflict" type="warning" show-icon class="mb"
      message="其他标签页已更新该批次"
      action="刷新"
      @click="refresh">
      <template #action><a-button size="small" @click="refresh">刷新</a-button></template>
    </a-alert>
    <a-alert v-if="stale && !batch.conflict" type="warning" show-icon class="mb"
      message="命中名单已失效"
      description="规则或放量已变更，旧名单不能继续放量，请重算命中名单后再开始灰度。" />
    <a-alert v-if="actionMsg" class="mb" :type="actionMsg.type" show-icon :message="actionMsg.text" @close="actionMsg = null" />

    <a-form layout="vertical">
      <a-row :gutter="12">
        <a-col :span="8"><a-form-item label="目标地区">
          <a-select v-model:value="draft.rules.region" :options="REGION_OPTIONS.map((v) => ({ value: v, label: v }))" />
        </a-form-item></a-col>
        <a-col :span="8"><a-form-item label="客户端版本">
          <a-input v-model:value="draft.rules.appVersion" />
        </a-form-item></a-col>
        <a-col :span="8"><a-form-item label="登录要求">
          <a-switch :checked="draft.rules.authenticated" @change="(v: boolean) => (draft.rules.authenticated = v)" />
        </a-form-item></a-col>
      </a-row>
      <a-form-item label="放量比例"><a-slider v-model:value="draft.rollout" :min="0" :max="100" :step="5" /></a-form-item>
      <div class="rollout-label">{{ draft.rollout }}% 用户可命中</div>
      <a-form-item label="定时生效"><a-input v-model:value="draft.scheduledAt" placeholder="2026-10-02T10:00" /></a-form-item>
    </a-form>

    <a-space wrap class="mb">
      <a-button type="primary" size="small" @click="save">保存本批</a-button>
      <span v-if="savedHint" class="saved-hint">已保存</span>
      <a-tag v-for="a in batch.approvals" :key="a" color="green">{{ a }}</a-tag>
      <a-button size="small" :disabled="batch.approvals.includes('产品负责人')" @click="store.approveBatch(batch.id, '产品负责人')">产品审批</a-button>
      <a-button size="small" :disabled="batch.approvals.includes('研发负责人')" @click="store.approveBatch(batch.id, '研发负责人')">研发审批</a-button>
    </a-space>

    <a-divider style="margin: 10px 0" />
    <a-space wrap>
      <a-button type="primary" size="small" :disabled="batch.conflict || stale || batch.approvals.length < 2 || batch.status === 'rolling'" @click="start">开始放量</a-button>
      <a-button size="small" :disabled="batch.status !== 'rolling'" @click="store.stopBatch(batch.id)">停止</a-button>
      <a-button size="small" danger ghost @click="store.rollbackBatch(batch.id)">回滚</a-button>
      <a-tag color="blue">命中 {{ batch.hitList.length }} 人</a-tag>
    </a-space>

    <a-collapse ghost class="mt">
      <a-collapse-panel key="hitlist" header="命中名单">
        <a-list size="small" :data-source="batch.hitList" :locale="{ emptyText: '暂无命中用户' }" bordered>
          <template #renderItem="{ item }">
            <a-list-item><code>{{ item.id }}</code> · {{ item.region }} · {{ item.appVersion }} · 桶 {{ item.bucket }}</a-list-item>
          </template>
        </a-list>
      </a-collapse-panel>
    </a-collapse>
  </a-card>
</template>

<style scoped>
.batch-card { margin-bottom: 14px; border-left: 3px solid #e5e7eb; }
.batch-conflict { border-left-color: #ef4444; background: #fef2f2; }
.batch-priority { font-weight: 700; color: #4338ca; }
.rollout-label { color: #4338ca; font-weight: 700; margin-bottom: 12px; }
.saved-hint { color: #16a34a; font-size: 12px; }
.mt { margin-top: 10px; }
.mb { margin-bottom: 10px; }
</style>
