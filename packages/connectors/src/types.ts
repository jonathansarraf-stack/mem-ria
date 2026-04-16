import type { MemRia } from '@mem-ria/core'

export interface Connector {
  name: string
  scan(mem: MemRia, config?: Record<string, unknown>): Promise<{ count: number }>
}
