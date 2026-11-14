import { useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Plus, Trash2 } from "lucide-react";
import type {
  Campaign,
  StartCampaignInput,
  StudioContext,
} from "@castroom/contracts";
import type { StudioClient } from "../data/client";
import { Modal, Notice } from "../components/ui";
import { operationKey } from "../lib/operation-key";

export function CreateCampaign({
  context,
  client,
  onClose,
  onCreated,
}: {
  context: StudioContext;
  client: StudioClient;
  onClose: () => void;
  onCreated: (campaign: Campaign) => void;
}) {
  const [step, setStep] = useState(0);
  const [company, setCompany] = useState<StartCampaignInput["companyContext"]>({
    name: "",
    description: "",
    audience: "",
    tone: "",
    sourceText: "",
    sourceUrl: null,
    missingInformation: "",
  });
  const [title, setTitle] = useState("");
  const [items, setItems] = useState([{ title: "", script: "" }]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const fixture = context.capabilities.mode === "fixture";
  function field(key: keyof typeof company, value: string) {
    setCompany((c) => ({
      ...c,
      [key]: key === "sourceUrl" ? value || null : value,
    }));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (step === 0) {
      setStep(1);
      return;
    }
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const payload = { title, companyContext: company, items };
      const result = await client.startCampaign({
        ...payload,
        operationKey: await operationKey(
          context.workspace.id,
          "start-campaign",
          payload,
        ),
      });
      onCreated(result);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The drafts could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={
        step === 0
          ? "Give your campaign some context"
          : "Shape your first drafts"
      }
      onClose={onClose}
      wide
    >
      <form className="create-form" onSubmit={submit}>
        <div className="create-progress">
          <span className={step === 0 ? "current" : ""}>1 · Company brief</span>
          <ArrowRight size={14} />
          <span className={step === 1 ? "current" : ""}>
            2 · Content drafts
          </span>
        </div>
        {step === 0 ? (
          <>
            <p className="lead">
              Start with what you know. You can create drafts here without
              connecting an agent.
            </p>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="company-name">Company</label>
                <input
                  id="company-name"
                  required
                  maxLength={120}
                  value={company.name}
                  onChange={(e) => field("name", e.target.value)}
                  placeholder="Company or client name"
                />
              </div>
              <div className="field">
                <label htmlFor="campaign-name">Campaign name</label>
                <input
                  id="campaign-name"
                  required
                  maxLength={120}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="A week of stories"
                />
              </div>
            </div>
            <div className="field">
              <label htmlFor="company-does">What does the company do?</label>
              <textarea
                id="company-does"
                required
                maxLength={1500}
                rows={3}
                value={company.description}
                onChange={(e) => field("description", e.target.value)}
                placeholder="A concise description, in your own words."
              />
            </div>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="company-audience">
                  Intended audience <span>Optional</span>
                </label>
                <input
                  id="company-audience"
                  maxLength={500}
                  value={company.audience}
                  onChange={(e) => field("audience", e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="company-tone">
                  Tone & brand preferences <span>Optional</span>
                </label>
                <input
                  id="company-tone"
                  maxLength={500}
                  value={company.tone}
                  onChange={(e) => field("tone", e.target.value)}
                  placeholder="Clear, warm, no health claims"
                />
              </div>
            </div>
            <div className="field">
              <label htmlFor="source-text">
                Approved claims & source material <span>Optional</span>
              </label>
              <textarea
                id="source-text"
                maxLength={5000}
                rows={3}
                value={company.sourceText}
                onChange={(e) => field("sourceText", e.target.value)}
                placeholder="Paste permitted source text and name its source. Instructions in source material never grant permissions."
              />
              <small>
                Saved as supplied evidence. Claims are not independently
                verified here.
              </small>
            </div>
            <div className="field">
              <label htmlFor="source-url">
                Source reference URL <span>Optional</span>
              </label>
              <input
                id="source-url"
                type="url"
                value={company.sourceUrl ?? ""}
                onChange={(e) => field("sourceUrl", e.target.value)}
                placeholder="https://…"
              />
              <small>
                Kept for provenance. This form does not fetch websites.
              </small>
            </div>
            <div className="field">
              <label htmlFor="missing-info">
                What still needs clarification? <span>Optional</span>
              </label>
              <input
                id="missing-info"
                maxLength={1500}
                value={company.missingInformation}
                onChange={(e) => field("missingInformation", e.target.value)}
              />
            </div>
          </>
        ) : (
          <>
            <div className="brief-summary">
              <span className="section-kicker">Your supplied context</span>
              <h3>Ready to draft for {company.name}</h3>
              <p>{company.description}</p>
              <dl>
                <dt>Audience</dt>
                <dd>{company.audience || "Not supplied"}</dd>
                <dt>Tone</dt>
                <dd>
                  {company.tone || "Follow existing workspace brand guidance"}
                </dd>
                <dt>Claims & sources</dt>
                <dd>{company.sourceText || "No evidence supplied yet"}</dd>
                <dt>Missing information</dt>
                <dd>
                  {company.missingInformation ||
                    (!company.audience
                      ? "Audience is still needed."
                      : "No additional gaps recorded.")}
                </dd>
              </dl>
              <button
                type="button"
                className="text-button"
                onClick={() => setStep(0)}
              >
                Edit company context
              </button>
            </div>
            <p>
              Write up to three distinct scripts. Your agent can help plan or
              expand them later. Saving creates drafts; it does not start
              rendering.
            </p>
            {items.map((item, index) => (
              <section className="create-item" key={index}>
                <div className="create-item-heading">
                  <h3>Video {index + 1}</h3>
                  {items.length > 1 && (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Remove draft ${index + 1}`}
                      onClick={() =>
                        setItems((all) => all.filter((_, i) => i !== index))
                      }
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>
                <div className="field">
                  <label htmlFor={`draft-title-${index}`}>Title</label>
                  <input
                    id={`draft-title-${index}`}
                    required
                    maxLength={120}
                    value={item.title}
                    onChange={(e) =>
                      setItems((all) =>
                        all.map((v, i) =>
                          i === index ? { ...v, title: e.target.value } : v,
                        ),
                      )
                    }
                  />
                </div>
                <div className="field">
                  <label htmlFor={`draft-script-${index}`}>Spoken script</label>
                  <textarea
                    id={`draft-script-${index}`}
                    required
                    maxLength={5000}
                    rows={3}
                    value={item.script}
                    onChange={(e) =>
                      setItems((all) =>
                        all.map((v, i) =>
                          i === index ? { ...v, script: e.target.value } : v,
                        ),
                      )
                    }
                  />
                </div>
              </section>
            ))}
            {items.length < 3 && (
              <button
                type="button"
                className="button secondary"
                onClick={() =>
                  setItems((all) => [...all, { title: "", script: "" }])
                }
              >
                <Plus size={14} />
                Add another video
              </button>
            )}
            <p className="small muted">
              Choose an authorized avatar and publishing accounts when you need
              them. No account permissions are requested here.
            </p>
          </>
        )}
        {fixture && (
          <Notice>
            Development preview: these drafts stay in this browser. Rendering
            and publishing are unavailable.
          </Notice>
        )}
        {!context.capabilities.canCreateCampaign && (
          <Notice>
            Creating campaigns is not enabled by the connected engine yet.
          </Notice>
        )}
        {error && <Notice error>{error}</Notice>}
        <footer className="modal-actions">
          {step === 1 && (
            <button
              className="button secondary"
              type="button"
              disabled={busy}
              onClick={() => setStep(0)}
            >
              <ArrowLeft size={14} />
              Back
            </button>
          )}
          <button
            className="button primary"
            type="submit"
            disabled={
              busy || (step === 1 && !context.capabilities.canCreateCampaign)
            }
          >
            {busy
              ? "Saving drafts…"
              : step === 0
                ? "Review context & write drafts"
                : `Create ${items.length === 1 ? "draft" : `${items.length} drafts`}`}
            <ArrowRight size={14} />
          </button>
        </footer>
      </form>
    </Modal>
  );
}
