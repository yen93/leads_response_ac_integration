/**
 * Per-response lead processor for james@myadventuregroup.com.au
 * -------------------------------------------------------------
 * DOWNSTREAM of the outbound-lead-response router
 * (../outbound_lead_response_automations). That project moves a follow-up thread
 * into the Gmail label "@-sales-to-action-outbound-lead-responses" once a LEAD
 * REPLIES, and records the lead into public.lead_responses (email -> AC contact /
 * account / deal) via the process_lead_responses RPC.
 *
 * This script ACTS on those to-action threads. Every minute it scans the label and,
 * for each lead-reply message in the last ACTIVE_WINDOW_MINUTES, it:
 *   1. logs the reply once per Gmail message id in public.lead_response_instances
 *      (message_id is UNIQUE, so a message is processed once);
 *   2. asks an OpenAI model for the reply's main message + a stage recommendation;
 *   3. posts an ActiveCampaign deal note ("Lead responded with ...") and stamps
 *      ac_note_datetime;
 *   4. if the model recommends a different allowed stage, changes the AC deal stage,
 *      posts a second note ("Stage changed to ..."), and stamps stage_change_datetime.
 *
 * Idempotency: a message is skipped once its instance row has ac_note_datetime set.
 * A row that exists but hasn't been noted yet is resumed on the next sweep, so a
 * transient OpenAI/AC/Supabase error just retries. All side-effects are ordered so
 * nothing is lost on a partial failure.
 *
 * Deploy: paste Code.gs into a NEW script.google.com project under James's account.
 * Set the Script Properties (SUPABASE_SERVICE_ROLE_KEY, AC_API_URL, AC_API_TOKEN,
 * OPENAI_API_KEY), run backfillLeadResponsesOnce() once (fills lead_responses for any
 * existing label threads), run testRunOnce() once to authorize, then
 * createEveryMinuteTrigger() to schedule. See README.md.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Supabase project URL (MAGTestProject). */
const SUPABASE_URL = 'https://aivitcomiywiysrfwqxt.supabase.co';

/** Gmail "label:" search token for the to-action label this script watches. */
const WATCH_LABEL_TOKEN = '@-sales-to-action-outbound-lead-responses';

/** Only inspect messages that arrived within this many minutes (keeps reads tiny). */
const ACTIVE_WINDOW_MINUTES = 10;

/** Max threads to look at per run. */
const BATCH_SIZE = 150;

/** Table this script writes one row per processed lead-reply message into. */
const INSTANCES_TABLE = 'lead_response_instances';

/** Table that maps a lead email -> AC contact/account/deal (populated upstream). */
const LEAD_RESPONSES_TABLE = 'lead_responses';

/** Cross-channel RPC that inserts a missing lead into lead_responses (dedup by email). */
const LEAD_RESPONSE_RPC = 'process_lead_responses';

/** Argument name of LEAD_RESPONSE_RPC (matches the upstream router). */
const LEAD_RESPONSE_RPC_ARG = '_email_add_sent';

/** Our own domain. A message from this domain = James/us, NOT a lead reply. */
const OUR_DOMAIN = 'myadventuregroup.com.au';

/** Any extra addresses that should also count as "us" (lowercase, optional). */
const OUR_EXTRA_ADDRESSES = [];

/** Bounce / system senders that must NOT be treated as a lead reply. */
const SYSTEM_SENDER_HINTS = ['mailer-daemon', 'postmaster', 'no-reply@google', 'noreply@google'];

/** OpenAI model used to summarise the reply and recommend a stage. */
const OPENAI_MODEL = 'gpt-4o-mini';

/** Fixed footer appended to every note this automation writes. */
const NOTE_FOOTER = 'This note was posted thru an AppScript Automation.';

/**
 * Allowed target stages the AI may choose from -> ActiveCampaign dealStage id
 * (all in deal group 3, "Keynotes // Workshops // Immersive (LIV)"). The AI must
 * return one of these EXACT names, or "NO_CHANGE".
 */
