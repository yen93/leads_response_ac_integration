# process_leads_per_response

A single Google Apps Script (`Code.gs`) that runs **inside
james@myadventuregroup.com.au's Gmail** and acts on lead replies that the upstream
router has already dropped into the label
**`@-sales-to-action-outbound-lead-responses`**.

For every lead-reply message (in the last 10 minutes) it:

1. logs the message once in `public.lead_response_instances` (Gmail `message_id` is
   the unique dedup key);
2. uses an OpenAI model to summarise the reply's main message and recommend a sales
   stage;
3. posts an ActiveCampaign **deal note** — `Lead responded with "<summary>".` — and
   stamps `ac_note_datetime`;
4. if the model recommends a **different** allowed stage, changes the AC deal stage,
   posts a second note — `Stage changed to <stage>.` — and stamps
   `stage_change_datetime`.

It is deployed by pasting `Code.gs` into a script.google.com project under James's
account — this repo is the source of truth, not a deploy target. No build step, no
package manager, no test suite.

## Where it sits in the pipeline

```
outbound follow-ups  --(lead replies)-->  ../outbound_lead_response_automations
    moves thread into label "@-sales-to-action-outbound-lead-responses"
    + records lead into public.lead_responses (email -> AC contact/account/deal)
                                   |
                                   v
        THIS SCRIPT (process_leads_per_response), every minute
    per reply message: lead_response_instances row + AC note + AI stage change
```

## Data model

**`public.lead_response_instances`** (created by this project, MAGTestProject
`aivitcomiywiysrfwqxt`):

| column | type | notes |
|---|---|---|
| `id` | bigint identity | PK |
| `created_at` | timestamptz | default `now()` |
| `lead_id` | bigint | FK → `lead_responses.id` |
| `message_id` | text | Gmail message id, **UNIQUE** (dedup key) |
| `ac_note_datetime` | timestamptz | set when the "Lead responded" note is posted |
| `stage_change_datetime` | timestamptz | set when the stage is changed |

`lead_responses` (populated upstream) maps `email → ac_contact_created /
ac_account_created / ac_deal_created`. This script reads `ac_deal_created` to know
which AC deal to act on.

## Configuration (top of `Code.gs`)

| const | meaning |
|---|---|
| `SUPABASE_URL` | MAGTestProject URL |
| `WATCH_LABEL_TOKEN` | `@-sales-to-action-outbound-lead-responses` |
| `ACTIVE_WINDOW_MINUTES` | `10` — only messages this fresh are processed |
| `BATCH_SIZE` | `150` — max threads per run |
| `INSTANCES_TABLE` / `LEAD_RESPONSES_TABLE` | Supabase tables |
| `LEAD_RESPONSE_RPC` | `process_lead_responses` (fills a missing lead) |
| `OPENAI_MODEL` | `gpt-4o-mini` |
| `STAGE_NAME_TO_ID` | allowed stage names → AC dealStage id (deal group 3) |
| `OUR_DOMAIN` / `SYSTEM_SENDER_HINTS` | reply-vs-us / bounce detection |

### Allowed stages → AC id (group 3)

| stage | id |
|---|---|
| CONTACT MADE - NO REPLY | 71 |
| CONTACT MADE - REPLY NO | 69 |
| CONTACT MADE - REPLY YES | 70 |
| F2F/ SALES DEMO BOOKED | 58 |
| Missed Deals (Due to Conflict of Schedule, When Schedules Collide) | 121 |
| Unqualified: Interest shown (no needs defined - no budget/ dates/ event) | 12 |
| Qualified: Sent proposal + avails NO AUTOMATION FOLLOWUP*** | 59 |
| DEAL WON: SOW NOT returned - awaiting briefing call, travel etc | 15 |

> The prompt's list duplicated "CONTACT MADE - NO REPLY" and omitted
> "CONTACT MADE - REPLY YES"; REPLY YES (70) was added so a positive reply classifies
> correctly.

## Script Properties (Project Settings → Script Properties)

| property | value |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | MAGTestProject service_role key (used as `apikey` + `Authorization: Bearer`) |
| `AC_API_URL` | `https://myadventuregroup.api-us1.com` |
| `AC_API_TOKEN` | ActiveCampaign API token (sent as `Api-Token` header) |
| `OPENAI_API_KEY` | OpenAI key (`sk-...`) |

Never hardcode these in `Code.gs`. `OPENAI_API_KEY` is also stored in Google Secret
Manager (project `claudegwscli-502400`) as the central copy.

## OAuth scopes (`appsscript.json`)

`gmail.modify`, `script.scriptapp`, `script.external_request` — same as the upstream
router (Gmail read, trigger management, outbound HTTP to Supabase / AC / OpenAI).

## First-time setup

1. Create the script project under James's account; paste `Code.gs` +
   `appsscript.json`.
2. Add the four Script Properties above.
3. Run **`backfillLeadResponsesOnce()`** once — fills `lead_responses` for any lead
   emails already sitting in the watch label but not yet recorded.
4. Run **`testRunOnce()`** once — triggers the Gmail/HTTP authorization prompt and
   does one real sweep.
5. Run **`createEveryMinuteTrigger()`** — schedules `processLeadResponses()` every
   minute. `deleteTriggers()` is the off switch.

## Idempotency & failure handling

- A message is skipped once its instance row has `ac_note_datetime` set. A row that
  exists but isn't noted yet is **resumed** next sweep, so a transient
  OpenAI/AC/Supabase failure just retries.
- The instance row is inserted with `Prefer: resolution=ignore-duplicates`, so a
  duplicate `message_id` is a no-op.
- All outbound calls use `muteHttpExceptions` and log failures to Stackdriver; a
  failed step leaves its timestamp column null so the next sweep retries it.
- A script-wide `LockService` lock (`tryLock(0)`) prevents overlapping ticks.

## Security

- `openai_api_key.txt` and `creds.txt` hold live secrets and are **gitignored** —
  never stage or commit them.
- Watch pasted snippets for keys before committing; `service_role` / `sbp_` / AC
  tokens / `sk-` keys are all high-risk.
