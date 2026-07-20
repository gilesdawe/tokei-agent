/** @jest-environment node */
import { main } from "../index.js";
import type { Io } from "../index.js";
import type { HttpResponse } from "../http.js";

const RL_HEADERS = {
  "X-RateLimit-Limit": "100",
  "X-RateLimit-Remaining": "99",
  "X-RateLimit-Reset": "1753000000",
};

function okRes(body: unknown = { ok: true }): HttpResponse {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(RL_HEADERS)) lower[k.toLowerCase()] = v;
  return {
    status: 200,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  };
}

interface Harness {
  io: Io;
  out: string[];
  err: string[];
  calls: { url: string; init: { method: string; headers: Record<string, string>; body?: string } }[];
}

function harness(opts: {
  env?: Record<string, string | undefined>;
  response?: HttpResponse | Error;
  readFile?: (path: string) => string;
} = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Harness["calls"] = [];
  const response = opts.response ?? okRes();
  const base = {
    env: opts.env ?? { TOKEI_API_KEY: "tokei_k_test" },
    fetchImpl: async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
      calls.push({ url, init });
      if (response instanceof Error) throw response;
      return response;
    },
    stdout: (line: string) => out.push(line),
    stderr: (line: string) => err.push(line),
    ...(opts.readFile ? { readFile: opts.readFile } : {}),
  };
  const io: Io = base as Io;
  return { io, out, err, calls };
}

function lastUrl(h: Harness): URL {
  return new URL(h.calls[h.calls.length - 1].url);
}

describe("main — command routing", () => {
  it("me -> GET /me", async () => {
    const h = harness();
    const code = await main(["me"], h.io);
    expect(code).toBe(0);
    const url = lastUrl(h);
    expect(url.origin + url.pathname).toBe("https://tokei.io/api/v1/me");
    expect(h.calls[0].init.headers["Authorization"]).toBe("Bearer tokei_k_test");
    expect(JSON.parse(h.out[0]).rate_limit).toEqual({
      limit: 100,
      remaining: 99,
      reset: 1753000000,
    });
  });

  it("pages:list maps --status/--mode/--page/--per-page to query params", async () => {
    const h = harness();
    await main(
      ["pages:list", "--status", "active", "--mode", "competition", "--page", "2", "--per-page", "50"],
      h.io,
    );
    const url = lastUrl(h);
    expect(url.pathname).toBe("/api/v1/contests");
    expect(url.searchParams.get("status")).toBe("active");
    expect(url.searchParams.get("mode")).toBe("competition");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("per_page")).toBe("50");
  });

  it("pages:get <id> -> GET /contests/:id", async () => {
    const h = harness();
    await main(["pages:get", "c-1"], h.io);
    expect(lastUrl(h).pathname).toBe("/api/v1/contests/c-1");
  });

  it("stats <id> -> GET /contests/:id/analytics", async () => {
    const h = harness();
    await main(["stats", "c-1"], h.io);
    expect(lastUrl(h).pathname).toBe("/api/v1/contests/c-1/analytics");
  });

  it("leaderboard <id> -> GET /contests/:id/leaderboard with paging", async () => {
    const h = harness();
    await main(["leaderboard", "c-1", "--page", "3"], h.io);
    expect(lastUrl(h).pathname).toBe("/api/v1/contests/c-1/leaderboard");
    expect(lastUrl(h).searchParams.get("page")).toBe("3");
  });

  it("entries:list <id> -> GET /contests/:id/entries with --email", async () => {
    const h = harness();
    await main(["entries:list", "c-1", "--email", "a@b.com"], h.io);
    expect(lastUrl(h).pathname).toBe("/api/v1/contests/c-1/entries");
    expect(lastUrl(h).searchParams.get("email")).toBe("a@b.com");
  });

  it("surveys:list <id> -> GET /contests/:id/survey-responses", async () => {
    const h = harness();
    await main(["surveys:list", "c-1"], h.io);
    expect(lastUrl(h).pathname).toBe("/api/v1/contests/c-1/survey-responses");
  });

  it("honours the TOKEI_API_URL override", async () => {
    const h = harness({ env: { TOKEI_API_KEY: "k", TOKEI_API_URL: "http://127.0.0.1:3000" } });
    await main(["me"], h.io);
    expect(h.calls[0].url).toBe("http://127.0.0.1:3000/api/v1/me");
  });
});

