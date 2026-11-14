import { useEffect, useState, type FormEvent } from "react";
import { LoaderCircle } from "lucide-react";
import type { Campaign, Template } from "@castroom/contracts";
import type { StudioClient } from "../data/client";
import { Modal, Notice } from "../components/ui";

const languageNames: Record<string, string> = { en: "English", el: "Greek (Ελληνικά)" };

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
      {error && <Notice error>{error}</Notice>}
      {!selected && templates === null && !error && <p role="status"><LoaderCircle size={14} className="spin" aria-hidden="true" /> Loading templates…</p>}
      {!selected && templates?.length === 0 && <p>No templates are available in this workspace yet. Start with your own script instead.</p>}
      {!selected && !!templates?.length && (
        <ul className="template-list">
          {templates.map((template) => (
            <li key={template.id}>
              <button className="template-option" onClick={() => choose(template)}>
                <strong>{template.name}</strong>
                <span>{template.description}</span>
                <small>{template.itemCount} {template.itemCount === 1 ? "video" : "videos"} · about {template.durationSeconds}s each · {template.aspectRatio} · {template.languages.map((code) => languageNames[code] ?? code).join(", ")}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
      {selected && (
        <form className="template-form" onSubmit={submit} aria-busy={busy}>
          <p>{selected.description} You can edit every line afterwards.</p>
          <div className="field">
            <label htmlFor="template-language">Script language</label>
            <select id="template-language" value={language} disabled={busy} onChange={(event) => setLanguage(event.target.value)}>
              {selected.languages.map((code) => <option key={code} value={code}>{languageNames[code] ?? code}</option>)}
            </select>
          </div>
          {selected.inputs.map((field) => (
            <div className="field" key={field.key}>
              <label htmlFor={`template-${field.key}`}>{field.label}{!field.required && <span>Optional</span>}</label>
              <input id={`template-${field.key}`} name={field.key} value={inputs[field.key] ?? ""} maxLength={field.maxLength} required={field.required} disabled={busy} placeholder={field.placeholder} autoComplete="off" onChange={(event) => setInputs((previous) => ({ ...previous, [field.key]: event.target.value }))} />
            </div>
          ))}
          <div className="modal-actions">
            <button className="button secondary" type="button" disabled={busy} onClick={() => { setSelected(null); setError(""); }}>Back to templates</button>
            <button className="button primary" disabled={busy}>{busy ? "Creating drafts…" : `Create ${selected.itemCount === 1 ? "draft" : `${selected.itemCount} drafts`}`}</button>
          </div>
        </form>
      )}
    </Modal>
  );
}
