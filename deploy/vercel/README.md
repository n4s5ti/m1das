# AMATI Oracle on Vercel Sandbox

This is a separate Vercel project. It runs one Pots gateway in the persistent named sandbox `amati-oracle`. The hourly cron snapshots its running session at 22 hours and resumes the same named sandbox from that snapshot into a new session with the configured 24-hour timeout. Snapshotting stops the old session. A second persistent sandbox, `amati-oracle-coordinator`, holds a 30-minute filesystem lease to serialize overlapping cron and bootstrap invocations; its filesystem survives session stops. Both sandboxes incur usage and snapshot storage charges. A failed rotation may leave the gateway stopped until the next cron invocation; monitor health and function logs.

## Configuration

Use a Pro or Enterprise team with Sandbox enabled and 24-hour sessions. Set these production environment variables on the **Oracle project**, not the storefront:

- `AI_GATEWAY_API_KEY`: optional. A real Vercel AI Gateway API key, for a `vercel-ai-gateway/...` model. It is passed to each detached Pots gateway process. The Function's OIDC token is only for Sandbox API authentication: it is not usable as a 24-hour gateway credential. Leave it out when the model is signed in to with `/api/login`.
- A chat channel, at least one. `DISCORD_BOT_TOKEN`: a Discord bot's token, with the Message Content intent turned on in the Developer Portal. `IMESSAGE_PROJECT_ID` and `IMESSAGE_PROJECT_SECRET`: Photon Spectrum Cloud credentials. Each is written mode 0600 to `~/.pots/secrets/<channel>-oracle.env`, and Oracle's bot configuration points to that file.
- `CRON_SECRET`: a strong random bearer token. Vercel Cron sends this automatically; use the same token to call either endpoint manually.
- `POTS_GIT_REF`: full 40-character commit SHA pushed to the source repository, containing the iMessage implementation. It is required and pinned to avoid a moving branch.
- `POTS_GIT_URL`: optional public Git URL, default `https://github.com/n4s5ti/p0ts.git`.
- `ORACLE_MODEL`: optional pi model ID, default `vercel-ai-gateway/anthropic/claude-sonnet-4.5`. Confirm the chosen model is available to your AI Gateway account. With a subscription, name one of its models, such as `openai-codex/<model>` for ChatGPT.

The initial sandbox clones that commit and runs `npm ci` (the repository's prepare script builds Pots). It initializes Oracle with `--no-service --no-chat`, then starts `pots start` detached. Snapshots preserve the installed checkout, bot data, and channel secrets. Changing `POTS_GIT_REF` does **not** upgrade an already initialized sandbox; plan a controlled upgrade separately. Changes to the AI Gateway key take effect when a new gateway process starts. The model is used at initial bot creation; subsequent model changes should be made in the bot's configuration.

## Deploy

Create a separate Vercel project and set its **Root Directory** to `deploy/vercel` when connecting this repository. Confirm the project identity before deploying. From the linked Oracle project directory:

```sh
cd deploy/vercel
env -u VERCEL_ORG_ID -u VERCEL_PROJECT_ID vercel deploy --prod --scope amanti
```

Vercel provides OIDC credentials to production Functions automatically. For local bootstrap, supply the four required variables above plus Sandbox access credentials (`VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`), or an OIDC token for the correct Oracle project. Then run `npm install` and `npm run bootstrap` from this directory. Do not use the storefront's project credentials. `bootstrap` uses the same rotation and lock path as cron.

Call `/api/health` with `Authorization: Bearer <CRON_SECRET>` to get the current session ID, age in milliseconds, sandbox status, and gateway liveness from `pots status`. `/api/rotate` accepts the same authorization and can be invoked manually. Both return 401 without it.

## Approval card relay

The AMATI tree approval broker sends signed requests to `POST /api/discord`. The relay forwards only the Discord requests needed to manage approval cards in the configured approver's direct messages.

Set these environment variables on the Oracle project; neither is secret:

- `APPROVAL_RELAY_PUBLIC_KEY`: the broker's raw 32-byte Ed25519 public key, encoded as 64 hex characters.
- `APPROVAL_APPROVER_ID`: the approver's Discord user ID.

The relay reads its bot token from `DISCORD_BOT_TOKEN || M1DAS_BOT_TOKEN`. Keep that token in Vercel; the broker does not need it.

## Sign in to a model

To run Oracle on a subscription such as ChatGPT instead of an AI Gateway key, call `/api/login` with the same authorization. It creates the sandbox if there is none, installs Pots, runs `pots login --link` in it and answers `{"url": "…"}`: Pots' own login page, served from the sandbox through a Cloudflare Quick Tunnel. Open the link on any device and sign in. It works for an hour, and a new call ends the page of the call before it. The login is written to `~/.pi/agent/auth.json` inside the sandbox, where pi refreshes it and snapshots carry it on; no model credential is stored in Vercel. Sign in there instead of copying a login from another computer: each refresh replaces the login's refresh token, so two computers that refresh one login may sign each other out.

Then set `ORACLE_MODEL` to a model of that login, deploy, and call `/api/rotate`. Until `ORACLE_MODEL` has a key or a login, `/api/rotate` fails at `pots init`, which refuses a model it cannot use. After an unexpected sandbox termination the login is the one of the last snapshot; when the provider no longer accepts it, sign in again.

## Operational limits

Snapshots stop the source process, so rotation has downtime. They contain the complete filesystem, including secrets, bot memory, SQLite files and any other sensitive data the gateway writes. Set access and retention accordingly. Unexpected sandbox termination can lose changes since the last successful snapshot. The 30-minute coordinator lease exceeds the 800-second Vercel Function limit; local bootstrap must not run longer than the lease, and interrupted server-side snapshot operations should be checked before manually retrying. Keep the coordinator's persistent sandbox and its snapshots intact: deleting them during an active operation bypasses the lock.

The iMessage channel's inbound delivery depends on Photon connectivity and how the adapter receives events inside a sandbox; a healthy Pots process alone does not prove messages arrive. Verify inbound and outbound delivery after deployment, including after rotation. This project does not configure an external public webhook route.
