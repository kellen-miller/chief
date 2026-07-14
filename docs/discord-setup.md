# Discord setup

1. Create an application and bot in the Discord Developer Portal.
2. Enable the privileged **Message Content Intent**. Chief also uses the ordinary Guilds, Guild Messages, Guild Voice States intents. It does not require the privileged Guild Members intent. Message Content is required for silent context observation, edits, and historical reconciliation.
3. Install the application into the one target guild with scopes `bot` and `applications.commands`.
4. Grant only: View Channels, Send Messages, **Read Message History**, Connect, Speak, and Use Voice Activity. Read Message History is required for gap reconciliation and owner-approved backfill. Chief does not need Administrator, Manage Channels, Manage Messages, or member-management permissions and never deletes a Discord message as part of a local forget.
5. Record the application ID, guild ID, main text channel ID, and main voice channel ID. Developer Mode in Discord exposes “Copy ID.”
6. Export those IDs plus the bot token and run:

   ```bash
   pnpm chief -- register-commands
   ```

Commands are guild-scoped so updates appear quickly. Chief fails closed if the configured guild or either channel is missing, if a command is invoked elsewhere, or if a message comes from a DM, thread, webhook, or another bot. Chief retains its own delivered messages by their Discord snowflakes and durable chunk order so reply history, edits, deletes, prompt assembly, and reconciliation use the same source lifecycle.

Only eligible human messages and Chief's own delivered messages in the configured
main text channel enter historical context. DMs, threads, webhooks, other guilds
or channels, other bots, failed sends, and voice audio are excluded. Safe
attachment names/descriptions may be retained with the source; attachment bytes
are not downloaded for indexing. An unmentioned eligible message is observed
silently: Chief does not type, react, or reply merely because it was indexed.

An ordinary member may locally forget only their own matching sources. The
guild owner or a member whose current request carries Discord Administrator may
forget another member's sources or a topic, with confirmation for broad scope.
If current permissions cannot be established, Chief refuses the broad action
without revealing hidden matches. These checks do not require the Guild Members
intent.

Never commit the bot token. Production reads it from the `chief-discord-token` Secret Manager resource.
