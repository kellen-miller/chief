select distinct speaker_id
         from conversation_events
         where guild_id || '/' || channel_id || '/' || discord_message_id
                 in ({{0}})
