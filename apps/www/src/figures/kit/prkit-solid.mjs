// prkit's own helper for figures, next to the vendored kit (not part of it): a solid whose
// shape changes as it moves, drawn once at build time and rewritten in place on the page.

/**
 * A solid whose shape changes as it moves, drawn with every path it can ever need (fill, four
 * shades, top, crease, outline), so the page only rewrites their `d` and never the markup.
 */
export function liveSolidSvg(paths, { tone = "mid", crease = "lo", lit = false } = {}) {
  const seamless = paths.seamless ? " data-seamless" : "";
  const shades = [0, 1, 2, 3]
    .map(
      (shade) => `<path class="iso-shade" data-shade="${shade}" d="${paths.shades[shade] ?? ""}"/>`,
    )
    .join("");
  return (
    `<g class="iso-solid"${lit ? " data-lit" : ""}${seamless}>` +
    `<path class="iso-fill" d="${paths.fill}"/>${shades}<path class="iso-top" d="${paths.top ?? ""}"/>` +
    `<path class="iso-line iso-crease" data-tone="${crease}" d="${paths.crease ?? ""}"/>` +
    `<path class="iso-line iso-edge" data-tone="${tone}" d="${paths.outline}"/></g>`
  );
}

/** Rewrites a live solid's paths in place. */
export function setSolid(group, paths) {
  const set = (selector, d) => {
    const node = group.querySelector(selector);
    if (node && node.getAttribute("d") !== d) node.setAttribute("d", d);
  };
  set(".iso-fill", paths.fill);
  [0, 1, 2, 3].forEach((shade) =>
    set(`.iso-shade[data-shade="${shade}"]`, paths.shades[shade] ?? ""),
  );
  set(".iso-top", paths.top ?? "");
  set(".iso-crease", paths.crease ?? "");
  set(".iso-edge", paths.outline);
}
