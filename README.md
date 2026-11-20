# Aunty Tauhu app

Booths (BWA consignment), vendors (DD, Kuekas), customer orders (BWA and direct),
invoices and PDF reports for **Aunty Tauhu Enterprise**.

- **App:** `index.html` (opens from the Home Screen like an app)
- **Setup guide:** `setup.html`
- **Database:** `supabase/schema.sql` (paste into Supabase SQL Editor)
- **Settings:** `config.js` (Supabase Project URL + anon public key)

Hosted free on GitHub Pages. Data is stored in Supabase and protected by login:
the owner sees everything; kitchen staff see customer orders only; new accounts
wait for the owner's approval.
