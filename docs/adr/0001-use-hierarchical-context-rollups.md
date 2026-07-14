---
status: accepted
---

# Use hierarchical context rollups

Chief will represent ambient channel history as provenance-backed hourly, daily, weekly, and long-term rollups rather than repeatedly searching every raw message or maintaining a speculative topic graph. The hierarchy bounds prompt size and summarization cost while preserving calendar-scale recall, correction, deletion, and rebuild lineage. It adds background jobs and derived-state management, but keeps historical discussion explicitly separate from durable communal memory.

## Considered options

Query-time windows over raw messages were rejected because relevance and prompt cost degrade with history length. A living entity/topic graph was rejected because casual group conversation does not justify its extraction cost or risk of false structure.

## Consequences

Raw messages may expire after their retention window while longer-lived rollups remain. Chief must therefore expose provenance quality, preserve uncertainty, suppress deleted descendants before rebuilding them, reconcile Discord lifecycle events missed during downtime, and restore a matching pre-migration database when rolling back an image that predates the context schema. Because bounded bucket and local recovery artifacts can outlive an active local deletion, every host start must fail closed unless a retained recovery image has verified and idempotently replayed all content-free forget journals into the selected database, including an older schema.
