import { json } from '@sveltejs/kit'
import type { RequestEvent } from './$types'
import type { Batch } from '$lib/batch'
import { setBatch } from '$lib/server/batchStore'

export async function POST({ request }: RequestEvent) {
  const body = (await request.json().catch(() => null)) as { batch?: Batch } | null
  const batch = body?.batch
  if (!batch?.id || !batch.base?.nodes || !batch.base?.mappings || !batch.base?.reviewItems) {
    return json({ ok: false, error: '批次无效：缺少冻结基线' }, { status: 400 })
  }
  setBatch(batch)
  return json({ ok: true, batchId: batch.id })
}
