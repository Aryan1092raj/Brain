type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {}
  }

  return value as UnknownRecord
}

export function getValidatedCommitSha(
  payload: Record<string, unknown>,
): string | null {
  const isPR = payload.pull_request !== undefined &&
    payload.pull_request !== null

  const rawSha = isPR
    ? asRecord(asRecord(payload.pull_request).head).sha
    : asRecord(payload.head_commit).id

  if (
    typeof rawSha !== 'string' ||
    !/^[0-9a-f]{40}$/i.test(rawSha)
  ) {
    return null
  }

  return rawSha
}
