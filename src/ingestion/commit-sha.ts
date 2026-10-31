function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {}
  }

  return value as Record<string, unknown>
}

export function getValidatedCommitSha(
  payload: Record<string, unknown>,
  isPR: boolean,
): string | null {
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