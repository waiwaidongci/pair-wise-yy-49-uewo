import { json } from '@sveltejs/kit'
import type { RequestEvent } from './$types'
import { mergeBatch, type Change } from '$lib/batch'
import { getBatch } from '$lib/server/batchStore'

export async function POST({ params, request }: RequestEvent) {
  const serverBatch = getBatch(params.id)
  if (!serverBatch) {
    return json({ ok: false, error: '批次不存在或已失效，请重新建立批次后再合并' }, { status: 404 })
  }

  const body = (await request.json().catch(() => ({}))) as {
    changes?: Change[]
    resolutions?: Record<string, unknown>
    forceFail?: boolean
  }

  // 模拟回网失败：服务端未确认，客户端保留现场并重试
  if (body.forceFail) {
    return json({ ok: false, error: '模拟回网失败：服务端未确认，变更已保留在本地，可重试' }, { status: 502 })
  }

  const incoming = body.changes ?? []
  for (const ch of incoming) serverBatch.changes.set(ch.id, ch)
  for (const [key, value] of Object.entries(body.resolutions ?? {})) {
    serverBatch.resolutions.set(key, value)
  }

  const merge = mergeBatch(
    serverBatch.batch.base,
    [...serverBatch.changes.values()],
    Object.fromEntries(serverBatch.resolutions),
    new Date().toISOString(),
    incoming,
  )

  return json({ ok: true, merge })
}
