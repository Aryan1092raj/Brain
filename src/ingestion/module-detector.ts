import { getKuzuClient } from '../graph/client.js'

export async function detectModules(repo: string): Promise<void> {
  const db = getKuzuClient()

  const files = await db.query<{ path: string }>(`
    MATCH (f:File {repo: $repo})
    RETURN f.path AS path
  `, { repo })

  const modules = new Map<string, string[]>()

  for (const { path: filePath } of files) {
    const parts = filePath.split('/')
    if (parts.length > 1) {
      const moduleName = parts[0] === 'src' && parts.length > 2 ? parts[1] : parts[0]
      if (!modules.has(moduleName)) modules.set(moduleName, [])
      modules.get(moduleName)!.push(filePath)
    }
  }

  for (const [moduleName, filePaths] of modules) {
    await db.run(`
      MERGE (m:Module {name: $name, repo: $repo})
    `, { name: moduleName, repo }).catch(() => {})

    for (const filePath of filePaths) {
      const symbols = await db.query<{ fqn: string }>(`
        MATCH (s:Symbol {repo: $repo, file: $file})
        RETURN s.fqn AS fqn
      `, { repo, file: filePath })

      for (const { fqn } of symbols) {
        await db.run(`
          MATCH (s:Symbol {fqn: $fqn}), (m:Module {name: $name, repo: $repo})
          MERGE (s)-[:BelongsTo]->(m)
        `, { fqn, name: moduleName, repo }).catch(() => {})
      }
    }
  }
}