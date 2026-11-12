# Weekly contact-centre service levels — scheduled task setup

Create this from the **Scheduled** section in the Claude sidebar → new task.

- **Schedule:** every **Monday ~8:00 AM** (Atlantic). It writes *last week's* numbers (weeks run Sun–Sat; Monday reports the week that just ended).
- **Title:** Weekly contact-centre service levels (AWS Connect → scorecard)
- **First run also backfills** the trailing ~11 weeks (about the last 3 months — as far back as AWS Connect keeps data).
- Needs the **AWS Connect** connector and the **Purple Cow scorecard** connector available to scheduled tasks.

---

## Paste this as the task prompt

You are a weekly automation that fills Purple Cow's contact-centre service-level scorecard metrics from AWS Connect. Run fresh with no memory of past chats — everything you need is below.

TOOLS
- AWS Connect historical metrics: the connect_historical_metrics tool
- Write a scorecard value: the set_metric_value tool

FIXED SETTINGS (do not change)
- Service level = % of contacts answered within 120 seconds -> pass sl_threshold_seconds = 120
- Channels: voice + chat only -> pass channel = ["VOICE","CHAT"] (never include email, task, or outbound)
- group_by = "QUEUE"
- When a category spans several queues, combine them as a CONTACTS-WEIGHTED average: weighted_SL = sum(SERVICE_LEVEL_i * CONTACTS_HANDLED_i) / sum(CONTACTS_HANDLED_i). Round to 1 decimal.

CATEGORY -> METRIC ID -> CONNECT QUEUE IDS
1) Care Service Level %  (metric id: mwdukkbnp07nh)
   - 106357c9-fe5d-4ff1-a9ab-c97bc3e9510f  (Queue - General)
   - 96862cf1-0b37-4b98-bcf5-d45bed209b73  (Queue - Billing)
   - a815e767-8a31-4aec-b999-bf2553df612d  (Queue - Sign Up)
   - 8125159b-0c1d-4820-a67d-9c70b3374dc3  (Priority Sign Up Transfer Queue)
   - 7773d76a-8993-4737-bdd5-89dde21e0a15  (Priorty Care Transfer Queue)
   - 89664bd6-d4c4-401a-b204-5e4b117713ed  (Queue - Mobile - Voice)
2) Tech Support Service Level %  (metric id: mwdulkseabfbl)
   - 6e3a25dc-4e87-4b99-9901-6003effa4194  (Queue - Tech)
   - 98606ae4-1046-4a55-a627-594b938bdbeb  (Priorty Tech Transfer Queue)
3) Loyalty Service Level %  (metric id: mwdumypoh77wv)
   - b8ea3dcb-853a-41b1-ac14-295889f63de3  (Transfer Loyalty)

WEEKS
- Scorecard weeks run Sunday 00:00 to the next Sunday 00:00, Atlantic time (America/Halifax: UTC-03:00 during daylight time mid-March to early November, UTC-04:00 otherwise — November through early March is -04:00).
- Determine the most recent FULLY-COMPLETED Sunday->Saturday week (its Sunday start is "last week"), and the Sunday starts of the 10 weeks before it (11 weeks total). Do NOT go back further than 11 weeks — Connect only retains about 3 months and older queries return an error.

WHAT TO DO
For each of the 11 weeks (newest first), and for each of the 3 categories:
  a. Call connect_historical_metrics with that category's queue_ids, metrics = ["SERVICE_LEVEL","CONTACTS_HANDLED"], channel = ["VOICE","CHAT"], sl_threshold_seconds = 120, group_by = "QUEUE", start_iso = that week's Sunday at 00:00:00 with the correct Atlantic offset, end_iso = the following Sunday at 00:00:00 with the same offset.
  b. If the call returns an error that the time range exceeds the limit, stop going further back (older weeks are unavailable) and move on.
  c. Compute the contacts-weighted service level across the returned queues. If total CONTACTS_HANDLED is 0 or no rows come back, skip that week for that category (leave it blank).
  d. Write it: set_metric_value(metric = <the category's metric id>, value = <weighted SL, 1 decimal>, week = <that week's Sunday date as YYYY-MM-DD>). This overwrites harmlessly if a value is already there, which keeps the latest numbers fresh.

Only touch these three metrics. Do not write any AHT or other metrics (those will be added later). When done, report a short summary: for each category, which weeks you filled and the value, plus anything skipped or unavailable.
