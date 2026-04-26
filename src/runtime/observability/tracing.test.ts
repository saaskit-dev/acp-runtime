import { context, trace } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";

import { testSpanExporter } from "../test-otel.js";
import { buildTraceMeta, withSpan } from "./tracing.js";

describe("runtime tracing metadata", () => {
  it("does not emit invalid all-zero traceparent metadata", () => {
    expect(buildTraceMeta(context.active())).toBeUndefined();
  });

  it("emits traceparent metadata for a valid active span", async () => {
    testSpanExporter.reset();

    await withSpan("test.trace-meta", {}, async (_span, spanContext) => {
      const meta = buildTraceMeta(spanContext);

      expect(meta?.traceparent).toMatch(
        /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/,
      );
      expect(String(meta?.traceparent)).not.toContain(
        "00000000000000000000000000000000",
      );
      expect(trace.getSpan(spanContext)?.spanContext().traceId).toBe(
        String(meta?.traceparent).split("-")[1],
      );
    });
  });
});
