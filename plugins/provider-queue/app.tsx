import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_useProviders,
  useRealtime,
  useRpc,
  type ComposerSendMenuItem,
  type PluginProvidersState,
  type PluginRpcClient,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server.js";
import { DEFAULT_LIMIT, type ProviderSummary } from "./src/shared.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const startWhenProviderFree: ComposerSendMenuItem = {
  id: "start-when-provider-free",
  label: "Start when provider has a slot",
  icon: "Clock",
  description:
    "Waits until fewer than the provider's limit of threads are running. Starts right away if a slot is free.",
  disabled: (composer) => composer.isSubmittingBlocked,
  run: async ({ composer }) => {
    try {
      await composer.submit({ experimental_data: { queue: true } });
    } catch (error: unknown) {
      toast.error("Could not queue the thread", {
        description: errorMessage(error),
      });
    }
  },
};

type QueueSnapshot = { providers: ProviderSummary[] };

function ProviderSection(props: {
  summary: ProviderSummary;
  directory: PluginProvidersState["providers"];
  rpc: PluginRpcClient<typeof rpcContract>;
  refresh: () => void;
}) {
  const { summary, directory, rpc, refresh } = props;
  const [limitDraft, setLimitDraft] = useState(String(summary.limit));
  const limitInputRef = useRef<HTMLInputElement | null>(null);
  // The server limit the draft currently reflects; the draft is dirty once
  // the user types past it.
  const syncedLimitRef = useRef(summary.limit);

  // A limit changed elsewhere (CLI, another panel) must not sit stale in this
  // draft: resync when the user has not typed since the last sync or is not
  // editing this input right now. A dirty draft is left alone only while its
  // input is focused; once unfocused, the next limit change resyncs it.
  useEffect(() => {
    if (
      limitDraft === String(syncedLimitRef.current) ||
      limitInputRef.current !== document.activeElement
    ) {
      syncedLimitRef.current = summary.limit;
      setLimitDraft(String(summary.limit));
    }
  }, [summary.limit]);

  const label =
    summary.label !== summary.providerId
      ? summary.label
      : (directory.find((provider) => provider.id === summary.providerId)
          ?.displayName ?? summary.providerId);

  function submitLimit(): void {
    if (limitDraft.trim() === "") {
      toast.error("Enter a number for the limit");
      return;
    }
    const limit = Number(limitDraft);
    if (!Number.isInteger(limit) || limit < 0) {
      toast.error("The limit must be a whole number of 0 or more");
      return;
    }
    rpc.call("setLimit", { providerId: summary.providerId, limit }).then(
      refresh,
      (cause: unknown) => {
        toast.error("Could not set the limit", {
          description: errorMessage(cause),
        });
      },
    );
  }

  function moveRow(threadId: string, direction: "up" | "down"): void {
    rpc.call("move", { threadId, direction }).then(
      refresh,
      (cause: unknown) => {
        toast.error("Could not move the thread", {
          description: errorMessage(cause),
        });
      },
    );
  }

  function releaseRow(threadId: string): void {
    rpc.call("release", { threadId }).then(refresh, (cause: unknown) => {
      toast.error("Could not release the thread", {
        description: errorMessage(cause),
      });
    });
  }

  return (
    <section>
      <h2>{label}</h2>
      <p>{summary.running.length} running + {summary.awaiting.length} awaiting you, limit {summary.limit}</p>
      <input
        ref={limitInputRef}
        type="number"
        min={0}
        aria-label={`Limit for ${label}`}
        value={limitDraft}
        onChange={(event) => setLimitDraft(event.target.value)}
      />
      <button type="button" onClick={submitLimit}>
        Set limit
      </button>
      <ul>
        {summary.running.map((row) => (
          <li key={row.threadId}>{row.title}</li>
        ))}
      </ul>
      <ul>
        {summary.awaiting.map((row) => (
          <li key={row.threadId}>{row.title} — awaiting you</li>
        ))}
      </ul>
      <ul>
        {summary.queue.map((row, index) => (
          <li key={row.threadId}>
            <span>
              {index + 1}. {row.title} ({row.threadId})
            </span>
            {index !== 0 && (
              <button
                type="button"
                aria-label={`Move ${row.title} (${row.threadId}) up`}
                onClick={() => moveRow(row.threadId, "up")}
              >
                ↑
              </button>
            )}
            {index !== summary.queue.length - 1 && (
              <button
                type="button"
                aria-label={`Move ${row.title} (${row.threadId}) down`}
                onClick={() => moveRow(row.threadId, "down")}
              >
                ↓
              </button>
            )}
            <button
              type="button"
              aria-label={`Release ${row.title} (${row.threadId})`}
              onClick={() => releaseRow(row.threadId)}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ProviderQueuePanel() {
  const rpc = useRpc<typeof rpcContract>();
  const directory = experimental_useProviders().providers;
  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback((): void => {
    rpc.call("snapshot", null).then(
      (next) => {
        setSnapshot(next);
        setError(null);
      },
      (cause: unknown) => {
        setSnapshot(null);
        setError(errorMessage(cause));
      },
    );
  }, [rpc]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useRealtime("provider-queue", () => {
    void refresh();
  });

  if (snapshot === null) {
    if (error === null) return <p>Loading…</p>;
    return <p role="alert">{error}</p>;
  }

  if (
    snapshot.providers.length === 0 ||
    snapshot.providers.every(
      (candidate) =>
        candidate.running.length === 0 &&
        candidate.awaiting.length === 0 &&
        candidate.queue.length === 0 &&
        candidate.limit === DEFAULT_LIMIT,
    )
  ) {
    return (
      <p>
        Nothing queued. Use "Start when provider has a slot" in the new-thread
        composer, or bb provider-queue add.
      </p>
    );
  }

  return (
    <>
      {snapshot.providers.map((summary) => (
        <ProviderSection
          key={summary.providerId}
          summary={summary}
          directory={directory}
          rpc={rpc}
          refresh={refresh}
        />
      ))}
    </>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "provider-queue",
    scopes: ["new-thread"],
    sendMenu: [startWhenProviderFree],
  });
  app.slots.navPanel({
    id: "provider-queue-panel",
    title: "Provider queue",
    icon: "ListOrdered",
    path: "queue",
    component: ProviderQueuePanel,
  });
});
