<script lang="ts">
  import { enhance } from '$app/forms'
  import type { SubmitFunction } from '@sveltejs/kit'
  import type { ActionData } from './$types'
  import { curriculumStore } from '$lib/stores'
  import type { ReviewItem } from '$lib/seed'
  let { form }: { form: ActionData } = $props()
  let selectedIds = $state<string[]>([])
  let reviewComments = $state<Record<string, string>>({})
  let editingEvidenceId = $state<string | null>(null)
  let evidenceDraft = $state('')
  const pending = $derived($curriculumStore.reviewItems.filter((item) => item.status === '待审阅'))
  const courseNames = $derived($curriculumStore.nodes.filter((node) => node.type === '课程'))
  const requirements = $derived($curriculumStore.nodes.filter((node) => node.type === '毕业要求'))

  function review(item: ReviewItem, status: '已附议' | '已退回') {
    curriculumStore.updateReview(item.id, status, reviewComments[item.id] || (status === '已附议' ? '证据充分，同意纳入修订。' : '请补充可验证的评分记录。'))
  }

  function bulkApprove() {
    selectedIds.forEach((id) => {
      const item = $curriculumStore.reviewItems.find((entry) => entry.id === id)
      if (item) curriculumStore.updateReview(id, '已附议', '批量附议：证据链完整。')
    })
    selectedIds = []
  }

  function startEditEvidence(item: ReviewItem) {
    editingEvidenceId = item.id
    evidenceDraft = item.evidence
  }

  function saveEvidence(id: string) {
    if (evidenceDraft.trim().length >= 12) {
      curriculumStore.editEvidence(id, evidenceDraft.trim())
      editingEvidenceId = null
    }
  }

  const handleSubmit: SubmitFunction = () => {
    return async ({ result, formElement }) => {
      if (result.type === 'success') {
        const item = (result.data as { item?: ReviewItem } | undefined)?.item
        if (item) curriculumStore.submitRevision(item)
        formElement.reset()
      }
    }
  }
</script>

<svelte:head><title>课程改革审阅</title></svelte:head>

