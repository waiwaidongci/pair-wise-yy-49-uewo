import type { Batch, Change } from '$lib/batch'

export type ServerBatch = {
  batch: Batch
  changes: Map<string, Change>
  resolutions: Map<string, unknown>
}

const batches = new Map<string, ServerBatch>()

export function getBatch(id: string): ServerBatch | undefined {
  return batches.get(id)
}

export function setBatch(batch: Batch): void {
  batches.set(batch.id, { batch, changes: new Map(), resolutions: new Map() })
}
