import { useEffect, useRef, useState } from "react";
import { Check, Copy, Download } from "lucide-react";
import { COMPACT_BELOW, concepts, CurrentMark, HelloMark, RoundWordmark, WORD_PICK, WordmarkContext, wordmarks, type MarkComponent, type Wordmark } from "./marks";
import { LogoFilm } from "./LogoFilm";
import "./logos.css";

const SIZES = [16, 20, 24, 32, 48, 64];
/** The direction this page argues for. See the last section. */
const PICK = "hello";

function Sized({ Mark, size }: { Mark: MarkComponent; size: number }) {
  return <Mark size={size} compact={size < COMPACT_BELOW} />;
}

/** With `typed`, the name is set in Inter the way the product does today. Otherwise it is a drawn wordmark: `word`, or the one chosen on the page. */
function Lockup({ Mark, height = 36, typed, word }: { Mark: MarkComponent; height?: number; typed?: string; word?: Wordmark }) {
  return (
    <span className="lg-lockup" style={{ fontSize: Math.round(height * 0.66) }}>
      <Sized Mark={Mark} size={height} />
      {typed ? <span>{typed}</span> : <RoundWordmark height={Math.round(height * 0.86)} word={word} />}
    </span>
  );
}

function Favicon({ Mark, size = 16 }: { Mark: MarkComponent; size?: number }) {
  return (
    <span className="lg-favicon" style={{ inlineSize: size, blockSize: size, borderRadius: size / 4 }}>
      <Sized Mark={Mark} size={size} />
    </span>
  );
}

function AppIcon({ Mark, tone, size = 84 }: { Mark: MarkComponent; tone: "warm" | "ink" | "art"; size?: number }) {
  return (
    <span className={`lg-app-icon is-${tone}`} style={{ inlineSize: size, blockSize: size }}>
      <Mark size={Math.round(size * 0.92)} />
    </span>
  );
}

function initialConcept() {
  const fromHash = location.hash.slice(1);
  return concepts.some((concept) => concept.id === fromHash) ? fromHash : PICK;
}

