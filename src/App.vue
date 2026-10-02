<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useOnline } from '@vueuse/core';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { useFlagStore } from './stores/flags';
import BatchCard from './components/BatchCard.vue';

const store = useFlagStore();
const online = useOnline();
const active = computed(() => store.active);
const batches = computed(() => store.activeBatches);
const createOpen = ref(false);
const simulation = ref<{ hit: boolean; reason: string; batchName?: string } | null>(null);
const user = reactive({ id: 'user-1042', region: '上海', appVersion: '8.3.0', authenticated: true });
const auditBatchFilter = ref<string>('all');

const schema = toTypedSchema(z.object({ name: z.string().min(3), key: z.string().regex(/^[a-z0-9-]+$/, '仅支持小写字母、数字和连字符') }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema });
const [name] = defineField('name');
const [key] = defineField('key');

const create = handleSubmit((values) => {
  const id = `f-${Date.now()}`;
  store.flags.push({ id, name: values.name, key: values.key, enabled: false, status: 'draft' });
  store.select(id);            // 先切换到新开关，addBatch 才会挂到新开关上
  store.addBatch('首批');
  store.audit('创建开关', `${values.key} 草稿版本 1`);
  createOpen.value = false; resetForm();
});

const filteredAudit = computed(() => {
  if (auditBatchFilter.value === 'all') return store.audit;
  if (auditBatchFilter.value === '__none__') return store.audit.filter((a) => !a.batchId);
  return store.audit.filter((a) => a.batchId === auditBatchFilter.value);
});

function simulate() { if (active.value) simulation.value = store.simulateHit(user); }
function statusColor(status?: string) { return status === 'rolling' ? 'green' : status === 'approved' ? 'blue' : status === 'stopped' || status === 'rolled-back' ? 'red' : 'gold'; }
</script>

