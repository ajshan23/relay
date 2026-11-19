import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  answerPaths,
  type HttpToolConfig,
  httpToolConfigSchema,
  pickAnswer,
  templateProblems,
  toolSlug,
} from "@relay/core/agent-tools";
import { assertPublicUrl, publicFetch } from "@relay/core/net";
import { z } from "zod";
import {
  buildHttpRequest,
  type CustomToolDef,
  callHttpTool,
  callMcpTool,
  createToolRunner,
  customTools,
  fillTemplate,
  listMcpTools,
  type ModelResponse,
  type RunContext,
  runTurn,
  systemPrompt,
  type ToolCallLog,
} from "../src/index";

const ctx: RunContext = {
  orgId: "org_1",
  branchId: "br_1",
  agentId: "agt_1",
  conversationId: "conv_1",
  contactId: "ct_1",
  mode: "live",
  timezone: "Asia/Dubai",
  now: new Date("2026-11-19T08:00:00Z"),
  contact: { phone: "+971501234567", name: 'Sara "S" Ali', fields: { city: "Dubai" } },
};

const http = (partial: Partial<HttpToolConfig>): HttpToolConfig =>
  httpToolConfigSchema.parse({ method: "GET", url: "https://shop.example.com/orders", ...partial });

const usage = { inputTokens: 10, cachedTokens: 0, outputTokens: 5 };
const respond = (partial: Partial<ModelResponse>): ModelResponse => ({
  text: "",
  toolCalls: [],
  usage,
  model: "fake",
  latencyMs: 1,
  messages: [{ role: "assistant", content: "…" }],
  ...partial,
});

