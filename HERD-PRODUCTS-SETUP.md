# Active Herd Members: live product breakdown

Clicking **Active Herd Members** in Round Up shows a **By product** panel above the graph:
Internet (split into Cable (TPIA) and Purple Fibre), Mobile, TV and Home Phone, each with its
share of internet subs. It updates from Salesforce every 15 minutes, and anyone can press
**↻ Refresh** to pull it right away.

Files:
- `index.html`: the panel and the Refresh button
- `herd-products-function.ts`: the Supabase Edge Function that pulls the counts from Salesforce
- `supabase-herd-products.sql`: the table it saves to, and the 15-minute schedule

The website change goes live when `index.html` is pushed. Until the function and SQL are set up,
the panel says "No counts yet" and Refresh says the function isn't deployed. Nothing else changes.

## 1. Deploy the function

Supabase → **Edge Functions** → **Create a function** named exactly `herd-products` → paste
`herd-products-function.ts` → **Deploy**. Then in its **Settings**, turn **Verify JWT = OFF**
(the schedule has no login; the function checks the secret or the person's login itself).

## 2. Check the secrets

Supabase → **Project Settings → Edge Functions → Secrets**. It uses the same ones as the MDU sync:
`SYNC_SECRET`, `SF_LOGIN_URL`, `SF_CLIENT_ID`, `SF_CLIENT_SECRET`, `SF_USERNAME`, `SF_PASSWORD`.
If they aren't there, follow steps 1 and 3 of `MDU-SYNC-SETUP.md`. The Salesforce user needs read
access to Customer Details, Mobile, TV and Phone.

## 3. Run the SQL

Supabase → **SQL Editor**:
1. On its own, with the real `SYNC_SECRET` value pasted in (don't save it into the file):
   `select vault.create_secret('<the SYNC_SECRET value>', 'herd_sync_secret');`
2. Then run all of `supabase-herd-products.sql`.

## 4. Test it

Open Round Up → Metrics → **Active Herd Members** → **↻ Refresh**. The panel should show
"Live · updated" with today's time. Within 15 minutes, this should show a row with
`source = 'schedule'`:

```sql
select taken_at, ok, source, internet, cable, fibre, mobile_lines, tv, phone, error
from public.herd_product_counts order by taken_at desc limit 5;
```

## The checks built in

- Every pull is checked before it's shown. If Internet, Cable (TPIA), Purple Fibre, Mobile, TV or
  Home Phone comes back blank or 0, the pull is saved as failed and the panel keeps the last good
  numbers. Cable and Fibre are checked separately so one side can't go missing inside the total.
- The status turns amber if the newest pull failed (hover for the reason) or the newest good pull
  is more than an hour old, so a stopped schedule is obvious.
- A Refresh within a minute of a good pull reuses it instead of asking Salesforce again.

## Where the numbers come from (Salesforce)

| Panel | Count |
|---|---|
| Internet | Sum of Live Internet Count on Customer Details |
| Purple Fibre | Sum of Live Purple Fibre Internet Count on Customer Details |
| Cable (TPIA) | Internet minus Purple Fibre (Eastlink and Bell) |
| Mobile | Mobile records with Line Status = Active |
| Mobile Herd Members / mobile only | Customer Details with Has Active Mobile (and Is Mobile Only) |
| TV | Purple Cow TV records with Account Status = ACTIVE |
| Home Phone | Phone records with Account Status = Active and Stage = Live |

Shares are each product's count divided by Internet. The herd counts subscriptions (mobile is its
own subscription), so it isn't used as the base.
