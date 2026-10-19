import { test } from "node:test"
import assert from "node:assert/strict"
import { Agent } from "../../src/core/agent.ts"
import { FakeProvider } from "../../src/providers/fake.ts"
import { ToolRegistry } from "../../src/tools/registry.ts"
import { clonePolicy, DEFAULT_POLICY } from "../../src/sandbox/policy.ts"
import { openDatabase } from "../../src/store/db.ts"
import { migrate } from "../../src/store/migrations.ts"
import { SqliteSessionStore } from "../../src/store/sessions.ts"
import type { ProviderMessage } from "../../src/providers/types.ts"
import type { AgentEvent } from "../../src/core/events.ts"

async function drive(agent: Agent, text: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  const finished = (async (): Promise<void> => {
    for await (const event of agent.events()) {
      events.push(event)
      if (event.t === "turn.end") break
    }
  })()
  agent.send({ t: "submit", text })
  await finished
  return events
}

function inputTokens(events: AgentEvent[]): number {
  return events.reduce((total, event) => (event.t === "usage" ? total + event.turnInput : total), 0)
}

function makeAgent(store: SqliteSessionStore, sessionId: string, history: ProviderMessage[]): Agent {
  return new Agent({
    provider: new FakeProvider(),
    model: "fake-1",
    tier: "normal",
    tools: new ToolRegistry(),
    policy: clonePolicy(DEFAULT_POLICY),
    cwd: "/tmp",
    id: sessionId,
    persistence: store.toPersistence(sessionId),
    initialHistory: history,
  })
}

test("a resumed session replays stored history into the new request", async () => {
  const db = openDatabase(":memory:")
  migrate(db)
  const store = new SqliteSessionStore(db)
  const session = store.create({
    provider: "fake",
    model: "fake-1",
    tier: "normal",
    cwd: "/tmp",
    policy: clonePolicy(DEFAULT_POLICY),
  })

  const first = makeAgent(store, session.id, [])
  const firstEvents = await drive(first, "the first question, which is reasonably long")
  await first.dispose()
  const firstInput = inputTokens(firstEvents)

  const history = store.getMessages(session.id).map((entry) => entry.message)
  assert.equal(history.length, 2, "one user message and one assistant reply should be stored")
  assert.equal(history[0]?.role, "user")

  const second = makeAgent(store, session.id, history)
  const secondEvents = await drive(second, "the second question")
  await second.dispose()
  const secondInput = inputTokens(secondEvents)

  assert.ok(
    secondInput > firstInput,
    `expected the resumed request to carry more input tokens (${secondInput}) than the first (${firstInput})`,
  )

  const after = store.getMessages(session.id)
  assert.equal(after.length, 4, "the resumed turn should extend the same session, not start a new one")
  assert.deepEqual(
    after.map((entry) => entry.role),
    ["user", "assistant", "user", "assistant"],
  )
  assert.equal(store.get(session.id)?.title, "the first question, which is reasonably long")
})
