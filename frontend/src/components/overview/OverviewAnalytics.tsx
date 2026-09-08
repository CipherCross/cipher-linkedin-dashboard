import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  CartesianGrid,
  Area,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { DateRangePicker } from "../DateRangePicker";
import type { DateRange } from "../../lib/leads";
import { ago, num, pct, shortDate } from "../../lib/format";
import { freshnessLevel } from "../../lib/freshness";
import type {
  CampaignMetrics,
  Instance,
  OverviewAnalytics as Analytics,
} from "../../lib/types";

type Props = {
  system: Analytics | null;
  performance: Analytics | null;
  campaigns: CampaignMetrics[];
  instances: Instance[];
  systemRange: DateRange;
  range: DateRange;
  presets: DateRange[];
  account: string;
  onSystemRangeChange: (range: DateRange) => void;
  onRangeChange: (range: DateRange) => void;
  onAccountChange: (id: string) => void;
  systemLoading: boolean;
  performanceLoading: boolean;
  systemError: string | null;
  performanceError: string | null;
  onSystemRetry: () => void;
  onPerformanceRetry: () => void;
};
const zero = (): Analytics["totals"] => ({
  leads: 0,
  invited: 0,
  connected: 0,
  messaged: 0,
  replied: 0,
  acceptedOfInvited: 0,
  repliedOfConnected: 0,
});
const labels = {
  invited: "Invited",
  connected: "Connected",
  replied: "First replies",
} as const;
const colors = {
  invited: "var(--accent)",
  connected: "var(--success)",
  replied: "var(--warning)",
} as const;
const chartDate = (day: string, weekly: boolean) => {
  if (weekly) return `Week of ${day}`;
  return shortDate(day);
};
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join("").toUpperCase() || "?";
function chartRows(a: Analytics | null, r: DateRange, account: string) {
  if (!a) return [];
  const rows = new Map<
    string,
    { day: string; invited: number; connected: number; replied: number }
  >();
  for (const item of a.activity) {
    if (account !== "all" && item.instance_id !== account) continue;
    if (
      item.event_type !== "invited" &&
      item.event_type !== "connected" &&
      item.event_type !== "replied"
    )
      continue;
    if ((r.from && item.day < r.from) || (r.to && item.day > r.to)) continue;
    const row = rows.get(item.day) ?? {
      day: item.day,
      invited: 0,
      connected: 0,
      replied: 0,
    };
    row[item.event_type] += item.cnt;
    rows.set(item.day, row);
  }
  if (r.from && r.to) {
    const days: string[] = [];
    const cursor = new Date(`${r.from}T00:00:00Z`);
    const end = new Date(`${r.to}T00:00:00Z`);
    while (cursor <= end && days.length <= 366) {
      days.push(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    if (days.length <= 366)
      return days.map(
        (day) => rows.get(day) ?? { day, invited: 0, connected: 0, replied: 0 },
      );
  }
  const rowDays = [...rows.keys()].sort();
  const spanDays =
    rowDays.length > 1
      ? Math.floor(
          (Date.parse(`${rowDays[rowDays.length - 1]}T00:00:00Z`) -
            Date.parse(`${rowDays[0]}T00:00:00Z`)) /
            86_400_000,
        ) + 1
      : 0;
  const boundedDays =
    r.from && r.to
      ? Math.floor(
          (Date.parse(`${r.to}T00:00:00Z`) -
            Date.parse(`${r.from}T00:00:00Z`)) /
            86_400_000,
        ) + 1
      : 0;
  if (!r.from && !r.to && spanDays <= 366) {
    return [...rows.values()].sort((x, y) => x.day.localeCompare(y.day));
  }
  if (r.from && r.to && boundedDays <= 366) {
    return [...rows.values()].sort((x, y) => x.day.localeCompare(y.day));
  }
  const buckets = new Map<
    string,
    { day: string; invited: number; connected: number; replied: number }
  >();
  for (const row of rows.values()) {
    const date = new Date(`${row.day}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    const week = date.toISOString().slice(0, 10);
    const bucket = buckets.get(week) ?? {
      day: week,
      invited: 0,
      connected: 0,
      replied: 0,
    };
    bucket.invited += row.invited;
    bucket.connected += row.connected;
    bucket.replied += row.replied;
    buckets.set(week, bucket);
  }
  return [...buckets.values()].sort((x, y) => x.day.localeCompare(y.day));
}

function chartUsesWeeklyBuckets(
  a: Analytics | null,
  r: DateRange,
  account: string,
) {
  if (!a) return false;
  const days = a.activity
    .filter((item) => account === "all" || item.instance_id === account)
    .map((item) => item.day)
    .filter((day) => (!r.from || day >= r.from) && (!r.to || day <= r.to))
    .sort();
  if (r.from && r.to) {
    return (
      (Date.parse(`${r.to}T00:00:00Z`) - Date.parse(`${r.from}T00:00:00Z`)) /
        86_400_000 +
        1 >
      366
    );
  }
  return (
    days.length > 1 &&
    (Date.parse(`${days[days.length - 1]}T00:00:00Z`) -
      Date.parse(`${days[0]}T00:00:00Z`)) /
      86_400_000 +
      1 >
      366
  );
}

export function OverviewAnalytics({
  system,
  performance,
  campaigns,
  instances,
  systemRange,
  range,
  presets,
  account,
  onSystemRangeChange,
  onRangeChange,
  onAccountChange,
  systemLoading,
  performanceLoading,
  systemError,
  performanceError,
  onSystemRetry,
  onPerformanceRetry,
}: Props) {
  const [showArchived, setShowArchived] = useState(false);
  const [page, setPage] = useState(0);
  const [accountPage, setAccountPage] = useState(0);
  const [sort, setSort] = useState<{
    key: "name" | "invited" | "connected" | "replied" | "acceptance" | "reply";
    direction: "asc" | "desc";
  }>({ key: "invited", direction: "desc" });
  const selected = instances.find((item) => item.id === account);
  const selectedAccount = performance?.accounts.find(
    (item) => item.instance_id === account,
  );
  const totals =
    selectedAccount?.totals ??
    (account === "all" ? performance?.totals : undefined) ??
    zero();
  const lifetime =
    selectedAccount?.lifetime ??
    (account === "all" ? performance?.lifetime : undefined) ??
    zero();
  const previous =
    selectedAccount?.previous ??
    (account === "all"
      ? performance?.previous
      : selected && !selectedAccount && performance?.previous !== null
        ? zero()
        : null);
  const chart = useMemo(
    () => chartRows(performance, range, account),
    [performance, range, account],
  );
  const weeklyChart = useMemo(
    () => chartUsesWeeklyBuckets(performance, range, account),
    [performance, range, account],
  );
  const visible = useMemo(
    () =>
      campaigns
        .filter(
          (c) =>
            (account === "all" || c.instance_id === account) &&
            (showArchived || c.is_archived !== true),
        )
        .sort((a, b) => {
          const av =
            sort.key === "name"
              ? a.campaign_name
              : sort.key === "invited"
                ? a.invites_sent
                : sort.key === "connected"
                  ? a.accepted
                  : sort.key === "replied"
                    ? a.replies
                    : sort.key === "acceptance"
                      ? (a.lifetime_acceptance_rate ?? -1)
                      : (a.lifetime_reply_rate ?? -1);
          const bv =
            sort.key === "name"
              ? b.campaign_name
              : sort.key === "invited"
                ? b.invites_sent
                : sort.key === "connected"
                  ? b.accepted
                  : sort.key === "replied"
                    ? b.replies
                    : sort.key === "acceptance"
                      ? (b.lifetime_acceptance_rate ?? -1)
                      : (b.lifetime_reply_rate ?? -1);
          const comparison =
            typeof av === "string" && typeof bv === "string"
              ? av.localeCompare(bv)
              : Number(av) - Number(bv);
          return (
            (sort.direction === "asc" ? comparison : -comparison) ||
            a.campaign_name.localeCompare(b.campaign_name)
          );
        }),
    [campaigns, account, showArchived, sort],
  );
  const pages = Math.max(1, Math.ceil(visible.length / 20));
  const pageIndex = Math.min(page, pages - 1);
  // A rostered account with no analytics row is a valid empty account. Only an
  // id absent from the roster is unknown; empty rows still render zero counts
  // and undefined conversion rates.
  const accountDataAvailable =
    account === "all" ? Boolean(performance) : Boolean(selected);
  const selectedLifetime = selectedAccount?.lifetime ?? zero();
  useEffect(() => {
    setPage(0);
    setAccountPage(0);
  }, [account, showArchived]);
  useEffect(() => {
    setPage((current) =>
      Math.min(current, Math.max(0, Math.ceil(visible.length / 20) - 1)),
    );
  }, [visible.length]);
  const accountRows = useMemo(
    () =>
      [...instances].sort((a, b) => {
        const accountValue = (instance: Instance) => {
          if (sort.key === "name")
            return instance.account_name || instance.label || instance.id;
          const row = performance?.accounts.find(
            (x) => x.instance_id === instance.id,
          );
          if (!row) return -1;
          if (sort.key === "acceptance")
            return (
              row.lifetime.acceptedOfInvited / Math.max(1, row.lifetime.invited)
            );
          if (sort.key === "reply")
            return (
              row.lifetime.repliedOfConnected /
              Math.max(1, row.lifetime.connected)
            );
          return row.totals[sort.key];
        };
        const av = accountValue(a);
        const bv = accountValue(b);
        const comparison =
          typeof av === "string" && typeof bv === "string"
            ? av.localeCompare(bv)
            : Number(av) - Number(bv);
        return (
          (sort.direction === "asc" ? comparison : -comparison) ||
          a.id.localeCompare(b.id)
        );
      }),
    [instances, performance, sort],
  );
  const accountPages = Math.max(1, Math.ceil(accountRows.length / 20));
  const accountPageIndex = Math.min(accountPage, accountPages - 1);
  const setSortKey = (key: typeof sort.key) => {
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: key === "name" ? "asc" : "desc" },
    );
    setAccountPage(0);
    setPage(0);
  };
  const today = new Date().toISOString().slice(0, 10);
  const incompleteToday = range.to === today;
  const sortLabel = (key: typeof sort.key, label: string) =>
    `${label}, ${sort.key === key ? (sort.direction === "asc" ? "ascending" : "descending") : "not sorted"}`;
  const fields: Array<[string, keyof Analytics["totals"]]> = [
    ["Leads added", "leads"],
    ["Invited", "invited"],
    ["Connected", "connected"],
    ["Messaged", "messaged"],
    ["Replied", "replied"],
  ];
  return (
    <>
      <section className="sa-summary" aria-labelledby="overview-system-title">
        <div className="sa-row">
          <div>
            <h2 id="overview-system-title">System totals</h2>
            <p className="sa-muted">{systemRange.label} · All accounts</p>
          </div>
          <div className="sa-controls">
            <label className="sa-muted">
              Dates
              <DateRangePicker
                ariaLabel="System totals date range"
                presets={presets}
                value={systemRange}
                onChange={onSystemRangeChange}
              />
            </label>
            {systemLoading && <span className="sa-muted">Refreshing…</span>}
          </div>
        </div>
        {systemError ? (
          <p role="alert" className="sa-muted">
            {systemError}{" "}
            <button type="button" onClick={onSystemRetry}>
              Retry
            </button>
          </p>
        ) : (
          <div className="sa-summary">
            {fields.map(([label, key]) => (
              <div className="sa-total" key={key}>
                <span>
                  {systemRange.from || systemRange.to
                    ? label
                    : label.replace(" added", "")}
                </span>
                <strong>{system ? num(system.totals[key]) : "—"}</strong>
                <small>{systemRange.label}</small>
              </div>
            ))}
          </div>
        )}
      </section>
      <section
        className="sa-panel"
        aria-labelledby="overview-performance-title"
      >
        <div className="sa-row">
          <div>
            <h2 id="overview-performance-title">Performance</h2>
            <p className="sa-muted">
              {range.label} · UTC
              {incompleteToday ? " · Today is in progress" : ""}
            </p>
          </div>
          <div className="sa-controls">
            <label className="sa-muted">
              Account
              <select
                aria-label="Performance account"
                value={account}
                onChange={(e) => {
                  setPage(0);
                  onAccountChange(e.target.value);
                }}
              >
                <option value="all">All accounts</option>
                {instances.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.account_name || i.label || i.id}
                  </option>
                ))}
              </select>
            </label>
            {performanceLoading && (
              <span className="sa-muted">Refreshing…</span>
            )}
            <label className="sa-muted">
              Dates
              <DateRangePicker
                ariaLabel="Performance date range"
                presets={presets}
                value={range}
                onChange={onRangeChange}
              />
            </label>
          </div>
        </div>
        {performanceError ? (
          <p role="alert" className="sa-muted">
            {performanceError}{" "}
            <button type="button" onClick={onPerformanceRetry}>
              Retry
            </button>
          </p>
        ) : performance && accountDataAvailable ? (
          <div className="sa-performance">
            <div>
              <div className="sa-metrics">
                {(["invited", "connected", "replied"] as const).map((key) => (
                  <div className="sa-metric" key={key}>
                    <span className="sa-dot" style={{ color: colors[key] }} />
                    <label>{labels[key]}</label>
                    <strong>{num(totals[key])}</strong>
                    <span>
                      {previous
                        ? `${totals[key] - previous[key] >= 0 ? "+" : ""}${num(totals[key] - previous[key])} vs previous`
                        : "No comparison"}
                    </span>
                  </div>
                ))}
              </div>
              <div
                className="sa-plot"
                role="img"
                aria-label={`${weeklyChart ? "Weekly" : "Daily"} invited, connected and first replies for ${range.label}`}
              >
                <ResponsiveContainer width="100%" height={280}>
                    <ComposedChart data={chart}>
                    <Area
                      type="linear"
                      dataKey="invited"
                      stroke="none"
                      fill={colors.invited}
                      fillOpacity={0.08}
                      tooltipType="none"
                      isAnimationActive={false}
                    />
                    <CartesianGrid
                      stroke="var(--border)"
                      strokeDasharray="3 3"
                    />
                    <XAxis
                      dataKey="day"
                      tick={{ fontSize: 11 }}
                      tickFormatter={(day: string) => chartDate(day, weeklyChart)}
                    />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                    <Tooltip
                      labelFormatter={(day) => chartDate(String(day), weeklyChart)}
                      contentStyle={{ background: "var(--surface-1)", border: "1px solid var(--border-strong)", borderRadius: 10, color: "var(--text)", boxShadow: "0 10px 24px rgb(4 10 24 / .16)" }}
                      labelStyle={{ color: "var(--text-muted)", fontWeight: 600 }}
                      itemStyle={{ color: "var(--text)" }}
                    />
                    <Line
                      dataKey="invited"
                      name="Invited"
                      stroke={colors.invited}
                      strokeWidth={2.5}
                      dot={false}
                      isAnimationActive={false}
                    />
                    <Line
                      dataKey="connected"
                      name="Connected"
                      stroke={colors.connected}
                      strokeWidth={2.5}
                      dot={false}
                      isAnimationActive={false}
                    />
                    <Line
                      dataKey="replied"
                      name="First replies"
                      stroke={colors.replied}
                      strokeWidth={2.5}
                      dot={false}
                      isAnimationActive={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>
            <aside className="sa-rates">
              <h3>All-time conversion</h3>
              <div className="sa-rate">
                <label>Acceptance rate</label>
                <strong>
                  {pct(lifetime.acceptedOfInvited, lifetime.invited)}
                </strong>
                <small>
                  {num(lifetime.acceptedOfInvited)} / {num(lifetime.invited)}{" "}
                  invited
                </small>
              </div>
              <div className="sa-rate">
                <label>Reply rate</label>
                <strong>
                  {pct(lifetime.repliedOfConnected, lifetime.connected)}
                </strong>
                <small>
                  {num(lifetime.repliedOfConnected)} / {num(lifetime.connected)}{" "}
                  connected
                </small>
              </div>
            </aside>
          </div>
        ) : (
          <p role="status" className="sa-muted">
            {account === "all"
              ? "Performance data unavailable. Try refreshing the performance range."
              : "This account has no performance data for the selected range. Select another account or refresh."}
            {account !== "all" && (
              <button type="button" onClick={() => onAccountChange("all")}>
                {" "}
                Back to all accounts
              </button>
            )}
          </p>
        )}
      </section>
      <section className="sa-panel" aria-labelledby="overview-account-title">
        <div className="sa-row">
          <div>
            <h2 id="overview-account-title">
              {account === "all"
                ? "Account analytics"
                : `${selected?.account_name || selected?.label || account} campaigns`}
            </h2>
            <p className="sa-muted">
              {account === "all"
                ? "Selected period counts · lifetime rates"
                : "Campaigns in the selected account"}
            </p>
          </div>
          {account !== "all" && (
            <button
              type="button"
              className="sa-back"
              onClick={() => onAccountChange("all")}
            >
              ← All accounts
            </button>
          )}
        </div>
        {account === "all" ? (
          !performance ? (
            <p className="sa-muted">
              Account data unavailable until performance data loads.
            </p>
          ) : (
            <>
              <div className="sa-tablewrap">
                <table>
                  <thead>
                    <tr>
                      <th
                        aria-sort={
                          sort.key === "name"
                            ? sort.direction === "asc"
                              ? "ascending"
                              : "descending"
                            : "none"
                        }
                      >
                        <button
                          type="button"
                          onClick={() => setSortKey("name")}
                          aria-label={sortLabel("name", "Account")}
                        >
                          Account
                        </button>
                      </th>
                      <th
                        aria-sort={
                          sort.key === "invited"
                            ? sort.direction === "asc"
                              ? "ascending"
                              : "descending"
                            : "none"
                        }
                      >
                        <button
                          type="button"
                          onClick={() => setSortKey("invited")}
                          aria-label={sortLabel("invited", "Invited")}
                        >
                          Invited
                        </button>
                      </th>
                      <th
                        aria-sort={
                          sort.key === "connected"
                            ? sort.direction === "asc"
                              ? "ascending"
                              : "descending"
                            : "none"
                        }
                      >
                        <button
                          type="button"
                          onClick={() => setSortKey("connected")}
                          aria-label={sortLabel("connected", "Connected")}
                        >
                          Connected
                        </button>
                      </th>
                      <th
                        aria-sort={
                          sort.key === "replied"
                            ? sort.direction === "asc"
                              ? "ascending"
                              : "descending"
                            : "none"
                        }
                      >
                        <button
                          type="button"
                          onClick={() => setSortKey("replied")}
                          aria-label={sortLabel("replied", "Replies")}
                        >
                          First replies
                        </button>
                      </th>
                      <th
                        aria-sort={
                          sort.key === "acceptance"
                            ? sort.direction === "asc"
                              ? "ascending"
                              : "descending"
                            : "none"
                        }
                      >
                        <button
                          type="button"
                          onClick={() => setSortKey("acceptance")}
                          aria-label={sortLabel(
                            "acceptance",
                            "Acceptance lifetime",
                          )}
                        >
                          Acceptance · lifetime
                        </button>
                      </th>
                      <th
                        aria-sort={
                          sort.key === "reply"
                            ? sort.direction === "asc"
                              ? "ascending"
                              : "descending"
                            : "none"
                        }
                      >
                        <button
                          type="button"
                          onClick={() => setSortKey("reply")}
                          aria-label={sortLabel("reply", "Reply rate lifetime")}
                        >
                          Reply rate · lifetime
                        </button>
                      </th>
                      <th>Last sync</th>
                    </tr>
                  </thead>
                  <tbody>
                    {accountRows
                      .slice(accountPageIndex * 20, accountPageIndex * 20 + 20)
                      .map((i) => {
                        const row = performance?.accounts.find(
                          (x) => x.instance_id === i.id,
                        );
                        const t = row?.totals ?? zero();
                        const l = row?.lifetime ?? zero();
                        return (
                          <tr key={i.id}>
                            <td>
                              <button
                                className="sa-name"
                                type="button"
                                aria-label={i.account_name || i.label || i.id}
                                onClick={() => onAccountChange(i.id)}
                              >
                                <span className="sa-avatar" aria-hidden="true">
                                  {i.account_avatar ? <img src={i.account_avatar} alt="" /> : initials(i.account_name || i.label || i.id)}
                                </span>
                                <span>
                                  {i.account_name || i.label || i.id}
                                  {i.account_name && i.label && i.label !== i.account_name && <small className="sa-muted">{i.label}</small>}
                                </span>
                              </button>
                            </td>
                            <td>{num(t.invited)}</td>
                            <td>{num(t.connected)}</td>
                            <td>{num(t.replied)}</td>
                            <td
                              title={`${num(l.acceptedOfInvited)} connected of ${num(l.invited)} invited`}
                            >
                              {pct(l.acceptedOfInvited, l.invited)}
                            </td>
                            <td
                              title={`${num(l.repliedOfConnected)} replies of ${num(l.connected)} connected`}
                            >
                              {pct(l.repliedOfConnected, l.connected)}
                            </td>
                            <td>
                              {i.last_sync_at ? (
                                <span
                                  title={new Date(
                                    i.last_sync_at,
                                  ).toLocaleString()}
                                >
                                  {ago(i.last_sync_at)} ·{" "}
                                  {freshnessLevel(i.last_sync_at)}
                                </span>
                              ) : (
                                <span title="No successful sync recorded">
                                  Unknown
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
              <div className="sa-bottom">
                <span>
                  Lifetime account totals · rates use invited → connected and
                  connected → replies
                </span>
                <span>
                  {accountRows.length > 20 && (
                    <>
                      <button
                        type="button"
                        disabled={accountPageIndex === 0}
                        onClick={() => setAccountPage(accountPageIndex - 1)}
                      >
                        Previous accounts
                      </button>{" "}
                      Page {accountPageIndex + 1} of {accountPages}{" "}
                      <button
                        type="button"
                        disabled={accountPageIndex + 1 >= accountPages}
                        onClick={() => setAccountPage(accountPageIndex + 1)}
                      >
                        Next accounts
                      </button>
                      {" · "}
                    </>
                  )}
                  Freshness is shown from each account’s last sync
                </span>
              </div>
            </>
          )
        ) : !selected ? (
          <p role="alert" className="sa-muted">
            Account not found.{" "}
            <button type="button" onClick={() => onAccountChange("all")}>
              Back to all accounts
            </button>
          </p>
        ) : (
          <>
            <div className="sa-detail" aria-label="Lifetime account totals">
              <div className="sa-row">
                <h3>Lifetime account totals</h3>
                <span className="sa-muted">Selected account · all time</span>
              </div>
              <div className="sa-details">
                {fields.map(([label, key]) => (
                  <div key={key}>
                    <strong>{num(selectedLifetime[key])}</strong>
                    <span>{label === "Leads added" ? "Leads" : label}</span>
                  </div>
                ))}
              </div>
            </div>
            <label className="sa-muted">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => {
                  setShowArchived(e.target.checked);
                  setPage(0);
                }}
              />{" "}
              Show archived
            </label>
            <div className="sa-tablewrap">
              <table>
                <thead>
                  <tr>
                    <th
                      aria-sort={
                        sort.key === "name"
                          ? sort.direction === "asc"
                            ? "ascending"
                            : "descending"
                          : "none"
                      }
                    >
                      <button
                        type="button"
                        onClick={() => setSortKey("name")}
                        aria-label={sortLabel("name", "Campaign")}
                      >
                        Campaign
                      </button>
                    </th>
                    <th
                      aria-sort={
                        sort.key === "invited"
                          ? sort.direction === "asc"
                            ? "ascending"
                            : "descending"
                          : "none"
                      }
                    >
                      <button
                        type="button"
                        onClick={() => setSortKey("invited")}
                        aria-label={sortLabel("invited", "Invited")}
                      >
                        Invited
                      </button>
                    </th>
                    <th
                      aria-sort={
                        sort.key === "connected"
                          ? sort.direction === "asc"
                            ? "ascending"
                            : "descending"
                          : "none"
                      }
                    >
                      <button
                        type="button"
                        onClick={() => setSortKey("connected")}
                        aria-label={sortLabel("connected", "Connected")}
                      >
                        Connected
                      </button>
                    </th>
                    <th
                      aria-sort={
                        sort.key === "replied"
                          ? sort.direction === "asc"
                            ? "ascending"
                            : "descending"
                          : "none"
                      }
                    >
                      <button
                        type="button"
                        onClick={() => setSortKey("replied")}
                        aria-label={sortLabel("replied", "First replies")}
                      >
                        First replies
                      </button>
                    </th>
                    <th
                      aria-sort={
                        sort.key === "acceptance"
                          ? sort.direction === "asc"
                            ? "ascending"
                            : "descending"
                          : "none"
                      }
                    >
                      <button
                        type="button"
                        onClick={() => setSortKey("acceptance")}
                        aria-label={sortLabel("acceptance", "Acceptance lifetime")}
                      >
                        Acceptance · lifetime
                      </button>
                    </th>
                    <th
                      aria-sort={
                        sort.key === "reply"
                          ? sort.direction === "asc"
                            ? "ascending"
                            : "descending"
                          : "none"
                      }
                    >
                      <button
                        type="button"
                        onClick={() => setSortKey("reply")}
                        aria-label={sortLabel("reply", "Reply rate lifetime")}
                      >
                        Reply rate · lifetime
                      </button>
                    </th>
                    <th>Open</th>
                  </tr>
                </thead>
                <tbody>
                  {visible
                    .slice(pageIndex * 20, pageIndex * 20 + 20)
                    .map((c) => (
                      <tr key={c.campaign_id}>
                        <td>{c.campaign_name}</td>
                        <td>{num(c.invites_sent)}</td>
                        <td>{num(c.accepted)}</td>
                        <td>{num(c.replies)}</td>
                        <td>
                          {c.lifetime_acceptance_rate == null
                            ? "—"
                            : `${c.lifetime_acceptance_rate.toFixed(1)}%`}
                        </td>
                        <td>
                          {c.lifetime_reply_rate == null
                            ? "—"
                            : `${c.lifetime_reply_rate.toFixed(1)}%`}
                        </td>
                        <td>
                          <Link
                            to={`/campaign/${encodeURIComponent(c.campaign_id)}`}
                          >
                            View leads
                          </Link>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            <div className="sa-bottom">
              <span>{visible.length} campaigns</span>
              <span>
                <button
                  type="button"
                  disabled={pageIndex === 0}
                  onClick={() => setPage(page - 1)}
                >
                  Previous
                </button>{" "}
                Page {pageIndex + 1} of {pages}{" "}
                <button
                  type="button"
                  disabled={pageIndex + 1 >= pages}
                  onClick={() => setPage(page + 1)}
                >
                  Next
                </button>
              </span>
            </div>
          </>
        )}
      </section>
    </>
  );
}
