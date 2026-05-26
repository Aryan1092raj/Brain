import type { HotZone } from './hotzone.js'
import { getDb } from '../memory/db.js'
import type { Config } from '../config/schema.js'

export async function dispatchHotZoneAlerts(
  config: Config,
  repo: string,
  hotZones: HotZone[],
): Promise<void> {
  const newZones = hotZones.filter(z => z.isNew)
  if (newZones.length === 0) return

  const db = getDb()
  const message = buildAlertMessage(repo, newZones)

  const results = await Promise.allSettled([
    config.slackWebhook   ? sendSlack(config.slackWebhook, message) : Promise.resolve(),
    config.discordWebhook ? sendDiscord(config.discordWebhook, message, repo, newZones) : Promise.resolve(),
  ])

  const now = Date.now()
  for (const zone of newZones) {
    db.prepare(
      `UPDATE hot_zones SET alert_sent = ? WHERE repo = ? AND symbol_fqn = ?`
    ).run(now, repo, zone.symbolFqn)
  }

  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`[brain/alert] channel ${i} failed:`, r.reason)
    }
  })
}

function buildAlertMessage(repo: string, zones: HotZone[]): string {
  const lines = zones.map(z => {
    const name = z.symbolFqn.split(':').pop() ?? z.symbolFqn
    return `• \`${name}\` in \`${z.filePath}\` — ${z.velocity.toFixed(2)} commits/day (z=${z.zScore.toFixed(1)}σ)`
  })

  return [
    `🔥 *Hot zone detected in \`${repo}\`*`,
    `${zones.length} symbol(s) showing unusually high change velocity (30d window):`,
    ...lines,
    `High change velocity correlates with incident risk. Review carefully before next deployment.`,
  ].join('\n')
}

async function sendSlack(webhookUrl: string, text: string): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  if (!res.ok) throw new Error(`Slack returned ${res.status}`)
}

async function sendDiscord(
  webhookUrl: string,
  text: string,
  repo: string,
  zones: HotZone[],
): Promise<void> {
  const embed = {
    title: `🔥 Hot zone detected — ${repo}`,
    color: 0xFF4444,
    description: zones.map(z => {
      const name = z.symbolFqn.split(':').pop() ?? z.symbolFqn
      return `**${name}** in \`${z.filePath}\`\n${z.velocity.toFixed(2)} commits/day · z-score ${z.zScore.toFixed(1)}σ`
    }).join('\n\n'),
    footer: { text: 'brain daemon · 30d change velocity window' },
  }

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] }),
  })
  if (!res.ok) throw new Error(`Discord returned ${res.status}`)
}