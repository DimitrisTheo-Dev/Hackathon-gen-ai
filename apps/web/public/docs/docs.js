// Enhancements for the static documentation. Every page is complete and readable without this file:
// it only adds a Copy button to code examples and marks the section in view in "On this page".
(() => {
  const status = document.createElement("p");
  status.className = "sr-only";
  status.setAttribute("role", "status");
  document.body.append(status);

  if (navigator.clipboard) {
    for (const figure of document.querySelectorAll("figure.code")) {
      const code = figure.querySelector("pre code");
      const caption = figure.querySelector("figcaption");
      if (!code || !caption) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "copy";
      button.textContent = "Copy";
      // The accessible name starts with the visible label and says which example it copies.
      button.setAttribute("aria-label", `Copy ${caption.textContent.trim()} example`);
      let reset;
      button.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(code.textContent.replace(/\n$/, ""));
          button.textContent = "Copied";
          status.textContent = "Copied to clipboard.";
        } catch {
          status.textContent = "Copying is blocked in this browser. Select the text and copy it.";
        }
        clearTimeout(reset);
        reset = setTimeout(() => {
          button.textContent = "Copy";
          status.textContent = "";
        }, 1800);
      });
      caption.append(button);
    }
  }

  const links = new Map();
  for (const link of document.querySelectorAll('.toc a[href^="#"]')) links.set(decodeURIComponent(link.hash.slice(1)), link);
  const sections = [...links.keys()].map((id) => document.getElementById(id)).filter(Boolean);
  if (!sections.length) return;
  // The section in view is the last one whose top has passed a line just below the sticky header.
  // At the very end of the page that is the final section, even when it is too short to reach the line.
  const line = 104;
  let queued = false;
  const mark = () => {
    queued = false;
    let current = sections[0];
    for (const section of sections) if (section.getBoundingClientRect().top <= line) current = section;
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) current = sections[sections.length - 1];
    for (const [id, link] of links) id === current.id ? link.setAttribute("aria-current", "location") : link.removeAttribute("aria-current");
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(mark);
  };
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule, { passive: true });
  mark();
})();
