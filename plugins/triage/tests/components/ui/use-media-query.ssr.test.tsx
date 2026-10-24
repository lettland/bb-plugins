import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { useMediaQuery } from "@/components/ui/hooks/use-media-query";

function Probe({ query }: { query: string }) {
  const matches = useMediaQuery(query);
  return <span data-matches={matches ? "yes" : "no"}>{query}</span>;
}

// Server-rendered useMediaQuery: no window exists, so every query resolves to
// false without touching any MediaQueryList.
describe("useMediaQuery on the server", () => {
  it("renders false without a window", () => {
    expect(typeof window).toBe("undefined");
    const html = renderToString(<Probe query="(max-width: 767px)" />);
    expect(html).toContain('data-matches="no"');
  });
});
