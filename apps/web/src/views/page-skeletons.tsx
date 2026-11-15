/**
 * Loading states that are the page itself: the same heading and intro text, the same grid and frames, with quiet
 * bars where data will be. Used both while a page's code loads (the studio's Suspense fallback) and while its data
 * loads, so nothing moves when the real content arrives. Styles live with each page (templates.css, clone.css).
 */
import "../templates.css";
import "../clone.css";

export const TEMPLATES_INTRO = "Short-form formats for health content, each with a sample rendered in Greek. Pick the one that fits what you want to say.";
export const CLONE_INTRO = "Paste a link to a short video you like. Say what to keep and what to change, and Faceful queues a job to make your own version.";

export function TemplateGridSkeleton() {
  return (
    <section className="tl-family tl-skeleton" aria-busy="true" aria-label="Loading templates">
      <div className="tl-family-head" aria-hidden="true"><i className="tl-sk-title" /><i className="tl-sk-note" /></div>
      <ul className="tl-grid" aria-hidden="true">
        {Array.from({ length: 5 }, (_, index) => (
          <li key={index}>
            <span className="tl-card">
              <span className="tl-poster" />
              <span className="tl-card-text"><i className="tl-sk-name" /><i className="tl-sk-line" /><i className="tl-sk-line short" /></span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function TemplatesSkeleton() {
  return (
    <div className="tl" role="status" aria-label="Loading templates">
      <header className="tl-intro"><h1>Templates</h1><p>{TEMPLATES_INTRO}</p></header>
      <TemplateGridSkeleton />
    </div>
  );
}

export function CloneSkeleton() {
  return (
    <div className="cv" role="status" aria-label="Loading Clone a video">
      <header className="cv-intro"><h1>Clone a video</h1><p>{CLONE_INTRO}</p></header>
      <div className="cv-form cv-skeleton" aria-hidden="true">
        <div className="cv-link"><i className="cv-sk-label" /><i className="cv-sk-input" /><i className="cv-sk-note" /></div>
        <div className="cv-brief"><i className="cv-sk-label wide" /><i className="cv-sk-note" /><i className="cv-sk-area" /></div>
        <div className="cv-traits"><i className="cv-sk-label" /><div className="cv-tags">{[132, 128, 104, 112, 96, 124].map((width) => <i key={width} className="cv-sk-chip" style={{ inlineSize: width }} />)}</div></div>
        <div className="cv-start"><i className="cv-sk-button" /></div>
        <section className="cv-source"><i className="cv-sk-label" /><div className="cv-frame is-empty" /></section>
        <section className="cv-result"><i className="cv-sk-label" /><div className="cv-frame is-empty" /></section>
      </div>
    </div>
  );
}
