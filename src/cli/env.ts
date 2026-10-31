
import fs from 'node:fs/promises'
import path from 'node:path'

export async function loadEnv() {
  const envPath = path.join(process.cwd(), '.env')

  try {
    const content = await fs.readFile(envPath, 'utf-8')

    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim()

      // Skip blank lines and full-line comments.
      if (!line || line.startsWith('#')) continue

      const match = line.match(/^([^=]+)=(.*)$/)
      if (!match || !match[1] || match[2] === undefined) continue

      const key = match[1].trim()
      let val = match[2].trim()

      if (!key) continue

      // Handle quoted values and optional trailing comments.
      if (val.startsWith('"') || val.startsWith("'")) {
        const quote = val[0]
        const closingQuote = val.indexOf(quote, 1)

        if (closingQuote !== -1) {
          const trailing = val.slice(closingQuote + 1).trim()

          if (!trailing || trailing.startsWith('#')) {
            val = val.slice(1, closingQuote)
          }
        }
      }

      // Preserve # in unquoted values.
      if (key && val && !process.env[key]) {
        process.env[key] = val
      }
    }
  } catch {
    // .env is optional.
  }
}
