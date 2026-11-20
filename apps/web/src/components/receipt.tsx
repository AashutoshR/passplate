import type { ReactNode } from "react";
import { formatMoney, receiptCode, type DayReportView, type PaymentMethod, type ReceiptView } from "@pass/shared";

const METHOD: Record<PaymentMethod, string> = { card: "Card", cash: "Cash", online: "Paid online" };
const SERVICE = { dine_in: "Dine in", pickup: "Collection", delivery: "Delivery" } as const;

function when(iso: string, timezone: string) {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, day: "2-digit", month: "short", year: "numeric" }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit" }).format(d);
  return `${date}  ${time}`;
}

const pct = (bp: number) => `${(bp / 100).toFixed(bp % 100 ? 1 : 0)}%`;

function Row({ left, right, strong = false }: { left: ReactNode; right: ReactNode; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-3 ${strong ? "font-bold" : ""}`}>
      <span className="min-w-0">{left}</span>
      <span className="shrink-0 tabular-nums">{right}</span>
    </div>
  );
}

const Rule = () => <div aria-hidden="true" className="my-2 border-t border-dashed border-black/50" />;

function Header({ r }: { r: ReceiptView["body"]["restaurant"] }) {
  return (
    <header className="text-center">
      <p className="text-[17px] font-bold tracking-[0.18em]">{r.name.toUpperCase()}</p>
      {r.legalName !== r.name && <p>{r.legalName}</p>}
      {r.address.map((line) => (
        <p key={line}>{line}</p>
      ))}
      {r.phone && <p>Tel {r.phone}</p>}
      {r.vatNumber && <p>VAT reg. {r.vatNumber}</p>}
    </header>
  );
}

/**
 * A till receipt: monospace, black on white, 72 mm wide when printed. The
 * same paper for the guest's own copy and for staff reprints.
 */
export function ReceiptPaper({ receipt, copy = false }: { receipt: ReceiptView; copy?: boolean }) {
  const b = receipt.body;
  const money = (m: number) => formatMoney(m, receipt.currency);
  const refund = receipt.kind === "refund";
  const neg = (m: number) => (refund ? `-${money(m)}` : money(m));
  return (
    <article
      className="receipt-paper print-area mx-auto w-full max-w-[360px] border border-black/15 px-6 py-7 shadow-[0_18px_40px_rgb(23_36_30/0.12)]"
      aria-label={`Receipt ${receiptCode(receipt.number)}`}
      data-receipt={receipt.number}
    >
      <Header r={b.restaurant} />
      <Rule />
      {copy && <p className="text-center font-bold tracking-[0.3em]">*** COPY ***</p>}
      {refund && <p className="text-center font-bold tracking-[0.3em]">*** REFUND ***</p>}
      <Row left="Receipt" right={receiptCode(receipt.number)} />
      <Row left="Date" right={when(receipt.issuedAt, receipt.timezone)} />
      <Row
        left={SERVICE[b.service.type]}
        right={b.service.tableLabel ?? b.service.customerName}
      />
      <Row left={b.service.orderNumbers.length > 1 ? "Orders" : "Order"} right={b.service.orderNumbers.map((n) => `#${n}`).join(", ")} />
      {refund && b.refundOf && <Row left="Refund of" right={receiptCode(b.refundOf.number)} />}
      <Rule />
      <ul className="space-y-1">
        {b.lines.map((l, i) => (
          <li key={i}>
            <Row left={`${l.quantity} x ${l.name}`} right={neg(l.lineTotalMinor)} />
            {l.modifiers.length > 0 && <p className="pl-4 text-[12px] text-black/70">{l.modifiers.join(", ")}</p>}
            {l.quantity > 1 && <p className="pl-4 text-[12px] text-black/70">@ {money(l.unitPriceMinor)} each</p>}
          </li>
        ))}
      </ul>
      <Rule />
      <Row left="Subtotal" right={neg(b.subtotalMinor)} />
      {b.discountMinor > 0 && <Row left="Reward" right={refund ? money(b.discountMinor) : `-${money(b.discountMinor)}`} />}
      {b.deliveryFeeMinor > 0 && <Row left="Delivery" right={neg(b.deliveryFeeMinor)} />}
      <div className="mt-1 text-[16px]">
        <Row strong left={refund ? "REFUNDED" : "TOTAL"} right={neg(b.totalMinor)} />
      </div>
      <Rule />
      <Row left={refund ? `Refunded to ${METHOD[b.payment.method].toLowerCase()}` : METHOD[b.payment.method]} right={neg(b.payment.amountMinor)} />
      {b.payment.takenBy && <Row left="Served by" right={b.payment.takenBy} />}
      <Rule />
      <Row left={`VAT ${pct(b.vat.rateBp)} included`} right={neg(b.vat.vatMinor)} />
      <Row left="Net of VAT" right={neg(b.vat.netMinor)} />
      <Rule />
      <p className="text-center">Thank you for eating with us.</p>
      <p className="mt-1 text-center text-[11px] text-black/60">Prices include VAT. Keep this receipt for refunds.</p>
    </article>
  );
}

/** The end-of-day report, on the same till paper. */
export function DayReportPaper({ report }: { report: DayReportView }) {
  const money = (m: number) => formatMoney(m, report.currency);
  const day = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${report.date}T12:00:00Z`),
  );
  return (
    <article className="receipt-paper print-area mx-auto w-full max-w-[360px] border border-black/15 px-6 py-7 shadow-[0_18px_40px_rgb(23_36_30/0.12)]" aria-label="End of day report">
      <Header r={report.restaurant} />
      <Rule />
      <p className="text-center font-bold tracking-[0.2em]">END OF DAY</p>
      <p className="text-center">{day}</p>
      <p className="text-center text-[11px] text-black/60">Printed {when(report.generatedAt, report.timezone)}</p>
      <Rule />
      <Row left="Receipts" right={report.receipts.count} />
      {report.receipts.first !== null && (
        <Row left="Numbers" right={`${receiptCode(report.receipts.first)} to ${receiptCode(report.receipts.last!)}`} />
      )}
      <Rule />
      <Row left={`Sales (${report.sales.count})`} right={money(report.sales.grossMinor)} />
      <Row left="  of which delivery fees" right={money(report.sales.deliveryFeesMinor)} />
      <Row left="  rewards given" right={money(report.sales.discountsMinor)} />
      <Row left={`Refunds (${report.refunds.count})`} right={report.refunds.amountMinor ? `-${money(report.refunds.amountMinor)}` : money(0)} />
      <div className="mt-1 text-[16px]">
        <Row strong left="NET TAKINGS" right={money(report.netMinor)} />
      </div>
      <Rule />
      <p className="font-bold">By payment</p>
      {(Object.keys(report.byMethod) as PaymentMethod[]).map((m) => (
        <Row key={m} left={`${METHOD[m]} (${report.byMethod[m].count})`} right={money(report.byMethod[m].amountMinor)} />
      ))}
      <Rule />
      <p className="font-bold">By service</p>
      {(Object.keys(report.byType) as (keyof typeof SERVICE)[]).map((t) => (
        <Row key={t} left={`${SERVICE[t]} (${report.byType[t].count})`} right={money(report.byType[t].amountMinor)} />
      ))}
      <Rule />
      <Row left={`VAT ${pct(report.vat.rateBp)} included`} right={money(report.vat.vatMinor)} />
      <Row left="Net of VAT" right={money(report.vat.netMinor)} />
      <Rule />
      <p className="text-center text-[11px] text-black/60">Cash in the drawer should match the cash line above.</p>
    </article>
  );
}
