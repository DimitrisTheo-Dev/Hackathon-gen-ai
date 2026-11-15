import { useId, useState, type FormEvent } from "react";
import { PictureInPicture2, RectangleVertical, Rows2 } from "lucide-react";
import { productMentions, productPlacementTime, type Composition, type ContentItem, type PlaceProductResult, type Product } from "@castroom/contracts";
import { ApiError, type StudioClient } from "../data/client";
import { Modal, Notice } from "../components/ui";
import { operationKey } from "../lib/operation-key";
import { DomainChip } from "../review/vocabulary";
import { timeLabel } from "./model";

type Layout = "window" | "split" | "full";
const LAYOUTS: Array<{ id: Layout; label: string; help: string; icon: typeof Rows2 }> = [
  { id: "window", label: "Window", help: "A rounded inset over the presenter.", icon: PictureInPicture2 },
  { id: "split", label: "Split", help: "The photo on the top half, the presenter below.", icon: Rows2 },
  { id: "full", label: "Full", help: "The photo fills the frame while it is up.", icon: RectangleVertical },
];
const SECONDS = 3;

/**
 * Puts a brand kit product's photo on the saved timeline (place_product): where the script names it, else a third of
 * the way in, optionally on a closing card. A newer timeline is a conflict, never overwritten.
 */
export function ShowProduct({
  client,
  workspaceId,
  item,
  products,
  composition,
  revision,
  dirty,
  onClose,
  onPlaced,
  onReload,
}: {
  client: StudioClient;
  workspaceId: string;
  /** The saved item: its script decides where the product is named. */
  item: ContentItem;
  products: Product[];
  /** The saved timeline the placement is based on. */
  composition: Composition;
  revision: number;
  dirty: boolean;
  onClose: () => void;
  onPlaced: (result: PlaceProductResult, product: Product, endCard: boolean) => void;
  onReload: () => Promise<void>;
}) {
  const id = useId();
  const choices = products.filter((product) => product.hasImage);
  const [productId, setProductId] = useState(() => productMentions(item.script, choices)[0]?.productId ?? choices[0]?.id ?? "");
  const [layout, setLayout] = useState<Layout>("window");
  const [endCard, setEndCard] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const product = choices.find((entry) => entry.id === productId) ?? null;
  // A preview of where it lands, by the same rule the server uses; the notice after placing says where it went.
  const placed = product ? productPlacementTime(item.script, composition, product, null) : null;
  const mention = placed?.matchedMention;
  const at = placed?.time ?? 0;
  const when = !product
    ? ""
    : mention
      ? `On screen at ${timeLabel(at)}, where the script first names it, for ${SECONDS} seconds.`
      : `On screen at ${timeLabel(at)}, a third of the way in, for ${SECONDS} seconds. The script doesn’t name it.`;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || dirty || !product) return;
    setBusy(true);
    setError("");
    setConflict(false);
    try {
      const payload = { itemId: item.id, productId: product.id, expectedCompositionRevision: revision, layout, at: null, seconds: SECONDS, endCard };
      const result = await client.placeProduct({ ...payload, operationKey: await operationKey(workspaceId, "place_product", payload) });
      onPlaced(result, product, endCard);
    } catch (failure) {
      const stale = failure instanceof ApiError && failure.code === "revision_conflict";
      setConflict(stale);
      setError(stale ? "The timeline changed after you opened it, so nothing was placed. Reload it, then show the product again." : failure instanceof Error && failure.message ? failure.message : "The product wasn’t placed. Check your connection and try again.");
      setBusy(false);
    }
  }
  return (
    <Modal title="Show a product" onClose={onClose}>
      <form className="sp" onSubmit={(event) => void submit(event)} noValidate aria-busy={busy || undefined}>
        <fieldset className="sp-fieldset" disabled={busy}>
          <legend>Product</legend>
          <div className="sp-products">
            {choices.map((entry) => (
              <label key={entry.id} className="sp-product">
                <input type="radio" name={`${id}-product`} value={entry.id} checked={entry.id === productId} onChange={() => setProductId(entry.id)} />
                <span className="sp-product-face">
                  <span className="sp-thumb">{entry.imageUrl && <img src={entry.imageUrl} alt="" />}</span>
                  <span className="sp-product-name">{entry.name}</span>
                  <DomainChip domain={entry.domain} />
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="sp-fieldset" disabled={busy} aria-describedby={`${id}-layout-help`}>
          <legend>Layout</legend>
          <div className="choice-segmented">
            {LAYOUTS.map(({ id: value, label, icon: Icon }) => (
              <label key={value}>
                <input type="radio" name={`${id}-layout`} value={value} checked={layout === value} onChange={() => setLayout(value)} />
                <span>
                  <Icon size={14} aria-hidden="true" />
                  {label}
                </span>
              </label>
            ))}
          </div>
          <p className="sp-help" id={`${id}-layout-help`}>{LAYOUTS.find((entry) => entry.id === layout)?.help}</p>
        </fieldset>
        <label className="check-label sp-check">
          <input type="checkbox" checked={endCard} disabled={busy} onChange={(event) => setEndCard(event.target.checked)} />
          <span>
            Add an end card
            <small>The photo and the product’s name on the closing call to action.</small>
          </span>
        </label>
        {when && <p className="sp-when">{when}</p>}
        {dirty && (
          <p className="sp-why" id={`${id}-why`}>
            Save or discard your timeline edits first. The product goes on the saved version.
          </p>
        )}
        {error && (
          <Notice error>
            {error}
            {conflict && (
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  void onReload().then(() => {
                    setError("");
                    setConflict(false);
                  })
                }
              >
                Reload the timeline
              </button>
            )}
          </Notice>
        )}
        <footer className="modal-actions sp-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={dirty || !product} aria-disabled={busy || undefined} aria-describedby={dirty ? `${id}-why` : undefined}>
            {busy ? "Placing…" : "Show product"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
