import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { formatMoney, receiptCode } from "@pass/shared";
import { ApiError, api } from "../lib/api";
import { useAccount } from "../lib/account";
import { StaffShell } from "../components/staff";

interface Hit {
  id: string;
  number: number;
  kind: "sale" | "refund";
  totalMinor: number;
  issuedAt: string;
  customerName: string;
  orderNumbers: number[];
  type: "dine_in" | "pickup" | "delivery";
  tableLabel: string | null;
}

/** "Can I get a receipt?": find it by receipt number, order number or name, and print it. */
export const Route = createFileRoute("/staff/receipts/")({
  validateSearch: (s: Record<string, unknown>) => ({ q: typeof s.q === "string" && s.q ? s.q : undefined }),
  head: () => ({ meta: [{ title: "Receipts · PassPlate" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <StaffShell roles={["staff", "admin"]}>
      <Receipts />
    </StaffShell>
  ),
});

const SERVICE = { dine_in: "Table", pickup: "Collect", delivery: "Delivery" } as const;

function Receipts() {
  const { q } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { user } = useAccount();
  const [text, setText] = useState(q ?? "");
  const [data, setData] = useState<{ currency: string; hits: Hit[] } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    setProblem(null);
    api<{ currency: string; hits: Hit[] }>(`/v1/staff/receipts${q ? `?q=${encodeURIComponent(q)}` : ""}`)
      .then(setData)
      .catch((e) => setProblem(e instanceof ApiError ? e.message : "Could not search receipts"));
  }, [q]);

  const time = (iso: string) =>
    new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

  return (
    <main className="mx-auto max-w-[1100px] px-4 py-8 md:px-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="font-serif text-4xl">Receipts</h1>
        {user?.role === "admin" && (
          <Link to="/staff/receipts/day" search={{ date: undefined }} className="cta cta-outline px-5 py-2.5">
            <span>End of day report</span>
          </Link>
        )}
      </div>
      <form
        className="mt-6 flex flex-wrap gap-2"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          void navigate({ search: { q: text.trim() || undefined } });
        }}
      >
        <label htmlFor="receipt-q" className="sr-only">
          Receipt number, order number or name
        </label>
        <input
          id="receipt-q"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="R-000123, #45 or a name"
          className="field min-w-0 flex-1 basis-64"
        />
        <button type="submit" className="cta cta-dark px-6 py-3">
          <span>Find</span>
        </button>
      </form>
      {problem && (
        <p role="alert" className="mt-4 border border-brass px-4 py-3">
          {problem}
        </p>
      )}
      <p className="mt-6 eyebrow text-taupe">{q ? `Matching "${q}"` : "Latest receipts"}</p>
      {data && data.hits.length === 0 ? (
        <p className="mt-3 border border-espresso/15 bg-cream px-5 py-8 text-umber">No receipt matches that. Try the order number, like #45.</p>
      ) : (
        <ul className="mt-3 divide-y divide-espresso/10 border border-espresso/15 bg-cream" id="receipt-list">
          {data?.hits.map((h) => (
            <li key={h.id}>
              <Link
                to="/staff/receipts/$id"
                params={{ id: h.id }}
                search={{ order: undefined }}
                className="grid grid-cols-[auto_1fr_auto] items-baseline gap-x-4 gap-y-1 px-5 py-4 transition-colors hover:bg-linen md:grid-cols-[130px_1fr_160px_110px]"
              >
                <span className="tabular font-medium">{receiptCode(h.number)}</span>
                <span className="min-w-0 truncate">
                  {h.customerName}
                  <span className="text-taupe">
                    {" "}
                    · {h.tableLabel ?? SERVICE[h.type]} · {h.orderNumbers.map((n) => `#${n}`).join(", ")}
                  </span>
                </span>
                <span className="hidden text-sm text-taupe md:block">{time(h.issuedAt)}</span>
                <span className={`tabular text-right ${h.kind === "refund" ? "text-brass" : ""}`}>
                  {h.kind === "refund" ? "-" : ""}
                  {formatMoney(h.totalMinor, data.currency)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
