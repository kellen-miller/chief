select c.guild_id || '/' || c.channel_id || '/' ||
                  c.discord_message_id as scopeId, c.content as text
         from conversation_event_fts f
         join conversation_events c on c.id = f.rowid
         where conversation_event_fts match ?
           and c.guild_id = ? and c.channel_id = ?
           and c.content_state = 'available'
         order by bm25(conversation_event_fts), c.id desc limit ? offset ?