<section class="page">
  <div class="page-head">
    <div><p class="eyebrow">REFORM REVIEW / 改革审阅</p><h1>修订提交与逐项审阅</h1><p class="muted">Form Actions 在服务端使用 Zod 校验；退回必须补充证据要求。</p></div>
    <div class="actions"><button class="btn-secondary" disabled={selectedIds.length === 0} onclick={bulkApprove}>批量附议 {selectedIds.length ? `(${selectedIds.length})` : ''}</button><button class="btn-secondary" onclick={() => window.print()}>打印审阅单</button></div>
  </div>

  {#if form?.success}
    <div class="notice success">修订 {form.item?.id} 已提交，进入院系审阅队列。</div>
  {:else if form?.errors}
    <div class="notice error">表单未通过校验：{Object.values(form.errors).flat().join('；')}</div>
  {/if}

  {#if $curriculumStore.invalidations.length > 0}
    <div class="notice invalidated">有 {$curriculumStore.invalidations.length} 项审阅结论因映射或证据变更已失效，需重新审阅；旧结论仍可在条目下追溯。</div>
  {/if}

  <div class="review-layout">
    <section class="panel">
      <div class="panel-head"><h3>审阅队列</h3><span class="muted">{pending.length} 项待处理</span></div>
      <div class="review-list">
        {#each $curriculumStore.reviewItems as item}
          <article class:selected={selectedIds.includes(item.id)}>
            <div class="select"><input type="checkbox" checked={selectedIds.includes(item.id)} onchange={(event) => selectedIds = event.currentTarget.checked ? [...selectedIds, item.id] : selectedIds.filter((id) => id !== item.id)} /></div>
            <div class="review-main">
              <div class="review-title">
                <strong>{item.id} · {courseNames.find((node) => node.id === item.courseId)?.label.split('\n')[0]}</strong>
                <span class:approved={item.status === '已附议'} class:returned={item.status === '已退回'}>{item.status}</span>
              </div>
              {#if editingEvidenceId === item.id}
                <div class="evidence-edit">
                  <textarea bind:value={evidenceDraft} rows="3"></textarea>
                  <div class="review-actions">
                    <button class="btn-primary" onclick={() => saveEvidence(item.id)} disabled={evidenceDraft.trim().length < 12}>保存证据（触发结论重算）</button>
                    <button class="btn-secondary" onclick={() => editingEvidenceId = null}>取消</button>
                  </div>
                </div>
              {:else}
                <p>{item.evidence}</p>
                <small>对应 {requirements.find((node) => node.id === item.requirementId)?.label.split('\n')[0]} · {item.submitter} 提交{#if item.decidedAt} · 结论于 {new Date(item.decidedAt).toLocaleString('zh-CN')}{/if}</small>
              {/if}
              {#if item.status === '待审阅'}
                <div class="review-actions">
                  <input bind:value={reviewComments[item.id]} placeholder="填写附议或退回意见" />
                  <button class="btn-primary" onclick={() => review(item, '已附议')}>附议</button>
                  <button class="btn-danger" onclick={() => review(item, '已退回')}>退回补充</button>
                </div>
              {:else}
                <div class:returned={item.status === '已退回'} class="decision">审阅意见：{item.comment}</div>
              {/if}
              {#if editingEvidenceId !== item.id}
                <div class="evidence-row">
                  <button class="link-btn" onclick={() => startEditEvidence(item)}>修改证据</button>
                </div>
              {/if}
              {#if item.conclusionHistory && item.conclusionHistory.length > 0}
                <div class="history">
                  {#each item.conclusionHistory as record}
                    <div class="history-item">
                      <span>旧结论：{record.status}（{record.decidedBy === 'owner' ? '负责人' : '审阅人'} · {new Date(record.decidedAt).toLocaleString('zh-CN')}）</span>
                      <span class="invalidated-note">已失效：{record.reason}（{new Date(record.invalidatedAt).toLocaleString('zh-CN')}）</span>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          </article>
        {/each}
      </div>
    </section>

    <aside class="panel">
      <div class="panel-head"><h3>提交课程修订</h3><span class="muted">服务端校验</span></div>
      <form method="POST" action="?/submitRevision" use:enhance={handleSubmit}>
        <label>课程<select name="courseId">{#each courseNames as course}<option value={course.id}>{course.id} · {course.label.split('\n')[0]}</option>{/each}</select></label>
        <label>毕业要求<select name="requirementId">{#each requirements as requirement}<option value={requirement.id}>{requirement.id} · {requirement.label.split('\n')[0]}</option>{/each}</select></label>
        <label>证据说明<textarea name="evidence" rows="4" placeholder="说明教学活动、考核记录与达成证据"></textarea></label>
        <label>修订说明<textarea name="revisionNote" rows="3" placeholder="说明本轮为什么调整映射或证据"></textarea></label>
        <label>提交人<input name="submitter" placeholder="课程负责人姓名" /></label>
        <button class="btn-primary" type="submit">提交院系审阅</button>
      </form>
      <div class="version-compare">
        <strong>R12 对比 R11</strong>
        <div><span>C-308 → GR-03</span><b>权重 0.85 → 1.00</b></div>
        <div><span>新增考核证据</span><b>需求追踪矩阵</b></div>
        <div><span>GR-06 覆盖</span><b class="returned">证据待补充</b></div>
      </div>
    </aside>
  </div>
</section>

<style>
  .actions { display: flex; gap: 8px; }
  .notice { margin-bottom: 12px; padding: 12px 14px; border-left: 3px solid #3f8869; color: #27634d; background: #ebf6f0; }
  .notice.error { border-color: #bd4d35; color: #913c2b; background: #fff1ec; }
  .notice.invalidated { border-color: #cd813a; color: #7a5223; background: #fff6e9; }
  .review-layout { display: grid; grid-template-columns: minmax(0,1fr) 360px; gap: 14px; align-items: start; }
  .review-list { padding: 8px 16px 16px; }
  .review-list article { display: grid; grid-template-columns: 28px minmax(0,1fr); gap: 9px; padding: 14px 0; border-bottom: 1px solid #e8eded; }
  .review-list article.selected { background: #f4f8f7; }
  .review-title { display: flex; justify-content: space-between; gap: 10px; }
  .review-title span { padding: 3px 6px; border-radius: 5px; color: #9b5a25; background: #fff0de; font-size: 10px; }
  .review-title span.approved { color: #2e7359; background: #e7f4ec; }
  .review-title span.returned { color: #a94331; background: #ffebe6; }
  .review-main p { margin: 7px 0; color: #5f6e74; font-size: 12px; line-height: 1.55; }
  .review-main small { color: #839096; }
  .review-actions { display: flex; gap: 7px; margin-top: 10px; }
  .review-actions input { flex: 1; }
  .decision { margin-top: 9px; padding: 8px; color: #2f6f58; background: #edf7f1; font-size: 11px; }
  .decision.returned { color: #a54431; background: #fff0ec; }
  .evidence-row { margin-top: 8px; }
  .link-btn { padding: 0; border: 0; color: #2f6f72; background: transparent; font-size: 11px; cursor: pointer; text-decoration: underline; }
  .evidence-edit { margin: 7px 0; }
  .evidence-edit textarea { margin-bottom: 7px; }
  .history { margin-top: 9px; padding: 8px 10px; border-left: 3px solid #cd813a; background: #faf6ee; }
  .history-item { display: grid; gap: 2px; font-size: 10px; color: #6c6256; }
  .history-item + .history-item { margin-top: 6px; }
  .invalidated-note { color: #a54431; }
  form { display: grid; gap: 12px; padding: 16px; }
  form button { margin-top: 3px; }
  .version-compare { margin: 0 16px 16px; padding: 12px; border: 1px solid #dbe3e3; border-radius: 8px; background: #f6f8f7; }
  .version-compare strong { display: block; margin-bottom: 9px; font-size: 12px; }
  .version-compare div { display: flex; justify-content: space-between; gap: 8px; padding: 5px 0; color: #66757b; font-size: 10px; }
  .version-compare b { color: #2e7359; }
  .version-compare b.returned { color: #aa4933; }
  @media (max-width: 1050px) { .review-layout { grid-template-columns: 1fr; } }
</style>
