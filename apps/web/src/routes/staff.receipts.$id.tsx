import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { receiptCode, type ReceiptView } from "@pass/shared";
import { ApiError, api } from "../lib/api";
import { StaffShell } from "../components/staff";
import { ReceiptPaper } from "../components/receipt";

/**
 * One receipt, for staff to print for a guest. The id may be a receipt id or,
 * with ?order=1, an order id: the floor opens this straight after settling a
 * table, before the worker may have written the receipt, so it waits for it.
 * Every print after the first says "Copy", as a till does.
 */
export const Route = createFileRoute("/staff/receipts/$id")({
  validateSearch: (s: Record<string, unknown>) => ({ order: s.order === 1 || s.order === "1" ? 1 : undefined }),
  head: () => ({ meta: [{ title: "Receipt · PassPlate" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <StaffShell roles={["staff", "admin"]}>
      <StaffReceipt />
    </StaffShell>
  ),
});

function StaffReceipt() {
  const { id } = Route.useParams();
  const { order } = Route.useSearch();
  const [receipt, setReceipt] = useState<ReceiptView | null>(null);
  const [copy, setCopy] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    let tries = 0;
    async function load() {
      try {
        const r = await api<ReceiptView>(order ? `/v1/staff/receipts/order/${id}` : `/v1/staff/receipts/${id}`);
        if (!stop) {
          setReceipt(r);
          setCopy(r.printedCount > 0);
        }
      } catch (e) {
        if (e instanceof ApiError && e.code === "receipt_pending" && tries++ < 30) {
          setTimeout(() => !stop && void load(), 700);
          return;
        }
        if (!stop) setProblem(e instanceof ApiError ? e.message : "Could not load the receipt");
      }
    }
    void load();
    return () => {
      stop = true;
    };
  }, [id, order]);

  // Print once React has drawn the receipt with the right Copy mark.
  useEffect(() => {
    if (!printing) return;
    const t = setTimeout(() => {
      window.print();
      setPrinting(false);
    }, 50);
    return () => clearTimeout(t);
  }, [printing]);

  async function print() {
    if (!receipt) return;
    try {
      const out = await api<{ copy: boolean; receipt: ReceiptView }>(`/v1/staff/receipts/${receipt.id}/printed`, { method: "POST" });
      setCopy(out.copy);
      setReceipt(out.receipt);
    } catch {
      // Printing matters more than the count.
    }
    setPrinting(true);
  }

  return (
    <main className="mx-auto max-w-[900px] px-4 py-8 md:px-6">
      <div className="no-print flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="font-serif text-4xl">{receipt ? receiptCode(receipt.number) : "Receipt"}</h1>
        <Link to="/staff/receipts" search={{ q: undefined }} className="draw text-umber">
          All receipts
        </Link>
      </div>
      <div className="mt-8 grid gap-8 md:grid-cols-[1fr_260px] md:items-start">
        <div>
          {receipt ? (
            <ReceiptPaper receipt={receipt} copy={copy} />
          ) : (
            <p className="border border-espresso/15 bg-cream px-5 py-8 text-center text-umber" role="status">
              {problem ?? "Writing the receipt…"}
            </p>
          )}
        </div>
        {receipt && (
          <aside className="no-print grid gap-3">
            <button type="button" id="print-receipt" onClick={() => void print()} className="cta cta-dark px-5 py-3.5">
              <span>{receipt.printedCount > 0 ? "Print a copy" : "Print receipt"}</span>
            </button>
            <p className="text-sm text-taupe">
              {receipt.printedCount === 0
                ? "Not printed yet."
                : `Printed ${receipt.printedCount} time${receipt.printedCount === 1 ? "" : "s"}. Reprints say "Copy".`}
            </p>
            <p className="text-sm text-taupe">Prints on an 80 mm till roll, or choose "Save as PDF" to email it.</p>
          </aside>
        )}
      </div>
    </main>
  );
}