const STAGE_NAME_TO_ID = {
  'CONTACT MADE - NO REPLY': '71',
  'CONTACT MADE - REPLY NO': '69',
  'CONTACT MADE - REPLY YES': '70',
  'F2F/ SALES DEMO BOOKED': '58',
  'Missed Deals (Due to Conflict of Schedule, When Schedules Collide)': '121',
  'Unqualified: Interest shown (no needs defined - no budget/ dates/ event)': '12',
  'Qualified: Sent proposal + avails NO AUTOMATION FOLLOWUP***': '59',
  'DEAL WON: SOW NOT returned - awaiting briefing call, travel etc': '15'
};

// --- Script Property names (secrets live here, never hardcoded) --------------
const SUPABASE_KEY_PROPERTY = 'SUPABASE_SERVICE_ROLE_KEY';
const AC_API_URL_PROPERTY = 'AC_API_URL';
const AC_API_TOKEN_PROPERTY = 'AC_API_TOKEN';
const OPENAI_KEY_PROPERTY = 'OPENAI_API_KEY';

// ---------------------------------------------------------------------------
// Main (scheduled)
// ---------------------------------------------------------------------------

/**
 * Scheduled entry point (wire this to the every-minute trigger). Processes lead-reply
 * messages in the watch label with activity in the last ACTIVE_WINDOW_MINUTES.
 */
function processLeadResponses() {
  processLabel_(ACTIVE_WINDOW_MINUTES);
}

/**
 * One-time: process EVERY lead-reply message in the watch label (no time window).
 * Idempotent (message_id dedup), so safe to run after deploying to clear a backlog.
 */
function processBacklogOnce() {
  processLabel_(null);
}

/**
 * Core routine. Under a script-wide lock, scans the watch label and hands each
 * lead-reply message (within the window) to handleReplyMessage_.
 * @param {number|null} windowMinutes  Only messages newer than this; null = no filter.
 */
