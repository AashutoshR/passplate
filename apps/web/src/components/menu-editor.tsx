import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ALLERGENS,
  DIETARY_LABELS,
  DIETARY_TAGS,
  formatMoney,
  type ItemInput,
  type MenuAdminView,
} from "@pass/shared";
import { ApiError, api } from "../lib/api";
import { DishPhoto } from "./dishes";
import { Sheet } from "./sheet";

/**
 * The menu editor (FR-1): sections, dishes, prices, photos, allergens and
 * choices. Saving tells every open menu to reload, so guests see the change
 * within a second. Dishes are taken off the menu, never deleted, because past
 * orders and receipts still name them.
 */

type AdminItem = MenuAdminView["categories"][number]["items"][number];
type Draft = Omit<ItemInput, "modifierGroups"> & {
  id?: string;
  priceText: string;
  stockText: string;
  modifierGroups: {
    id?: string;
    name: string;
    minSelect: number;
    maxSelect: number;
    modifiers: { id?: string; name: string; priceText: string }[];
  }[];
};

const pounds = (minor: number) => (minor / 100).toFixed(2);
const toMinor = (text: string) => Math.round(Number(text.replace(/[£,\s]/g, "")) * 100);
const errorText = (err: unknown) =>
  err instanceof ApiError
    ? ((err.details as { path: string; message: string }[] | undefined)?.map((d) => d.message).join(". ") ?? err.message)
    : "No connection. Nothing was saved.";

function draftFrom(item: AdminItem | null, categoryId: string): Draft {
  return {
    id: item?.id,
    categoryId: item?.categoryId ?? categoryId,
    name: item?.name ?? "",
    description: item?.description ?? "",
    priceMinor: item?.priceMinor ?? 0,
    priceText: item ? pounds(item.priceMinor) : "",
    allergens: (item?.allergens ?? []) as Draft["allergens"],
    dietary: (item?.dietary ?? []) as Draft["dietary"],
    image: item?.image ?? null,
    featured: item?.featured ?? false,
    stock: item?.stock ?? null,
    stockText: item?.stock === null || item?.stock === undefined ? "" : String(item.stock),
    soldOut: item?.soldOut ?? false,
    modifierGroups: (item?.modifierGroups ?? []).map((g) => ({
      id: g.id,
      name: g.name,
      minSelect: g.minSelect,
      maxSelect: g.maxSelect,
      modifiers: g.modifiers.map((m) => ({ id: m.id, name: m.name, priceText: pounds(m.priceDeltaMinor) })),
    })),
  };
}

function toInput(d: Draft): ItemInput {
  return {
    categoryId: d.categoryId,
    name: d.name.trim(),
    description: d.description?.trim() || null,
    priceMinor: toMinor(d.priceText || "0"),
    allergens: d.allergens,
    dietary: d.dietary,
    image: d.image ?? null,
    featured: d.featured,
    stock: d.stockText.trim() === "" ? null : Math.max(0, Math.floor(Number(d.stockText))),
    soldOut: d.soldOut,
    modifierGroups: d.modifierGroups.map((g) => ({
      ...(g.id ? { id: g.id } : {}),
      name: g.name.trim(),
      minSelect: g.minSelect,
      maxSelect: g.maxSelect,
      modifiers: g.modifiers.map((m) => ({ ...(m.id ? { id: m.id } : {}), name: m.name.trim(), priceDeltaMinor: toMinor(m.priceText || "0") })),
    })),
  };
}