describe("main — error and usage handling", () => {
  it("prints an API error body to stdout and exits 1", async () => {
    const errRes: HttpResponse = {
      status: 404,
      headers: { get: () => null },
      text: async () => JSON.stringify({ success: false, error: { code: "NOT_FOUND" } }),
    };
    const h = harness({ response: errRes });
    const code = await main(["pages:get", "missing"], h.io);
    expect(code).toBe(1);
    expect(JSON.parse(h.out[0]).success).toBe(false);
    expect(h.err).toEqual([]);
  });

  it("emits a network_error envelope on fetch failure, exit 1", async () => {
    const h = harness({ response: new Error("boom") });
    const code = await main(["me"], h.io);
    expect(code).toBe(1);
    expect(JSON.parse(h.out[0])).toEqual({
      ok: false,
      error: { type: "network_error", message: "boom" },
    });
  });

  it("missing TOKEI_API_KEY -> usage error on stderr, exit 2", async () => {
    const h = harness({ env: {} });
    const code = await main(["me"], h.io);
    expect(code).toBe(2);
    expect(h.out).toEqual([]);
    expect(JSON.parse(h.err[0]).error.type).toBe("usage_error");
  });

  it("unknown command -> usage error listing valid commands, exit 2", async () => {
    const h = harness();
    const code = await main(["bogus"], h.io);
    expect(code).toBe(2);
    const parsed = JSON.parse(h.err[0]);
    expect(parsed.error.type).toBe("usage_error");
    expect(parsed.error.message).toContain("pages:list");
    expect(h.calls).toEqual([]);
  });

  it("no command -> usage error, exit 2", async () => {
    const h = harness();
    const code = await main([], h.io);
    expect(code).toBe(2);
    expect(JSON.parse(h.err[0]).error.type).toBe("usage_error");
  });

  it("missing required contestId -> usage error, exit 2", async () => {
    const h = harness();
    const code = await main(["stats"], h.io);
    expect(code).toBe(2);
    expect(JSON.parse(h.err[0]).error.type).toBe("usage_error");
    expect(h.calls).toEqual([]);
  });

  it("invalid --per-page (out of range) -> usage error, exit 2", async () => {
    const h = harness();
    const code = await main(["pages:list", "--per-page", "500"], h.io);
    expect(code).toBe(2);
    expect(JSON.parse(h.err[0]).error.type).toBe("usage_error");
    expect(h.calls).toEqual([]);
  });

  it("non-numeric --page -> usage error, exit 2", async () => {
    const h = harness();
    const code = await main(["pages:list", "--page", "abc"], h.io);
    expect(code).toBe(2);
    expect(JSON.parse(h.err[0]).error.type).toBe("usage_error");
  });

  it("invalid --status enum value -> usage error, exit 2", async () => {
    const h = harness();
    const code = await main(["pages:list", "--status", "nope"], h.io);
    expect(code).toBe(2);
    expect(JSON.parse(h.err[0]).error.type).toBe("usage_error");
  });

  it("unknown flag for a command -> usage error, exit 2", async () => {
    const h = harness();
    const code = await main(["me", "--bogus", "x"], h.io);
    expect(code).toBe(2);
    expect(JSON.parse(h.err[0]).error.type).toBe("usage_error");
  });
});

describe("main — help and version", () => {
  it("--help prints human-readable text to stdout, exit 0", async () => {
    const h = harness();
    const code = await main(["--help"], h.io);
    expect(code).toBe(0);
    expect(h.out.join("\n")).toContain("tokei-agent");
    expect(h.out.join("\n")).toContain("TOKEI_API_KEY");
    expect(h.calls).toEqual([]);
  });

  it("help subcommand also prints help, exit 0", async () => {
    const h = harness();
    const code = await main(["help"], h.io);
    expect(code).toBe(0);
    expect(h.out.join("\n")).toContain("Commands");
  });

  it("--version prints the version, exit 0", async () => {
    const h = harness();
    const code = await main(["--version"], h.io);
    expect(code).toBe(0);
    expect(h.out.join("\n").trim()).toBe("0.2.0");
  });

  it("-v prints the version, exit 0", async () => {
    const h = harness();
    const code = await main(["-v"], h.io);
    expect(code).toBe(0);
    expect(h.out.join("\n").trim()).toBe("0.2.0");
  });
});

