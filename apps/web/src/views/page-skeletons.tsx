/**
 * Loading states that are the page itself: the same heading and intro text, the same grid and frames, with quiet
 * bars where data will be. Used both while a page's code loads (the studio's Suspense fallback) and while its data
 * loads, so nothing moves when the real content arrives. Styles live with each page (templates.css, clone.css).
 */
import { CopyPlus, LayoutTemplate } from "lucide-react";
import "../templates.css";
import "../clone.css";

export const TEMPLATES_INTRO = "Start from a format or clone a video you like.";

/** The two ways to start on the Templates page. The short label is what a phone shows; the long one is the name. */
export type TemplatesTab = "formats" | "clone";
export const TEMPLATES_TABS: Array<{ key: TemplatesTab; label: string; short: string }> = [
  { key: "formats", label: "Start from a format", short: "From a format" },
  { key: "clone", label: "Clone a video you like", short: "Clone a video" },
];
/** The open tab, from the address: `?view=templates&tab=clone`, or the older `?view=clone`. */
export function templatesTab(): TemplatesTab {
  const query = new URLSearchParams(location.search);
  return query.get("tab") === "clone" || query.get("view") === "clone" ? "clone" : "formats";
}

export function TemplateGridSkeleton() {
  return (
    <section className="tl-family tl-skeleton" aria-busy="true" aria-label="Loading formats">
      <div className="tl-family-head" aria-hidden="true"><i className="tl-sk-title" /><i className="tl-sk-note" /></div>
      <ul className="tl-grid" aria-hidden="true">
        {Array.from({ length: 5 }, (_, index) => (
          <li key={index}>
            <span className="tl-card">
              <span className="tl-poster" />
              <span className="tl-card-text"><i className="tl-sk-name" /></span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The clone form's geometry: the three steps on the left, the two frames on the right (one column on a phone). */
function CloneFormSkeleton() {
  return (
    <div className="cv">
      <div className="cv-form cv-skeleton" aria-hidden="true">
        <div className="cv-link"><i className="cv-sk-label" /><i className="cv-sk-input" /><i className="cv-sk-note" /></div>
        <div className="cv-brief"><i className="cv-sk-label wide" /><i className="cv-sk-note" /><i className="cv-sk-area" /></div>
        <div className="cv-traits"><i className="cv-sk-label" /><div className="cv-tags">{[150, 140, 116, 124, 100].map((width) => <i key={width} className="cv-sk-chip" style={{ inlineSize: width }} />)}</div></div>
        <div className="cv-start"><i className="cv-sk-button" /></div>
        <section className="cv-source"><i className="cv-sk-label" /><div className="cv-frame is-empty" /></section>
        <section className="cv-result"><i className="cv-sk-label" /><div className="cv-frame is-empty" /></section>
      </div>
    </div>
  );
}

/** The whole Templates page while its code loads: the real header and tabs, then the open tab's skeleton. */
export function TemplatesSkeleton() {
  const tab = templatesTab();
  return (
    <div className="tl" data-tab={tab} role="status" aria-label="Loading templates">
      <header className="tl-intro">
        <h1>Templates</h1>
        <p>{TEMPLATES_INTRO}</p>
        <div className="tl-tabs" aria-hidden="true">
          {TEMPLATES_TABS.map(({ key, label, short }) => (
            <span key={key} className="tl-tab" data-selected={tab === key || undefined}>
              {key === "formats" ? <LayoutTemplate size={16} /> : <CopyPlus size={16} />}
              <span className="tl-tab-long">{label}</span>
              <span className="tl-tab-short">{short}</span>
            </span>
          ))}
        </div>
      </header>
      <div className="tl-panel">{tab === "clone" ? <CloneFormSkeleton /> : <TemplateGridSkeleton />}</div>
    </div>
  );
}
