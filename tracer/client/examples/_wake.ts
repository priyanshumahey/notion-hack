import { sendEvent } from "../src/index.js";

const r = await sendEvent({
  url: process.env.SEND_EVENT_URL!,
  secret: process.env.TRACER_SECRET!,
  name: "approval.decided",
  data: {
    requestId: process.env.REQ_ID ?? "req_mp91nrso",
    decision: "approved",
    decidedBy: "bob@acme.com",
    reason: "Within Q4 discretionary budget",
  },
});
console.log("accepted", r.status, r.eventId);