describe("the business's own tools", () => {
  it("fills values into URLs, headers and JSON bodies safely", () => {
    const values = {
      "input.order": "A 12/3",
      "input.qty": 2,
      "contact.name": 'Sara "S"',
      "input.gift": true,
      "input.evil": "x\r\nX-Admin: 1",
    };
    assert.equal(
      fillTemplate("https://x.com/o/{{input.order}}", values, "url"),
      "https://x.com/o/A%2012%2F3",
    );
    assert.equal(fillTemplate("Bearer {{ input.evil }}", values, "text"), "Bearer x X-Admin: 1");
    const body = fillTemplate(
      '{"order":"{{input.order}}","note":"for {{contact.name}}","qty":{{input.qty}},"gift":{{input.gift}},"missing":{{input.nope}}}',
      values,
      "json",
    );
    assert.deepEqual(JSON.parse(body), {
      order: "A 12/3",
      note: 'for Sara "S"',
      qty: 2,
      gift: true,
      missing: null,
    });
  });

  it("builds the request from the chat, the inputs and the key, and flags unknown values", () => {
    const config = http({
      url: "https://shop.example.com/orders/{{input.order_number}}",
      query: [
        { key: "phone", value: "{{contact.phone}}" },
        { key: "empty", value: "{{input.none}}" },
      ],
      inputs: [{ key: "order_number", description: "", type: "text", required: true }],
    });
    const req = buildHttpRequest(config, { header: "X-Key", value: "k1" }, { order_number: "1001" }, ctx);
    assert.equal(req.url, "https://shop.example.com/orders/1001?phone=%2B971501234567");
    assert.equal(req.headers["X-Key"], "k1");
    assert.deepEqual(templateProblems(config), [
      "{{input.none}} isn't one of the things the agent asks for.",
    ]);
    assert.deepEqual(templateProblems(http({ url: "https://x.com/{{contact.secret}}" })), [
      "{{contact.secret}} isn't a value Relay knows.",
    ]);
  });

  it("lists an answer's fields and keeps only the ticked ones", () => {
    const answer = {
      order: { status: "shipped", eta: "Fri", internal: "x" },
      items: [{ name: "S26", cost: 3 }],
    };
    assert.deepEqual(answerPaths(answer), [
      "order.status",
      "order.eta",
      "order.internal",
      "items[].name",
      "items[].cost",
    ]);
    assert.deepEqual(pickAnswer(answer, ["order.status", "items[].name"]), {
      order: { status: "shipped" },
      items: [{ name: "S26" }],
    });
    assert.deepEqual(pickAnswer(answer, []), answer);
    assert.equal(toolSlug("Check order status!"), "check_order_status");
  });

  it("makes look-ups read tools and changes confirm tools, with names that never clash", () => {
    const defs: CustomToolDef[] = [
      {
        id: "t1",
        kind: "http",
        name: "search_knowledge",
        title: "Order status",
        description: "When they ask where their order is",
        confirm: false,
        config: http({
          inputs: [{ key: "order", description: "Order number", type: "text", required: true }],
        }),
        secret: null,
      },
      {
        id: "t2",
        kind: "http",
        name: "create_order",
        title: "Create order",
        description: "When they confirm an order",
        confirm: true,
        config: http({
          method: "POST",
          inputs: [{ key: "qty", description: "", type: "number", required: true }],
        }),
        secret: null,
      },
    ];
    const tools = customTools(defs, async () => ({}));
    assert.deepEqual(
      tools.map((t) => [t.name, t.kind]),
      [
        ["search_knowledge_2", "read"],
        ["create_order", "confirm"],
      ],
    );
    assert.equal(tools[0]?.input.safeParse({}).success, false, "order is required");
    assert.equal(tools[1]?.input.safeParse({ qty: 2 }).success, false, "a change needs its question");
    assert.equal(tools[1]?.input.safeParse({ qty: 2, confirmText: "Order 2?" }).success, true);
    assert.match(
      systemPrompt({
        name: "M",
        role: "",
        businessName: "B",
        instructions: "",
        tone: "",
        languages: [],
        handoffWhen: "",
        ownTools: true,
      }),
      /business's own tools/,
    );
  });

  it("asks before a change: the turn ends with the question and nothing is called", async () => {
    let called = 0;
    const [tool] = customTools(
      [
        {
          id: "t2",
          kind: "http",
          name: "book_table",
          title: "Book a table",
          description: "Book when they want a table",
          confirm: true,
          config: http({
            method: "POST",
            inputs: [{ key: "people", description: "", type: "number", required: true }],
          }),
          secret: null,
        },
      ],
      async () => {
        called++;
        return {};
      },
    );
    const res = await runTurn({
      model: "f",
      system: "s",
      messages: [],
      tools: [tool as never],
      ctx,
      callModel: async () =>
        respond({
          toolCalls: [
            { id: "c1", name: "book_table", input: { people: 2, confirmText: "Book a table for *2*?" } },
          ],
        }),
    });
    assert.deepEqual(res.outcome, {
      kind: "confirm",
      toolName: "book_table",
      toolId: "t2",
      input: { people: 2 },
      text: "Book a table for *2*?",
    });
    assert.equal(called, 0);
  });

  it("calls an API, keeps the ticked fields, and turns failures into plain words", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      if (url.includes("404"))
        return new Response(JSON.stringify({ error: "Order not found" }), { status: 404 });
      return new Response(JSON.stringify({ status: "shipped", secret: "x" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const config = http({
      method: "POST",
      url: "https://shop.example.com/{{input.id}}",
      body: '{"id":"{{input.id}}","phone":"{{contact.phone}}"}',
      inputs: [{ key: "id", description: "", type: "text", required: true }],
      pick: ["status"],
    });
    const ok = await callHttpTool(config, null, { id: "1001" }, ctx, { fetch: fake, allowPrivate: true });
    assert.deepEqual(ok.data, { status: "shipped" });
    assert.deepEqual(JSON.parse(String(seen[0]?.init.body)), { id: "1001", phone: "+971501234567" });
    const logs: ToolCallLog[] = [];
    const run = createToolRunner({ fetch: fake, allowPrivate: true, onCall: (l) => void logs.push(l) });
    const def: CustomToolDef = {
      id: "t1",
      kind: "http",
      name: "order",
      title: "Order",
      description: "",
      confirm: false,
      config,
      secret: null,
    };
    await assert.rejects(
      run(def, null, { id: "404" }, ctx),
      /Their system answered 404: \{"error":"Order not found"\}/,
    );
    assert.deepEqual(
      logs.map((l) => [l.ok, l.httpStatus]),
      [[false, 404]],
    );
  });

  it("refuses addresses that aren't on the public internet", async () => {
    await assert.rejects(assertPublicUrl("http://127.0.0.1:8080/x"), /public internet/);
    await assert.rejects(assertPublicUrl("http://10.0.0.5/x"), /public internet/);
    await assert.rejects(assertPublicUrl("ftp://example.com"), /http or https/);
    await assert.rejects(publicFetch()("http://169.254.169.254/latest/meta-data"), /public internet/);
    await assert.rejects(publicFetch()("http://localhost:8080/x"), /public internet/);
  });
});

describe("MCP servers", () => {
  let server: Server;
  let url = "";
  const calls: unknown[] = [];

  before(async () => {
    server = createServer(async (req, res) => {
      if (req.headers["x-key"] !== "secret") {
        res.writeHead(401).end("no key");
        return;
      }
      const mcp = new McpServer({ name: "shop", version: "1.0.0" });
      mcp.registerTool(
        "order_status",
        {
          description: "Where an order is",
          inputSchema: { order: z.string() },
          annotations: { readOnlyHint: true },
        },
        async ({ order }) => {
          calls.push(order);
          return { content: [{ type: "text", text: JSON.stringify({ order, status: "shipped" }) }] };
        },
      );
      mcp.registerTool(
        "cancel_order",
        { description: "Cancel an order", inputSchema: { order: z.string() } },
        async () => ({ content: [{ type: "text", text: "Can't cancel a shipped order" }], isError: true }),
      );
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  });
  after(() => server.close());

  it("lists a server's tools, read-only ones not asking first", async () => {
    const tools = await listMcpTools(url, { header: "x-key", value: "secret" }, { allowPrivate: true });
    assert.deepEqual(
      tools.map((t) => [t.name, t.readOnly, t.confirm, t.allowed]),
      [
        ["order_status", true, false, false],
        ["cancel_order", false, true, false],
      ],
    );
    await assert.rejects(listMcpTools(url, null, { allowPrivate: true }));
    await assert.rejects(listMcpTools(url, null), /public internet/);
  });

  it("calls an allowed tool and reads its JSON answer; a failing tool is an error", async () => {
    const secret = { header: "x-key", value: "secret" };
    const res = await callMcpTool(url, secret, "order_status", { order: "1001" }, { allowPrivate: true });
    assert.deepEqual(res.data, { order: "1001", status: "shipped" });
    assert.deepEqual(calls, ["1001"]);
    await assert.rejects(
      callMcpTool(url, secret, "cancel_order", { order: "1001" }, { allowPrivate: true }),
      /The tool failed: \["Can't cancel a shipped order"\]/,
    );
    const listed = await listMcpTools(url, secret, { allowPrivate: true });
    const tools = customTools(
      [
        {
          id: "m1",
          kind: "mcp",
          name: "shop",
          title: "Shop",
          description: "",
          config: {
            url,
            listedAt: null,
            tools: listed.map((t) => ({ ...t, allowed: t.name === "order_status" })),
          },
          secret,
        },
      ],
      createToolRunner({ allowPrivate: true }),
    );
    assert.deepEqual(
      tools.map((t) => [t.name, t.kind]),
      [["shop__order_status", "read"]],
    );
    assert.deepEqual(await tools[0]?.run?.({ order: "7" }, ctx), { order: "7", status: "shipped" });
  });
});
