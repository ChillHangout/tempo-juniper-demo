# Evidence

`temporal-ui.png` shows one representative opening, `opening-carla-2026-10-07-1500`, in the Temporal Web UI:

- **Workflow ID and Completed status**, with the input (Haircut with Carla, demo-speed 30-second offers) and the result (`phase: "booked"`, booked client Elena Rossi).
- **Timeline of the event history:**
  - the eligible-client lookup
  - an offer text and 30-second timer for Maya, ended early by her `respondToOffer` decline
  - a failed text to Priya, whose seeded number is invalid, so she was skipped
  - Jordan's offer timer running out
  - Elena's offer, her accepting `respondToOffer` Update, and the confirmation text

During this run the app was stopped and restarted while Jordan's offer was counting down. The Workflow resumed and moved on to Elena when the app came back. All client data is fictional.
