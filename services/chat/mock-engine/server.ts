import "dotenv/config";
import { MockEngine } from "./engine.js";

const token = process.env.INTERNAL_API_TOKEN;
if (!token) {
  console.error("Set INTERNAL_API_TOKEN (same value the chat service uses).");
  process.exit(1);
}
const port = Number(new URL(process.env.ENGINE_URL ?? "http://localhost:3001").port || 3001);
const engine = new MockEngine({ token, mockCostCents: Number(process.env.MOCK_COST_CENTS ?? 120) });
await engine.start(port);
console.log(`MOCK engine listening on ${engine.url}. No real purchases are ever made.`);
