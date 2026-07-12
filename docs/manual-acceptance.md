# Manual production acceptance

Repository tests do not use paid APIs, real Discord encryption, live WIF, or GCP resources. Complete this checklist before calling Chief production-deployed.

## Discord text and commands

- An allowed-channel message without a mention receives no reply.
- `@Chief` alone returns a local greeting; `@Chief <request>` returns one answer whose final segment ends exactly “Mr. President.”
- Current-fact research includes direct links. Prompt injection in fetched pages does not change Chief’s rules.
- DMs, threads, webhooks, bots, other channels, and other guilds are ignored.
- `/roll max:1` returns 1; normal bounds are inclusive; `/roll`, `/help`, `/join`, and `/leave` still work when AI usage is paused.
- A remembered plan can be recalled, corrected, and forgotten without exposing a memory browser.

## Live DAVE voice gate

This is blocking. With Discord DAVE enabled, have two humans join the configured non-stage voice channel.

- `/join` connects Chief and both humans can hear him.
- One-human mode accepts natural conversation without saying Chief.
- Two-human mode ignores an unaddressed completed utterance and answers “Chief, …”.
- A join/leave during speech does not change that utterance’s latched mode.
- Speaking over Chief immediately stops playback; a later qualifying turn can answer.
- Receive, transmit, and interruption all work for both speakers—playback-only success is a failure.
- Completed speech ends exactly “Mr. President” without duplication. Delete the persisted suffix clip once and confirm it is regenerated and validated within budget.
- Voice research posts source links in the text channel. If this is not observed, voice research is not accepted.
- Chief closes a Realtime session after about 60 seconds idle and leaves Discord after about 15 minutes without a qualifying turn.

If pinned `@discordjs/voice` 0.19.2 fails DAVE receive, upgrade to a verified fixed release or disable voice; do not ship playback-only voice.

## Live performance and operations

- Normal text generation is at most 10 seconds after reaching the head of the paid queue, excluding deliberate queue wait and slow research.
- First voice audio is at most 2.5 seconds after a qualifying completed turn reaches the head of the paid queue.
- PR WIF cannot authenticate a push/environment token; production WIF accepts only the exact production environment subject.
- A real GCS backup restores with matching known memory retrieval.
- A deliberately unhealthy deployment returns to the prior digest and database within five minutes.
- Stop the VM and confirm the uptime alert; force a watchdog and backup failure and confirm redacted email alerts.