export function MenuEditor() {
  const [menu, setMenu] = useState<MenuAdminView | null>(null);
  const [sectionId, setSectionId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [newSection, setNewSection] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async () => {
    const m = await api<MenuAdminView>("/v1/staff/admin/menu");
    setMenu(m);
    setSectionId((cur) => (cur && m.categories.some((c) => c.id === cur) ? cur : (m.categories[0]?.id ?? null)));
  }, []);
  useEffect(() => void load().catch((err) => setError(errorText(err))), [load]);

  const section = menu?.categories.find((c) => c.id === sectionId) ?? null;
  const money = (m: number) => formatMoney(m, menu?.currency ?? "GBP");

  async function act(fn: () => Promise<unknown>, done?: string) {
    setError(null);
    try {
      await fn();
      await load();
      if (done) {
        setSaved(done);
        setTimeout(() => setSaved(null), 3000);
      }
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    }
  }

  function move(ids: string[], index: number, by: -1 | 1) {
    const next = [...ids];
    const [x] = next.splice(index, 1);
    next.splice(index + by, 0, x!);
    return next;
  }

  if (!menu) return <p className="text-taupe">{error ?? "Loading the menu…"}</p>;
  const sectionIds = menu.categories.map((c) => c.id);

  return (
    <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
      <aside className="border border-espresso/15 bg-cream" aria-label="Menu sections">
        <h2 className="border-b border-espresso/15 px-4 py-3 font-serif text-2xl">Sections</h2>
        <ol>
          {menu.categories.map((c, i) => (
            <li key={c.id} className={`flex items-center gap-1 border-b border-espresso/10 ${c.id === sectionId ? "bg-linen" : ""}`}>
              <button type="button" onClick={() => setSectionId(c.id)} className="min-w-0 flex-1 px-4 py-3 text-left">
                <span className="block truncate font-medium">{c.name}</span>
                <span className="text-sm text-umber">
                  {c.items.filter((x) => !x.archived).length} dishes
                </span>
              </button>
              <button
                type="button"
                aria-label={`Move ${c.name} up`}
                disabled={i === 0}
                onClick={() => void act(() => api("/v1/staff/admin/menu/categories/order", { method: "POST", json: { ids: move(sectionIds, i, -1) } }))}
                className="px-2 py-3 text-umber hover:text-espresso disabled:opacity-25"
              >
                ↑
              </button>
              <button
                type="button"
                aria-label={`Move ${c.name} down`}
                disabled={i === menu.categories.length - 1}
                onClick={() => void act(() => api("/v1/staff/admin/menu/categories/order", { method: "POST", json: { ids: move(sectionIds, i, 1) } }))}
                className="px-2 py-3 pr-3 text-umber hover:text-espresso disabled:opacity-25"
              >
                ↓
              </button>
            </li>
          ))}
        </ol>
        <form
          className="flex gap-2 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!newSection.trim()) return;
            void act(() => api("/v1/staff/admin/menu/categories", { method: "POST", json: { name: newSection.trim() } }), "Section added").then(
              (ok) => ok && setNewSection(""),
            );
          }}
        >
          <input
            value={newSection}
            onChange={(e) => setNewSection(e.target.value.slice(0, 60))}
            placeholder="New section"
            aria-label="New section name"
            className="min-w-0 flex-1 border border-espresso/25 bg-cream px-3 py-2 outline-none focus:border-espresso"
          />
          <button type="submit" className="cta cta-dark px-4 py-2">
            <span>Add</span>
          </button>
        </form>
      </aside>

      <section aria-live="polite">
        {(error || saved) && (
          <p role={error ? "alert" : "status"} className={`mb-4 border px-4 py-3 ${error ? "border-brass" : "border-olive text-olive"}`}>
            {error ?? saved}
          </p>
        )}
        {section && (
          <SectionPanel
            key={section.id}
            section={section}
            money={money}
            onEdit={(item) => setEditing(draftFrom(item, section.id))}
            onAct={act}
            move={move}
          />
        )}
      </section>

      {editing && (
        <ItemSheet
          draft={editing}
          setDraft={setEditing}
          sections={menu.categories.map((c) => ({ id: c.id, name: c.name }))}
          photos={menu.photos}
          money={money}
          onClose={() => setEditing(null)}
          onSave={async () => {
            const body = toInput(editing);
            const ok = await act(
              () =>
                editing.id
                  ? api(`/v1/staff/admin/menu/items/${editing.id}`, { method: "PUT", json: body })
                  : api("/v1/staff/admin/menu/items", { method: "POST", json: body }),
              `${body.name} saved. Guests see it now.`,
            );
            if (ok) setEditing(null);
          }}
          onArchive={
            editing.id
              ? async () => {
                  const ok = await act(() => api(`/v1/staff/admin/menu/items/${editing.id}`, { method: "DELETE" }), `${editing.name} is off the menu.`);
                  if (ok) setEditing(null);
                }
              : undefined
          }
          error={error}
        />
      )}
    </div>
  );
}

