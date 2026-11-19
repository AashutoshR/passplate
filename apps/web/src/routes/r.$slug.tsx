import { createFileRoute, notFound } from "@tanstack/react-router";
import type { MenuView } from "@pass/shared";
import { ApiError, api } from "../lib/api";
import { OrderingPage } from "../components/ordering";

/** Pickup ordering from a public link (FR-5). */
export const Route = createFileRoute("/r/$slug")({
  validateSearch: (search: Record<string, unknown>): { delivery?: boolean } => ({ delivery: search.delivery === true || search.delivery === "1" || search.delivery === 1 ? true : undefined }),
  loader: async ({ params }) => {
    try {
      return await api<MenuView>(`/v1/locations/${encodeURIComponent(params.slug)}/menu`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) throw notFound();
      throw err;
    }
  },
  head: ({ loaderData }) => ({ meta: [{ title: loaderData ? `${loaderData.location.name} · Order` : "Order" }] }),
  component: PickupPage,
});

function PickupPage() {
  const menu = Route.useLoaderData();
  const { delivery } = Route.useSearch();
  return <OrderingPage initialMenu={menu} mode={{ type: "pickup", delivery: Boolean(delivery) }} />;
}
