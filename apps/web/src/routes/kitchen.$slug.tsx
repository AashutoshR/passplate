import { createFileRoute } from "@tanstack/react-router";
import { useAccount } from "../lib/account";
import { KitchenBoard } from "../components/kitchen";
import { StaffShell } from "../components/staff";

/**
 * Kitchen display (FR-10 to FR-13). Staff sign in with their own account
 * (FR-22): every tap is recorded against the person who made it.
 */
export const Route = createFileRoute("/kitchen/$slug")({
  head: () => ({
    meta: [{ title: "Kitchen · PassPlate" }, { name: "theme-color", content: "#0b0b0a" }],
  }),
  component: KitchenPage,
});

function KitchenPage() {
  const { slug } = Route.useParams();
  const { user, ready, signOut } = useAccount();

  if (!ready) return <div className="theme-dark min-h-dvh" />;
  const allowed = user && (user.role === "staff" || user.role === "admin") && user.locationId;
  if (!allowed) {
    // The usual staff frame: a sign-in form, or a note that this screen is not for this role.
    return (
      <StaffShell roles={["staff", "admin"]}>
        <div />
      </StaffShell>
    );
  }
  return (
    <KitchenBoard
      slug={slug}
      session={{ locationId: user.locationId!, locationName: "Kitchen" }}
      onLogout={() => void signOut()}
    />
  );
}
