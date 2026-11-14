import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Clapperboard, LoaderCircle } from "lucide-react";
import type { Campaign, Template } from "@castroom/contracts";
import type { StudioClient } from "../data/client";
import { Modal } from "../components/ui";

const languageNames: Record<string, string> = { en: "English", el: "Greek (Ελληνικά)" };
const languageShort: Record<string, string> = { en: "English", el: "Ελληνικά" };

/** Curated starting points. A template fills editable drafts from what you type; nothing is rendered. */
export function Templates({
  client,
  onClose,
  onCreated,
}: {
  client: StudioClient;
  onClose: () => void;
  onCreated: (campaign: Campaign) => void;
}) {
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [selected, setSelected] = useState<Template | null>(null);
  const [language, setLanguage] = useState("en");
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [operationKey, setOperationKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    client.listTemplates()
      .then((list) => { if (active) setTemplates(list); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Templates could not be loaded."); });
    return () => { active = false; };
  }, [client]);
  function choose(template: Template) {
    setSelected(template); setInputs({}); setError("");
    setLanguage(template.languages.includes(language) ? language : template.languages[0]);
    setOperationKey(crypto.randomUUID());
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!selected || busy) return;
    setBusy(true); setError("");
    try {
      // The key stays the same across retries of this form, so a repeated click cannot create two projects.
      onCreated(await client.createFromTemplate({ templateId: selected.id, language, inputs, operationKey }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The drafts could not be created. Nothing was saved.");
      setBusy(false);
    }
  }
  return (
    <Modal title={selected ? selected.name : "Choose a template"} onClose={onClose}>
      <div className="ob-templates" key={selected?.id ?? "list"}>
        {error && <p className="ob-error" role="alert">{error}</p>}
        {!selected && templates === null && !error && (
          <div className="ob-template-list" role="status">
            <span className="sr-only">Loading templates…</span>
            <div className="ob-template-option ob-skeleton-card"><i /><i /><i /></div>
            <div className="ob-template-option ob-skeleton-card"><i /><i /><i /></div>
          </div>
        )}
        {!selected && templates?.length === 0 && <p className="ob-sub">No templates are available in this workspace yet. Start with your own script instead.</p>}
        {!selected && !!templates?.length && (
          <>
            <p className="ob-sub">Each template turns a few words into editable drafts. Nothing is rendered until you ask.</p>
            <ul className="ob-template-list">
              {templates.map((template, index) => (
                <li key={template.id} style={{ "--ob-i": index } as React.CSSProperties}>
                  <button className="ob-template-option" onClick={() => choose(template)}>
                    <span className="ob-template-icon" aria-hidden="true"><Clapperboard size={18} strokeWidth={1.75} /></span>
                    <span className="ob-template-text">
                      <strong>{template.name}</strong>
                      <span>{template.description}</span>
                      <small>{template.itemCount} {template.itemCount === 1 ? "video" : "videos"} · about {template.durationSeconds}s each · {template.aspectRatio} · {template.languages.map((code) => languageNames[code] ?? code).join(", ")}</small>
                    </span>
                    <ArrowRight className="ob-template-arrow" size={16} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        {selected && (
          <form className="ob-template-form" onSubmit={submit} aria-busy={busy}>
            <p className="ob-sub">{selected.description} You can edit every line afterwards.</p>
            <div className="ob-field">
              <label htmlFor="template-language">Script language</label>
              {/* The select is the real control (keyboard and screen readers); the segments are its pointer shortcut. */}
              <div className="ob-language" style={{ "--ob-count": selected.languages.length, "--ob-index": Math.max(0, selected.languages.indexOf(language)) } as React.CSSProperties}>
                <select id="template-language" className="ob-language-select" value={language} disabled={busy} onChange={(event) => setLanguage(event.target.value)}>
                  {selected.languages.map((code) => <option key={code} value={code}>{languageNames[code] ?? code}</option>)}
                </select>
                {selected.languages.map((code) => (
                  <button key={code} type="button" tabIndex={-1} aria-hidden="true" data-checked={code === language || undefined} disabled={busy} onClick={() => setLanguage(code)}>
                    {languageShort[code] ?? code}
                  </button>
                ))}
              </div>
            </div>
            {selected.inputs.map((field) => (
              <div className="ob-field" key={field.key}>
                <label htmlFor={`template-${field.key}`}>{field.label}{!field.required && <span>Optional</span>}</label>
                <input id={`template-${field.key}`} name={field.key} value={inputs[field.key] ?? ""} maxLength={field.maxLength} required={field.required} readOnly={busy} placeholder={field.placeholder} autoComplete="off" enterKeyHint="next" onChange={(event) => setInputs((previous) => ({ ...previous, [field.key]: event.target.value }))} />
              </div>
            ))}
            <div className="ob-template-actions">
              <button className="ob-button ob-button-quiet" type="button" disabled={busy} onClick={() => { setSelected(null); setError(""); }}><ArrowLeft size={15} aria-hidden="true" />Back to templates</button>
              <button className="ob-button ob-button-primary" aria-disabled={busy || undefined}>
                {busy ? <><LoaderCircle size={16} className="spin" aria-hidden="true" />Creating drafts…</> : `Create ${selected.itemCount === 1 ? "draft" : `${selected.itemCount} drafts`}`}
              </button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}
