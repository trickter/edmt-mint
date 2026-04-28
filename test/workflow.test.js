import test from "node:test";
import assert from "node:assert/strict";
import { createEdmtApi } from "../src/edmt-api.js";
import { readConfig } from "../src/config.js";
import { dryRunCandidates, scanCandidates } from "../src/workflow.js";

test("dry-run skips a candidate that was minted after the pending scan", async () => {
  const api = createEdmtApi({
    fetchImpl: mockFetch({
      "GET /api/v1/mints/pending?limit=1": {
        data: { items: [{ blk: 123, burn: 900, minted_by: null, finalized: true }], next_cursor: null, count: 1 }
      },
      "GET /api/v1/blocks/123": {
        data: { blk: 123, burn: 900, is_mintable: true, minted_by: "0xabc" }
      }
    })
  });

  const candidates = await scanCandidates(api, { limit: 1 });
  const rows = await dryRunCandidates(api, candidates, { maxTx: 1 });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "skipped");
  assert.match(rows[0].error, /already minted/);
});

test("dry-run builds calldata for an unminted candidate", async () => {
  const api = createEdmtApi({
    fetchImpl: mockFetch({
      "GET /api/v1/mints/pending?limit=1": {
        data: { items: [{ blk: 456, burn: 800, minted_by: null, finalized: true }], next_cursor: null, count: 1 }
      },
      "GET /api/v1/blocks/456": {
        data: { blk: 456, burn: 800, is_mintable: true, minted_by: null }
      },
      "GET /api/v1/mint/capture-fee?blk=456": {
        feeRequired: false,
        requiredFeeGwei: "0"
      },
      "POST /api/v1/build/mint": {
        calldata: "0x64617461",
        calldata_text: "data:,{\"p\":\"edmt\",\"op\":\"emt-mint\",\"tick\":\"enat\",\"blk\":\"456\"}",
        to: null,
        value: "0"
      }
    })
  });

  const candidates = await scanCandidates(api, { limit: 1 });
  const rows = await dryRunCandidates(api, candidates, { maxTx: 1 });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "buildable");
  assert.match(rows[0].calldata_text, /emt-mint/);
});

test("readConfig does not require PRIVATE_KEY", () => {
  const config = readConfig({ SCAN_LIMIT: "3", MAX_TX: "2" });
  assert.equal(config.scanLimit, 3);
  assert.equal(config.maxTx, 2);
});

function mockFetch(routes) {
  return async (url, init = {}) => {
    const parsed = new URL(url);
    const key = `${init.method ?? "GET"} ${parsed.pathname}${parsed.search}`;
    const response = routes[key];
    if (!response) {
      return jsonResponse({ error: { code: "not_found", message: `missing mock route ${key}` } }, 404);
    }
    return jsonResponse(response, 200);
  };
}

function jsonResponse(body, status) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    }
  };
}
