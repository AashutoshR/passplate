import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { receiptCode, type ReceiptView } from "@pass/shared";
import { ApiError, api } from "../lib/api";
import { Logo } from "../components/brand";
import { ReceiptPaper } from "../components/receipt";

/**
 * The guest's receipt, opened from their order page. Same private link as the
 * order, so nobody else can find it. Print it, or save it as a PDF from the
 * print dialog.
 */
export const Route = createFileRoute("/receipt/$orderId")({
  head: () => ({ meta: [{ title: "Receipt · PassPlate" }, { name: "robots", content: "noindex" }] }),
  component: GuestReceipt,
});

function GuestReceipt() {
  const { orderId } = Route.useParams();
  const [receipt, setReceipt] = useState<ReceiptView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    let tries = 0;
    async function load() {
      try {
        const r = await api<ReceiptView>(`/v1/orders/${encodeURIComponent(orderId)}/receipt`);
        if (!stop) setReceipt(r);
      } catch (e) {
        // Written by the worker a moment after payment: wait for it.
        if (e instanceof ApiError && e.code === "receipt_pending" && tries++ < 30) {
          setTimeout(() => !stop && void load(), 1000);
          return;
        }
        if (!stop) setProblem(e instanceof ApiError ? e.message : "The receipt could not load. Try again in a moment.");
      }
    }
    void load();
    return () => {
      stop = true;
    };
  }, [orderId]);

  return (
    <main className="min-h-dvh bg-[#f6f2ea] px-4 pt-6 pb-16">
      <div className="no-print mx-auto flex max-w-[360px] items-center justify-between">
        <Logo size="sm" />
        <Link to="/order/$id" params={{ id: orderId }} className="draw text-sm text-umber">
          Back to your order
        </Link>
      </div>
      <h1 className="no-print sr-only">Your receipt</h1>
      <div className="mt-8">
        {receipt ? (
          <ReceiptPaper receipt={receipt} />
        ) : (
          <p className="mx-auto max-w-[360px] border border-espresso/15 bg-cream px-5 py-8 text-center text-umber" role="status">
            {problem ?? "Preparing your receipt…"}
          </p>
        )}
      </div>
      {receipt && (
        <div className="no-print mx-auto mt-6 grid max-w-[360px] gap-2">
          <button type="button" id="print-receipt" onClick={() => window.print()} className="cta cta-dark px-5 py-3.5">
            <span>Print or save as PDF</span>
          </button>
          <p className="text-center text-sm text-taupe">
            Quote {receiptCode(receipt.number)} if you need to ask us about this order.
          </p>
        </div>
      )}
    </main>
  );
}
