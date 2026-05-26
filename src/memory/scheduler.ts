import { compressTier1ToTier2 } from './tier2.js'
import { promoteToTier3 } from './tier3.js'
import { promoteToTier4 } from './tier4.js'
import { runDecayCycle } from './decay.js'
import { evictExpiredTier1 } from './tier1.js'
import { getDb } from './db.js'
import type { Config } from '../config/schema.js'

const HOUR = 60 * 60 * 1000

export function startScheduler(config: Config): void {
  setInterval(async () => {
    for (const repo of config.repos) {
      try {
        const evicted = evictExpiredTier1()
        await runDecayCycle(repo.name)
        await compressTier1ToTier2(repo.name)
        console.info(`[brain/scheduler] 6h cycle done for ${repo.name}, evicted ${evicted} events`)
      } catch (err) {
        console.error(`[brain/scheduler] error for ${repo.name}:`, err)
      }
    }
  }, 6 * HOUR)

  setInterval(() => {
    for (const repo of config.repos) {
      try {
        promoteToTier3(repo.name)
        promoteToTier4(repo.name)
        getDb().prepare(
          `DELETE FROM tier2_episodes WHERE expires_at < ?`
        ).run(Date.now())
        console.info(`[brain/scheduler] 24h promotion done for ${repo.name}`)
      } catch (err) {
        console.error(`[brain/scheduler] promotion error for ${repo.name}:`, err)
      }
    }
  }, 24 * HOUR)

  console.info('[brain/scheduler] started — 6h decay cycle, 24h tier promotion')
}