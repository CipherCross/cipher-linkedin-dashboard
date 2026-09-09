// @vitest-environment jsdom
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Overview } from "../src/pages/Overview";
import type { DashboardData, OverviewSummary } from "../src/lib/types";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver =
  ResizeObserverStub as unknown as typeof ResizeObserver;

const fetchSummary = vi.fn();
const resolvePath = vi.fn();
let data: DashboardData;
let phase: "partial" | "full";
vi.mock("../src/lib/DataContext", () => ({ useData: () => ({ data, phase }) }));
vi.mock("../src/lib/dashboardReads", () => ({
  resolveReadPath: () => resolvePath(),
  fetchNeonOverviewSummary: (...args: unknown[]) => fetchSummary(...args),
}));

const totals = (o: Record<string, number> = {}) => ({
  leads: 4,
  invited: 3,
  connected: 2,
  messaged: 1,
  replied: 1,
  acceptedOfInvited: 2,
  repliedOfConnected: 1,
  ...o,
});
const analytics = (o: Record<string, unknown> = {}) => ({
  totals: totals(),
  previous: null,
  lifetime: totals(),
  accounts: [
    {
      instance_id: "one",
      totals: totals({ invited: 2, connected: 1, replied: 1 }),
      previous: null,
      lifetime: totals({
        invited: 4,
        connected: 2,
        acceptedOfInvited: 2,
        repliedOfConnected: 1,
      }),
    },
  ],
  activity: [],
  ...o,
});
const campaign = (o: Record<string, unknown> = {}) => ({
  campaign_id: "one:42",
  campaign_name: "HealthTech motion",
  instance_id: "one",
  status: "active",
  runtime_status: "running",
  is_archived: false,
  status_observed_at: null,
  status_source: null,
  status_raw: null,
  total_leads: 4,
  invites_sent: 3,
  accepted: 2,
  replies: 1,
  acceptance_rate: 66.7,
  reply_rate: 50,
  last_activity_at: null,
  allTotal: 4,
  replyCounts: { total: 1, c: {} },
  lifetime_acceptance_rate: 50,
  lifetime_reply_rate: 50,
  ...o,
});
const summary = (withAnalytics = true, o: Record<string, unknown> = {}) =>
  ({
    analytics: withAnalytics ? analytics() : undefined,
    campaigns: [campaign()],
    ...o,
  }) as unknown as OverviewSummary;
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
};
const paint = (initialEntries?: string[]) =>
  render(
    <MemoryRouter initialEntries={initialEntries}>
      <Overview />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-09-06T12:00:00Z"));
  phase = "full";
  data = {
    instances: [
      {
        id: "one",
        label: "Notebook one",
        account_name: "Alice",
        last_sync_at: "2026-09-06T10:00:00Z",
        agent_version: null,
        account_url: null,
        account_avatar: null,
        config: null,
        config_updated_at: null,
      },
    ],
    campaigns: [campaign()] as never,
    leads: [],
    activity: [],
    syncRuns: [],
    messages: [],
    conversationReplyIntents: [],
    annotations: [],
    steps: [],
    teamMembers: [],
    rosterPath: "neon",
    pipelineEvents: [],
    followUpStates: [],
    latestConversationMessages: [],
    followUpsAvailable: false,
    savedSearches: [],
    icps: [],
    icpPersonas: [],
    icpIndustries: [],
    hypotheses: [],
    hypothesisCampaigns: [],
    campaignSequenceContext: null,
  };
  resolvePath.mockReset().mockResolvedValue("neon");
  fetchSummary.mockReset().mockResolvedValue(summary());
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Overview request orchestration and real analytics UI", () => {
  it("uses independent system All time and performance previous 7 days requests", async () => {
    paint();
    await waitFor(() => expect(fetchSummary).toHaveBeenCalledTimes(2));
    expect(fetchSummary).toHaveBeenCalledWith(
      expect.objectContaining({ from: null, to: null }),
    );
    expect(fetchSummary).toHaveBeenCalledWith(
      expect.objectContaining({ from: "2026-08-31", to: "2026-09-06" }),
    );
  });
  it("changes only the selected performance scope and keeps lifetime rates account-specific", async () => {
    fetchSummary.mockResolvedValue(
      summary(true, {
        analytics: analytics({
          accounts: [
            {
              instance_id: "one",
              totals: totals({ invited: 9, connected: 4, replied: 2 }),
              previous: null,
              lifetime: totals({
                invited: 10,
                connected: 5,
                acceptedOfInvited: 8,
                repliedOfConnected: 3,
              }),
            },
          ],
        }),
      }),
    );
    paint();
    await screen.findByRole("heading", { name: "Performance" });
    await waitFor(() => expect(fetchSummary).toHaveBeenCalledTimes(2));
    const before = fetchSummary.mock.calls.length;
    fireEvent.change(
      screen.getByRole("combobox", { name: "Performance account" }),
      { target: { value: "one" } },
    );
    await waitFor(() => expect(fetchSummary).toHaveBeenCalledTimes(before));
    expect(screen.getByText("80.0%")).toBeTruthy();
    expect(screen.getByText("60.0%")).toBeTruthy();
  });
  it("does not invent analytics for an account absent from the roster", async () => {
    paint(["/?account=missing"]);
    await screen.findByRole("alert");
    expect(screen.getByText("Account not found.")).toBeTruthy();
    expect(screen.queryByText("0.0%")).toBeNull();
  });
  it("renders a rostered account with no analytics row as an empty account", async () => {
    fetchSummary.mockResolvedValue(
      summary(
        true,
        { analytics: analytics({ accounts: [], previous: totals({ invited: 5, connected: 4, replied: 2 }) }) },
      ),
    );
    paint(["/?account=one"]);
    await screen.findByRole("heading", { name: "Lifetime account totals" });
    expect(screen.queryByText(/Performance data unavailable/)).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Lifetime account totals" }),
    ).toBeTruthy();
    expect(screen.getAllByText("0").length).toBeGreaterThan(0);
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.getAllByText("+0 vs previous")).toHaveLength(3);
  });
  it("keeps system data when performance fails and retries only performance", async () => {
    fetchSummary
      .mockResolvedValueOnce(summary())
      .mockRejectedValueOnce(new Error("performance down"));
    paint();
    await screen.findByRole("alert");
    expect(screen.getByRole("heading", { name: "System totals" })).toBeTruthy();
    const before = fetchSummary.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetchSummary).toHaveBeenCalledTimes(before + 1));
    expect(fetchSummary.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ from: "2026-08-31", to: "2026-09-06" }),
    );
  });
  it("treats a missing analytics payload as unavailable", async () => {
    fetchSummary.mockResolvedValue(summary(false));
    paint();
    await waitFor(() => expect(screen.getAllByRole("alert").length).toBe(2));
    expect(screen.getAllByText("Retry").length).toBe(2);
    expect(
      screen.getByText(
        "Account data unavailable until performance data loads.",
      ),
    ).toBeTruthy();
  });
  it("ignores out-of-order responses and keeps the latest response", async () => {
    const first = deferred<OverviewSummary>();
    const second = deferred<OverviewSummary>();
    fetchSummary
      .mockReset()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    paint();
    await waitFor(() => expect(fetchSummary).toHaveBeenCalledTimes(2));
    second.resolve(
      summary(true, {
        analytics: analytics({ totals: totals({ invited: 99 }) }),
      }),
    );
    await screen.findByText("99");
    first.resolve(
      summary(true, {
        analytics: analytics({ totals: totals({ invited: 1 }) }),
      }),
    );
    await waitFor(() => expect(screen.getByText("99")).toBeTruthy());
  });
  it("fails closed on provider discovery and retries discovery", async () => {
    resolvePath
      .mockRejectedValueOnce(new Error("discovery down"))
      .mockResolvedValueOnce("supabase");
    paint();
    await screen.findByRole("alert");
    expect(fetchSummary).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { name: "System totals" });
    expect(fetchSummary).not.toHaveBeenCalled();
  });
  it("uses legacy analytics only after the full data phase, without Neon requests", async () => {
    resolvePath.mockResolvedValue("supabase");
    phase = "partial";
    const view = paint();
    await screen.findByRole("status", { name: "Loading system totals" });
    expect(screen.getByRole("status", { name: "Loading performance analytics" })).toBeTruthy();
    expect(screen.getByRole("status", { name: "Loading account analytics" })).toBeTruthy();
    expect(fetchSummary).not.toHaveBeenCalled();
    phase = "full";
    view.rerender(
      <MemoryRouter>
        <Overview />
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "System totals" });
    expect(fetchSummary).not.toHaveBeenCalled();
  });
  it("updates the default preset at the UTC midnight boundary", async () => {
    paint();
    await waitFor(() =>
      expect(fetchSummary).toHaveBeenCalledWith(
        expect.objectContaining({ to: "2026-09-06" }),
      ),
    );
    vi.setSystemTime(new Date("2026-09-07T00:00:00Z"));
    await vi.advanceTimersByTimeAsync(60_000);
    await waitFor(() =>
      expect(fetchSummary).toHaveBeenCalledWith(
        expect.objectContaining({ to: "2026-09-07" }),
      ),
    );
  });
  it("links a campaign row to its encoded campaign detail route", async () => {
    paint();
    await screen.findByRole("heading", { name: "Performance" });
    fireEvent.change(
      screen.getByRole("combobox", { name: "Performance account" }),
      { target: { value: "one" } },
    );
    const link = await screen.findByRole("link", { name: "View leads" });
    expect(link.getAttribute("href")).toBe("/campaign/one%3A42");
  });
  it("labels activity over a year with weekly buckets", async () => {
    fetchSummary.mockResolvedValue(
      summary(true, {
        analytics: analytics({
          activity: [
            {
              day: "2025-01-01",
              instance_id: "one",
              event_type: "invited",
              cnt: 1,
            },
            {
              day: "2026-09-06",
              instance_id: "one",
              event_type: "replied",
              cnt: 1,
            },
          ],
        }),
      }),
    );
    paint(["/?range=2025-01-01~2026-09-06"]);
    expect(
      await screen.findByRole("img", {
        name: /Weekly invited, connected and first replies/,
      }),
    ).toBeTruthy();
  });
  it("sorts and paginates campaign rows without losing the detail links", async () => {
    data.campaigns = Array.from({ length: 21 }, (_, i) =>
      campaign({
        campaign_id: `one:${i + 1}`,
        campaign_name: `Campaign ${i + 1}`,
        invites_sent: i + 1,
      }),
    ) as never;
    fetchSummary.mockResolvedValue(
      summary(true, { campaigns: data.campaigns }),
    );
    paint();
    await screen.findByRole("heading", { name: "Performance" });
    fireEvent.change(
      screen.getByRole("combobox", { name: "Performance account" }),
      { target: { value: "one" } },
    );
    await screen.findByText("Page 1 of 2");
    expect(screen.getByText("Campaign 21")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Page 2 of 2");
    expect(screen.getByText("Campaign 1")).toBeTruthy();
    expect(screen.queryByText("Campaign 21")).toBeNull();
    expect(screen.getAllByRole("link", { name: "View leads" }).length).toBe(1);
  });
});
