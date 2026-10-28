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
import "./app.css";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Icon } from "./components/ui/icon";
import { Input } from "./components/ui/input";
import { StatusDot } from "./components/ui/status-dot";

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

function providerLabel(
  providerId: string,
  label: string,
  directory: PluginProvidersState["providers"],
): string {
  if (label !== providerId) return label;
  return (
    directory.find((provider) => provider.id === providerId)?.displayName ??
    providerId
  );
}

function LimitRow(props: {
  providerId: string;
  label: string;
  limit: number;
  rpc: PluginRpcClient<typeof rpcContract>;
  refresh: () => void;
}) {
  const { providerId, label, limit, rpc, refresh } = props;
  const [limitDraft, setLimitDraft] = useState(String(limit));
  const limitInputRef = useRef<HTMLInputElement | null>(null);
  // The server limit the draft currently reflects; the draft is dirty once
  // the user types past it.
  const syncedLimitRef = useRef(limit);

  // A limit changed elsewhere (CLI, another panel) must not sit stale in this
  // draft: resync when the user has not typed since the last sync or is not
  // editing this input right now. A dirty draft is left alone only while its
  // input is focused; once unfocused, the next limit change resyncs it.
  useEffect(() => {
    // The draft starts in sync, so the first run has nothing to do; skipping
    // it also keeps a late-flushing mount effect from clobbering a draft the
    // user has already edited.
    if (limit === syncedLimitRef.current) return;
    if (
      limitDraft === String(syncedLimitRef.current) ||
      limitInputRef.current !== document.activeElement
    ) {
      syncedLimitRef.current = limit;
      setLimitDraft(String(limit));
    }
  }, [limit]);

  function submitLimit(): void {
    if (limitDraft.trim() === "") {
      toast.error("Enter a number for the limit");
      return;
    }
    const parsed = Number(limitDraft);
    if (!Number.isInteger(parsed) || parsed < 0) {
      toast.error("The limit must be a whole number of 0 or more");
      return;
    }
    rpc.call("setLimit", { providerId, limit: parsed }).then(
      refresh,
      (cause: unknown) => {
        toast.error("Could not set the limit", {
          description: errorMessage(cause),
        });
      },
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
      <Input
        ref={limitInputRef}
        type="number"
        min={0}
        aria-label={`Limit for ${label}`}
        value={limitDraft}
        onChange={(event) => setLimitDraft(event.target.value)}
        className="w-20"
      />
      <Button type="button" onClick={submitLimit}>
        Save
      </Button>
    </div>
  );
}

function QueueList(props: {
  queue: ProviderSummary["queue"];
  move: (threadId: string, direction: "up" | "down") => void;
  release: (threadId: string) => void;
}) {
  const { queue, move, release } = props;
  return (
    <ul className="flex flex-col gap-2">
      {queue.map((row, index) => (
        <li key={row.threadId} className="flex items-center gap-2 text-sm">
          <span className="w-4 text-right text-muted-foreground tabular-nums">
            {index + 1}
          </span>
          <span className="min-w-0 truncate">{row.title}</span>
          <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
            {row.threadId}
          </span>
          <span className="ml-auto flex items-center gap-0.5">
            {index !== 0 && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Move ${row.title} (${row.threadId}) up`}
                onClick={() => move(row.threadId, "up")}
              >
                <Icon name="ChevronUp" aria-hidden />
              </Button>
            )}
            {index !== queue.length - 1 && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Move ${row.title} (${row.threadId}) down`}
                onClick={() => move(row.threadId, "down")}
              >
                <Icon name="ChevronDown" aria-hidden />
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Release ${row.title} (${row.threadId})`}
              onClick={() => release(row.threadId)}
            >
              <Icon name="X" aria-hidden />
            </Button>
          </span>
        </li>
      ))}
    </ul>
  );
}

function ProviderCard(props: {
  summary: ProviderSummary;
  directory: PluginProvidersState["providers"];
  rpc: PluginRpcClient<typeof rpcContract>;
  refresh: () => void;
}) {
  const { summary, directory, rpc, refresh } = props;
  const label = providerLabel(summary.providerId, summary.label, directory);

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
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <h2 className="font-semibold leading-none tracking-tight">
            {label}
          </h2>
          <Badge variant="secondary">{summary.running.length} running</Badge>
          {summary.awaiting.length > 0 && (
            <Badge variant="outline">
              {summary.awaiting.length} waiting on you
            </Badge>
          )}
          {summary.queue.length > 0 && (
            <Badge variant="default">{summary.queue.length} queued</Badge>
          )}
          <Badge variant="outline">limit {summary.limit}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {summary.running.length > 0 && (
          <ul className="flex flex-col gap-2">
            {summary.running.map((row) => (
              <li key={row.threadId} className="flex items-center gap-2 text-sm">
                <StatusDot tone="ongoing" pulse />
                <span className="min-w-0 truncate">{row.title}</span>
              </li>
            ))}
          </ul>
        )}
        {summary.awaiting.length > 0 && (
          <ul className="flex flex-col gap-2">
            {summary.awaiting.map((row) => (
              <li key={row.threadId} className="flex items-center gap-2 text-sm">
                <StatusDot tone="unread" />
                <span className="min-w-0 truncate">{row.title}</span>
                <Badge variant="outline">waiting on you</Badge>
              </li>
            ))}
          </ul>
        )}
        {summary.queue.length > 0 && (
          <QueueList queue={summary.queue} move={moveRow} release={releaseRow} />
        )}
      </CardContent>
    </Card>
  );
}

// Known providers for the limits section: every snapshot provider first, in
// snapshot order, then directory-only providers sorted by display name. The
// section hides itself when no provider is known.
function LimitsSection(props: {
  providers: ProviderSummary[];
  directory: PluginProvidersState["providers"];
  rpc: PluginRpcClient<typeof rpcContract>;
  refresh: () => void;
}) {
  const { providers, directory, rpc, refresh } = props;
  const directoryOnlyProviders = directory
    .filter(
      (provider) => !providers.some((known) => known.providerId === provider.id),
    )
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  if (providers.length === 0 && directoryOnlyProviders.length === 0) {
    return null;
  }
  return (
    <section className="flex flex-col gap-2">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <Icon
          name="SlidersHorizontal"
          className="size-4 text-muted-foreground"
          aria-hidden
        />
        Limits
      </h2>
      <p className="text-sm text-muted-foreground">
        At most this many threads run on one provider at once. The limit
        holds only queued threads. Other threads count toward it while
        they run.
      </p>
      <div className="flex flex-col gap-2">
        {providers.map((summary) => (
          <LimitRow
            key={summary.providerId}
            providerId={summary.providerId}
            label={providerLabel(summary.providerId, summary.label, directory)}
            limit={summary.limit}
            rpc={rpc}
            refresh={refresh}
          />
        ))}
        {directoryOnlyProviders.map((provider) => (
          <LimitRow
            key={provider.id}
            providerId={provider.id}
            label={provider.displayName}
            limit={DEFAULT_LIMIT}
            rpc={rpc}
            refresh={refresh}
          />
        ))}
      </div>
    </section>
  );
}

function QueueArea(props: {
  providers: ProviderSummary[];
  directory: PluginProvidersState["providers"];
  rpc: PluginRpcClient<typeof rpcContract>;
  refresh: () => void;
}) {
  const { providers, directory, rpc, refresh } = props;
  const active = providers.filter(
    (candidate) =>
      candidate.running.length > 0 ||
      candidate.awaiting.length > 0 ||
      candidate.queue.length > 0,
  );
  if (active.length === 0) {
    return (
      <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed border-border px-6 py-10 text-center">
        <Icon
          name="Clock"
          className="size-7 text-muted-foreground"
          aria-hidden
        />
        <p className="text-sm font-medium">Nothing queued</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Queue a thread with "Start when provider has a slot" in the
          new-thread composer. Or run bb provider-queue add &lt;thread-id&gt;.
        </p>
      </div>
    );
  }
  return (
    <>
      {active.map((summary) => (
        <ProviderCard
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
    if (error === null) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
    return <p role="alert" className="p-4 text-sm text-destructive">{error}</p>;
  }

  return (
    <div className="flex flex-col gap-5 p-4">
      <p className="text-sm text-muted-foreground">
        A queued thread waits for a free slot on its provider. A thread you
        never queue starts at once. Both count toward the limit.
      </p>
      <QueueArea
        providers={snapshot.providers}
        directory={directory}
        rpc={rpc}
        refresh={refresh}
      />
      <LimitsSection
        providers={snapshot.providers}
        directory={directory}
        rpc={rpc}
        refresh={refresh}
      />
    </div>
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