describe("main — write commands", () => {
  it("pages:clone --title/--source/--status/--prize -> POST /api/v1/promotions", async () => {
    const h = harness();
    const code = await main(
      ["pages:clone", "--title", "Spring Clone", "--source", "src-1", "--status", "active", "--prize", "Gift card"],
      h.io,
    );
    expect(code).toBe(0);
    const url = lastUrl(h);
    expect(url.origin + url.pathname).toBe("https://tokei.io/api/v1/promotions");
    expect(h.calls[0].init.method).toBe("POST");
    expect(h.calls[0].init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(h.calls[0].init.body!)).toEqual({
      title: "Spring Clone",
      source_promotion_id: "src-1",
      status: "active",
      prize: "Gift card",
    });
  });

  it("pages:clone missing --title (no --data) -> usage error, exit 2, no call", async () => {
    const h = harness();
    const code = await main(["pages:clone", "--source", "src-1"], h.io);
    expect(code).toBe(2);
    expect(JSON.parse(h.err[0]).error.type).toBe("usage_error");
    expect(h.calls).toEqual([]);
  });

  it("pages:clone --status bogus -> usage error, exit 2", async () => {
    const h = harness();
    const code = await main(["pages:clone", "--title", "X", "--status", "bogus"], h.io);
    expect(code).toBe(2);
    expect(JSON.parse(h.err[0]).error.type).toBe("usage_error");
    expect(h.calls).toEqual([]);
  });

  it("pages:update <contestId> with all four flags -> PATCH /api/v1/contests/:id", async () => {
    const h = harness();
    const code = await main(
      [
        "pages:update",
        "c-1",
        "--title",
        "New title",
        "--description",
        "New desc",
        "--start-date",
        "2027-01-01T00:00:00Z",
        "--end-date",
        "2027-02-01T00:00:00Z",
      ],
      h.io,
    );
    expect(code).toBe(0);
    const url = lastUrl(h);
    expect(url.pathname).toBe("/api/v1/contests/c-1");
    expect(h.calls[0].init.method).toBe("PATCH");
    expect(JSON.parse(h.calls[0].init.body!)).toEqual({
      title: "New title",
      description: "New desc",
      start_date: "2027-01-01T00:00:00Z",
      end_date: "2027-02-01T00:00:00Z",
    });
  });

  it("pages:update <contestId> with no flags and no --data -> usage error, exit 2, no call", async () => {
    const h = harness();
    const code = await main(["pages:update", "c-1"], h.io);
    expect(code).toBe(2);
    expect(JSON.parse(h.err[0]).error.type).toBe("usage_error");
    expect(h.calls).toEqual([]);
  });

  it("entries:create <contestId> --email/--name/--action-type/--points/--value -> POST /contests/:id/entries", async () => {
    const h = harness();
    const code = await main(
      [
        "entries:create",
        "c-1",
        "--email",
        "a@b.com",
        "--name",
        "Ada",
        "--action-type",
        "email_signup",
        "--points",
        "10",
        "--value",
        "Order #1",
      ],
      h.io,
    );
    expect(code).toBe(0);
    const url = lastUrl(h);
    expect(url.pathname).toBe("/api/v1/contests/c-1/entries");
    expect(h.calls[0].init.method).toBe("POST");
    expect(JSON.parse(h.calls[0].init.body!)).toEqual({
      email: "a@b.com",
      name: "Ada",
      action_type: "email_signup",
      points: 10,
      value: "Order #1",
    });
  });

  it("entries:create missing --email -> usage error, exit 2, no call", async () => {
    const h = harness();
    const code = await main(["entries:create", "c-1", "--name", "Ada"], h.io);
    expect(code).toBe(2);
    expect(JSON.parse(h.err[0]).error.type).toBe("usage_error");
    expect(h.calls).toEqual([]);
  });

  it("entries:create --points non-numeric -> usage error, exit 2, no call", async () => {
    const h = harness();
    const code = await main(["entries:create", "c-1", "--email", "a@b.com", "--points", "abc"], h.io);
    expect(code).toBe(2);
    expect(JSON.parse(h.err[0]).error.type).toBe("usage_error");
    expect(h.calls).toEqual([]);
  });

  it("webhooks:list --page 2 -> GET /api/v1/webhooks?page=2", async () => {
    const h = harness();
    const code = await main(["webhooks:list", "--page", "2"], h.io);
    expect(code).toBe(0);
    const url = lastUrl(h);
    expect(url.pathname).toBe("/api/v1/webhooks");
    expect(url.searchParams.get("page")).toBe("2");
  });

  it("webhooks:create --url/--events -> POST /api/v1/webhooks, warns once about the returned secret", async () => {
    const secretRes: HttpResponse = {
      status: 201,
      headers: { get: () => null },
      text: async () => JSON.stringify({ success: true, data: { id: "w-1", secret: "whsec_abc123" } }),
    };
    const h = harness({ response: secretRes });
    const code = await main(
      ["webhooks:create", "--url", "https://x.example/hook", "--events", "entry.created"],
      h.io,
    );
    expect(code).toBe(0);
    const url = lastUrl(h);
    expect(url.pathname).toBe("/api/v1/webhooks");
    expect(h.calls[0].init.method).toBe("POST");
    expect(JSON.parse(h.calls[0].init.body!)).toEqual({
      url: "https://x.example/hook",
      events: ["entry.created"],
    });
    expect(JSON.parse(h.out[0]).data.secret).toBe("whsec_abc123");
    expect(h.err.length).toBe(1);
    expect(h.err[0]).toContain("cannot be retrieved");
    const combined = h.out.join("\n") + h.err.join("\n");
    expect(combined.split("whsec_abc123").length - 1).toBe(1);
  });

  it("webhooks:create --events comma-separated -> events array of both", async () => {
    const h = harness();
    const code = await main(
      ["webhooks:create", "--url", "https://x.example/hook", "--events", "entry.created,entry.updated"],
      h.io,
    );
    expect(code).toBe(0);
    expect(JSON.parse(h.calls[0].init.body!).events).toEqual(["entry.created", "entry.updated"]);
  });

  it("webhooks:create missing --url -> usage error, exit 2, no call", async () => {
    const h = harness();
    const code = await main(["webhooks:create", "--events", "entry.created"], h.io);
    expect(code).toBe(2);
    expect(JSON.parse(h.err[0]).error.type).toBe("usage_error");
    expect(h.calls).toEqual([]);
  });

  it("webhooks:create missing --events -> usage error, exit 2, no call", async () => {
    const h = harness();
    const code = await main(["webhooks:create", "--url", "https://x.example/hook"], h.io);
    expect(code).toBe(2);
    expect(JSON.parse(h.err[0]).error.type).toBe("usage_error");
    expect(h.calls).toEqual([]);
  });

  it("webhooks:create response without a secret -> no stderr output", async () => {
    const plainRes: HttpResponse = {
      status: 201,
      headers: { get: () => null },
      text: async () => JSON.stringify({ success: true, data: { id: "w-1" } }),
    };
    const h = harness({ response: plainRes });
    const code = await main(
      ["webhooks:create", "--url", "https://x.example/hook", "--events", "entry.created"],
      h.io,
    );
    expect(code).toBe(0);
    expect(h.err).toEqual([]);
  });

  it("webhooks:delete <webhookId> -> DELETE /api/v1/webhooks/:id, no request body", async () => {
    const h = harness();
    const code = await main(["webhooks:delete", "w-1"], h.io);
    expect(code).toBe(0);
    const url = lastUrl(h);
    expect(url.pathname).toBe("/api/v1/webhooks/w-1");
    expect(h.calls[0].init.method).toBe("DELETE");
    expect(h.calls[0].init.body).toBeUndefined();
  });

  it("webhooks:delete with no positional -> usage error, exit 2, no call", async () => {
    const h = harness();
    const code = await main(["webhooks:delete"], h.io);
    expect(code).toBe(2);
    expect(JSON.parse(h.err[0]).error.type).toBe("usage_error");
    expect(h.calls).toEqual([]);
  });

  it("--help mentions the new write commands, the rate-limit note, and the secret warning", async () => {
    const h = harness();
    const code = await main(["--help"], h.io);
    expect(code).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain("pages:clone");
    expect(text).toContain("20 clones");
    expect(text).toContain("cannot be retrieved");
  });
});

