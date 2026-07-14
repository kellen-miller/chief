# Chief Knowledge Context

Chief maintains shared conversational context for one private Discord community. The language below distinguishes what the group discussed from what Chief accepts as durable communal knowledge.

## Language

**Source event**:
An eligible human or Chief message from the configured Discord channel, including its speaker, time, reply relationship, and provenance.
_Avoid_: Chat record, memory

**Recent conversation**:
The short-lived chronological source events supplied directly to Chief for conversational continuity.
_Avoid_: Index, long-term memory

**Historical context**:
A time-bounded account of what the group discussed. Historical context is evidence about a conversation, not an authoritative fact.
_Avoid_: Memory, truth

**Context tier**:
One of the hourly, daily, weekly, or long-term horizons through which Chief recalls historical context.
_Avoid_: Memory level

**Rollup**:
A derived historical account whose provenance identifies all source events and earlier rollups from which it was produced.
_Avoid_: Memory, digest message

**Long-term topic**:
An enduring historical account of how discussion about one recurring subject changed over time.
_Avoid_: Fact, belief

**Durable memory**:
An accepted communal fact or preference that remains available until it is corrected or forgotten.
_Avoid_: Historical context, rollup

**Provenance**:
The trace from recalled context or durable memory back to the Discord source events and periods that support it.
_Avoid_: Citation text

**Suppression tombstone**:
A content-free record that prevents a deleted source event or derived account from being restored by backfill or stale work.
_Avoid_: Soft deletion

**Content-state reason**:
The non-content reason a source or rollup is retained, retention-expired, Discord-deleted, or locally forgotten. It controls whether Chief may expose a Discord source link.
_Avoid_: Deletion text, tombstone content

**Forget journal**:
An append-only, content-free backup-side record that forces a restored snapshot to reapply later local forgetting before Chief can start.
_Avoid_: Backup of deleted content, audit transcript

**Recovery image**:
The retained Chief image capable of verifying and replaying forget journals into supported current or older database schemas before the selected runtime image starts.
_Avoid_: Runtime fallback, rollback image

**Recovery artifact**:
A bucket backup, local pre-deploy database, or displaced failed database retained for bounded operational recovery and never runnable without the forget-journal preflight.
_Avoid_: Active database, archival memory

**Retrieval query**:
One substantive text request or one model-invoked Realtime context lookup. Historical context and durable memory reuse one embedding within that query.
_Avoid_: Voice session, rollup job
