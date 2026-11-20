import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { DayReportView } from "@pass/shared";
import { ApiError, api } from "../lib/api";
import { StaffShell } from "../components/staff";
import { DayReportPaper } from "../components/receipt";

/** End of day: the till report an owner prints at closing (Z report). */
export const Route = createFileRoute("/staff/receipts/day")({
  validateSearch: (s: Record<string, unknown>) => ({
    date: typeof s.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.date) ? s.date : undefined,
  }),
  head: () => ({ meta: [{ title: "End of day · PassPlate" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <StaffShell roles={["admin"]}>
      <DayReport />
    </StaffShell>
  ),
});

function DayReport() {
  const { date } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const [report, setReport] = useState<DayReportView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    setReport(null);
    api<DayReportView>(`/v1/staff/receipts/day${date ? `?date=${date}` : ""}`)
      .then(setReport)
      .catch((e) => setProblem(e instanceof ApiError ? e.message : "Could not build the report"));
  }, [date]);

  return (
    <main className="mx-auto max-w-[900px] px-4 py-8 md:px-6">
      <div className="no-print flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="font-serif text-4xl">End of day</h1>
        <Link to="/staff/receipts" search={{ q: undefined }} className="draw text-umber">
          Receipts
        </Link>
      </div>
      <div className="mt-8 grid gap-8 md:grid-cols-[1fr_260px] md:items-start">
        <div>
          {report ? (
            <DayReportPaper report={report} />
          ) : (
            <p className="border border-espresso/15 bg-cream px-5 py-8 text-center text-umber" role="status">
              {problem ?? "Adding up the day…"}
            </p>
          )}
        </div>
        <aside className="no-print grid gap-3">
          <label className="grid gap-1.5">
            <span className="eyebrow text-[0.62rem] text-taupe">Day</span>
            <input
              type="date"
              className="field"
              value={report?.date ?? date ?? ""}
              onChange={(e) => void navigate({ search: { date: e.target.value || undefined } })}
            />
          </label>
          <button type="button" onClick={() => window.print()} disabled={!report} className="cta cta-dark px-5 py-3.5" id="print-day">
            <span>Print report</span>
          </button>
          <p className="text-sm text-taupe">Built from the receipts themselves, so it always matches what guests were given.</p>
        </aside>
      </div>
    </main>
  );
}
