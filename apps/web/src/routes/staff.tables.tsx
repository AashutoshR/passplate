import { useEffect, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import QRCode from "qrcode";
import { api } from "../lib/api";
import { SITE } from "../lib/site";
import { StaffShell } from "../components/staff";

interface Demo {
  location: { id: string; slug: string; name: string };
  tables: { label: string; token: string }[];
  kitchenCode: string;
  lanUrls: string[];
}

/** Staff only: the kitchen screen, and the table codes to print. Not linked from the guest pages except the footer. */
export const Route = createFileRoute("/staff/tables")({
  loader: async () => {
    try {
      return await api<Demo>("/v1/dev/demo");
    } catch {
      return null;
    }
  },
  head: () => ({ meta: [{ title: "Table codes · PassPlate" }, { name: "robots", content: "noindex" }] }),
  component: StaffPage,
});

function StaffPage() {
  const demo = Route.useLoaderData();
  const [origin, setOrigin] = useState<string | null>(null);
  const [codes, setCodes] = useState<Record<string, string>>({});

  useEffect(() => {
    // Phones cannot open "localhost", so point the codes at this computer's Wi-Fi address.
    const local = ["localhost", "127.0.0.1"].includes(window.location.hostname);
    setOrigin(local && demo?.lanUrls[0] ? demo.lanUrls[0] : window.location.origin);
  }, [demo]);

  useEffect(() => {
    if (!demo || origin === null) return;
    Promise.all(
      demo.tables.map(async (t) => [
        t.token,
        await QRCode.toDataURL(`${origin}/t/${t.token}`, { margin: 1, width: 240, color: { dark: "#17241e", light: "#f2ece1" } }),
      ]),
    )
      .then((pairs) => setCodes(Object.fromEntries(pairs)))
      .catch(() => {});
  }, [demo, origin]);

  return (
    <StaffShell roles={["staff", "admin"]}>
      <main className="mx-auto max-w-[1440px] px-5 py-16 md:px-10">
        <div className="grid gap-10 border-t-2 border-espresso pt-6 md:grid-cols-[minmax(180px,1fr)_3fr]">
          <p className="eyebrow text-taupe">Kitchen screen</p>
          <div className="flex flex-col items-start gap-5">
            <h1 className="display text-[clamp(2.6rem,5vw,4.4rem)]">Open the line.</h1>
            <p className="max-w-lg text-lg text-umber">
              Run this on the tablet at the pass. Sign in with the device code for this kitchen.
              {demo && (
                <>
                  {" "}
                  On this development server the code is{" "}
                  <code className="border border-espresso/25 bg-linen px-1.5 py-0.5 font-mono text-espresso">{demo.kitchenCode}</code>.
                </>
              )}
            </p>
            <Link to="/kitchen/$slug" params={{ slug: SITE.slug }} className="cta cta-dark px-7 py-4">
              <span>Open the kitchen screen</span>
              <span className="arrow" aria-hidden="true">
                →
              </span>
            </Link>
          </div>
        </div>

        <div className="mt-20 grid gap-10 border-t-2 border-espresso pt-6 md:grid-cols-[minmax(180px,1fr)_3fr]">
          <p className="eyebrow text-taupe">Table codes</p>
          <div>
            <p className="max-w-lg text-lg text-umber">
              Print these and put one on each table. Each opens the menu already set to that table.
            </p>
            {!demo ? (
              <p className="mt-6 text-umber">Table codes are only listed on the development server.</p>
            ) : (
              <ul className="mt-10 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {demo.tables.map((t) => (
                  <li key={t.token} className="border border-espresso/20 p-4">
                    {codes[t.token] ? (
                      <img src={codes[t.token]} alt={`Code for ${t.label}`} className="aspect-square w-full" />
                    ) : (
                      <div className="aspect-square w-full bg-linen" />
                    )}
                    <div className="mt-3 flex items-baseline justify-between">
                      <span className="font-serif text-2xl">{t.label}</span>
                      <Link to="/t/$token" params={{ token: t.token }} className="eyebrow draw text-brass">
                        Open
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </main>
    </StaffShell>
  );
}
