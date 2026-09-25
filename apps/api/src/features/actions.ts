import { Elysia, t } from "elysia";

type ActionReceipt = {
  id: string;
  action: string;
  createdAt: string;
};

type EventsClient = {
  send(data: string): void;
};

export function actionsFeature() {
  const actions: ActionReceipt[] = [];
  const clients = new Set<EventsClient>();

  return new Elysia()
    .get("/api/actions", () => ({ actions }))
    .post(
      "/api/actions",
      ({ body, set }) => {
        const receipt: ActionReceipt = {
          id: crypto.randomUUID(),
          action: body.action,
          createdAt: new Date().toISOString(),
        };
        actions.unshift(receipt);
        set.status = 201;
        const event = JSON.stringify({ type: "action.created", receipt });
        for (const client of clients) client.send(event);
        return receipt;
      },
      { body: t.Object({ action: t.String({ minLength: 1, maxLength: 120 }) }) },
    )
    .ws("/api/events", {
      open(client) {
        clients.add(client);
        client.send(JSON.stringify({ type: "snapshot", actions }));
      },
      close(client) {
        clients.delete(client);
      },
    });
}
