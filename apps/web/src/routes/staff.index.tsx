import { Link, createFileRoute } from "@tanstack/react-router";
import type { UserRole } from "@pass/shared";
import { useAccount } from "../lib/account";
import { ROLE_LABEL, StaffShell } from "../components/staff";

export const Route = createFileRoute("/staff/")({
  head: () => ({ meta: [{ title: "Staff · PassPlate" }, { name: "robots", content: "noindex" }] }),
  component: StaffHome,
});

const SCREENS: { to: string; title: string; body: string; roles: UserRole[] }[] = [
  { to: "/staff/floor", title: "Floor", body: "The room live: who is where, what is booked, who is waiting.", roles: ["staff", "admin"] },
  { to: "/kitchen/passplate", title: "Kitchen", body: "Tickets as they come in, for the screen at the pass.", roles: ["staff", "admin"] },
  { to: "/staff/driver", title: "Deliveries", body: "Pick up ready orders and share your route with the guest.", roles: ["driver", "admin"] },
  { to: "/staff/admin", title: "Admin", body: "Takings, every transaction, bookings, the team and guests.", roles: ["admin"] },
  { to: "/staff/tables", title: "Table codes", body: "Print the code for each table.", roles: ["staff", "admin"] },
];

function StaffHome() {
  const { user } = useAccount();
  return (
    <StaffShell roles={["staff", "driver", "admin"]}>
      <main className="mx-auto max-w-[1100px] px-5 py-16">
        <p className="eyebrow text-brass">{user ? ROLE_LABEL[user.role] : ""}</p>
        <h1 className="display mt-4 text-[clamp(2.6rem,5vw,4rem)]">Good service, {user?.name.split(" ")[0]}.</h1>
        <ul className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {SCREENS.filter((s) => user && s.roles.includes(user.role)).map((s) => (
            <li key={s.to}>
              <Link to={s.to} className="group flex h-full flex-col border border-espresso/15 bg-cream p-7 transition-colors hover:border-espresso">
                <span className="font-serif text-3xl">{s.title}</span>
                <span className="mt-3 flex-1 text-umber">{s.body}</span>
                <span className="eyebrow mt-6 text-brass transition-transform group-hover:translate-x-1">Open →</span>
              </Link>
            </li>
          ))}
        </ul>
      </main>
    </StaffShell>
  );
}
