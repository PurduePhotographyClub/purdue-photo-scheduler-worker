import assert from "node:assert/strict";
import test from "node:test";

import { SCHEDULED_JOB_ENDPOINTS, runScheduledJobs } from "./index.ts";

test("scheduler sends the Cloudflare scheduled timestamp with every internal job", async () => {
  const requests = [];
  const scheduledTime = 1_784_001_234_567;
  const env = {
    API_WORKER: {
      fetch: async (request) => {
        requests.push(request);
        return Response.json({ success: true });
      },
    },
    INTERNAL_TOKEN: "test-internal-token",
  };

  const summary = await runScheduledJobs(env, { cron: "*/30 * * * *", scheduledTime });

  assert.equal(summary.succeeded, SCHEDULED_JOB_ENDPOINTS.length);
  assert.equal(requests.length, SCHEDULED_JOB_ENDPOINTS.length);
  for (const request of requests) {
    assert.equal(request.headers.get("x-pcc-scheduled-at"), String(scheduledTime));
  }
});