describe("main — --data handling", () => {
  it("pages:clone --data only -> merges JSON body fields, exit 0", async () => {
    const h = harness();
    const code = await main(
      ["pages:clone", "--data", '{"title":"From JSON","end_date":"2027-01-01T00:00:00Z"}'],
      h.io,
    );
    expect(code).toBe(0);
    expect(JSON.parse(h.calls[0].init.body!)).toEqual({
      title: "From JSON",
      end_date: "2027-01-01T00:00:00Z",
    });
  });

  it("pages:clone --title flag wins over --data, other --data fields kept", async () => {
    const h = harness();
    const code = await main(
      ["pages:clone", "--title", "Flag wins", "--data", '{"title":"json","description":"keep"}'],
      h.io,
    );
    expect(code).toBe(0);
    expect(JSON.parse(h.calls[0].init.body!)).toEqual({
      title: "Flag wins",
      description: "keep",
    });
  });

  it("pages:update --data passes an arbitrary body through exactly", async () => {
    const h = harness();
    const code = await main(
      ["pages:update", "c-1", "--data", '{"prizes":[{"name":"P","value":100}],"reward_thresholds":[]}'],
      h.io,
    );
    expect(code).toBe(0);
    expect(JSON.parse(h.calls[0].init.body!)).toEqual({
      prizes: [{ name: "P", value: 100 }],
      reward_thresholds: [],
    });
  });

  it("--data invalid JSON -> usage error, exit 2, no call", async () => {
    const h = harness();
    const code = await main(["pages:update", "c-1", "--data", "not json"], h.io);
    expect(code).toBe(2);
    expect(JSON.parse(h.err[0]).error.type).toBe("usage_error");
    expect(h.calls).toEqual([]);
  });

  it("--data non-object JSON (array) -> usage error, exit 2, no call", async () => {
    const h = harness();
    const code = await main(["pages:update", "c-1", "--data", "[1,2]"], h.io);
    expect(code).toBe(2);
    expect(JSON.parse(h.err[0]).error.type).toBe("usage_error");
    expect(h.calls).toEqual([]);
  });

  it("--data @file reads via io.readFile and merges, exit 0", async () => {
    let received: string | undefined;
    const h = harness({
      readFile: (path) => {
        received = path;
        return '{"title":"From File"}';
      },
    });
    const code = await main(["pages:update", "c-1", "--data", "@body.json"], h.io);
    expect(code).toBe(0);
    expect(received).toBe("body.json");
    expect(JSON.parse(h.calls[0].init.body!)).toEqual({ title: "From File" });
  });

  it("--data @file where io.readFile throws -> usage error, exit 2, no call", async () => {
    const h = harness({
      readFile: () => {
        throw new Error("ENOENT");
      },
    });
    const code = await main(["pages:update", "c-1", "--data", "@missing.json"], h.io);
    expect(code).toBe(2);
    expect(JSON.parse(h.err[0]).error.type).toBe("usage_error");
    expect(h.calls).toEqual([]);
  });
});

describe("main — path encoding", () => {
  it("pages:get encodes special characters in the contestId path segment", async () => {
    const h = harness();
    await main(["pages:get", "a/b c"], h.io);
    expect(lastUrl(h).pathname).toBe("/api/v1/contests/a%2Fb%20c");
  });

  it("webhooks:delete encodes special characters in the webhookId path segment", async () => {
    const h = harness();
    await main(["webhooks:delete", "x y"], h.io);
    expect(lastUrl(h).pathname).toBe("/api/v1/webhooks/x%20y");
  });
});
