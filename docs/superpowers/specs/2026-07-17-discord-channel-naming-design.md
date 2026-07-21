# Discord Channel Naming Design

## Goal

Mirror Codex conversation titles into Discord conversation channel names without dropping Chinese or other Unicode letters.

## Naming Rules

- Preserve Unicode letters and numbers, including Chinese text.
- Lowercase Latin letters.
- Replace whitespace and punctuation runs with a single hyphen.
- Remove leading and trailing hyphens.
- Keep Discord's 100-character channel-name limit.
- Fall back to `thread-<short-id>` only when no usable title is available.

Examples:

- `问题` becomes `问题`.
- `不下单` becomes `不下单`.
- `任务指导 存档，到时候来对` becomes `任务指导-存档-到时候来对`.

## Synchronization

The existing conversation-channel reconciliation remains authoritative. New conversations use the current Codex title when the channel is created. Existing mapped channels are renamed when later discovery returns a changed authoritative title.

The Codex thread ID remains in the Discord channel topic and local mapping store, so duplicate visible titles do not break identity or routing.

## Failure Handling

If a title is empty, synthetic, fully redacted, or contains no usable Unicode letters or numbers, the bridge uses the existing `thread-<short-id>` fallback. A later valid title replaces that fallback during normal reconciliation.

## Verification

- Unit-test Chinese-only, mixed Chinese/Latin, punctuation, repeated separators, fallback, and length behavior.
- Run the focused formatting tests and TypeScript build.
- Restart the guarded bridge and verify existing mapped channels are renamed.
- Confirm the bridge remains connected through the configured proxy.
