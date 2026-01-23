# Udacity Mentor Dashboard — Daily Income Counter (Tampermonkey)

A Tampermonkey userscript that calculates **today’s income (USD)** from **Reviews + Questions** on Udacity’s Mentor Dashboard and shows it as a small pill near the bottom-right of the page.

- **Script file**: `udacity-mentor-daily-income.user.js`
- **Runs on**: `https://mentor-dashboard.udacity.com/queue/*`
- **“Today” timezone**: **Greece** (`Europe/Athens`)

## Install

1. Install the browser extension **Tampermonkey**.
2. Open Tampermonkey → **Create a new script**.
3. Paste the contents of `udacity-mentor-daily-income.user.js`.
4. Save.
5. Refresh the Mentor Dashboard.

## What you’ll see

A compact pill showing:

- **R**: Reviews income today
- **Q**: Questions income today
- **T**: Total income today
- **OK / … / ERR**: status indicator (ready / loading / error)

Click **`i`** to open details and see debug info (endpoints discovered, last parse time, data source, etc).

## How it calculates totals

The dashboard data is not reliably readable via a hidden iframe (cross-origin restrictions can apply), so the script uses a multi-step strategy:

- **History page**: reads the visible tables and computes totals.
- **Cache**: saves today’s totals in `localStorage`.
- **Overview / other pages**:
  - Uses **API mode** only when it has discovered **both** required endpoints (reviews + questions).
  - Otherwise, it shows **cached totals** (so you don’t lose the value when you leave History).

## Positioning

The pill is placed at the bottom-right and attempts to sit **above Udacity’s “Auto Refresh” widget** to avoid overlap. If that widget can’t be detected, it uses a safe bottom offset.

## Configuration

### Change timezone

In `udacity-mentor-daily-income.user.js`, edit:

```js
const TODAY_TIME_ZONE = 'Europe/Athens';
```

Use any valid IANA timezone (e.g. `America/Los_Angeles`).

## Troubleshooting

### It shows $0.00 on Overview

- Go to **History** and wait for the pill to show the correct total there (this updates the cache).
- Return to **Overview**.
- Click **`i`** and check:
  - **Source**: should be `cache` (until API is fully discovered) or `api` once endpoints are found
  - **Endpoints**: should eventually show `reviews=yes` and `questions=yes` for API mode

If it never discovers both endpoints, on **History** click **Older** once or twice (this often triggers the “list” API calls).

### It overlaps the Auto Refresh box

Refresh the page. The script re-measures and re-positions during rendering and on window resize. If Udacity changes the Auto Refresh widget structure, the fallback bottom offset should still avoid overlap.

## Privacy & safety

- The script runs locally in your browser.
- It does **not** send data anywhere.
- It stores small bits of state in `localStorage` (cached totals + discovery/debug metadata).

