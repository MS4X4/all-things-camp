# All Things Camp — Setup Guide
## Zero subscriptions. Zero Google. Entirely free.

| Service | Purpose | Cost |
|---|---|---|
| **Supabase** | Auth + Database | Free tier — no credit card |
| **OpenStreetMap** | Map tiles | Always free |
| **Nominatim** | Geocoding / search | Always free |
| **Bunny Fonts** | Typography CDN | Always free |
| **Leaflet.js** | Map interaction | Open source |
| **GitHub Pages / Netlify / Cloudflare Pages** | Hosting | Always free |

---

## Step 1 — Create a Supabase Project

1. Go to [supabase.com](https://supabase.com) and click **Start your project**
2. Sign up with GitHub, GitLab, or email — **no credit card required**
3. Click **New project** → give it a name → choose a region → set a database password
4. Wait ~2 minutes for the project to provision

---

## Step 2 — Run the SQL Schema

In your Supabase project go to **SQL Editor** and run the following:

```sql
-- ── Profiles (one row per user) ──────────────────────────────
create table if not exists profiles (
  id           uuid primary key references auth.users on delete cascade,
  display_name text,
  email        text,
  created_at   timestamptz default now()
);

-- Auto-create a profile row whenever a new user registers
create or replace function handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, split_part(new.email,'@',1))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ── Groups ───────────────────────────────────────────────────
create table if not exists groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  owner_id    uuid references profiles(id) on delete set null,
  owner_name  text,
  created_at  timestamptz default now()
);

-- ── Group members ─────────────────────────────────────────────
create table if not exists group_members (
  id        uuid primary key default gen_random_uuid(),
  group_id  uuid references groups(id)  on delete cascade,
  user_id   uuid references profiles(id) on delete cascade,
  joined_at timestamptz default now(),
  unique(group_id, user_id)
);

-- ── Invites ───────────────────────────────────────────────────
create table if not exists invites (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid references groups(id) on delete cascade,
  group_name text,
  from_id    uuid references profiles(id),
  from_name  text,
  to_email   text,
  status     text default 'pending',  -- pending | accepted | declined
  created_at timestamptz default now()
);

-- ── Map pins ──────────────────────────────────────────────────
create table if not exists pins (
  id               uuid primary key default gen_random_uuid(),
  group_id         uuid references groups(id) on delete cascade,
  name             text not null,
  address          text,
  lat              double precision,
  lng              double precision,
  status           text default 'Maybe',  -- Maybe|Planned|Booked|Paid|Been There
  campmaster_id    uuid references profiles(id),
  campmaster_name  text,
  created_by       uuid references profiles(id),
  created_by_name  text,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

-- ── Pin chat messages ─────────────────────────────────────────
create table if not exists pin_chat (
  id           uuid primary key default gen_random_uuid(),
  pin_id       uuid references pins(id) on delete cascade,
  user_id      uuid references profiles(id),
  display_name text,
  message      text,
  created_at   timestamptz default now()
);

-- ── Pin ratings (one per user per pin) ───────────────────────
create table if not exists pin_ratings (
  id           uuid primary key default gen_random_uuid(),
  pin_id       uuid references pins(id) on delete cascade,
  user_id      uuid references profiles(id),
  display_name text,
  rating       integer check (rating >= 1 and rating <= 5),
  created_at   timestamptz default now(),
  unique(pin_id, user_id)
);
```

---

## Step 3 — Enable Row Level Security (RLS)

Still in **SQL Editor**, run:

```sql
-- Enable RLS on every table
alter table profiles    enable row level security;
alter table groups      enable row level security;
alter table group_members enable row level security;
alter table invites     enable row level security;
alter table pins        enable row level security;
alter table pin_chat    enable row level security;
alter table pin_ratings enable row level security;

-- Profiles: visible to authenticated users, editable by owner
create policy "profiles_select" on profiles for select using (auth.role()='authenticated');
create policy "profiles_insert" on profiles for insert with check (auth.uid()=id);
create policy "profiles_update" on profiles for update using (auth.uid()=id);

-- Groups: visible and editable by members
create policy "groups_select" on groups for select
  using (id in (select group_id from group_members where user_id=auth.uid()));
create policy "groups_insert" on groups for insert
  with check (auth.uid()=owner_id);
create policy "groups_update" on groups for update
  using (owner_id=auth.uid());
create policy "groups_delete" on groups for delete
  using (owner_id=auth.uid());

-- Group members: visible to fellow members, insert by owner or self, delete by owner
create policy "gm_select" on group_members for select
  using (group_id in (select group_id from group_members where user_id=auth.uid()));
create policy "gm_insert" on group_members for insert
  with check (
    user_id=auth.uid() or
    group_id in (select id from groups where owner_id=auth.uid())
  );
create policy "gm_delete" on group_members for delete
  using (
    user_id=auth.uid() or
    group_id in (select id from groups where owner_id=auth.uid())
  );

-- Invites: recipient and sender can see them; sender can create; recipient can update
create policy "inv_select" on invites for select
  using (to_email=(select email from auth.users where id=auth.uid()) or from_id=auth.uid());
create policy "inv_insert" on invites for insert with check (from_id=auth.uid());
create policy "inv_update" on invites for update
  using (to_email=(select email from auth.users where id=auth.uid()));

-- Pins: full access for group members
create policy "pins_select" on pins for select
  using (group_id in (select group_id from group_members where user_id=auth.uid()));
create policy "pins_insert" on pins for insert
  with check (group_id in (select group_id from group_members where user_id=auth.uid()));
create policy "pins_update" on pins for update
  using (group_id in (select group_id from group_members where user_id=auth.uid()));
create policy "pins_delete" on pins for delete
  using (group_id in (select group_id from group_members where user_id=auth.uid()));

-- Pin chat: group members only
create policy "chat_select" on pin_chat for select
  using (pin_id in (select id from pins where group_id in (select group_id from group_members where user_id=auth.uid())));
create policy "chat_insert" on pin_chat for insert
  with check (pin_id in (select id from pins where group_id in (select group_id from group_members where user_id=auth.uid())));

-- Ratings: group members can read; users manage their own rating
create policy "ratings_select" on pin_ratings for select
  using (pin_id in (select id from pins where group_id in (select group_id from group_members where user_id=auth.uid())));
create policy "ratings_insert" on pin_ratings for insert with check (user_id=auth.uid());
create policy "ratings_update" on pin_ratings for update using (user_id=auth.uid());
```

---

## Step 4 — Enable Real-Time for Tables

Supabase real-time subscriptions require tables to be added to the replication publication.

In **SQL Editor**, run:

```sql
alter publication supabase_realtime add table
  groups, group_members, invites, pins, pin_chat, pin_ratings;
```

---

## Step 5 — Get Your API Credentials

Go to **Project Settings → API** and copy:

- **Project URL** (looks like `https://abcxyz.supabase.co`)
- **anon public** key (long JWT string)

Open `all-things-camp.html` and replace these two lines:

```js
const SUPABASE_URL = 'YOUR_SUPABASE_URL';
const SUPABASE_KEY = 'YOUR_SUPABASE_ANON_KEY';
```

---

## Step 6 — Deploy for Free

Rename `all-things-camp.html` to `index.html` and place it alongside `sw.js`.

### Option A — GitHub Pages (completely free)
```bash
git init && git add . && git commit -m "initial"
# Push to GitHub, then enable Pages in repo Settings → Pages → Deploy from branch
```

### Option B — Netlify (free tier, drag & drop)
1. Go to [app.netlify.com](https://app.netlify.com)
2. Drag your project folder onto the deploy zone
3. Done — live in ~30 seconds

### Option C — Cloudflare Pages (free, fast CDN)
```bash
npm install -g wrangler
wrangler pages deploy . --project-name all-things-camp
```

All three options give you HTTPS automatically, which is required for PWA service workers.

---

## Step 7 — PWA Manifest (optional, makes it installable)

Create `manifest.json` alongside `index.html`:

```json
{
  "name": "All Things Camp",
  "short_name": "Camp",
  "description": "Your camping companion",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#1a2e1a",
  "theme_color": "#2d5a1b",
  "orientation": "portrait",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

Add this inside `<head>` in `index.html`:

```html
<link rel="manifest" href="/manifest.json" />
```

---

## About Invites

Invites are stored in the database and shown in-app to any user who logs in with the invited email address. No email is sent automatically — this avoids needing a paid email service.

**To add real email delivery (still free):**

1. Sign up at [resend.com](https://resend.com) — free tier: 3,000 emails/month, no credit card
2. In Supabase: **Edge Functions → New Function** named `send-invite-email`
3. Trigger it on `invites` INSERT via a database webhook
4. The function calls the Resend API to send a notification email

This is optional — the app is fully functional without it.

---

## Supabase Free Tier Limits

| Resource | Free Allowance |
|---|---|
| Database | 500 MB |
| Bandwidth | 2 GB / month |
| Auth users | 50,000 monthly active users |
| Real-time messages | 2 million / month |
| Edge Function invocations | 500,000 / month |
| Projects | 2 |

More than enough for a camp group app. No credit card required to stay on the free tier.
