import { app } from "./app";

const port = Number(process.env.API_PORT ?? 3000);
app.listen({ hostname: "0.0.0.0", port });
console.log(`Elysia API listening on ${port}`);
