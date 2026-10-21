import recorded from './recorded-acceptance.json' with { type: 'json' };

// No filesystem, profile, auth, clock or network access. Every invocation gets
// a separate object so callers cannot mutate later capability responses.
export function getRecordedAcceptance() { return structuredClone(recorded); }