function SectionPanel({
  section,
  money,
  onEdit,
  onAct,
  move,
}: {
  section: MenuAdminView["categories"][number];
  money: (m: number) => string;
  onEdit: (item: AdminItem | null) => void;
  onAct: (fn: () => Promise<unknown>, done?: string) => Promise<boolean>;
  move: (ids: string[], index: number, by: -1 | 1) => string[];
}) {
  const [name, setName] = useState(section.name);
  const [blurb, setBlurb] = useState(section.blurb ?? "");
  const live = section.items.filter((i) => !i.archived);
  const off = section.items.filter((i) => i.archived);
  const liveIds = live.map((i) => i.id);
  const dirty = name !== section.name || blurb !== (section.blurb ?? "");

  return (
    <div className="border border-espresso/15 bg-cream">
      <form
        className="grid gap-3 border-b border-espresso/15 p-5 md:grid-cols-[1fr_2fr_auto] md:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          void onAct(() => api(`/v1/staff/admin/menu/categories/${section.id}`, { method: "PATCH", json: { name, blurb: blurb || null } }), "Section saved");
        }}
      >
        <label>
          <span className="eyebrow mb-1.5 block text-[0.6rem] text-taupe">Section</span>
          <input value={name} onChange={(e) => setName(e.target.value.slice(0, 60))} className="w-full border-b border-espresso/30 bg-transparent py-1.5 font-serif text-2xl outline-none focus:border-espresso" />
        </label>
        <label>
          <span className="eyebrow mb-1.5 block text-[0.6rem] text-taupe">Line under the heading</span>
          <input value={blurb} onChange={(e) => setBlurb(e.target.value.slice(0, 160))} className="w-full border-b border-espresso/30 bg-transparent py-2 outline-none focus:border-espresso" />
        </label>
        <div className="flex gap-2">
          {dirty && (
            <button type="submit" className="cta cta-dark px-4 py-2.5">
              <span>Save</span>
            </button>
          )}
          <button type="button" onClick={() => onEdit(null)} className="cta px-4 py-2.5">
            <span>Add a dish</span>
          </button>
        </div>
      </form>

      {live.length === 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-8">
          <p className="text-umber">No dishes here yet.</p>
          <button
            type="button"
            onClick={() => void onAct(() => api(`/v1/staff/admin/menu/categories/${section.id}`, { method: "DELETE" }), "Section removed")}
            className="eyebrow text-[0.6rem] text-umber hover:text-espresso"
          >
            Remove this section
          </button>
        </div>
      )}
      <ul className="divide-y divide-espresso/10">
        {live.map((item, i) => (
          <li key={item.id} className="flex items-center gap-4 px-5 py-3">
            <DishPhoto src={item.image} alt="" className="size-14 shrink-0" />
            <button type="button" onClick={() => onEdit(item)} className="min-w-0 flex-1 text-left">
              <span className="block truncate font-medium">{item.name}</span>
              <span className="text-sm text-umber">
                {money(item.priceMinor)}
                {item.modifierGroups.length > 0 && ` · ${item.modifierGroups.length} ${item.modifierGroups.length === 1 ? "choice" : "choices"}`}
                {item.soldOut && " · Sold out"}
                {item.stock !== null && !item.soldOut && ` · ${item.stock} left`}
                {item.featured && " · Signature"}
              </span>
            </button>
            <button type="button" aria-label={`Move ${item.name} up`} disabled={i === 0} onClick={() => void onAct(() => api(`/v1/staff/admin/menu/categories/${section.id}/order`, { method: "POST", json: { ids: move(liveIds, i, -1) } }))} className="px-1.5 py-2 text-umber hover:text-espresso disabled:opacity-25">
              ↑
            </button>
            <button type="button" aria-label={`Move ${item.name} down`} disabled={i === live.length - 1} onClick={() => void onAct(() => api(`/v1/staff/admin/menu/categories/${section.id}/order`, { method: "POST", json: { ids: move(liveIds, i, 1) } }))} className="px-1.5 py-2 text-umber hover:text-espresso disabled:opacity-25">
              ↓
            </button>
            <button type="button" onClick={() => onEdit(item)} className="eyebrow text-[0.6rem] text-brass hover:text-espresso">
              Edit
            </button>
          </li>
        ))}
      </ul>
      {off.length > 0 && (
        <details className="border-t border-espresso/15 px-5 py-4">
          <summary className="cursor-pointer text-umber">Off the menu ({off.length})</summary>
          <ul className="mt-3 divide-y divide-espresso/10">
            {off.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-4 py-2.5">
                <span className="text-taupe line-through decoration-1">{item.name}</span>
                <button
                  type="button"
                  onClick={() => void onAct(() => api(`/v1/staff/admin/menu/items/${item.id}/restore`, { method: "POST" }), `${item.name} is back on the menu.`)}
                  className="eyebrow text-[0.6rem] text-brass hover:text-espresso"
                >
                  Put back
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function ItemSheet({
  draft,
  setDraft,
  sections,
  photos,
  money,
  onClose,
  onSave,
  onArchive,
  error,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  sections: { id: string; name: string }[];
  photos: string[];
  money: (m: number) => string;
  onClose: () => void;
  onSave: () => Promise<void>;
  onArchive?: () => Promise<void>;
  error: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [library, setLibrary] = useState(false);
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const field = "w-full border border-espresso/25 bg-cream px-3 py-2.5 outline-none focus:border-espresso";
  const label = "mb-1.5 block text-sm font-medium";
  const price = toMinor(draft.priceText || "0");
  const priceOk = Number.isFinite(price) && price >= 0;
  const toggle = <T extends string>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const allPhotos = useMemo(() => [...new Set([...(draft.image ? [draft.image] : []), ...photos])], [draft.image, photos]);

  async function upload(file: File) {
    setUploading(true);
    setUploadError(null);
    try {
      const form = new FormData();
      form.append("photo", file);
      const res = await fetch("/api/v1/staff/admin/menu/photos", { method: "POST", body: form });
      const data = (await res.json()) as { path?: string; error?: { message: string } };
      if (!res.ok || !data.path) throw new Error(data.error?.message ?? "Upload failed");
      set({ image: data.path });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  const groups = draft.modifierGroups;
  const setGroup = (i: number, patch: Partial<Draft["modifierGroups"][number]>) =>
    set({ modifierGroups: groups.map((g, j) => (j === i ? { ...g, ...patch } : g)) });

  return (
    <Sheet
      open
      onClose={onClose}
      title={draft.id ? draft.name || "Dish" : "New dish"}
      kicker={priceOk && draft.priceText ? money(price) : undefined}
      footer={
        <div className="space-y-3">
          {error && (
            <p role="alert" className="border border-brass px-4 py-2.5">
              {error}
            </p>
          )}
          <div className="flex gap-3">
            {onArchive && (
              <button type="button" disabled={busy} onClick={() => void onArchive()} className="cta px-4 py-3.5">
                <span>Take off the menu</span>
              </button>
            )}
            <button
              type="button"
              disabled={busy || !draft.name.trim() || !priceOk || !draft.priceText}
              onClick={async () => {
                setBusy(true);
                await onSave();
                setBusy(false);
              }}
              className="cta cta-dark flex-1 justify-center px-5 py-3.5"
            >
              <span>{busy ? "Saving…" : "Save"}</span>
            </button>
          </div>
        </div>
      }
    >
      <div className="grid gap-5">
        <div>
          <span className={label}>Photo</span>
          <div className="flex items-center gap-4">
            <DishPhoto src={draft.image ?? null} alt="" className="size-24 shrink-0" />
            <div className="flex flex-col items-start gap-2">
              <label className="cta cursor-pointer px-4 py-2.5">
                <span>{uploading ? "Uploading…" : "Upload a photo"}</span>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="sr-only"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void upload(f);
                    e.target.value = "";
                  }}
                />
              </label>
              <button type="button" onClick={() => setLibrary(!library)} className="text-sm text-umber underline decoration-espresso/30 underline-offset-4">
                {library ? "Hide the library" : "Choose from the library"}
              </button>
              {draft.image && (
                <button type="button" onClick={() => set({ image: null })} className="text-sm text-umber underline decoration-espresso/30 underline-offset-4">
                  No photo
                </button>
              )}
            </div>
          </div>
          {uploadError && <p className="mt-2 text-sm text-oxblood">{uploadError}</p>}
          {library && (
            <div className="mt-3 grid max-h-64 grid-cols-5 gap-1.5 overflow-y-auto">
              {allPhotos.map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-label="Use this photo"
                  aria-pressed={draft.image === p}
                  onClick={() => set({ image: p })}
                  className={`outline-offset-1 ${draft.image === p ? "outline-2 outline-espresso" : ""}`}
                >
                  <DishPhoto src={p} alt="" className="aspect-square w-full" />
                </button>
              ))}
            </div>
          )}
          <p className="mt-2 text-xs text-taupe">JPEG, PNG or WebP, up to 3 MB. Use a real photo of this dish.</p>
        </div>

        <label>
          <span className={label}>Name</span>
          <input value={draft.name} onChange={(e) => set({ name: e.target.value.slice(0, 80) })} className={field} />
        </label>
        <label>
          <span className={label}>Description</span>
          <textarea value={draft.description ?? ""} onChange={(e) => set({ description: e.target.value.slice(0, 400) })} rows={2} className={field} />
        </label>
        <div className="grid grid-cols-2 gap-4">
          <label>
            <span className={label}>Price (£)</span>
            <input inputMode="decimal" value={draft.priceText} onChange={(e) => set({ priceText: e.target.value })} placeholder="12.50" className={`${field} tabular`} />
          </label>
          <label>
            <span className={label}>Section</span>
            <select value={draft.categoryId} onChange={(e) => set({ categoryId: e.target.value })} className={field}>
              {sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className={label}>Portions tonight</span>
            <input inputMode="numeric" value={draft.stockText} onChange={(e) => set({ stockText: e.target.value.replace(/\D/g, "").slice(0, 5) })} placeholder="No limit" className={`${field} tabular`} />
          </label>
          <div className="flex flex-col justify-end gap-2 pb-1">
            <label className="flex items-center gap-2.5">
              <input type="checkbox" checked={draft.soldOut} onChange={(e) => set({ soldOut: e.target.checked })} className="size-4 accent-[#17241e]" />
              Sold out
            </label>
            <label className="flex items-center gap-2.5">
              <input type="checkbox" checked={draft.featured} onChange={(e) => set({ featured: e.target.checked })} className="size-4 accent-[#17241e]" />
              Signature dish
            </label>
          </div>
        </div>

        <fieldset>
          <legend className={label}>Dietary</legend>
          <div className="flex flex-wrap gap-2">
            {DIETARY_TAGS.map((t) => (
              <label key={t} className={`cursor-pointer border px-3 py-1.5 text-sm ${draft.dietary.includes(t) ? "border-espresso bg-espresso text-cream" : "border-espresso/25"}`}>
                <input type="checkbox" className="sr-only" checked={draft.dietary.includes(t)} onChange={() => set({ dietary: toggle(draft.dietary, t) })} />
                {DIETARY_LABELS[t]}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className={label}>Allergens</legend>
          <div className="flex flex-wrap gap-2">
            {ALLERGENS.map((a) => (
              <label key={a} className={`cursor-pointer border px-3 py-1.5 text-sm capitalize ${draft.allergens.includes(a) ? "border-espresso bg-espresso text-cream" : "border-espresso/25"}`}>
                <input type="checkbox" className="sr-only" checked={draft.allergens.includes(a)} onChange={() => set({ allergens: toggle(draft.allergens, a) })} />
                {a}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="grid gap-4">
          <legend className={label}>Choices guests make</legend>
          {groups.map((g, i) => (
            <div key={g.id ?? `new-${i}`} className="border border-espresso/20 p-4">
              <div className="grid grid-cols-[1fr_auto_auto] items-end gap-3">
                <label>
                  <span className="text-xs text-umber">Choice</span>
                  <input value={g.name} onChange={(e) => setGroup(i, { name: e.target.value.slice(0, 60) })} placeholder="Cooked" className={field} />
                </label>
                <label>
                  <span className="text-xs text-umber">At least</span>
                  <input type="number" min={0} max={g.modifiers.length} value={g.minSelect} onChange={(e) => setGroup(i, { minSelect: Math.max(0, Number(e.target.value) || 0) })} className={`${field} w-20`} />
                </label>
                <label>
                  <span className="text-xs text-umber">At most</span>
                  <input type="number" min={1} max={g.modifiers.length} value={g.maxSelect} onChange={(e) => setGroup(i, { maxSelect: Math.max(1, Number(e.target.value) || 1) })} className={`${field} w-20`} />
                </label>
              </div>
              <ul className="mt-3 grid gap-2">
                {g.modifiers.map((m, k) => (
                  <li key={m.id ?? `m-${k}`} className="grid grid-cols-[1fr_6rem_auto] items-center gap-2">
                    <input
                      value={m.name}
                      aria-label="Option"
                      onChange={(e) => setGroup(i, { modifiers: g.modifiers.map((x, j) => (j === k ? { ...x, name: e.target.value.slice(0, 60) } : x)) })}
                      placeholder="Option"
                      className={field}
                    />
                    <input
                      value={m.priceText}
                      aria-label="Extra price in pounds"
                      inputMode="decimal"
                      onChange={(e) => setGroup(i, { modifiers: g.modifiers.map((x, j) => (j === k ? { ...x, priceText: e.target.value } : x)) })}
                      placeholder="+0.00"
                      className={`${field} tabular`}
                    />
                    <button type="button" aria-label="Remove option" onClick={() => setGroup(i, { modifiers: g.modifiers.filter((_, j) => j !== k) })} className="px-2 text-umber hover:text-espresso">
                      ×
                    </button>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex justify-between">
                <button type="button" onClick={() => setGroup(i, { modifiers: [...g.modifiers, { name: "", priceText: "0.00" }] })} className="text-sm text-brass">
                  Add an option
                </button>
                <button type="button" onClick={() => set({ modifierGroups: groups.filter((_, j) => j !== i) })} className="text-sm text-umber hover:text-espresso">
                  Remove this choice
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={() => set({ modifierGroups: [...groups, { name: "", minSelect: 0, maxSelect: 1, modifiers: [{ name: "", priceText: "0.00" }] }] })}
            className="cta justify-center px-4 py-2.5"
          >
            <span>Add a choice</span>
          </button>
        </fieldset>
      </div>
    </Sheet>
  );
}
