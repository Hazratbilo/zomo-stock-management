# ZOMO Stock Management

A responsive inventory, sales and team dashboard for ZOMO ADVANCED TECHNOLOGIES LIMITED, built with React, Vite and Supabase.

## Start the application

```sh
npm install
npm run dev
```

The app starts with an empty workspace. It does not include sample products, sales, staff, or dashboard figures.

## Connect Supabase

1. Create a Supabase project and copy its Project URL and **publishable** key. The app guides you through entering both the first time you open it; they can also be provided in `.env.local` as `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`.
2. In a new Supabase project, open SQL Editor and run `supabase/schema.sql`. For the existing ZOMO project, apply the service workflow migration if it has not already been applied, then apply `supabase/migrations/20261025_payment_tracking.sql` in SQL Editor to enable service fees, outstanding balances and payment history.
3. Create the owner's account in Supabase Authentication, then add the owner's Auth UUID, name, and email to `public.profiles` as an `owner` (see the SQL at the end of the schema).
4. Sign in through the app. Public sign-up is intentionally disabled; an owner controls representative access.

Only use a Supabase publishable key in the browser. Never put a secret or `service_role` key in this app.

The SQL schema sets up one owner to many sales representatives, products, role-aware row level security, and an atomic `record_sale` function that reduces stock without permitting overselling. Representatives can read workspace stock and their own sales only. The owner can view all sales across the team, remove inventory and manage team access.

NIN registration requests store the customer’s name, contact number, agreed total fee, payments received and `pending`/`done` processing status. They do not ask for an existing NIN number. SIM records capture the agreed service fee and amount paid; registering a SIM atomically subtracts one available SIM. All three workflows support later installment payments, which are checked against the remaining balance by a database function. An auditable payment ledger dates receipts when collected, so weekly and monthly reports show money received in the right period and outstanding balances for new records. Older service records did not contain fee totals, so the migration treats their recorded amount paid as their known total rather than inventing old debt. Lists mask phone digits, and each representative sees only their own requests and SIM logs.

### Sales representative invitations

Supabase Auth Admin creation requires a trusted server environment. Never pass an Auth service-role key to the browser. Deploy the included `invite-sales-rep` Supabase Edge Function:

1. The `invite-sales-rep` function is deployed to the connected Supabase project. Supabase provides its API keys in the Edge Function runtime; keep any secret key out of the browser app.
2. The function validates the caller's bearer token and `owner` profile, checks the representative's details, creates the Auth account, and inserts a `sales_rep` profile attached to that owner. It removes the Auth account if profile creation fails.
3. Browser access is limited to `http://127.0.0.1:5173` and `http://localhost:5173` by default. If the app is hosted at another address, set the Edge Function secret `APP_ORIGIN` to that exact application origin (or a comma-separated list of allowed origins).

Removing a representative revokes their profile association and existing sessions while retaining their historical sales.

## Current scope

Product creation without SKU, product removal, filtering, searching, CSV export, inventory alerts, sales overview, separate NIN request and SIM stock/registration tracking, reporting and team overview use live Supabase data. Empty states are shown until you add company records.
