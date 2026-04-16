import type { MemRia } from '@mem-ria/core'
import type { Connector } from './types.js'

interface RegisteredConnector {
  connector: Connector
  config?: Record<string, unknown>
}

export class ConnectorRegistry {
  private connectors: RegisteredConnector[] = []

  register(connector: Connector, config?: Record<string, unknown>): void {
    // Replace if same name already registered
    const idx = this.connectors.findIndex(c => c.connector.name === connector.name)
    if (idx >= 0) {
      this.connectors[idx] = { connector, config }
    } else {
      this.connectors.push({ connector, config })
    }
  }

  async scanAll(mem: MemRia): Promise<{ total: number; byConnector: Record<string, number> }> {
    const byConnector: Record<string, number> = {}
    let total = 0

    for (const { connector, config } of this.connectors) {
      try {
        const result = await connector.scan(mem, config)
        byConnector[connector.name] = result.count
        total += result.count
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        byConnector[connector.name] = 0
        // Log but don't throw — other connectors should still run
        console.error(`[mem-ria/connectors] ${connector.name} failed: ${msg}`)
      }
    }

    return { total, byConnector }
  }

  list(): string[] {
    return this.connectors.map(c => c.connector.name)
  }
}
