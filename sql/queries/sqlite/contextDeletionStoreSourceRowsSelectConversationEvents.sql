select id, occurred_at as occurredAt,
                guild_id || '/' || channel_id || '/' || discord_message_id
                  as scopeId
         from conversation_events
         where guild_id || '/' || channel_id || '/' || discord_message_id
                 in ({{0}})
            {{1}}
         order by id