export default function LogosPage() {
  const [selected, setSelected] = useState(initialConcept);
  const [wordId, setWordId] = useState(WORD_PICK);
  const word = wordmarks.find((item) => item.id === wordId) ?? wordmarks[0];
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const source = useRef<HTMLDivElement>(null);
  const concept = concepts.find((item) => item.id === selected) ?? concepts[0];
  const pick = concepts.find((item) => item.id === PICK) ?? concepts[0];

  useEffect(() => {
    document.title = "Logo redesign · Faceful";
  }, []);
  useEffect(() => {
    if (copyState === "idle") return;
    const timer = setTimeout(() => setCopyState("idle"), 1800);
    return () => clearTimeout(timer);
  }, [copyState]);

  function choose(id: string) {
    setSelected(id);
    history.replaceState(null, "", `#${id}`);
  }
  // The exported file is the drawing on the grid tile, with the page's ink baked in.
  function svgSource() {
    const svg = source.current?.querySelector("svg");
    if (!svg) return "";
    const copy = svg.cloneNode(true) as SVGSVGElement;
    for (const name of ["aria-hidden", "focusable"]) copy.removeAttribute(name);
    copy.setAttribute("width", "512");
    copy.setAttribute("height", "512");
    return new XMLSerializer().serializeToString(copy).replaceAll("currentColor", "#2A2A27");
  }
  function download() {
    const url = URL.createObjectURL(new Blob([svgSource()], { type: "image/svg+xml" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `faceful-${concept.id}.svg`;
    link.click();
    URL.revokeObjectURL(url);
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(svgSource());
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <WordmarkContext.Provider value={word}>
      <div className="logos-page">
        <header className="lg-header">
          <div className="lg-wrap lg-header-inner">
            <a className="lg-home" href="/" aria-label="Faceful home"><Lockup Mark={CurrentMark} height={32} typed="faceful" /></a>
            <span className="lg-header-title">Logo redesign</span>
            <span className="lg-status">Proposals<span> · nothing in the product has changed</span></span>
          </div>
        </header>

        <main className="lg-wrap">
          <section className="lg-hero">
            <h1>A face for Faceful.</h1>
            <p>Today's mark is three leaning bars. It reads as sound levels, and the name on the door is Faceful. Here are four redesigns drawn in the same ink, on the same paper, with the same lean. Pick one to see it in use.</p>
          </section>

          <section className="lg-section" aria-labelledby="lg-film-title">
            <h2 id="lg-film-title">Hello, in motion</h2>
            <p className="lg-section-lead">About ten seconds, with music and a voice you can pick underneath. Blue sky, the art drifts in like fog, the logo arrives and says its line. Then the face moves in and erases the word letter by letter, and is left alone in the middle to wink, with the address at the bottom.</p>
            <LogoFilm />
          </section>

          <section className="lg-section" aria-labelledby="lg-word-title">
            <h2 id="lg-word-title">Three wordmarks</h2>
            <p className="lg-section-lead">The name is drawn, not typed: every letter is one round stroke with the same ends as the face, and there is no font file to load. Here are three ways to draw it, from calm to cheerful. The one you pick is used in the animation above and in every logo below.</p>
            <div className="lg-concepts is-words" role="group" aria-label="Wordmarks">
              {wordmarks.map((item, index) => (
                <button key={item.id} type="button" className="lg-concept" aria-pressed={item.id === word.id} onClick={() => setWordId(item.id)}>
                  <span className="lg-concept-art lg-word-art"><Lockup Mark={HelloMark} height={56} word={item} /></span>
                  <span className="lg-concept-meta"><span className="lg-concept-number">{"ABC"[index]}</span><strong>{item.name}</strong>{item.id === WORD_PICK && <span className="lg-concept-pick">My pick</span>}</span>
                  <span className="lg-concept-idea">{item.idea}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="lg-section" aria-labelledby="lg-today-title">
            <h2 id="lg-today-title">Where the logo stands today</h2>
            <div className="lg-today">
              <figure className="lg-fig">
                <div className="lg-tile lg-today-tile">
                  <CurrentMark size={132} />
                  <div className="lg-today-words">
                    <Lockup Mark={CurrentMark} height={30} typed="Faceful" />
                    <Lockup Mark={CurrentMark} height={30} typed="faceful" />
                  </div>
                </div>
                <figcaption>The current mark, and the two ways the name is written next to it.</figcaption>
              </figure>
              <ol className="lg-findings">
                <li><strong>It says sound.</strong><p>Three bars of different heights are the picture of an audio meter. The product makes presenter-led video, and its name starts with face.</p></li>
                <li><strong>It is spelled two ways.</strong><p>The studio header writes Faceful with a capital. The landing page writes faceful without one.</p></li>
                <li><strong>It is built three times.</strong><p>One set of CSS bars leans 9 degrees, another leans 8, and the favicon is a separate SVG. There is no single logo file to export from.</p></li>
              </ol>
            </div>
          </section>

          <section className="lg-section" aria-labelledby="lg-directions-title">
            <h2 id="lg-directions-title">Four directions</h2>
            <p className="lg-section-lead">Each one is a single SVG on a 48 unit grid that takes its colour from the text around it. The wordmark is the same in all four, so you are comparing marks and not type.</p>
            <div className="lg-concepts" role="group" aria-label="Logo directions">
              {concepts.map((item) => (
                <button key={item.id} type="button" className="lg-concept" aria-pressed={item.id === concept.id} onClick={() => choose(item.id)}>
                  <span className="lg-concept-art"><item.Mark size={112} /></span>
                  <span className="lg-concept-meta"><span className="lg-concept-number">{item.number}</span><strong>{item.name}</strong>{item.id === PICK && <span className="lg-concept-pick">My pick</span>}</span>
                  <span className="lg-concept-idea">{item.idea}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="lg-section" aria-labelledby="lg-stage-title">
            <div className="lg-stage-head">
              <div>
                <h2 id="lg-stage-title"><span className="lg-concept-number">{concept.number}</span> {concept.name} in use</h2>
                <p>{concept.rationale} {concept.keeps}</p>
              </div>
              <div className="lg-actions">
                <button type="button" className="lg-button is-primary" onClick={download}><Download size={16} aria-hidden="true" />Download SVG</button>
                <button type="button" className="lg-button" onClick={() => void copy()}>
                  {copyState === "copied" ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
                  <span aria-live="polite">{copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy SVG"}</span>
                </button>
              </div>
            </div>

            <div className="lg-stage-grid">
              <figure className="lg-fig lg-span-4"><div className="lg-tile"><Lockup Mark={concept.Mark} height={52} /></div><figcaption>On paper</figcaption></figure>
              <figure className="lg-fig lg-span-4"><div className="lg-tile is-ink"><Lockup Mark={concept.Mark} height={52} /></div><figcaption>On ink</figcaption></figure>
              <figure className="lg-fig lg-span-4"><div className="lg-tile is-art"><Lockup Mark={concept.Mark} height={52} /></div><figcaption>On art</figcaption></figure>

              <figure className="lg-fig lg-span-5">
                <div className="lg-tile"><div className="lg-icons"><AppIcon Mark={concept.Mark} tone="warm" /><AppIcon Mark={concept.Mark} tone="ink" /><AppIcon Mark={concept.Mark} tone="art" /></div></div>
                <figcaption>App icon in the three surfaces</figcaption>
              </figure>
              <figure className="lg-fig lg-span-7">
                <div className="lg-tile">
                  <div className="lg-ladder">
                    {SIZES.map((size) => <span key={size} className="lg-ladder-item"><Sized Mark={concept.Mark} size={size} /><small>{size}</small></span>)}
                  </div>
                </div>
                <figcaption>Small sizes, in pixels</figcaption>
              </figure>

              <figure className="lg-fig lg-span-7">
                <div className="lg-tile is-flush">
                  <div className="lg-browser">
                    <div className="lg-browser-bar">
                      <span className="lg-browser-dots" aria-hidden="true"><i /><i /><i /></span>
                      <span className="lg-browser-tab"><Favicon Mark={concept.Mark} />Faceful · content studio</span>
                    </div>
                    <div className="lg-browser-page">
                      <Lockup Mark={concept.Mark} height={32} />
                      <span className="lg-browser-links"><span>Why Faceful</span><span>Features</span><span>What works today</span></span>
                      <span className="lg-browser-cta">Open studio</span>
                    </div>
                  </div>
                </div>
                <figcaption>Browser tab and landing navigation</figcaption>
              </figure>
              <figure className="lg-fig lg-span-5">
                <div className="lg-tile"><div className="lg-construct" ref={source}><concept.Mark size={192} /></div></div>
                <figcaption>On the 48 unit grid, one line every 4 units</figcaption>
              </figure>
            </div>
          </section>

          <section className="lg-section" aria-labelledby="lg-compare-title">
            <h2 id="lg-compare-title">Side by side</h2>
            <p className="lg-section-lead">The same four sizes for every direction, with today's mark on the first row.</p>
            <div className="lg-compare-scroll">
              <table className="lg-compare">
                <thead><tr><th scope="col">Direction</th><th scope="col">Favicon, 16</th><th scope="col">24</th><th scope="col">48</th><th scope="col">With the wordmark</th><th scope="col"><span className="lg-visually-hidden">Show in use</span></th></tr></thead>
                <tbody>
                  <tr>
                    <th scope="row">Today</th>
                    <td><Favicon Mark={CurrentMark} /></td><td><CurrentMark size={24} /></td><td><CurrentMark size={48} /></td><td><Lockup Mark={CurrentMark} height={34} typed="faceful" /></td><td />
                  </tr>
                  {concepts.map((item) => (
                    <tr key={item.id} className={item.id === concept.id ? "is-selected" : undefined}>
                      <th scope="row"><span className="lg-concept-number">{item.number}</span> {item.name}</th>
                      <td><Favicon Mark={item.Mark} /></td><td><Sized Mark={item.Mark} size={24} /></td><td><Sized Mark={item.Mark} size={48} /></td><td><Lockup Mark={item.Mark} height={34} /></td>
                      <td>{item.id === concept.id ? <span className="lg-compare-current">Shown above</span> : <button type="button" className="lg-link" onClick={() => choose(item.id)}>Show in use<span className="lg-visually-hidden">: {item.name}</span></button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="lg-section" aria-labelledby="lg-pick-title">
            <h2 id="lg-pick-title">My pick: {pick.name}</h2>
            <div className="lg-pick">
              <AppIcon Mark={pick.Mark} tone="art" size={132} />
              <div>
                <p>It is the only one of the four that someone who knows the current logo would recognise, and it holds at 16 pixels with no simplified drawing. It fixes the real problem, a mark that says sound under a name that says face, by bending one bar.</p>
                <p>Duet tells the bigger story and is the one to choose if the people and agents idea should lead the brand. Profile is the safe typographic option. Take explains the product best and ages fastest if the product grows past portrait video.</p>
                <p className="lg-pick-note">Adopting any of them means one SVG replaces the two CSS marks in the studio and landing page, the favicon, the four PNG app icons and the share image, and the name is written one way everywhere.</p>
              </div>
            </div>
          </section>
        </main>
      </div>
    </WordmarkContext.Provider>
  );
}
