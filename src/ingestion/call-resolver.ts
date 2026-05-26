import { getKuzuClient } from '../graph/client.js'

export async function resolveCallEdges(repo: string): Promise<void> {
  const db = getKuzuClient()

  const symbols = await db.query<{ fqn: string; name: string }>(`
    MATCH (s:Symbol {repo: $repo})
    WHERE s.is_exported = true
    RETURN s.fqn AS fqn, s.name AS name
  `, { repo })

  const exportedMap = new Map(symbols.map(s => [s.name, s.fqn]))

  const callers = await db.query<{ fqn: string; file: string }>(`
    MATCH (s:Symbol {repo: $repo})
    RETURN s.fqn AS fqn, s.file AS file
  `, { repo })

  for (const caller of callers) {
    const callsResult = await db.query<{ calls: string[] }>(`
      MATCH (s:Symbol {fqn: $fqn})
      RETURN s.calls AS calls
    `, { fqn: caller.fqn })

    const calls = callsResult[0]?.calls || []
    
    for (const calleeName of calls) {
      const calleeFqn = exportedMap.get(calleeName)
      if (calleeFqn && calleeFqn !== caller.fqn) {
        await db.run(`
          MATCH (caller:Symbol {fqn: $caller}), (callee:Symbol {fqn: $callee})
          MERGE (caller)-[:Calls]->(callee)
        `, { caller: caller.fqn, callee: calleeFqn }).catch(() => {})
      }
    }
  }
}