<template>
  <a-config-provider><a-layout class="app-shell">
    <a-layout-header class="topbar"><div><div class="eyebrow">FEATURE FLAG / PORT 62023</div><h1>{{ $t('title') }}</h1></div><a-space><a-tag :color="online ? 'green' : 'orange'">{{ online ? '控制面在线' : '离线草稿' }}</a-tag><a-button type="primary" @click="createOpen = true">新建功能开关</a-button></a-space></a-layout-header>
    <a-layout-content class="content">
      <a-alert v-if="!online" type="warning" show-icon message="离线状态" description="规则修改保留在浏览器，恢复网络后仍需完成审批才能发布。" class="mb" />
      <a-row :gutter="[18,18]">
        <a-col :xs="24" :lg="7">
          <a-card title="功能开关" size="small">
            <a-list :data-source="store.flags" bordered>
              <template #renderItem="{ item }">
                <a-list-item :class="{ selected: item.id === store.activeId }" @click="store.select(item.id)">
                  <a-list-item-meta>
                    <template #title><a-space><span>{{ item.name }}</span><a-tag :color="statusColor(item.status)">{{ item.status }}</a-tag></a-space></template>
                    <template #description><code>{{ item.key }}</code> · {{ store.activeId === item.id ? batches.length : store.batches.filter((b) => b.flagId === item.id).length }} 个批次</template>
                  </a-list-item-meta>
                </a-list-item>
              </template>
            </a-list>
          </a-card>
          <a-card title="规则命中模拟" size="small" class="mt">
            <a-form layout="vertical">
              <a-form-item label="用户 ID"><a-input v-model:value="user.id" /></a-form-item>
              <a-row :gutter="8"><a-col :span="12"><a-form-item label="地区"><a-input v-model:value="user.region" /></a-form-item></a-col><a-col :span="12"><a-form-item label="版本"><a-input v-model:value="user.appVersion" /></a-form-item></a-col></a-row>
              <a-checkbox v-model:checked="user.authenticated">已登录</a-checkbox>
              <a-button type="primary" block class="mt" @click="simulate">{{ $t('simulate') }}</a-button>
            </a-form>
            <a-alert v-if="simulation" class="mt" :type="simulation.hit ? 'success' : 'info'" show-icon :message="simulation.hit ? `命中「${simulation.batchName}」` : '未命中'" :description="simulation.reason" />
          </a-card>
        </a-col>
        <a-col :xs="24" :lg="17">
          <template v-if="active">
            <a-card :title="active.name" class="mb">
              <template #extra><a-space><a-tag :color="statusColor(active.status)">{{ active.status }}</a-tag><a-button danger :disabled="!active.enabled" @click="store.emergencyStop">紧急停止</a-button><a-button danger ghost @click="store.rollback">全部回滚</a-button></a-space></template>
              <a-descriptions bordered :column="{ xs: 1, md: 3 }">
                <a-descriptions-item label="开关 Key"><code>{{ active.key }}</code></a-descriptions-item>
                <a-descriptions-item label="批次数">{{ batches.length }}</a-descriptions-item>
                <a-descriptions-item label="状态">{{ active.enabled ? '已启用' : '已关闭' }}</a-descriptions-item>
              </a-descriptions>
              <a-alert class="mt" type="info" show-icon message="多批次灰度" description="同一开关可保留多个灰度批次，每批带独立规则与放量比例；同一用户命中多批时按优先级（#数字越小越优先）得出一个结果。规则或放量变更后命中名单立即失效，需重算后才能继续放量。" />
            </a-card>

            <a-card class="mb">
              <template #title>灰度批次</template>
              <template #extra><a-space><a-button size="small" @click="store.recomputeHitLists">重算全部命中名单</a-button><a-button size="small" type="primary" @click="store.addBatch()">新增批次</a-button></a-space></template>
              <BatchCard v-for="b in batches" :key="b.id" :batch="b" />
              <a-empty v-if="!batches.length" description="暂无批次，点击右上角新增" />
            </a-card>

            <a-card title="审计记录">
              <template #extra>
                <a-select size="small" style="width: 180px" v-model:value="auditBatchFilter" :options="[{ value: 'all', label: '全部批次' }, { value: '__none__', label: '开关级' }, ...batches.map((b) => ({ value: b.id, label: b.name }))]" />
              </template>
              <a-timeline>
                <a-timeline-item v-for="item in filteredAudit" :key="item.id" :color="item.action.includes('停止') || item.action.includes('回滚') || item.action.includes('冲突') ? 'red' : 'blue'">
                  <b>{{ item.at }} · {{ item.actor }}</b>
                  <a-tag v-if="item.batchName" color="purple" class="ml">{{ item.batchName }}</a-tag>
                  <p>{{ item.action }}：{{ item.detail }}</p>
                </a-timeline-item>
              </a-timeline>
            </a-card>
          </template>
        </a-col>
      </a-row>
    </a-layout-content>
    <a-modal v-model:open="createOpen" title="新建功能开关" @ok="create"><a-form layout="vertical"><a-form-item label="展示名称" :validate-status="errors.name ? 'error' : ''" :help="errors.name"><a-input v-model:value="name" /></a-form-item><a-form-item label="开关 Key" :validate-status="errors.key ? 'error' : ''" :help="errors.key"><a-input v-model:value="key" /></a-form-item></a-form></a-modal>
  </a-layout></a-config-provider>
</template>

<style>
* { box-sizing: border-box; }
body { margin: 0; background: #f4f6fb; font-family: Inter, "PingFang SC", sans-serif; }
.app-shell { min-height: 100vh; background: transparent; }
.topbar { height: auto; min-height: 88px; display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 16px 32px; color: white; background: linear-gradient(120deg, #111827, #312e81); }
.topbar h1 { color: white; margin: 3px 0; font-size: 25px; }
.eyebrow { color: #a5b4fc; font-size: 11px; letter-spacing: .13em; }
.content { max-width: 1400px; width: 100%; margin: 0 auto; padding: 24px; }.mb { margin-bottom: 18px; }.mt { margin-top: 14px; }.selected { background: #eef2ff; cursor: pointer; }.rollout-label { color: #4338ca; font-weight: 700; }.ant-list-item { cursor: pointer; }
.ml { margin-left: 8px; }
@media (max-width: 720px) { .topbar { padding: 18px; flex-direction: column; align-items: flex-start; }.content { padding: 16px; } }
</style>
