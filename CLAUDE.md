# CLAUDE.md

Guidance for future Claude sessions working in this repo.

## What this is

A single Google Apps Script (`Code.gs`) that runs **inside
james@myadventuregroup.com.au's Gmail** and processes lead replies sitting in the
label **`@-sales-to-action-outbound-lead-responses`**. It is deployed by pasting
`Code.gs` into a script.google.com project under James's account — this repo is the
source of truth, not a deploy target. No build step, package manager, or test suite.

It is the **downstream actor** for `../outbound_lead_response_automations` (the
router). The router detects a lead reply, records the lead into
`public.lead_responses`, and moves the thread into the watch label. This script then,
per reply message: writes a `public.lead_response_instances` row, posts an
ActiveCampaign deal note, and (via OpenAI) optionally changes the deal's stage.

## Architecture / flow (read before editing Code.gs)

Every minute, `processLeadResponses()` → `processLabel_(ACTIVE_WINDOW_MINUTES)`. Under
one script-wide lock it searches the watch label, and for each **message** newer than
the window whose sender is an external lead (not our domain, not a system/bounce
sender) it calls `handleReplyMessage_(message, leadEmail)`:

1. `getInstanceState_(messageId)` — if a row already exists **with
   `ac_note_datetime`**, skip. (A row without it is resumed.)
2. `resolveLeadForEmail_(email)` — read `lead_responses` (`id`, `ac_deal_created`); if
   absent, call the `process_lead_responses` RPC (idempotent) and re-read. No row or
   no `ac_deal_created` → skip (can't act without a deal).
3. `insertInstance_(leadId, messageId)` — claim the message
   (`Prefer: resolution=ignore-duplicates`); on conflict, re-read the existing id.
4. `openAiClassify_(cleanBody)` — one JSON call returning
   `{ main_message, stage }` (`stage` is an allowed name or `NO_CHANGE`).
5. Post the `Lead responded with "<main_message>".` note → stamp `ac_note_datetime`.
6. If `stage` maps to an id **different** from the deal's current stage: set the
   stage, post `Stage changed to <stage>.`, stamp `stage_change_datetime`.

`backfillLeadResponsesOnce()` is a run-once helper: scan the whole label, call the RPC
for every distinct lead email so `lead_responses` is populated before the automation
runs.

## Critical conventions / gotchas

- **Idempotency by `message_id`.** `lead_response_instances.message_id` is UNIQUE;
  the insert ignores duplicates. A message is only "done" once `ac_note_datetime` is
  set — keep that the skip condition so partial failures resume.
- **Side-effects before the stamp.** Post the note, THEN stamp `ac_note_datetime`;
  change the stage, THEN stamp `stage_change_datetime`. A failure leaves the column
  null so the next sweep retries. Preserve this order when adding steps; keep new
  side-effects idempotent.
- **Auth.** Supabase calls use `SUPABASE_SERVICE_ROLE_KEY` (Script Property) as both
  `apikey` and `Authorization: Bearer`. ActiveCampaign uses `AC_API_TOKEN` (Script
  Property) as the `Api-Token` header against `AC_API_URL`. OpenAI uses
  `OPENAI_API_KEY` (Script Property). Never hardcode a key in `Code.gs`.
- **The deal id comes from `lead_responses.ac_deal_created`** (the most-recent AC deal
  for the contact, set upstream). This script does not re-derive it from AC.
- **Stage list.** `STAGE_NAME_TO_ID` holds the allowed stages (deal group 3). The AI
  must return an exact name or `NO_CHANGE`; anything off-list is coerced to
  `NO_CHANGE`. REPLY YES (70) was added vs the original prompt (which duplicated
  "NO REPLY" and omitted "REPLY YES").
- **Labels are Gmail `label:` search tokens.** `resolveLabel_` matches by normalizing
  (lowercase, whitespace/slashes → hyphens). Unlike the router, this script does NOT
  create the label if missing — it aborts (the router owns/creates it).
- **Runs in James's mailbox only.** The watch label does not exist in other
  mailboxes, so nothing here can be exercised from a different Gmail account or via an
  MCP Gmail connector — test by pasting into James's Apps Script and running
  `testRunOnce()`.

## Deploying a change

Edit `Code.gs` here, then paste it over the Apps Script project's `Code.gs` and save.
No new Script Property / OAuth scope is needed for changes that reuse the existing
properties and `UrlFetchApp`.

## Security

- `openai_api_key.txt` / `creds.txt` hold live secrets and are **gitignored** — never
  stage or commit them. `OPENAI_API_KEY` also lives in Google Secret Manager
  (`claudegwscli-502400`) as the central copy.
