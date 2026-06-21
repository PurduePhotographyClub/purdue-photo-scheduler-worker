export const SCHEDULED_JOB_ENDPOINTS = [
  "/internal/jobs/memberships/expire",
  "/internal/jobs/darkroom/schedule/sweep",
  "/internal/jobs/studio/schedule/sweep",
  "/internal/jobs/darkroom/stats/sync",
  "/internal/jobs/equipment/reminders/run",
] as const;

const INTERNAL_SOURCE_HEADER = "x-pcc-internal-source";
const INTERNAL_TOKEN_HEADER = "x-internal-token";
const SCHEDULER_WORKER_SOURCE = "scheduler-worker";
const RATE_LIMIT_RETRY_SECONDS = 60;

interface ScheduledRunInput {
  cron: string;
  scheduledTime: number;
}

interface ScheduledJobRunResult {
  body: unknown;
  durationMs: number;
  error?: string;
  ok: boolean;
  path: string;
  status: number;
}

export interface ScheduledJobSummary {
  cron: string;
  failed: number;
  finishedAt: string;
  results: ScheduledJobRunResult[];
  scheduledAt: string;
  succeeded: number;
  total: number;
}

export async function runScheduledJobs(
  env: Env,
  input: ScheduledRunInput,
): Promise<ScheduledJobSummary> {
  const token = env.INTERNAL_TOKEN?.trim();
  if (!token) {
    throw new Error("INTERNAL_TOKEN is required for scheduler-to-API job calls.");
  }

  if (!env.API_WORKER) {
    throw new Error("API_WORKER service binding is required for scheduled jobs.");
  }

  const results = await Promise.all(
    SCHEDULED_JOB_ENDPOINTS.map((path) => runApiJob(env.API_WORKER, token, path)),
  );

  const succeeded = results.filter((result) => result.ok).length;
  const failed = results.length - succeeded;
  const summary: ScheduledJobSummary = {
    cron: input.cron,
    failed,
    finishedAt: new Date().toISOString(),
    results,
    scheduledAt: new Date(input.scheduledTime).toISOString(),
    succeeded,
    total: results.length,
  };

  if (failed > 0) {
    console.error("Scheduled job run completed with failures.", {
      failed,
      succeeded,
      total: results.length,
    });
  } else {
    console.info("Scheduled job run completed.", {
      succeeded,
      total: results.length,
    });
  }

  return summary;
}

async function runApiJob(
  apiWorker: Fetcher,
  token: string,
  path: string,
): Promise<ScheduledJobRunResult> {
  const startedAt = Date.now();
  try {
    const response = await apiWorker.fetch(createApiJobRequest(path, token));
    const body = await readResponseBody(response);
    const durationMs = Date.now() - startedAt;

    if (!response.ok) {
      console.error("Scheduled API job failed.", {
        durationMs,
        path,
        status: response.status,
      });
    }

    return {
      body,
      durationMs,
      ok: response.ok,
      path,
      status: response.status,
      ...(response.ok ? {} : { error: `HTTP ${response.status}` }),
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : "Unknown scheduler job error.";
    console.error("Scheduled API job threw before response.", {
      durationMs,
      error: message,
      path,
    });

    return {
      body: null,
      durationMs,
      error: message,
      ok: false,
      path,
      status: 0,
    };
  }
}

function createApiJobRequest(path: string, token: string) {
  return new Request(new URL(path, "https://api.internal"), {
    headers: {
      [INTERNAL_SOURCE_HEADER]: SCHEDULER_WORKER_SOURCE,
      [INTERNAL_TOKEN_HEADER]: token,
    },
    method: "POST",
  });
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text.slice(0, 2_000);
  }
}

function healthResponse() {
  return Response.json({
    jobCount: SCHEDULED_JOB_ENDPOINTS.length,
    ok: true,
    service: "purdue-photography-club-scheduler",
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if ((url.pathname === "/" || url.pathname === "/health") && request.method === "GET") {
      const rateLimitResponse = await checkHealthRateLimit(request, env, url.pathname);
      if (rateLimitResponse) {
        return rateLimitResponse;
      }

      return healthResponse();
    }

    return Response.json({ error: "Not Found." }, { status: 404 });
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    context: ExecutionContext,
  ): Promise<void> {
    context.waitUntil(
      runScheduledJobs(env, {
        cron: controller.cron,
        scheduledTime: controller.scheduledTime,
      }),
    );
  },
} satisfies ExportedHandler<Env>;

async function checkHealthRateLimit(
  request: Request,
  env: Env,
  pathname: string,
) {
  if (!env.SCHEDULER_RATE_LIMITER) {
    return null;
  }

  const outcome = await env.SCHEDULER_RATE_LIMITER.limit({
    key: `health:${pathname}:${getClientIdentity(request)}`,
  });
  if (outcome.success) {
    return null;
  }

  return Response.json(
    {
      error: "Too many requests.",
      success: false,
    },
    {
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": String(RATE_LIMIT_RETRY_SECONDS),
      },
      status: 429,
    },
  );
}

function getClientIdentity(request: Request) {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}