function processLabel_(windowMinutes) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    console.log('Another run is in progress; skipping this tick.');
    return;
  }

  try {
    const label = resolveLabel_(WATCH_LABEL_TOKEN);
    if (!label) {
      console.log('Watch label not found: "' + WATCH_LABEL_TOKEN + '". Aborting.');
      return;
    }

    const threads = GmailApp.search('label:' + WATCH_LABEL_TOKEN, 0, BATCH_SIZE);
    if (threads.length === 0) {
      return;
    }

    const cutoffMs = windowMinutes == null ? null : (Date.now() - windowMinutes * 60 * 1000);

    let inspected = 0;
    let processed = 0;
    for (let i = 0; i < threads.length; i++) {
      const thread = threads[i];

      // Cheap metadata check: skip threads with no recent activity (no message fetch).
      if (cutoffMs != null && thread.getLastMessageDate().getTime() < cutoffMs) {
        continue;
      }

      const msgs = thread.getMessages();
      for (let j = 0; j < msgs.length; j++) {
        const msg = msgs[j];

        if (cutoffMs != null && msg.getDate().getTime() < cutoffMs) {
          continue; // only recent messages
        }
        const from = extractEmail_(msg.getFrom());
        if (!isExternalLeadAddress_(from)) {
          continue; // our own follow-up or a system/bounce sender — not a lead reply
        }

        inspected++;
        if (handleReplyMessage_(msg, from)) {
          processed++;
        }
      }
    }

    if (processed > 0 || windowMinutes == null) {
      console.log('Inspected ' + inspected + ' lead-reply message(s); processed ' + processed + '.');
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * Process one lead-reply message: log it (once per message_id), post the AC note, and
 * apply an AI-recommended stage change. Every step is guarded so a retry is safe.
 * @param {GmailMessage} message
 * @param {string} leadEmail  Lowercase reply address (already validated external).
 * @return {boolean} true if this call did any new work.
 */
function handleReplyMessage_(message, leadEmail) {
  const messageId = message.getId();

  // Already fully processed (noted)? Skip. (A row still awaiting its note resumes.)
  let state = getInstanceState_(messageId);
  if (state && state.ac_note_datetime) {
    return false;
  }

  // Resolve the lead (id) + its AC deal. Backfill via the RPC if not present yet.
  const lead = resolveLeadForEmail_(leadEmail);
  if (!lead || !lead.id) {
    console.warn('No lead_responses row for ' + leadEmail + ' (not in a threads table?); skipping message ' + messageId + '.');
    return false;
  }
  if (!lead.ac_deal_created) {
    console.warn('lead_responses row for ' + leadEmail + ' has no ac_deal_created; skipping message ' + messageId + '.');
    return false;
  }
  const dealId = String(lead.ac_deal_created);

  // Claim the message: insert the instance row (idempotent). Resume an existing one.
  let instanceId = state ? state.id : insertInstance_(lead.id, messageId);
  if (!instanceId) {
    console.error('Could not insert/resolve instance row for message ' + messageId + '; skipping.');
    return false;
  }

  // Ask the model for the reply's main message + a stage recommendation.
  const ai = openAiClassify_(getCleanBody_(message));
  if (!ai) {
    console.warn('OpenAI classify failed for message ' + messageId + '; will retry next sweep.');
    return false;
  }

  // Step 4: post the "Lead responded with ..." note (unless already stamped).
  if (!state || !state.ac_note_datetime) {
    const noteText = 'Lead responded with "' + ai.main_message + '".\n' + NOTE_FOOTER;
    if (!acAddDealNote_(dealId, noteText)) {
      return false; // leave row un-stamped so the next sweep retries
    }
    patchInstance_(instanceId, 'ac_note_datetime', new Date().toISOString());
  }

  // Steps 5-8: change the stage if the AI picked a different allowed stage.
  if (!state || !state.stage_change_datetime) {
    const stageId = STAGE_NAME_TO_ID[ai.stage];
    if (stageId) {
      const current = acGetDealStage_(dealId);
      if (current && String(current) !== String(stageId)) {
        if (acSetDealStage_(dealId, stageId)) {
          acAddDealNote_(dealId, 'Stage changed to ' + ai.stage + '.\n' + NOTE_FOOTER);
          patchInstance_(instanceId, 'stage_change_datetime', new Date().toISOString());
          console.log('Deal ' + dealId + ' stage -> "' + ai.stage + '" (' + stageId + ') for message ' + messageId + '.');
        }
      }
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Supabase: lead_response_instances + lead lookup
// ---------------------------------------------------------------------------

/**
 * Fetch the instance row for a Gmail message id.
 * @param {string} messageId
 * @return {{id:number, ac_note_datetime:?string, stage_change_datetime:?string}|null}
 */
function getInstanceState_(messageId) {
  const key = getSupabaseKey_();
  if (!key) { return null; }
  const url = SUPABASE_URL + '/rest/v1/' + INSTANCES_TABLE +
              '?message_id=eq.' + encodeURIComponent(messageId) +
              '&select=id,ac_note_datetime,stage_change_datetime&limit=1';
  const rows = supabaseGetJson_(url, key);
  return rows && rows.length ? rows[0] : null;
}

/**
 * Resolve a lead by email: read lead_responses; if missing, call the upstream RPC to
 * insert it (idempotent, only inserts emails found in a threads table), then re-read.
 * @param {string} email  Lowercase lead email.
 * @return {{id:number, ac_deal_created:?string}|null}
 */
function resolveLeadForEmail_(email) {
  let row = selectLead_(email);
  if (row) { return row; }
  // Not recorded yet — try the upstream recorder, then re-read.
  callLeadResponseRpc_(email);
  return selectLead_(email);
}

/**
 * Read the lead_responses row for an email (case-insensitive), newest first.
 * @param {string} email
 * @return {{id:number, ac_deal_created:?string}|null}
 */
function selectLead_(email) {
  const key = getSupabaseKey_();
  if (!key) { return null; }
  const url = SUPABASE_URL + '/rest/v1/' + LEAD_RESPONSES_TABLE +
              '?email=ilike.' + encodeURIComponent(email) +
              '&select=id,ac_deal_created&order=id.desc&limit=1';
  const rows = supabaseGetJson_(url, key);
  return rows && rows.length ? rows[0] : null;
}

/**
 * Call process_lead_responses(_email_add_sent) to insert a missing lead (idempotent).
 * @param {string} email
 * @return {boolean} true on HTTP 2xx.
 */
function callLeadResponseRpc_(email) {
  const key = getSupabaseKey_();
  if (!key) { return false; }
  const url = SUPABASE_URL + '/rest/v1/rpc/' + LEAD_RESPONSE_RPC;
  const payload = {};
  payload[LEAD_RESPONSE_RPC_ARG] = email;
  const resp = supabaseFetch_(url, 'post', key, payload);
  if (resp && resp.ok) { return true; }
  console.warn('RPC ' + LEAD_RESPONSE_RPC + ' for ' + email + ' returned ' +
               (resp ? resp.code : 'no response') + '.');
  return false;
}

/**
 * Insert an instance row, ignoring a duplicate message_id. On a conflict, re-read the
 * existing row's id so the caller can resume it.
 * @param {number} leadId
 * @param {string} messageId
 * @return {number|null} the instance row id, or null on failure.
 */
function insertInstance_(leadId, messageId) {
  const key = getSupabaseKey_();
  if (!key) { return null; }
  const url = SUPABASE_URL + '/rest/v1/' + INSTANCES_TABLE;
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      Prefer: 'resolution=ignore-duplicates,return=representation'
    },
    payload: JSON.stringify({ lead_id: leadId, message_id: messageId }),
    muteHttpExceptions: true
  };
  try {
    const resp = UrlFetchApp.fetch(url, options);
    const code = resp.getResponseCode();
    if (code >= 200 && code < 300) {
      let rows = [];
      try { rows = JSON.parse(resp.getContentText()); } catch (e) { rows = []; }
      if (rows && rows.length && rows[0].id != null) {
        return rows[0].id;
      }
      // Duplicate ignored (no row returned) — read the existing row's id.
      const existing = getInstanceState_(messageId);
      return existing ? existing.id : null;
    }
    console.error('Insert into ' + INSTANCES_TABLE + ' failed (HTTP ' + code + '): ' + resp.getContentText());
    return null;
  } catch (err) {
    console.error('Insert into ' + INSTANCES_TABLE + ' error: ' + err);
    return null;
  }
}

/**
 * Stamp a timestamp column on an instance row.
 * @param {number} instanceId
 * @param {string} field  'ac_note_datetime' or 'stage_change_datetime'.
 * @param {string} isoTs  ISO-8601 timestamp.
 * @return {boolean} true on HTTP 2xx.
 */
function patchInstance_(instanceId, field, isoTs) {
  const key = getSupabaseKey_();
  if (!key) { return false; }
  const url = SUPABASE_URL + '/rest/v1/' + INSTANCES_TABLE + '?id=eq.' + encodeURIComponent(instanceId);
  const body = {};
  body[field] = isoTs;
  const resp = supabaseFetch_(url, 'patch', key, body);
  if (resp && resp.ok) { return true; }
  console.error('Patch ' + field + ' on instance ' + instanceId + ' failed (' +
                (resp ? resp.code : 'no response') + ').');
  return false;
}

// ---------------------------------------------------------------------------
// Supabase HTTP helpers
// ---------------------------------------------------------------------------

/** @return {string|null} the service_role key from Script Properties. */
function getSupabaseKey_() {
  const key = PropertiesService.getScriptProperties().getProperty(SUPABASE_KEY_PROPERTY);
  if (!key) {
    console.error('Missing Script Property "' + SUPABASE_KEY_PROPERTY + '". Set it in Project Settings.');
  }
  return key;
}

/** GET a PostgREST URL and parse the JSON array; [] / null on any failure. */
function supabaseGetJson_(url, key) {
  const options = {
    method: 'get',
    headers: { apikey: key, Authorization: 'Bearer ' + key },
    muteHttpExceptions: true
  };
  try {
    const resp = UrlFetchApp.fetch(url, options);
    const code = resp.getResponseCode();
    if (code >= 200 && code < 300) {
      try { return JSON.parse(resp.getContentText()); } catch (e) { return []; }
    }
    console.error('Supabase GET failed (HTTP ' + code + '): ' + resp.getContentText());
    return null;
  } catch (err) {
    console.error('Supabase GET error: ' + err);
    return null;
  }
}

/**
 * POST/PATCH a PostgREST/RPC URL with a JSON body.
 * @return {{ok:boolean, code:number, body:string}|null}
 */
function supabaseFetch_(url, method, key, payloadObj) {
  const options = {
    method: method,
    contentType: 'application/json',
    headers: { apikey: key, Authorization: 'Bearer ' + key },
    payload: JSON.stringify(payloadObj || {}),
    muteHttpExceptions: true
  };
  try {
    const resp = UrlFetchApp.fetch(url, options);
    const code = resp.getResponseCode();
    return { ok: code >= 200 && code < 300, code: code, body: resp.getContentText() };
  } catch (err) {
    console.error('Supabase ' + method + ' error: ' + err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

/**
 * Ask the model for the reply's main message and a stage recommendation.
 * @param {string} bodyText  Cleaned reply text.
 * @return {{main_message:string, stage:string}|null}  stage is an allowed name or 'NO_CHANGE'.
 */
function openAiClassify_(bodyText) {
  const apiKey = PropertiesService.getScriptProperties().getProperty(OPENAI_KEY_PROPERTY);
  if (!apiKey) {
    console.error('Missing Script Property "' + OPENAI_KEY_PROPERTY + '".');
    return null;
  }

  const stageNames = Object.keys(STAGE_NAME_TO_ID);
  const system =
    'You analyse a sales lead\'s email reply for James Castrission (My Adventure Group), a ' +
    'keynote-speaker / corporate-event business. Return STRICT JSON with two keys:\n' +
    '1. "main_message": a concise 1-3 sentence plain-text summary of what the lead actually ' +
    'said (their intent/request), with any greeting, signature and quoted history removed.\n' +
    '2. "stage": the sales stage this reply implies, chosen EXACTLY from this list, or the ' +
    'literal "NO_CHANGE" if none clearly applies:\n- ' + stageNames.join('\n- ') + '\n' +
    'Guidance: a positive/interested reply -> "CONTACT MADE - REPLY YES"; a clear no/not ' +
    'interested -> "CONTACT MADE - REPLY NO"; agreeing to a call/demo -> "F2F/ SALES DEMO ' +
    'BOOKED"; can\'t proceed due to a scheduling clash -> the "Missed Deals" stage. When ' +
    'unsure, use "NO_CHANGE". Output JSON only.';

  const payload = {
    model: OPENAI_MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: (bodyText || '').substring(0, 6000) }
    ]
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const resp = UrlFetchApp.fetch('https://api.openai.com/v1/chat/completions', options);
    const code = resp.getResponseCode();
    if (code < 200 || code >= 300) {
      console.error('OpenAI failed (HTTP ' + code + '): ' + resp.getContentText());
      return null;
    }
    const data = JSON.parse(resp.getContentText());
    const content = data && data.choices && data.choices[0] && data.choices[0].message &&
                    data.choices[0].message.content;
    if (!content) { return null; }
    const parsed = JSON.parse(content);
    const main = String(parsed.main_message || '').trim();
    let stage = String(parsed.stage || 'NO_CHANGE').trim();
    if (stage !== 'NO_CHANGE' && !STAGE_NAME_TO_ID.hasOwnProperty(stage)) {
      stage = 'NO_CHANGE'; // ignore anything off-list
    }
    if (!main) { return null; }
    return { main_message: main, stage: stage };
  } catch (err) {
    console.error('OpenAI request/parse error: ' + err);
    return null;
  }
}

/**
 * Best-effort clean of a reply body: plain text, quoted history / common reply markers
 * trimmed. The model does the real extraction; this just reduces noise and tokens.
 * @param {GmailMessage} message
 * @return {string}
 */
function getCleanBody_(message) {
  let body = '';
  try { body = message.getPlainBody() || ''; } catch (e) { body = ''; }

  const cutMarkers = [
    /^On .+ wrote:$/m,                 // Gmail quote header
    /^-----Original Message-----/m,
    /^________+/m,                     // Outlook divider
    /^From:\s.+$/m                     // forwarded/replied header block
  ];
  let cut = body.length;
  for (let i = 0; i < cutMarkers.length; i++) {
    const m = body.match(cutMarkers[i]);
    if (m && m.index != null && m.index < cut) {
      cut = m.index;
    }
  }
  return body.substring(0, cut).trim();
}

// ---------------------------------------------------------------------------
// ActiveCampaign (v3 REST)
// ---------------------------------------------------------------------------

/** @return {{url:string, token:string}|null} AC creds from Script Properties. */
function getAcCreds_() {
  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty(AC_API_URL_PROPERTY);
  const token = props.getProperty(AC_API_TOKEN_PROPERTY);
  if (!url || !token) {
    console.error('Missing AC Script Property (' + AC_API_URL_PROPERTY + ' / ' + AC_API_TOKEN_PROPERTY + ').');
    return null;
  }
  return { url: url.replace(/\/+$/, ''), token: token };
}

/**
 * Add a note to an AC deal: POST /api/3/deals/{id}/notes.
 * @return {boolean} true on HTTP 2xx.
 */
function acAddDealNote_(dealId, text) {
  const creds = getAcCreds_();
  if (!creds) { return false; }
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Api-Token': creds.token },
    payload: JSON.stringify({ note: { note: text } }),
    muteHttpExceptions: true
  };
  try {
    const resp = UrlFetchApp.fetch(creds.url + '/api/3/deals/' + encodeURIComponent(dealId) + '/notes', options);
    const code = resp.getResponseCode();
    if (code >= 200 && code < 300) { return true; }
    console.error('AC add-note failed for deal ' + dealId + ' (HTTP ' + code + '): ' + resp.getContentText());
    return false;
  } catch (err) {
    console.error('AC add-note error for deal ' + dealId + ': ' + err);
    return false;
  }
}

/**
 * Read an AC deal's current stage id: GET /api/3/deals/{id}.
 * @return {string|null}
 */
function acGetDealStage_(dealId) {
  const creds = getAcCreds_();
  if (!creds) { return null; }
  const options = {
    method: 'get',
    headers: { 'Api-Token': creds.token },
    muteHttpExceptions: true
  };
  try {
    const resp = UrlFetchApp.fetch(creds.url + '/api/3/deals/' + encodeURIComponent(dealId), options);
    const code = resp.getResponseCode();
    if (code >= 200 && code < 300) {
      const data = JSON.parse(resp.getContentText());
      return data && data.deal && data.deal.stage != null ? String(data.deal.stage) : null;
    }
    console.error('AC get-deal failed for ' + dealId + ' (HTTP ' + code + '): ' + resp.getContentText());
    return null;
  } catch (err) {
    console.error('AC get-deal error for ' + dealId + ': ' + err);
    return null;
  }
}

/**
 * Change an AC deal's stage: PUT /api/3/deals/{id} with {deal:{stage}}.
 * @return {boolean} true on HTTP 2xx.
 */
function acSetDealStage_(dealId, stageId) {
  const creds = getAcCreds_();
  if (!creds) { return false; }
  const options = {
    method: 'put',
    contentType: 'application/json',
    headers: { 'Api-Token': creds.token },
    payload: JSON.stringify({ deal: { stage: String(stageId) } }),
    muteHttpExceptions: true
  };
  try {
    const resp = UrlFetchApp.fetch(creds.url + '/api/3/deals/' + encodeURIComponent(dealId), options);
    const code = resp.getResponseCode();
    if (code >= 200 && code < 300) { return true; }
    console.error('AC set-stage failed for deal ' + dealId + ' -> ' + stageId + ' (HTTP ' + code + '): ' + resp.getContentText());
    return false;
  } catch (err) {
    console.error('AC set-stage error for deal ' + dealId + ': ' + err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// One-time backfill: fill lead_responses for existing label threads
// ---------------------------------------------------------------------------

/**
 * Run ONCE after deploying. Scans the whole watch label (no time window), collects
 * every distinct external (lead) sender address, and calls process_lead_responses for
 * each so lead_responses is populated for emails not yet in it. The RPC de-dups by
 * email and only inserts emails present in a threads table, so this is safe to repeat.
 */
function backfillLeadResponsesOnce() {
  const label = resolveLabel_(WATCH_LABEL_TOKEN);
  if (!label) {
    console.log('Watch label not found: "' + WATCH_LABEL_TOKEN + '". Nothing to backfill.');
    return;
  }
  const threads = GmailApp.search('label:' + WATCH_LABEL_TOKEN, 0, BATCH_SIZE);
  const seen = {};
  const emails = [];
  for (let i = 0; i < threads.length; i++) {
    const msgs = threads[i].getMessages();
    for (let j = 0; j < msgs.length; j++) {
      const from = extractEmail_(msgs[j].getFrom());
      if (isExternalLeadAddress_(from) && !seen[from]) {
        seen[from] = true;
        emails.push(from);
      }
    }
  }
  let ok = 0;
  for (let k = 0; k < emails.length; k++) {
    if (callLeadResponseRpc_(emails[k])) { ok++; }
  }
  console.log('Backfill: found ' + emails.length + ' distinct lead email(s) across ' +
              threads.length + ' thread(s); process_lead_responses called OK for ' + ok + '.');
}

// ---------------------------------------------------------------------------
// Detection helpers (shared with the upstream router)
// ---------------------------------------------------------------------------

/** True if the email is an external lead (not ours, not a system/bounce sender). */
function isExternalLeadAddress_(email) {
  return !!email && !isOurAddress_(email) && !isSystemSender_(email);
}

/** True if the email is one of ours (James / colleagues / configured aliases). */
function isOurAddress_(email) {
  if (email.indexOf('@' + OUR_DOMAIN.toLowerCase()) !== -1) {
    return true;
  }
  return OUR_EXTRA_ADDRESSES.map(function (a) { return a.toLowerCase(); }).indexOf(email) !== -1;
}

/** True if the email looks like an automated / bounce system sender. */
function isSystemSender_(email) {
  for (let i = 0; i < SYSTEM_SENDER_HINTS.length; i++) {
    if (email.indexOf(SYSTEM_SENDER_HINTS[i].toLowerCase()) !== -1) {
      return true;
    }
  }
  return false;
}

/** Extract a single lowercase email from a "From"-style header value ('' if none). */
function extractEmail_(headerValue) {
  const all = extractEmails_(headerValue);
  return all.length ? all[0] : '';
}

/** Extract all lowercase emails from a header value ([] if none). */
function extractEmails_(headerValue) {
  if (!headerValue) {
    return [];
  }
  const matches = String(headerValue).match(/[^\s<>@,;"']+@[^\s<>@,;"']+/g);
  if (!matches) {
    return [];
  }
  return matches.map(function (e) { return e.trim().toLowerCase(); });
}

// ---------------------------------------------------------------------------
// Label resolution (shared with the upstream router)
// ---------------------------------------------------------------------------

/**
 * Resolve a GmailLabel from a "label:" search token. Gmail turns spaces/slashes into
 * hyphens, so we match on a normalized form of each user label's name.
 * @param {string} token
 * @return {GmailLabel|null}
 */
function resolveLabel_(token) {
  const target = normalizeLabel_(token);
  const labels = GmailApp.getUserLabels();
  for (let i = 0; i < labels.length; i++) {
    if (normalizeLabel_(labels[i].getName()) === target) {
      return labels[i];
    }
  }
  return null;
}

/** Lowercase + collapse whitespace/slashes to single hyphens (label: token rules). */
function normalizeLabel_(name) {
  return String(name).toLowerCase().replace(/[\s\/]+/g, '-');
}

// ---------------------------------------------------------------------------
// Trigger management / setup
// ---------------------------------------------------------------------------

/**
 * Install a time-driven trigger that runs processLeadResponses() every minute.
 * Safe to run more than once: it clears existing triggers first.
 */
function createEveryMinuteTrigger() {
  deleteTriggers();
  ScriptApp.newTrigger('processLeadResponses')
    .timeBased()
    .everyMinutes(1)
    .create();
  console.log('Trigger installed: processLeadResponses() every 1 minute.');
}

/** Remove all triggers for processLeadResponses() (the off switch). */
function deleteTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  let removed = 0;
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'processLeadResponses') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  console.log('Removed ' + removed + ' existing processLeadResponses trigger(s).');
}

/** Run one scheduled-style sweep manually (use first to trigger the auth prompt). */
function testRunOnce() {
  processLeadResponses();
}
