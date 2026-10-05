import path from "node:path";
import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
  WorkflowUpdateFailedError,
} from "@temporalio/client";
import express, { type NextFunction, type Request, type Response } from "express";
import { lateCancelResult, lateReplyResult, parseOpeningRequest } from "./requests";
import { isOutageOn, loadSalon, setOutage } from "./store";
import { TASK_QUEUE, type OpeningStatus } from "./types";
import { cancelOpening, fillOpening, getStatus, respondToOffer } from "./workflows";

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

let clientPromise: Promise<Client> | undefined;
function getClient(): Promise<Client> {
  clientPromise ??= Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
  }).then((connection) => new Client({ connection, namespace: "default" }));
  return clientPromise;
}

async function statusOf(openingId: string): Promise<OpeningStatus> {
  const client = await getClient();
  try {
    return await client.workflow.getHandle(openingId).query(getStatus);
  } catch (error) {
    if (error instanceof WorkflowNotFoundError) throw new HttpError(404, "That opening doesn't exist.");
    throw error;
  }
}

async function recentOpenings(limit = 20): Promise<OpeningStatus[]> {
  const client = await getClient();
  const ids = new Set<string>();
  for await (const execution of client.workflow.list({ query: "WorkflowType = 'fillOpening'" })) {
    ids.add(execution.workflowId);
    if (ids.size >= limit) break;
  }
  const statuses = await Promise.all([...ids].map((id) => statusOf(id).catch(() => undefined)));
  return statuses.filter((status): status is OpeningStatus => status !== undefined);
}

app.get("/api/salon", async (_request, response) => {
  const salon = await loadSalon();
  response.json({
    stylists: salon.stylists,
    services: salon.services,
    clients: salon.clients.map((client) => ({ id: client.id, name: client.name })),
  });
});

app.get("/api/openings", async (_request, response) => {
  response.json({ openings: await recentOpenings() });
});

app.post("/api/openings", async (request, response) => {
  const parsed = parseOpeningRequest(request.body ?? {});
  if ("error" in parsed) throw new HttpError(400, parsed.error);

  // A slot that was already booked must never be offered again.
  const previous = await statusOf(parsed.openingId).catch(() => undefined);
  if (previous?.phase === "booked") {
    throw new HttpError(409, `${previous.bookedClient?.name ?? "A client"} already booked this opening.`);
  }

  const client = await getClient();
  try {
    await client.workflow.start(fillOpening, {
      workflowId: parsed.openingId,
      taskQueue: TASK_QUEUE,
      args: [parsed.openingId, parsed.opening],
    });
  } catch (error) {
    if (error instanceof WorkflowExecutionAlreadyStartedError) {
      throw new HttpError(409, "This opening is already being offered to the waitlist.");
    }
    throw error;
  }
  response.status(201).json({ openingId: parsed.openingId });
});

app.get("/api/openings/:id", async (request, response) => {
  response.json(await statusOf(request.params.id));
});

app.post("/api/openings/:id/respond", async (request, response) => {
  const clientId = typeof request.body?.clientId === "string" ? request.body.clientId : "";
  if (!clientId) throw new HttpError(400, "Missing client.");
  const handle = (await getClient()).workflow.getHandle(request.params.id);
  try {
    response.json(await handle.executeUpdate(respondToOffer, { args: [{ clientId, accept: request.body.accept === true }] }));
  } catch (error) {
    if (error instanceof WorkflowUpdateFailedError) {
      throw new HttpError(400, error.cause?.message ?? "That reply couldn't be accepted.");
    }
    // The opening has probably finished already; answer from its final status.
    const late = lateReplyResult(await statusOf(request.params.id), clientId);
    if (!late) throw new HttpError(400, "There's no offer for this client on that opening.");
    response.json(late);
  }
});

app.post("/api/openings/:id/cancel", async (request, response) => {
  const reason = typeof request.body?.reason === "string" ? request.body.reason : "";
  const handle = (await getClient()).workflow.getHandle(request.params.id);
  try {
    response.json(await handle.executeUpdate(cancelOpening, { args: [{ reason }] }));
  } catch (error) {
    if (error instanceof WorkflowUpdateFailedError) throw error;
    // The opening has probably finished already (404 if it never existed).
    response.json(lateCancelResult(await statusOf(request.params.id)));
  }
});

app.get("/api/clients/:id/messages", async (request, response) => {
  const messages = (await recentOpenings())
    .flatMap((status) =>
      status.texts
        .filter((text) => text.clientId === request.params.id)
        .map((text) => ({ ...text, openingId: status.openingId })),
    )
    .sort((a, b) => a.at.localeCompare(b.at));
  response.json({ messages });
});

app.get("/api/simulate/outage", (_request, response) => {
  response.json({ on: isOutageOn() });
});

app.post("/api/simulate/outage", async (request, response) => {
  await setOutage(request.body?.on === true);
  response.json({ on: isOutageOn() });
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  if (error instanceof HttpError) {
    response.status(error.status).json({ error: error.message });
    return;
  }
  console.error(error);
  response.status(500).json({ error: "Something went wrong. Check that the app is still running." });
});

const port = Number(process.env.PORT ?? 3000);
// Start every session with texting working normally.
setOutage(false).then(() => {
  app.listen(port, () => console.log(`Juniper Salon openings app: http://localhost:${port}`));
});
