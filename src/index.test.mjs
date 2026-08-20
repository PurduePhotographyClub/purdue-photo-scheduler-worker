import assert from "node:assert/strict";
import test from "node:test";

import schedulerWorker, {
  SCHEDULED_JOB_ENDPOINTS,
  runScheduledJobs,
} from "./index.ts";

const EXPECTED_JOB_ENDPOINTS = [
  "/internal/jobs/memberships/expire",
  "/internal/jobs/memberships/roles/reconcile",
  "/internal/jobs/darkroom/schedule/sweep",
  "/internal/jobs/studio/schedule/sweep",
  "/internal/jobs/darkroom/stats/sync",
  "/internal/jobs/equipment/reminders/run",
  "/internal/jobs/photographer-requests/expire",
  "/internal/jobs/event-carpools/expire",
];

test("scheduler exposes the complete internal job contract", () => {
  assert.deepEqual(SCHEDULED_JOB_ENDPOINTS, EXPECTED_JOB_ENDPOINTS);
});

test("health reports the complete job count without exposing job paths", async () => {
  const response = await schedulerWorker.fetch(
    new Request("https://scheduler.example/health"),
    {},
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    jobCount: EXPECTED_JOB_ENDPOINTS.length,
    ok: true,
    service: "purdue-photography-club-scheduler",
  });
  assert.equal(JSON.stringify(body).includes("/internal/jobs/"), false);
});

test("scheduler authenticates every API Worker call and sends its scheduled timestamp", async () => {
  let requests = [];
  const scheduledTime = 1_784_001_234_567;
  const env = {
    API_WORKER: {
      fetch: async (request) => {
        requests = [...requests, request];
        return Response.json({ success: true });
      },
    },
    INTERNAL_TOKEN: "test-internal-token",
  };

  const summary = await runScheduledJobs(env, {
    cron: "*/30 * * * *",
    scheduledTime,
  });

  assert.equal(summary.succeeded, EXPECTED_JOB_ENDPOINTS.length);
  assert.equal(summary.total, EXPECTED_JOB_ENDPOINTS.length);
  assert.equal(requests.length, EXPECTED_JOB_ENDPOINTS.length);
  assert.deepEqual(
    requests.map((request) => new URL(request.url).pathname),
    EXPECTED_JOB_ENDPOINTS,
  );
  for (const request of requests) {
    assert.equal(request.method, "POST");
    assert.equal(
      request.headers.get("x-pcc-internal-source"),
      "scheduler-worker",
    );
    assert.equal(request.headers.get("x-internal-token"), "test-internal-token");
    assert.equal(request.headers.get("x-pcc-scheduled-at"), String(scheduledTime));
  }
});

test("one failed event carpool job does not hide successful scheduled jobs", async (t) => {
  t.mock.method(console, "error", () => {});

  let requestedPaths = [];
  const env = {
    API_WORKER: {
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        requestedPaths = [...requestedPaths, path];
        if (path === "/internal/jobs/event-carpools/expire") {
          return Response.json({ error: "temporary failure" }, { status: 503 });
        }

        return Response.json({ success: true });
      },
    },
    INTERNAL_TOKEN: "test-internal-token",
  };

  const summary = await runScheduledJobs(env, {
    cron: "*/30 * * * *",
    scheduledTime: 1_784_001_234_567,
  });

  assert.deepEqual(requestedPaths, EXPECTED_JOB_ENDPOINTS);
  assert.equal(summary.total, EXPECTED_JOB_ENDPOINTS.length);
  assert.equal(summary.succeeded, EXPECTED_JOB_ENDPOINTS.length - 1);
  assert.equal(summary.failed, 1);
  const failedResult = summary.results.find(
    (result) => result.path === "/internal/jobs/event-carpools/expire",
  );
  assert.ok(failedResult);
  const { durationMs, ...failedResultWithoutDuration } = failedResult;
  assert.deepEqual(
    failedResultWithoutDuration,
    {
      body: { error: "temporary failure" },
      error: "HTTP 503",
      ok: false,
      path: "/internal/jobs/event-carpools/expire",
      status: 503,
    },
  );
  assert.equal(Number.isFinite(durationMs), true);
});
