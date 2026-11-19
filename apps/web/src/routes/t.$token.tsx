import { createFileRoute, notFound } from "@tanstack/react-router";
import type { MenuView } from "@pass/shared";
import { ApiError, api } from "../lib/api";
import { OrderingPage } from "../components/ordering";

/** Dine-in: the QR code on a table opens this page (FR-4). */
export const Route = createFileRoute("/t/$token")({
  loader: async ({ params }) => {
    try {
      const table = await api<{ label: string; locationSlug: string }>(
        `/v1/tables/${encodeURIComponent(params.token)}`,
      );
      const menu = await api<MenuView>(`/v1/locations/${encodeURIComponent(table.locationSlug)}/menu`);
      return { table, menu };
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) throw notFound();
      throw err;
    }
  },
  head: ({ loaderData }) => ({
    meta: [{ title: loaderData ? `${loaderData.table.label} · ${loaderData.menu.location.name}` : "Order" }],
  }),
  component: TablePage,
});

function TablePage() {
  const { table, menu } = Route.useLoaderData();
  const { token } = Route.useParams();
  return <OrderingPage initialMenu={menu} mode={{ type: "dine_in", tableToken: token, tableLabel: table.label }} />;
}
