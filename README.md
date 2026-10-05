# Juniper Salon: last-minute openings

When a client cancels, this prototype offers the opening to waitlisted clients **one at a time**, in the order they joined, until someone accepts. Each client gets 15 minutes to reply. The first "yes" is booked immediately and nobody else can claim the opening. Staff see who has the offer, when it ends, who declined or didn't reply, and who's next, and they can cancel at any time.

It's built on [Temporal](https://temporal.io): each opening is a durable Workflow, so timers, replies, and retries survive restarts.

## Run it (one command)

Requirements: **Node.js 20+** and **Docker Desktop (running)**.

```bash
npm start
```

Then open **http://localhost:3000**. The Temporal Web UI is at http://localhost:8233.

`npm start` installs dependencies, starts Temporal in Docker, and runs the Worker and the web app. Press Ctrl+C to stop it, then run `npm run stop` to shut down Temporal.

## Two-minute demo

1. Under **Log a cancellation**, choose *Carla · Haircut*, a **weekday** at **3:00 PM** at least a day ahead, and tick **Demo speed** (30-second offers instead of 15 minutes). Click **Start offering this opening**.
2. The opening shows **Maya Chen** holding the offer with a countdown. **Next in line** lists Priya, Jordan, and Elena (all on the waitlist, wanting a haircut, free then, and happy with Carla).
3. On the **Client phone**, choose *Maya Chen* and tap **NO**. Maya moves to *Declined*.
4. Priya's number on file is invalid, so she's skipped with a *Couldn't text* notice, and **Jordan** gets the offer.
5. Switch the phone back to *Maya* and tap **YES** on her old offer. She's told the offer has expired. This is the "two people accepted the same Saturday haircut" problem, prevented.
6. Wait 30 seconds without answering for Jordan: a notice says his offer expired, and **Elena** gets it.
7. Switch to *Elena* and tap **YES**. The opening shows **Booked**, with a reminder to update Square.

More to try:
- **Cancel this opening** while an offer is out. The client holding it is told it's no longer available.
- Tick **Simulate a text message outage** before logging an opening. Texts are retried automatically; if the outage lasts, the opening stops with "Please contact clients directly."
- **Durability:** while an offer is counting down, press Ctrl+C to stop the app (Temporal keeps running in Docker), wait a bit, then run `npm run dev`. The opening picks up where it left off; if the offer expired while the app was down, it moves on to the next client as soon as the app is back.
- In the **Temporal Web UI**, open any `opening-…` Workflow to see every step in its history.

## How it works

| Piece | Where | Role |
|---|---|---|
| `fillOpening` Workflow | `src/workflows.ts` | One per opening. Offers to each eligible client in turn and waits on a durable timer (15 minutes, never past the cutoff). |
| `respondToOffer` Update | `src/workflows.ts` | A client's YES or NO. Replies are processed one at a time, so only the current offer holder can book. Late replies get the "expired" message. |
| `cancelOpening` Update | `src/workflows.ts` | Staff cancel, with a definite answer ("Cancelled" or "Too late, already booked"). |
| `getStatus` Query | `src/workflows.ts` | Everything the staff page shows. |
| Activities | `src/activities.ts` | Read the waitlist; send (simulated) texts with automatic retries. Invalid numbers are skipped, not retried. |
| API | `src/api.ts` | Routes for the page. |
| Page | `public/` | Staff view, simulated client phone, demo controls. |

**Workflow ID = the slot** (`opening-<stylist>-<date>-<time>`), so the same opening can't be run twice at once, and a slot that was booked can't be offered again.

## Decisions and assumptions

From the conversation with Lena:
- Offer to **one client at a time**, never a group text.
- Eligible clients want the service, are free for the whole appointment, and either named this stylist or named none. The earliest to join goes first.
- **15 minutes** per offer, then automatically the next client.
- **A yes books immediately.** Staff update Square themselves.
- A late reply is told the offer expired and is **never** booked automatically.
- Staff can cancel if the original client returns or the stylist becomes unavailable.

Assumptions made for the prototype:
- **Cutoff: 45 minutes before the appointment.** An offer's window is shortened so it never runs past the cutoff. If less than 2 minutes would be left to reply, no new offer is sent and the opening stops as *Too late*.
- **Texts are simulated** (the client phone panel). No real SMS, Square, or Google Sheets connection.
- The waitlist is a seed file of fictional clients (`data/waitlist.json`). Someone who declines or doesn't reply isn't asked again for that opening, but stays on the waitlist.
- Times are the salon's local time (the machine running the app).
- Out of scope: logins, editing the waitlist, and stopping one client from accepting two *different* openings.

## Tests

```bash
npm test          # eligibility, request validation, Activities, and Workflow tests (no Docker needed)
npm run typecheck
```

The Workflow tests use Temporal's time-skipping test server, so the 15-minute timers run instantly. They cover:
- booking, timeouts, decline-all, and nobody eligible
- late and duplicate replies, including a YES after someone else booked
- staff cancel: during an offer, after a booking, and during a texting outage
- the cutoff: shortened windows, too little time left, and an offer delivered late
- invalid numbers and a persistent texting outage

## Repository map

- `src/workflows.ts`: the `fillOpening` Workflow, Query, and Updates
- `src/activities.ts`: waitlist lookup and simulated texting
- `src/eligibility.ts`: who can be offered an opening, and in what order
- `src/requests.ts`: form validation and late-reply answers for the API
- `src/store.ts`: seed data and the demo outage switch
- `src/worker.ts`, `src/api.ts`: Worker and web server
- `public/`: the page
- `data/waitlist.json`: fictional stylists, services, and clients
- `docs/deck/`: short slide deck for Lena (PDF)
- `docs/superpowers/`: design spec and implementation plan
- `evidence/`: Temporal Web UI screenshot
